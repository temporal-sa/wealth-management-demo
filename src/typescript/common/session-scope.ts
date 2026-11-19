/**
 * Browser sessions: which session a chat, and everything it does, belongs to.
 *
 * Several people can use one running copy of the demo at once. The API gives each browser a random
 * session ID (a cookie) and starts its chat workflows with IDs that carry it:
 *
 *     <framework's workflow ID prefix>session-<32 hex chars>-chat-<16 hex chars>
 *
 * An open-account workflow's ID starts with its chat's ID (OpenAccount-<chat workflow ID>-...), so the
 * activities of a chat and of its account openings can all find the session from their workflow ID. A
 * workflow started some other way (a test, a script, the CLI) has no session in its ID and uses the
 * "default" session.
 *
 * The session scopes the chaos flags (chaos-manager.ts) and, with DEMO_DATA_STORE=redis, the sample
 * bank data (data-store.ts). This follows the Python and Go frameworks exactly
 * (src/python/common/session_scope.py, src/go/internal/common/session): they all share one Redis.
 */
import { randomBytes } from 'crypto';
import { Context } from '@temporalio/activity';

export const DEFAULT_SESSION = 'default';
/**
 * A session's state in Redis (chaos flags, failure log, sample data) expires this long after its last
 * change, so abandoned sessions don't pile up.
 */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const SESSION_IN_WORKFLOW_ID_RE = /session-([0-9a-f]{32})-chat-/;

export function newSessionId(): string {
  return randomBytes(16).toString('hex');
}

export function isSessionId(value: string | null | undefined): boolean {
  return !!value && SESSION_ID_RE.test(value);
}

/** The start of every chat workflow ID of this session. */
export function chatWorkflowPrefix(frameworkPrefix: string, sessionId: string): string {
  return `${frameworkPrefix}session-${sessionId}-chat-`;
}

export function newChatWorkflowId(frameworkPrefix: string, sessionId: string): string {
  return chatWorkflowPrefix(frameworkPrefix, sessionId) + randomBytes(8).toString('hex');
}

/** True if workflowId is one of this session's chats. */
export function ownsWorkflow(frameworkPrefix: string, sessionId: string, workflowId: string): boolean {
  const prefix = chatWorkflowPrefix(frameworkPrefix, sessionId);
  return workflowId.startsWith(prefix) && workflowId.length > prefix.length;
}

/** The session in a chat's or account opening's workflow ID, or the default session. */
export function sessionFromWorkflowId(workflowId: string | null | undefined): string {
  return SESSION_IN_WORKFLOW_ID_RE.exec(workflowId ?? '')?.[1] ?? DEFAULT_SESSION;
}

/** The session of the workflow whose activity is running, or the default session outside one. */
export function currentSession(): string {
  let workflowId: string | undefined;
  try {
    workflowId = Context.current().info.workflowExecution?.workflowId;
  } catch {
    // Not in an activity
    return DEFAULT_SESSION;
  }
  return sessionFromWorkflowId(workflowId);
}
