/** A command typed while a task runs: everything it does follows it through its awaits, so the screen knows its boxes
 * from the task's. Its pickers and questions give way to the task's approvals and questions (src/tui/surface.ts). */

import { AsyncLocalStorage } from "node:async_hooks";

const typed = new AsyncLocalStorage<true>();

/** Runs `work` as a command typed during a task. */
export function duringTask<T>(work: () => T): T {
  return typed.run(true, work);
}

/** The code running now belongs to a command typed during a task. */
export function typedDuringTask(): boolean {
  return typed.getStore() === true;
}
