import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { withLoginDisplay } from "../tui/login";
import { openRouterAttribution } from "./openrouter-attribution";
import type { RuntimeAuthenticationOptions, RuntimeAuthenticationResult, RuntimeAuthProvider } from "./types";

const providers: readonly { id: RuntimeAuthProvider; label: string }[] = [
  { id: "openai-codex", label: "OpenAI Codex — device code" },
  { id: "github-copilot", label: "GitHub Copilot — device code (github.com)" },
  { id: "anthropic", label: "Anthropic / Claude — API key or browser sign-in" },
  { id: "openrouter", label: "OpenRouter — API key or browser sign-in" },
];

/** Accept only Anthropic's HTTPS authorization page and loopback callback. */
function validAuthorizationUrl(provider: RuntimeAuthProvider, value: string): boolean {
  if (typeof value !== "string" || value.length > 8192 || !/^[\x21-\x7e]+$/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (provider === "anthropic") {
      return url.origin === "https://claude.ai" && url.pathname === "/oauth/authorize" &&
        url.searchParams.get("redirect_uri") === "http://localhost:53692/callback";
    }
    if (provider === "openrouter") {
      return url.origin === "https://openrouter.ai" && url.pathname === "/auth";
    }
    return false;
  } catch { return false; }
}

/** Non-atomic preflight only; Pi retains lock/write ownership. Never repair modes silently.
 * Returns a terminal-safe description of the first unsafe component (with the remedy), or undefined.
 * Casper owns the credential file and the directory holding it: neither may be a link. Ancestors above
 * are the user's or the OS's (macOS /tmp -> private/tmp, ostree /home -> var/home), so a link there is
 * followed hop by hop when it is owned by root or the user, and the walk continues on its target.
 * Windows has no POSIX mode bits or uid: a regular, non-linked file under the profile is accepted;
 * its ACL is the operating system's per-user default, not something Casper can inspect here. */
async function destinationProblem(file: string, signal: AbortSignal): Promise<string | undefined> {
  if (Buffer.byteLength(file) > 4096) return "the credential path exceeds 4096 bytes";
  const posix = process.platform !== "win32";
  const uid = process.getuid?.();
  const quoted = (value: string) => JSON.stringify(value);
  const inspect = async (target: string) => {
    signal.throwIfAborted();
    return lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw Object.assign(new Error(`${quoted(target)} cannot be inspected (${error.code ?? "error"})`), { destination: true });
    });
  };
  try {
    const leaf = await inspect(file);
    if (leaf) {
      if (leaf.isSymbolicLink()) return `${quoted(file)} is a symbolic link; replace it with a regular file`;
      if (!leaf.isFile()) return `${quoted(file)} is not a regular file`;
      if (leaf.nlink !== 1) return `${quoted(file)} has other hard links; replace it with a private copy`;
      if (posix && uid !== undefined && leaf.uid !== uid) return `${quoted(file)} is not owned by you`;
      if (posix && (leaf.mode & 0o077) !== 0) return `${quoted(file)} is accessible to other users; run chmod 600 ${quoted(file)}`;
    }
    const directory = path.dirname(file);
    const owned = await inspect(directory);
    if (owned?.isSymbolicLink()) return `${quoted(directory)} is a symbolic link; use a real directory for credentials`;
    if (owned && !owned.isDirectory()) return `${quoted(directory)} is not a directory`;
    let current = path.dirname(directory);
    for (let hops = 0; hops < 128; hops++) {
      const stat = await inspect(current);
      if (stat?.isSymbolicLink()) {
        if (posix && uid !== undefined && stat.uid !== 0 && stat.uid !== uid) return `${quoted(current)} is a symbolic link owned by another user`;
        current = path.resolve(path.dirname(current), await readlink(current));
        continue;
      }
      if (stat && !stat.isDirectory()) return `${quoted(current)} is not a directory`;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
    return "the credential path has too many components or symbolic links";
  } catch (error) {
    if ((error as { destination?: boolean }).destination) return (error as Error).message;
    throw error;
  }
}

/** Typed API keys are verified with the provider before they are stored. Verification never
 * echoes the key or provider response bodies — only a status taxonomy reaches the screen. */
const KEY_VERIFICATION_TIMEOUT_MS = 10_000;

type KeyVerification = { ok: true } | { ok: false; rejected: true; status: number } | { ok: false; rejected: false; reason: string };

async function verifyProviderKey(provider: "anthropic" | "openrouter", key: string, signal: AbortSignal): Promise<KeyVerification> {
  const url = provider === "openrouter" ? "https://openrouter.ai/api/v1/auth/key" : "https://api.anthropic.com/v1/models";
  const headers: Record<string, string> = provider === "openrouter"
    ? { authorization: `Bearer ${key}`, ...openRouterAttribution() }
    : { "x-api-key": key, "anthropic-version": "2023-06-01" };
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(KEY_VERIFICATION_TIMEOUT_MS)]),
    });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) return { ok: false, rejected: true, status: response.status };
    return { ok: false, rejected: false, reason: `provider error (HTTP ${response.status})` };
  } catch (error) {
    if (signal.aborted) throw error; // Cancellation maps to the login result, not a retry note.
    return { ok: false, rejected: false, reason: "network error" };
  }
}

/** Dedicated builtin-only runtime: no sessions, extensions, model config or network catalog refresh. */
export async function authenticatePi(options: RuntimeAuthenticationOptions, destination: string,
  lifetime: AbortSignal): Promise<RuntimeAuthenticationResult & { provider?: RuntimeAuthProvider }> {
  const signal = AbortSignal.any([lifetime, ...(options.signal ? [options.signal] : [])]);
  if (signal.aborted) return { status: "cancelled", effect: "none" };
  if ((options.provider !== undefined && !providers.some(item => item.id === options.provider)) || process.env.CASPER_TUI_WRITE_LOG || process.env.PI_TUI_WRITE_LOG) {
    return { status: "failed", effect: "none", reason: "unavailable" };
  }
  let invoked = false;
  let provider = options.provider;
  try {
    // Refuse an unusable destination before the picker and consent, naming the component to fix.
    const early = await destinationProblem(destination, signal);
    if (early) return { status: "failed", effect: "none", reason: "destination", detail: early };
    return await options.terminalHost.run((io) => withLoginDisplay(io, signal, async (display): Promise<RuntimeAuthenticationResult> => {
      provider ??= await display.choose("Choose provider", providers);
      if (!provider) return { status: "cancelled", effect: "none" };
      const selected = provider;
      const method = selected === "anthropic" || selected === "openrouter"
        ? await display.choose("Choose sign-in method", [{ id: "api_key", label: "API key" }, { id: "oauth", label: "Browser sign-in" }] as const)
        : "oauth";
      if (!method) return { status: "cancelled", effect: "none" };
      // Browser sign-in (loopback listener + authorization page) vs device-code oauth.
      const browser = method === "oauth" && (selected === "anthropic" || selected === "openrouter");
      const disclosure = selected === "github-copilot"
        ? "Sign-in may enable model policies on your GitHub account. Cancellation cannot undo remote changes."
        : selected === "anthropic" ? "API use is billed separately. Claude subscription sign-in is documented as per-token extra usage, not plan limits."
        : selected === "openrouter"
          ? method === "api_key" ? "Usage is billed from OpenRouter credits. Use an API key from OpenRouter."
            : "Usage is billed from OpenRouter credits. Browser sign-in exchanges an authorization code for a user-controlled OpenRouter API key."
          : "Device-code access must be enabled by the provider.";
      if (!await display.consent(destination, selected, method === "api_key" ? "an API key" : browser ? "browser authorization" : "a device code",
        disclosure + (browser ? "\nStarts a temporary loopback callback listener. Redirect URLs/codes belong only in the private login prompt." : "")) || display.signal.aborted) {
        return { status: "cancelled", effect: "none" };
      }
      // The SDK reads this override when its lazy OAuth module loads. Never allow a public listener.
      if (browser && [process.env.CASPER_OAUTH_CALLBACK_HOST, process.env.PI_OAUTH_CALLBACK_HOST]
        .some(host => host && host !== "127.0.0.1")) {
        return { status: "failed", effect: "none", reason: "unavailable" };
      }
      // Re-check after consent: the preflight above is not atomic.
      try {
        const problem = await destinationProblem(destination, display.signal);
        if (problem) return { status: "failed", effect: "none", reason: "destination", detail: problem };
      } catch { return display.signal.aborted ? { status: "cancelled", effect: "none" } : { status: "failed", effect: "none", reason: "destination" }; }
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 15 * 60_000);
      const flow = AbortSignal.any([display.signal, deadline.signal]);
      let active = true;
      let promptHandled = false;
      let authorizationShown = false;
      let verificationCancelled = false;
      try {
        flow.throwIfAborted();
        const runtime = await ModelRuntime.create({ authPath: destination, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal: flow });
        flow.throwIfAborted();
        invoked = true;
        await runtime.login(selected, method, {
          signal: flow,
          prompt: async (prompt) => {
            flow.throwIfAborted(); prompt.signal?.throwIfAborted();
            if (!active || promptHandled) throw new Error("unsupported interaction");
            promptHandled = true;
            if (method === "api_key" && prompt.type === "secret") {
              flow.throwIfAborted();
              let note = "";
              for (;;) {
                const key = await display.privateInput(note === ""
                  ? "Private API key (never enter keys in chat)"
                  : `Private API key — ${note} Paste again, or Esc to cancel.`, flow);
                // Stored Pi keys are configuration expressions; accept only literal keys here.
                if (key.startsWith("!") || key.includes("$") || !/^[\x21-\x7e]{1,4096}$/.test(key)) throw new Error("invalid key");
                flow.throwIfAborted();
                const verification = await verifyProviderKey(selected as "anthropic" | "openrouter", key, flow);
                if (verification.ok) return key;
                if (verification.rejected) { note = `rejected by ${provider} (HTTP ${verification.status}).`; continue; }
                const choice = await display.choose(`Key could not be verified (${verification.reason}).`, [
                  { id: "retry", label: "Paste the key again" },
                  { id: "save", label: "Save without verification" },
                  { id: "cancel", label: "Cancel sign-in" },
                ] as const);
                if (choice === "save") return key;
                if (choice !== "retry") { verificationCancelled = true; deadline.abort(); throw new Error("verification cancelled"); }
              }
            }
            if (selected === "openai-codex" && prompt.type === "select" && prompt.message === "Select OpenAI Codex login method:" &&
              prompt.options.length === 2 && prompt.options[0]?.id === "browser" && prompt.options[1]?.id === "device_code") return "device_code";
            if (selected === "github-copilot" && prompt.type === "text" && prompt.message === "GitHub Enterprise URL/domain (blank for github.com)") return "";
            if (browser && authorizationShown && prompt.type === "manual_code") {
              return display.privateInput("Private authorization code / redirect URL (or finish in your browser)",
                AbortSignal.any([flow, ...(prompt.signal ? [prompt.signal] : [])]));
            }
            throw new Error("unsupported interaction");
          },
          notify: (event) => {
            if (!active || flow.aborted) return;
            if (event.type === "progress" || event.type === "info") return; // No raw provider text or links.
            if (browser && !authorizationShown && event.type === "auth_url" && validAuthorizationUrl(selected, event.url)) {
              authorizationShown = true; display.browser(event.url); return;
            }
            const verification = selected === "openai-codex" ? "https://auth.openai.com/codex/device" : "https://github.com/login/device";
            if (browser || method !== "oauth" || !promptHandled || authorizationShown || event.type !== "device_code" ||
              event.verificationUri !== verification || typeof event.userCode !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(event.userCode)) {
              deadline.abort(); throw new Error("unsupported authorization display");
            }
            authorizationShown = true; display.device(event.verificationUri, event.userCode);
          },
        });
        return { status: "saved" };
      } catch (error) {
        if (error instanceof CredentialSynchronizationError) return { status: "saved-needs-refresh" };
        if (verificationCancelled) return { status: "cancelled", effect: invoked ? "unknown" : "none" };
        return display.signal.aborted
          ? { status: "cancelled", effect: invoked ? "unknown" : "none" }
          : { status: "failed", effect: invoked ? "unknown" : "none", reason: "provider" };
      } finally { active = false; clearTimeout(timer); deadline.abort(); }
    })).then(result => ({ ...result, provider }));
  } catch {
    // Never expose SDK error objects: synchronization errors contain the credential itself.
    return signal.aborted ? { status: "cancelled", effect: invoked ? "unknown" : "none", provider }
      : { status: "failed", effect: invoked ? "unknown" : "none", reason: "unavailable", provider };
  }
}
