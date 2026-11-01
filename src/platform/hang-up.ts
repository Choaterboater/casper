/**
 * Whether Casper stays after its terminal hangs up: a task was running, so it carries on as a walk-away job (decision 51).
 * The hang-up listeners that clean up for an ending Casper (the side pane, slow commands) read this first: a Casper
 * that stays keeps its slow commands, and nobody hangs it up again.
 */
let staying = false;

export function stayingAfterHangUp(): boolean { return staying; }

export function stayAfterHangUp(): void { staying = true; }

/** Tests only: a fresh process state. */
export function resetHangUpForTests(): void { staying = false; }
