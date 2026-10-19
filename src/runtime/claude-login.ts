import type { LoginDisplay } from "../tui/login";
import { terminalText } from "../tui/format";
import { claudeAuthStatus, claudeExecutable, isSubscriptionStatus, subscriptionEnvironment } from "./claude-subscription";
import type { RuntimeAuthenticationResult } from "./types";
import { returnClaudeFiles } from "../platform/home-owner";

interface LoginProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  write(text: string): void;
  kill(): void;
}

/** Claude Code owns this browser flow, credential storage and refresh. No tokens are copied to Casper. */
export async function loginClaudeCode(display: LoginDisplay, dependencies: {
  executable?: () => string | undefined;
  status?: typeof claudeAuthStatus;
  launch?: (executable: string, env: Record<string, string | undefined>) => LoginProcess;
  timeoutMs?: number;
} = {}): Promise<RuntimeAuthenticationResult> {
  const tag = { claudeCode: true as const };
  if (display.signal.aborted) return { ...tag, status: "cancelled", effect: "none" };
  const executable = (dependencies.executable ?? claudeExecutable)();
  if (!executable) return { ...tag, status: "failed", effect: "none", reason: "unavailable",
    detail: "Install native Claude Code from https://code.claude.com/docs/en/setup, then /login claude-subscription. On Windows use the native claude.exe, not the npm shim." };
  const env = subscriptionEnvironment(process.env);
  const status = dependencies.status ?? claudeAuthStatus;
  const verified = async () => isSubscriptionStatus(await status(executable, env, process.cwd()).catch(() => undefined));
  display.setNote("Claude Code keeps its own plan login. No credentials are copied into Casper; no model request is sent.");
  display.wait("Claude Code plan", "Checking Claude Code's existing subscription login…");
  if (await verified()) return display.signal.aborted ? { ...tag, status: "cancelled", effect: "none" } : { ...tag, status: "saved" };
  if (display.signal.aborted) return { ...tag, status: "cancelled", effect: "none" };
  const controller = new AbortController();
  const signal = AbortSignal.any([display.signal, controller.signal, AbortSignal.timeout(dependencies.timeoutMs ?? 15 * 60_000)]);
  let child: LoginProcess | undefined;
  let ended = false;
  let input: Promise<void> | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("login stopped"));
    signal.addEventListener("abort", abort, { once: true });
  });
  // Attach the handler before launching; no unhandled rejection if spawning fails.
  void stopped.catch(() => {});
  try {
    display.wait("Claude Code plan sign-in", "Complete Claude Code's sign-in in your browser. Esc cancels.");
    signal.throwIfAborted();
    child = dependencies.launch ? dependencies.launch(executable, env) : (() => {
      const process = Bun.spawn([executable, "auth", "login", "--claudeai"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      return { stdout: process.stdout, stderr: process.stderr, exited: process.exited,
        write: (text: string) => { process.stdin.write(text); process.stdin.flush(); }, kill: () => { process.kill(); } };
    })();
    let shown = false;
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let tail = "";
      try {
        while (!signal.aborted) {
          const item = await Promise.race([reader.read(), stopped]);
          if (item.done) break;
          tail = (tail + decoder.decode(item.value, { stream: true })).slice(-16_384);
          if (shown) continue;
          const match = terminalText(tail).match(/https:\/\/claude\.ai\/oauth\/authorize\?[^\s]+/);
          if (!match || match[0].length > 8192) continue;
          // Native output can split a URL across chunks; wait for its line terminator.
          if (!terminalText(tail).includes(`${match[0]}\n`) && !terminalText(tail).includes(`${match[0]} `)) continue;
          const url = new URL(match[0]);
          if (url.origin !== "https://claude.ai" || url.pathname !== "/oauth/authorize" || url.username || url.password || url.hash) continue;
          shown = true;
          display.browser(url.href, { openedByProvider: true });
          input = display.privateInput("Claude Code authorization code (or finish in your browser)", signal).then(code => {
            if (!signal.aborted && /^[\x21-\x7e]{1,8192}$/.test(code)) child!.write(`${code}\n`);
          }).catch(() => { if (!signal.aborted) controller.abort(); });
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    };
    const streams = Promise.all([read(child.stdout), read(child.stderr)]);
    // Drain output concurrently but do not expose native diagnostics, which may contain secrets.
    void streams.catch(() => { if (!signal.aborted) controller.abort(); });
    const exit = await Promise.race([child.exited, stopped]);
    ended = true;
    controller.abort();
    await streams.catch(() => {});
    await input;
    if (display.signal.aborted) return { ...tag, status: "cancelled", effect: "unknown" };
    if (exit !== 0 || !(await verified())) return { ...tag, status: "failed", effect: "unknown", reason: "provider",
      detail: "Claude Code did not verify a Pro, Max, Team or Enterprise plan login. Model and defaults unchanged." };
    if (display.signal.aborted) return { ...tag, status: "cancelled", effect: "unknown" };
    return { ...tag, status: "saved" };
  } catch {
    return display.signal.aborted ? { ...tag, status: "cancelled", effect: child ? "unknown" : "none" }
      : { ...tag, status: "failed", effect: child ? "unknown" : "none", reason: "provider",
        detail: signal.aborted ? "Claude Code sign-in timed out or stopped." : "Could not start Claude Code sign-in; update the native Claude Code installation." };
  } finally {
    signal.removeEventListener("abort", abort!);
    controller.abort();
    if (child && !ended) { try { child.kill(); } catch { /* already exited */ } }
    await input;
    if (child) await returnClaudeFiles().catch(() => {});
  }
}
