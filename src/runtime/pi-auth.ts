import os from "node:os";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { tildePath } from "../new/scaffold";
import { privateFileProblem } from "../platform/private-file";
import { withLoginDisplay } from "../tui/login";
import { openRouterAttribution } from "./openrouter-attribution";
import type { RuntimeAuthenticationOptions, RuntimeAuthenticationResult, RuntimeAuthProvider } from "./types";

/** The home folder now (tests and wrappers change HOME after start). */
const home = () => process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();

const providerNames: Record<RuntimeAuthProvider, string> = {
  openrouter: "OpenRouter", anthropic: "Anthropic (Claude)", "openai-codex": "OpenAI Codex (ChatGPT plan)", "github-copilot": "GitHub Copilot",
};

/** One way to sign in: a provider and its method, one numbered row. */
export interface SignInWay { id: string; provider: RuntimeAuthProvider; method: "api_key" | "oauth"; label: string }

/** Every way to sign in, provider and method together in one list, OpenRouter first (Enter picks it).
 * With a provider, only that provider's ways. */
export function signInWays(provider?: RuntimeAuthProvider): SignInWay[] {
  const ways: SignInWay[] = [
    { id: "openrouter:api_key", provider: "openrouter", method: "api_key", label: "OpenRouter · paste an API key" },
    { id: "openrouter:oauth", provider: "openrouter", method: "oauth", label: "OpenRouter · sign in with your browser" },
    { id: "anthropic:api_key", provider: "anthropic", method: "api_key", label: "Anthropic (Claude) · paste an API key" },
    { id: "anthropic:oauth", provider: "anthropic", method: "oauth", label: "Anthropic (Claude) · sign in with your browser" },
    { id: "openai-codex:oauth", provider: "openai-codex", method: "oauth", label: "OpenAI Codex (ChatGPT plan) · enter a code at openai.com" },
    { id: "github-copilot:oauth", provider: "github-copilot", method: "oauth", label: "GitHub Copilot · enter a code at github.com" },
  ];
  return provider ? ways.filter((way) => way.provider === provider) : ways;
}

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
  if ((options.provider !== undefined && !Object.hasOwn(providerNames, options.provider)) || process.env.CASPER_TUI_WRITE_LOG || process.env.PI_TUI_WRITE_LOG) {
    return { status: "failed", effect: "none", reason: "unavailable" };
  }
  let invoked = false;
  let provider = options.provider;
  try {
    // Refuse an unusable destination before the picker, naming the component to fix.
    const early = await privateFileProblem(destination, signal);
    if (early) return { status: "failed", effect: "none", reason: "destination", detail: early };
    return await options.terminalHost.run((io) => withLoginDisplay(io, signal, async (display): Promise<RuntimeAuthenticationResult> => {
      const saved = `Saved in ${tildePath(destination, home())}, only on this computer.`;
      display.setNote(saved);
      // One numbered list (provider and method together); a provider with one way skips it.
      const ways = signInWays(provider);
      const pickedId = ways.length === 1 ? ways[0]!.id
        : await display.choose(provider ? `Sign in to ${providerNames[provider]}` : "Sign in", ways);
      const way = ways.find((item) => item.id === pickedId);
      if (!way) return { status: "cancelled", effect: "none" };
      provider = way.provider;
      const selected = way.provider;
      const method = way.method;
      // Browser sign-in (loopback listener + authorization page) vs device-code oauth.
      const browser = method === "oauth" && (selected === "anthropic" || selected === "openrouter");
      // Picking the way is the consent (as in Claude Code and Codex); the next screen still says what it costs.
      const disclosure = selected === "github-copilot" ? "Signing in may turn on model policies on your GitHub account."
        : selected === "anthropic" ? "API use is billed per token; a Claude plan sign-in is billed per token as extra usage."
        : selected === "openrouter" ? "Usage is billed from your OpenRouter credits."
        : "";
      display.setNote([saved, disclosure].filter(Boolean).join("\n"));
      if (display.signal.aborted) return { status: "cancelled", effect: "none" };
      // The SDK reads this override when its lazy OAuth module loads. Never allow a public listener.
      if (browser && [process.env.CASPER_OAUTH_CALLBACK_HOST, process.env.PI_OAUTH_CALLBACK_HOST]
        .some(host => host && host !== "127.0.0.1")) {
        return { status: "failed", effect: "none", reason: "unavailable" };
      }
      // Re-check after the pick: the preflight above is not atomic.
      try {
        const problem = await privateFileProblem(destination, display.signal);
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
