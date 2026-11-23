/**
 * What a turn's agents did, from the OpenAI Agents SDK's run items: the reply, the tools' results and the
 * trace of handoffs and tool calls. Used by the chat workflow for its chat history, and by the standalone chat.
 */
import {
  RunHandoffOutputItem,
  RunMessageOutputItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  type RunItem,
} from '@openai/agents-core';

/** What a turn's agents did, for the chat history: the reply, the tools' results and the trace. */
export function describeTurn(items: RunItem[]): { text: string; json: string; trace: string } {
  let text = '';
  let json = '';
  let trace = '';
  for (const item of items) {
    if (item instanceof RunMessageOutputItem) {
      // An agent can answer more than once in a turn (before and after a tool call): one paragraph each
      text += text && item.content ? `\n\n${item.content}` : item.content;
    } else if (item instanceof RunHandoffOutputItem) {
      trace += `Handed off from ${item.sourceAgent.name} to ${item.targetAgent.name}\n`;
    } else if (item instanceof RunToolCallItem) {
      const name = 'name' in item.rawItem ? item.rawItem.name : item.rawItem.type;
      trace += `${item.agent.name}: Calling a tool: ${name}\n`;
    } else if (item instanceof RunToolCallOutputItem) {
      json += `${typeof item.output === 'string' ? item.output : JSON.stringify(item.output)}\n`;
    }
  }
  return { text, json, trace };
}
