/**
 * Test helpers: the SDK's local test server, a worker over a fresh copy of the demo data with an
 * in-memory event stream and chaos flags, and a scripted model, so the default suite needs no model
 * key, no Redis and no running Temporal service.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import type { Content, FunctionCall, Part } from '@google/genai';
import { GoogleAdkPlugin } from '@temporalio/google-adk';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { WorkerConfig } from '../../common/config';
import { DataStore } from '../../common/data-store';
import { createActivities } from '../activities';
import { InMemoryChaos, setChaosSource } from '../chaos';
import { chaosModelProvider } from '../chaos-model';
import { InMemoryEventStream } from '../redis/event-stream-manager';
import {
  ChatInteraction,
  GET_ACCOUNT_OPENING_STATES_QUERY,
  GET_CHAT_HISTORY_QUERY,
  PROCESS_USER_MESSAGE_SIGNAL,
} from '../shared';

// Keep the SDK's logs quiet unless TEST_LOG is set. Installed when this module loads, before any
// test environment starts (which would install the default runtime).
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

/** What a scripted model sees of a request. */
export interface ScriptedRequest {
  agent: string;
  /** The instructions the agent was given, client ID line included. */
  instructions: string;
  contents: Content[];
  /** The text of the latest customer message. */
  lastUserText: string;
  /** The function responses since the latest customer message, oldest first. */
  responsesThisTurn: Array<{ name: string; response: Record<string, unknown> }>;
  /** Names of the tools the agent was offered. */
  tools: string[];
}

export type ScriptStep = { text: string } | { calls: FunctionCall[] };
export type Script = (req: ScriptedRequest) => ScriptStep;

export const say = (text: string): ScriptStep => ({ text });
export const call = (name: string, args: Record<string, unknown> = {}): ScriptStep => ({ calls: [{ name, args }] });
export const transfer = (agentName: string): ScriptStep => call('transfer_to_agent', { agentName });

function textOf(content: Content): string {
  return (content.parts ?? []).map((p: Part) => p.text ?? '').join('');
}

export function toScriptedRequest(req: LlmRequest): ScriptedRequest {
  const contents = req.contents ?? [];
  let lastUser = -1;
  contents.forEach((c, i) => {
    // ADK passes other agents' turns as user content that starts "For context:"
    if (c.role === 'user' && c.parts?.[0]?.text !== undefined && c.parts[0].text !== 'For context:') lastUser = i;
  });
  const responsesThisTurn: ScriptedRequest['responsesThisTurn'] = [];
  for (const c of contents.slice(lastUser + 1)) {
    for (const p of c.parts ?? []) {
      if (p.functionResponse) {
        responsesThisTurn.push({
          name: p.functionResponse.name ?? '',
          response: (p.functionResponse.response ?? {}) as Record<string, unknown>,
        });
      }
    }
  }
  const sys = req.config?.systemInstruction;
  const instructions = typeof sys === 'string' ? sys : sys ? textOf(sys as Content) : '';
  const tools = (req.config?.tools ?? []).flatMap((t) =>
    'functionDeclarations' in t ? (t.functionDeclarations ?? []).map((d) => d.name ?? '') : [],
  );
  return {
    agent: String(req.config?.labels?.adk_agent_name ?? ''),
    instructions,
    contents,
    lastUserText: lastUser >= 0 ? textOf(contents[lastUser]) : '',
    responsesThisTurn,
    tools,
  };
}

/** A model that answers from a script. Every request it got is kept in `requests`. */
export class ScriptedLlm extends BaseLlm {
  static requests: ScriptedRequest[] = [];
  static script: Script = () => say('Hello');

  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const req = toScriptedRequest(request);
    ScriptedLlm.requests.push(req);
    const step = ScriptedLlm.script(req);
    const parts: Part[] = 'text' in step ? [{ text: step.text }] : step.calls.map((c) => ({ functionCall: c }));
    yield { content: { role: 'model', parts }, turnComplete: true };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support connect()');
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface TestWorker {
  worker: Worker;
  taskQueue: string;
  store: DataStore;
  events: InMemoryEventStream;
  chaos: InMemoryChaos;
}

let queueCounter = 0;

/**
 * A worker on a new task queue that runs both workflows, every activity and the model calls (the
 * model task queue is the same queue here), over a fresh copy of the demo data.
 */
export async function createTestWorker(
  env: TestWorkflowEnvironment,
  options: {
    /** The model the worker's model activity calls (default: ScriptedLlm). */
    model?: (model: string) => BaseLlm;
    /** The model name the agents ask for (default: scripted-model). */
    modelName?: string;
    activityOverrides?: Record<string, unknown>;
  } = {},
): Promise<TestWorker> {
  const taskQueue = `test-${process.pid}-${++queueCounter}`;
  const store = new DataStore(freshDataDir());
  const events = new InMemoryEventStream();
  const chaos = new InMemoryChaos();
  setChaosSource(chaos);
  const config: WorkerConfig = {
    task_queue: taskQueue,
    open_account_task_queue: taskQueue,
    llm_task_queue: taskQueue,
    model: options.modelName ?? 'scripted-model',
  };
  const activities = {
    ...createActivities({ store, events, client: async () => env.client, config }),
    ...(options.activityOverrides ?? {}),
  };
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve('../workflows/index'),
    activities,
    plugins: [
      new GoogleAdkPlugin({
        modelProvider: chaosModelProvider(options.model ?? ((m) => new ScriptedLlm({ model: m }))),
      }),
    ],
  });
  return { worker, taskQueue, store, events, chaos };
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
