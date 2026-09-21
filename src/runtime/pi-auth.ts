import { lstat } from "node:fs/promises";
import path from "node:path";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { withLoginDisplay } from "../tui/login";
import type { RuntimeAuthenticationOptions, RuntimeAuthenticationResult, RuntimeAuthProvider } from "./types";

const providers: readonly { id: RuntimeAuthProvider; label: string }[] = [
  { id: "openai-codex", label: "OpenAI Codex — device code" },
  { id: "github-copilot", label: "GitHub Copilot — device code (github.com)" },
  { id: "anthropic", label: "Anthropic / Claude — API key or browser sign-in" },
  { id: "openrouter", label: "OpenRouter — API key or browser sign-in" },
];

/** Accept only the pinned providers' HTTPS authorization pages and loopback redirects. */
function validAuthorizationUrl(provider: RuntimeAuthProvider, value: string): boolean {
  if (typeof value !== "string" || value.length > 8192 || !/^[\x21-\x7e]+$/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (provider === "anthropic") {
      return url.origin === "https://claude.ai" && url.pathname === "/oauth/authorize" &&
        url.searchParams.get("redirect_uri") === "http://localhost:53692/callback";
    }
    if (provider !== "openrouter" || url.origin !== "https://openrouter.ai" || url.pathname !== "/auth") return false;
    const callback = new URL(url.searchParams.get("callback_url") ?? "");
    return callback.protocol === "http:" && callback.hostname === "127.0.0.1" && !!callback.port &&
      !callback.username && !callback.password && !callback.search && !callback.hash &&
      /^\/oauth\/callback\/[a-f0-9-]{36}$/.test(callback.pathname);
  } catch { return false; }
}

/** Non-atomic preflight only; Pi retains lock/write ownership. Never repair modes silently. */
async function checkDestination(file: string, signal: AbortSignal): Promise<void> {
  if (Buffer.byteLength(file) > 4096) throw new Error("destination");
  let current = file;
  for (let depth = 0; depth < 128; depth++) {
    signal.throwIfAborted();
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (stat) {
      if (stat.isSymbolicLink() || (current === file
        ? !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())
        : !stat.isDirectory())) throw new Error("destination");
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
  throw new Error("destination");
}

/** Dedicated builtin-only runtime: no sessions, extensions, model config or network catalog refresh. */
export async function authenticatePi(options: RuntimeAuthenticationOptions, destination: string,
  lifetime: AbortSignal): Promise<RuntimeAuthenticationResult & { provider?: RuntimeAuthProvider }> {
  const signal = AbortSignal.any([lifetime, ...(options.signal ? [options.signal] : [])]);
  if (signal.aborted) return { status: "cancelled", effect: "none" };
  if ((options.provider !== undefined && !providers.some(item => item.id === options.provider)) || process.env.PI_TUI_WRITE_LOG) {
    return { status: "failed", effect: "none", reason: "unavailable" };
  }
  let invoked = false;
  let provider = options.provider;
  try {
    return await options.terminalHost.run((io) => withLoginDisplay(io, signal, async (display): Promise<RuntimeAuthenticationResult> => {
      provider ??= await display.choose("Choose provider", providers);
      if (!provider) return { status: "cancelled", effect: "none" };
      const selected = provider;
      const method = selected === "anthropic" || selected === "openrouter"
        ? await display.choose("Choose sign-in method", [{ id: "api_key", label: "API key" }, { id: "oauth", label: "Browser sign-in" }] as const)
        : "oauth";
      if (!method) return { status: "cancelled", effect: "none" };
      const browser = method === "oauth" && (selected === "anthropic" || selected === "openrouter");
      const disclosure = selected === "github-copilot"
        ? "Pi may enable model policies on your GitHub account. Cancellation cannot undo remote changes."
        : selected === "anthropic" ? "API use is billed separately. Pi documents Claude subscription sign-in as per-token extra usage, not plan limits."
        : selected === "openrouter" ? "Usage is billed from OpenRouter credits. Browser sign-in creates a permanent API key."
        : "Device-code access must be enabled by the provider.";
      if (!await display.consent(destination, selected, method === "api_key" ? "an API key" : browser ? "browser authorization" : "a device code",
        disclosure + (browser ? "\nStarts a temporary loopback callback listener. Redirect URLs/codes belong only in the private login prompt." : "")) || display.signal.aborted) {
        return { status: "cancelled", effect: "none" };
      }
      // The SDK reads this override when its lazy OAuth module loads. Never allow a public listener.
      if (browser && process.env.PI_OAUTH_CALLBACK_HOST && process.env.PI_OAUTH_CALLBACK_HOST !== "127.0.0.1") {
        return { status: "failed", effect: "none", reason: "unavailable" };
      }
      try { await checkDestination(destination, display.signal); }
      catch { return display.signal.aborted ? { status: "cancelled", effect: "none" } : { status: "failed", effect: "none", reason: "destination" }; }
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 15 * 60_000);
      const flow = AbortSignal.any([display.signal, deadline.signal]);
      let active = true;
      let promptHandled = false;
      let authorizationShown = false;
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
              const key = await display.privateInput("Private API key (never enter keys in chat)", flow);
              // Stored Pi keys are configuration expressions; accept only literal keys here.
              if (key.startsWith("!") || key.includes("$") || !/^[\x21-\x7e]{1,4096}$/.test(key)) throw new Error("invalid key");
              flow.throwIfAborted();
              return key;
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
