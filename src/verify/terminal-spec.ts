import { createHash } from "node:crypto";
import type { NetworkCheckSpec } from "../network/spec";
import { argvText } from "./command";
import { isVerificationScope, type VerificationScope } from "./scope";

export const TERMINAL_KEYS = {
  enter: "\r", tab: "\t", "shift-tab": "\x1b[Z", escape: "\x1b",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  "ctrl-c": "\x03", "ctrl-d": "\x04", backspace: "\x7f",
} as const;
export type TerminalStep = { expect: string } | { send: string } | { key: keyof typeof TERMINAL_KEYS };
export interface TerminalCheckSpec extends Omit<NetworkCheckSpec, "preset"> {
  kind: "offline";
  preset: "terminal";
  argv: string[];
  steps: TerminalStep[];
  columns?: number;
  rows?: number;
  /** Exit code required after all steps; the app must exit, not merely draw a passing screen. */
  exitCode?: number;
  scope?: VerificationScope;
}

/** Steps, viewport and exit expectations are part of the contract, not just the program's argv.
 * A changed scenario must invalidate managed evidence even when the project files are unchanged. */
export function terminalCommand(spec: TerminalCheckSpec): string {
  const hash = createHash("sha256").update(JSON.stringify(parseTerminalCheck(spec, "terminal"))).digest("hex").slice(0, 16);
  return `${argvText(spec.argv)} [terminal scenario ${hash}]`;
}

const KEYS = new Set(["preset", "kind", "argv", "steps", "columns", "rows", "exitCode", "timeout", "after", "scope"]);
const mapping = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (label: string, value: unknown, min: number, max: number): number => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label}: expected a whole number from ${min} to ${max}`);
  return value as number;
};

/** A named terminal scenario, never a shell string. Network/account operations belong in a lab check, not here. */
export function parseTerminalCheck(value: unknown, label: string): TerminalCheckSpec {
  if (!mapping(value)) throw new Error(`${label}: expected a terminal check mapping`);
  for (const key of Object.keys(value)) if (!KEYS.has(key)) throw new Error(`${label}.${key}: unknown setting`);
  if (value.preset !== "terminal" || (value.kind !== undefined && value.kind !== "offline")) throw new Error(`${label}: terminal is an ordinary check; leave kind out`);
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.length > 32 || value.argv.some(arg => typeof arg !== "string" || !arg || arg.length > 4096 || arg.includes("\0"))) {
    throw new Error(`${label}.argv: expected 1-32 nonempty program/argument strings, at most 4096 characters each, without NUL`);
  }
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 24) throw new Error(`${label}.steps: expected 1-24 steps`);
  const steps = value.steps.map((step, i): TerminalStep => {
    const at = `${label}.steps[${i}]`;
    if (!mapping(step) || Object.keys(step).length !== 1) throw new Error(`${at}: set exactly one of expect, send or key`);
    if (Object.hasOwn(step, "key")) {
      if (typeof step.key !== "string" || !Object.hasOwn(TERMINAL_KEYS, step.key)) throw new Error(`${at}.key: expected ${Object.keys(TERMINAL_KEYS).join(", ")}`);
      return { key: step.key as keyof typeof TERMINAL_KEYS };
    }
    const field = Object.hasOwn(step, "expect") ? "expect" : "send";
    if (!Object.hasOwn(step, field) || typeof step[field] !== "string" || !step[field].length || step[field].length > 4096 || step[field].includes("\0")) throw new Error(`${at}: expected nonempty expect or send text, at most 4096 characters, without NUL`);
    if (field === "send" && /[\x00-\x1f\x7f]/.test(step[field])) throw new Error(`${at}.send: use key for control characters (including Enter)`);
    if (field === "expect" && /[\x00-\x08\x0b-\x1f\x7f]/.test(step[field])) throw new Error(`${at}.expect: use visible screen text, not terminal escapes`);
    return field === "expect" ? { expect: step[field] } : { send: step[field] };
  });
  if (!steps.some(step => "expect" in step)) throw new Error(`${label}.steps: at least one screen expectation is required`);
  if (value.after !== undefined && value.after !== "ask" && value.after !== "each-change") throw new Error(`${label}.after: expected each-change or ask`);
  if (value.scope !== undefined && !isVerificationScope(value.scope)) throw new Error(`${label}.scope: expected project-relative inputs and optional excludes`);
  return {
    kind: "offline", preset: "terminal", argv: [...value.argv] as string[], steps,
    ...(value.scope !== undefined ? { scope: structuredClone(value.scope as VerificationScope) } : {}),
    after: value.after === "ask" ? "ask" : "each-change",
    ...(value.timeout !== undefined ? { timeout: integer(`${label}.timeout`, value.timeout, 1, 3600) } : {}),
    ...(value.columns !== undefined ? { columns: integer(`${label}.columns`, value.columns, 20, 240) } : {}),
    ...(value.rows !== undefined ? { rows: integer(`${label}.rows`, value.rows, 5, 100) } : {}),
    ...(value.exitCode !== undefined ? { exitCode: integer(`${label}.exitCode`, value.exitCode, 0, 255) } : {}),
  };
}
