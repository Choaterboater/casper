/** The text before one streamed tool call, carried through its awaits (including shell approval queues). */
import { AsyncLocalStorage } from "node:async_hooks";

const preceding = new AsyncLocalStorage<string>();

export function withToolReason<T>(text: string, work: () => T): T {
  return preceding.run(text, work);
}

/** No active tool call means no model-supplied title, never the tail of a later response. */
export function toolReason(): string | undefined {
  return preceding.getStore();
}
