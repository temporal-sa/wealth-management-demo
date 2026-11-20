/**
 * Test helpers: the SDK's local test server, workers over a fresh copy of the demo data with an in-memory
 * event stream and chaos flags, and a scripted Strands model, so the default suite needs no model key, no
 * Redis and no running Temporal service.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';
import { StrandsPlugin } from '@temporalio/strands-agents';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { WorkerConfig } from '../strands_lib/config';
import { DataStore } from '../strands_lib/data-store';
import { MODEL_NAME } from '../strands_lib/model-name';
import { createActivities } from '../durable/activities';
import { InMemoryChaos, setChaosSource, type ChaosSource } from '../durable/chaos';
import { withChaos } from '../durable/chaos-model';
import { InMemoryEventStream } from '../durable/redis/event-stream-manager';
import {
  ChatInteraction,
  GET_ACCOUNT_OPENING_STATES_QUERY,
  GET_CHAT_HISTORY_QUERY,
  PROCESS_USER_MESSAGE_SIGNAL,
} from '../durable/shared';

// Keep the SDK's logs quiet unless TEST_LOG is set. Installed when this module loads, before any test
// environment starts (which would install the default runtime).
try {
  Runtime.install({ logger: new DefaultLogger(process.env.TEST_LOG ? 'INFO' : 'WARN') });
} catch {
  // already installed
}

/** A fresh copy of the committed demo data (never data/ itself, which a demo run changes). */
export function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-data-'));
  const src = path.join(__dirname, 'fixtures', 'data');
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  return dir;
}

// ---------------------------------------------------------------------------
// Scripted model
// ---------------------------------------------------------------------------

/** Which agent a request came from, told apart by the tools it was offered. */
export type AgentKind = 'supervisor' | 'beneficiary' | 'investment' | 'open-account' | 'unknown';

/** What a scripted model sees of a request. */
export interface ScriptedRequest {
  agent: AgentKind;
  systemPrompt: string;
  /** Names of the tools the agent was offered. */
  tools: string[];
  /** The text of the latest user message (for a sub-agent, the request its assistant tool sent). */
  lastUserText: string;
  /** The text of the tool results since that message, oldest first. */
  resultsThisTurn: string[];
  /** The text of every tool result in the agent's history, oldest first. */
  allResults: string[];
}

export type ScriptStep = { text: string } | { calls: Array<{ name: string; args: Record<string, unknown> }> };
export type Script = (req: ScriptedRequest) => ScriptStep;

export const say = (text: string): ScriptStep => ({ text });
export const call = (name: string, args: Record<string, unknown> = {}): ScriptStep => ({ calls: [{ name, args }] });

function agentKind(tools: string[]): AgentKind {
  if (tools.includes('beneficiary_assistant')) return 'supervisor';
  if (tools.includes('list_beneficiaries')) return 'beneficiary';
  if (tools.includes('open_account_assistant')) return 'investment';
  if (tools.includes('open_new_investment_account')) return 'open-account';
  return 'unknown';
}

type Block = { type: string; text?: string; json?: unknown; content?: Block[] };

function resultText(block: Block): string {
  return (block.content ?? []).map((c) => c.text ?? (c.json !== undefined ? JSON.stringify(c.json) : '')).join('');
}

export function toScriptedRequest(messages: Message[], options?: StreamOptions): ScriptedRequest {
  const tools = (options?.toolSpecs ?? []).map((t) => t.name);
  const blocks = messages.map((m) => ({ role: m.role, content: m.content as unknown as Block[] }));
  let lastUser = -1;
  blocks.forEach((m, i) => {
    if (m.role === 'user' && m.content.some((b) => b.type === 'textBlock')) lastUser = i;
  });
  const results = (from: number) =>
    blocks.slice(from).flatMap((m) => m.content.filter((b) => b.type === 'toolResultBlock').map(resultText));
  const sys = options?.systemPrompt;
  return {
    agent: agentKind(tools),
    systemPrompt: typeof sys === 'string' ? sys : '',
    tools,
    lastUserText:
      lastUser >= 0
        ? blocks[lastUser].content
            .filter((b) => b.type === 'textBlock')
            .map((b) => b.text)
            .join('')
        : '',
    resultsThisTurn: results(lastUser + 1),
    allResults: results(0),
  };
}

/** Where a model call ran: the activity's task queue and workflow ID. */
export interface ModelCall {
  agent: AgentKind;
  taskQueue: string;
  workflowId?: string;
}

let toolUseCounter = 0;

/** A Strands model that answers from a script. Every request it got is kept in `requests`. */
export class ScriptedModel extends Model<BaseModelConfig> {
  static requests: ScriptedRequest[] = [];
  static calls: ModelCall[] = [];
  static script: Script = () => say('Hello');
  private config: BaseModelConfig = { modelId: 'scripted-model' };

  updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }
  getConfig(): BaseModelConfig {
    return this.config;
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const req = toScriptedRequest(messages, options);
    ScriptedModel.requests.push(req);
    // Imported here, so the helpers load outside an activity
    const { Context } = await import('@temporalio/activity');
    const info = Context.current().info;
    ScriptedModel.calls.push({
      agent: req.agent,
      taskQueue: info.taskQueue,
      workflowId: info.workflowExecution?.workflowId,
    });
    const step = ScriptedModel.script(req);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if ('text' in step) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: step.text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
      return;
    }
    for (const c of step.calls) {
      const toolUseId = `tool-${++toolUseCounter}`;
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: c.name, toolUseId } };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(c.args) },
      };
      yield { type: 'modelContentBlockStopEvent' };
    }
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
  }

  static reset(script: Script): void {
    ScriptedModel.requests = [];
    ScriptedModel.calls = [];
    ScriptedModel.script = script;
  }
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export interface TestWorker {
  /** Runs `fn` while both workers poll, and shuts them down after. */
  runUntil<R>(fn: () => Promise<R>): Promise<R>;
  taskQueue: string;
  llmTaskQueue: string;
  store: DataStore;
  events: InMemoryEventStream;
  chaos: InMemoryChaos;
}

let queueCounter = 0;

/**
 * Two workers like the real one: the chat workflow, the open-account workflow and the activities on one task
 * queue, and the model calls on a <queue>-llm queue of their own, over a fresh copy of the demo data. The
 * model is the scripted one, with the chaos panel's model flags.
 */
export async function createTestWorker(
  env: TestWorkflowEnvironment,
  options: { activityOverrides?: Record<string, unknown>; chaos?: ChaosSource } = {},
): Promise<TestWorker> {
  const taskQueue = `test-${process.pid}-${++queueCounter}`;
  const llmTaskQueue = `${taskQueue}-llm`;
  const store = new DataStore(freshDataDir());
  const events = new InMemoryEventStream();
  const chaos = new InMemoryChaos();
  setChaosSource(options.chaos ?? chaos);
  const config: WorkerConfig = {
    task_queue: taskQueue,
    open_account_task_queue: taskQueue,
    llm_task_queue: llmTaskQueue,
    model: 'scripted-model',
  };
  const activities = {
    ...createActivities({ store, events, client: async () => env.client, config }),
    ...(options.activityOverrides ?? {}),
  };
  const plugin = new StrandsPlugin({ models: { [MODEL_NAME]: () => withChaos(new ScriptedModel()) } });
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve('../durable/workflows/index'),
    activities,
    plugins: [plugin],
  });
  const llmWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: llmTaskQueue,
    plugins: [plugin],
  });
  return {
    runUntil: (fn) => llmWorker.runUntil(worker.runUntil(fn)),
    taskQueue,
    llmTaskQueue,
    store,
    events,
    chaos,
  };
}

/** Polls `fn` until it returns a value other than undefined, or fails after `timeoutMs`. */
export async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Sends customer messages to a chat workflow and waits for each reply. */
export function chatSender(handle: WorkflowHandle, timeoutMs = 30_000) {
  let sent = 0;
  return async (text: string): Promise<ChatInteraction> => {
    const n = ++sent;
    await handle.signal(PROCESS_USER_MESSAGE_SIGNAL, { user_input: text });
    return waitFor(
      async () => {
        const history = await handle.query<ChatInteraction[]>(GET_CHAT_HISTORY_QUERY);
        return history.length >= n ? history[n - 1] : undefined;
      },
      timeoutMs,
      `the reply to "${text}"`,
    );
  };
}

/** The latest state of each account opening the chat started. */
export function openingStates(handle: WorkflowHandle): Promise<Record<string, string>> {
  return handle.query<Record<string, string>>(GET_ACCOUNT_OPENING_STATES_QUERY);
}
