/** The text before one streamed tool call, carried through its awaits (including shell approval queues). */
import { AsyncLocalStorage } from "node:async_hooks";

const preceding = new AsyncLocalStorage<string>();
const calls = new AsyncLocalStorage<string>();

export function withToolReason<T>(text: string, work: () => T): T {
  return preceding.run(text, work);
}

/** No active tool call means no model-supplied title, never the tail of a later response. */
export function toolReason(): string | undefined {
  return preceding.getStore();
}

/** The model's id of the tool call `work` runs, carried through its awaits the same way (an MCP call to an ACP client's
 * server names the step it belongs to). */
export function withToolCall<T>(id: string, work: () => T): T {
  return calls.run(id, work);
}

/** The model's id of the running tool call, if any. */
export function toolCallId(): string | undefined {
  return calls.getStore();
}
