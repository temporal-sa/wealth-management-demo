/**
 * How long a chat waits for the customer before it ends by itself.
 *
 * A chat with no customer message and no account-opening status update for CHAT_IDLE_TIMEOUT ends
 * as it does on End Chat, so chats abandoned without End Chat (a closed tab) don't run forever. Its
 * open-account child workflows are terminated by their parent close policy.
 *
 * Workflow code only. The timer is behind a patch, so chats that started before it existed replay
 * without it instead of failing with a non-determinism error.
 */
import { condition, patched } from '@temporalio/workflow';

export const CHAT_IDLE_TIMEOUT = '1 hour';
export const CHAT_IDLE_TIMEOUT_PATCH = 'chat-idle-timeout';

/** Waits until `ready()`; false when the chat sat idle for CHAT_IDLE_TIMEOUT first. */
export async function waitForCustomer(ready: () => boolean): Promise<boolean> {
  if (patched(CHAT_IDLE_TIMEOUT_PATCH)) {
    return condition(ready, CHAT_IDLE_TIMEOUT);
  }
  await condition(ready);
  return true;
}
