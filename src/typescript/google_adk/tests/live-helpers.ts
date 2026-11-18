/**
 * Helpers for the live tests, which call the paid Gemini API: the real chat workflow and the real
 * model on the SDK's local test server, with an in-memory event stream and the chaos flags off. Each
 * conversation is repeated LIVE_TEST_RUNS times (default 1), and every run's transcript is printed.
 */
import { LLMRegistry } from '@google/adk';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { loadWorkerConfig } from '../../common/config';
import { ChatInteraction } from '../shared';
import { WealthManagementWorkflow } from '../workflows/wealth-management';
import { chatSender, createTestWorker, TestWorker } from './helpers';

export const LIVE_TEST_RUNS = Math.max(1, Number(process.env.LIVE_TEST_RUNS ?? 1));

export function requireApiKey(): void {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENAI_API_KEY && !process.env.GOOGLE_API_KEY) {
    throw new Error('The live tests call Gemini: set GEMINI_API_KEY (source setgeminikey.sh)');
  }
}

export async function liveWorker(env: TestWorkflowEnvironment): Promise<TestWorker> {
  return createTestWorker(env, { model: (m) => LLMRegistry.newLlm(m), modelName: loadWorkerConfig().model });
}

export interface LiveChat {
  handle: WorkflowHandle;
  send: (text: string) => Promise<ChatInteraction>;
  transcript: string[];
}

/** Starts a chat whose send() also records the transcript. */
export async function startLiveChat(env: TestWorkflowEnvironment, t: TestWorker, name: string): Promise<LiveChat> {
  const handle = await env.client.workflow.start(WealthManagementWorkflow, {
    taskQueue: t.taskQueue,
    workflowId: `${name}-${Date.now()}`,
  });
  const sender = chatSender(handle, 180_000);
  const transcript: string[] = [];
  return {
    handle,
    transcript,
    send: async (text) => {
      const reply = await sender(text);
      transcript.push(`Customer: ${text}`, `Agent: ${reply.text_response}`);
      if (reply.agent_trace.trim())
        transcript.push(
          ...reply.agent_trace
            .trim()
            .split('\n')
            .map((l) => `   [${l}]`),
        );
      return reply;
    },
  };
}

export function printTranscript(title: string, chat: LiveChat): void {
  console.log(`\n----- ${title} (${chat.handle.workflowId}) -----\n${chat.transcript.join('\n')}\n`);
}
