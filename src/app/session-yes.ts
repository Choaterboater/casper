import { NO, YES_ONCE, YES_SESSION, type Choice } from "./safe-choices";

/** One approval box: the context lines, the question, the choices; the chosen label, or undefined (nobody answered). */
export type ApproveBox = (preview: string, question: string, options: Choice[], signal?: AbortSignal) => Promise<string | undefined>;

/**
 * Approval boxes that offer "Yes, for this session" (a browser action, a debugger launch): 1 No · 2 Yes, this once ·
 * 3 Yes, for this session. A session yes covers that key until Casper exits or forget(); nobody to ask is a No.
 */
export class SessionYes {
  private readonly keys = new Set<string>();

  constructor(private readonly ask: ApproveBox) {}

  async approve(key: string, preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
    if (this.keys.has(key)) return true;
    const answer = await this.ask(preview, question, [{ label: NO }, { label: YES_ONCE }, { label: YES_SESSION }], signal);
    if (answer === YES_SESSION) { this.keys.add(key); return true; }
    return answer === YES_ONCE;
  }

  /** A new workspace or conversation: every session yes ends. */
  forget(): void { this.keys.clear(); }
}
