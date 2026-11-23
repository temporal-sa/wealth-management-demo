/**
 * Test helpers: the SDK's local test server, workers over a fresh copy of the demo data with an in-memory
 * event stream and chaos flags, and a scripted OpenAI Agents model, so the default suite needs no model key, no
 * Redis and no running Temporal service.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '@openai/agents-core';
import { OpenAIAgentsPlugin } from '@temporalio/openai-agents';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { WorkerConfig } from '../oai_lib/config';
import { DataStore } from '../oai_lib/data-store';
import { createActivities } from '../durable/activities';
import { InMemoryChaos, setChaosSource, type ChaosSource } from '../durable/chaos';
import { ChaosModelProvider } from '../durable/chaos-model';
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
  /** Names of the tools and handoffs the agent was offered. */
  tools: string[];
  /** The text of the customer's latest message. */
  lastUserText: string;
  /** The results of the tools (not handoffs) called since that message, oldest first. */
  resultsThisTurn: string[];
  /** Every tool result (not handoffs) in the conversation, oldest first. */
  allResults: string[];
}

export type ScriptStep = { text: string } | { calls: Array<{ name: string; args: Record<string, unknown> }> };
export type Script = (req: ScriptedRequest) => ScriptStep;

export const say = (text: string): ScriptStep => ({ text });
export const call = (name: string, args: Record<string, unknown> = {}): ScriptStep => ({ calls: [{ name, args }] });

/** The handoff tool names, as the SDK names them (transfer_to_<agent name>). */
export const TO_SUPERVISOR = 'transfer_to_Supervisor_Agent';
export const TO_BENEFICIARY = 'transfer_to_Beneficiary_Agent';
export const TO_INVESTMENT = 'transfer_to_Investment_Agent';
export const TO_OPEN_ACCOUNT = 'transfer_to_Open_Account_Agent';

function agentKind(tools: string[]): AgentKind {
  if (tools.includes(TO_BENEFICIARY)) return 'supervisor';
  if (tools.includes('list_beneficiaries')) return 'beneficiary';
  if (tools.includes('list_investments')) return 'investment';
  if (tools.includes('open_new_investment_account')) return 'open-account';
  return 'unknown';
}

type Item = {
  type?: string;
  role?: string;
  name?: string;
  callId?: string;
  content?: unknown;
  output?: unknown;
};

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => text(c)).join('');
  if (content && typeof content === 'object') {
    const c = content as { text?: string; type?: string };
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}

export function toScriptedRequest(request: ModelRequest): ScriptedRequest {
  const tools = [...request.tools.map((t) => t.name), ...request.handoffs.map((h) => h.toolName)];
  const items: Item[] =
    typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : (request.input as Item[]);
  // Which tool each call ID belongs to, so handoff results can be left out
  const callNames = new Map<string, string>();
  for (const i of items) if (i.type === 'function_call' && i.callId) callNames.set(i.callId, i.name ?? '');
  let lastUser = -1;
  items.forEach((i, n) => {
    if (i.role === 'user') lastUser = n;
  });
  const results = (from: number) =>
    items
      .slice(from)
      .filter(
        (i) =>
          i.type === 'function_call_result' &&
          !(callNames.get(i.callId ?? '') ?? i.name ?? '').startsWith('transfer_to_'),
      )
      .map((i) => text(i.output));
  return {
    agent: agentKind(tools),
    systemPrompt: request.systemInstructions ?? '',
    tools,
    lastUserText: lastUser >= 0 ? text(items[lastUser].content) : '',
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

let callCounter = 0;

/** An OpenAI Agents model that answers from a script. Every request it got is kept in `requests`. */
export class ScriptedModel implements Model {
  static requests: ScriptedRequest[] = [];
  static calls: ModelCall[] = [];
  static script: Script = () => say('Hello');

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const req = toScriptedRequest(request);
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
    const output: AgentOutputItem[] =
      'text' in step
        ? [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: step.text }],
            },
          ]
        : step.calls.map((c) => ({
            type: 'function_call',
            callId: `call-${++callCounter}`,
            name: c.name,
            arguments: JSON.stringify(c.args),
            status: 'completed',
          }));
    return { usage: new Usage(), output };
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error('The scripted model does not stream');
  }

  static reset(script: Script): void {
    ScriptedModel.requests = [];
    ScriptedModel.calls = [];
    ScriptedModel.script = script;
  }
}

/** The scripted model, with the chaos panel's model flags, as the worker's provider gives OpenAI. */
const scriptedProvider: ModelProvider = new ChaosModelProvider({ getModel: () => new ScriptedModel() });

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
  const plugin = new OpenAIAgentsPlugin({ modelProvider: scriptedProvider });
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
