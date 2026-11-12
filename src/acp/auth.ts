// Sign-in over ACP (decision 103): an app with no terminal signs Casper in, asks what is saved and signs out.
// `casper acp`'s router answers these itself, before any session exists, with the steps /login runs
// (src/runtime/pi-auth.ts): the same key check with the provider, the same login file only you can read.
//
// - `initialize` lists the ways to sign in as ACP `authMethods` (signInWays, without Claude Code's own program).
// - `authenticate { methodId }` runs one. A key comes in that request, in `_meta.casper.key`, from the app's hidden
//   field: it goes to the provider's check and the login file, and is never written to a reply, an update, stderr or
//   a log. A browser sign-in opens the browser here and tells the app the page; a code sign-in tells it the code
//   (`_casper/auth/update`). `_casper/auth/cancel` stops the one that is running.
// - `_casper/auth/status` names the saved sign-ins (provider and kind, never a value); `_casper/auth/logout` removes one.

import path from "node:path";
import { existsSync } from "node:fs";
import { CredentialSynchronizationError, ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { authenticatePi, signInKind, signInProviderName, signInWays, type SignInWay } from "../runtime/pi-auth";
import { launchBrowser, type LoginDisplay } from "../tui/login";
import { RpcFailure, RPC, type Json } from "./rpc";

/** The ways an app can run: every /login row but Claude Code plan, whose own program signs in through a terminal. */
const appWays = (): SignInWay[] => signInWays().filter((way) => way.method !== "claude_code");

/** `initialize`'s authMethods: one per way, named as /login names it. `_meta.casper.kind` tells the app what to show:
 * a hidden field (`api_key`), "finish in your browser" (`browser`), or a code to enter (`device_code`). */
export function authMethods(): Json[] {
  return appWays().map((way) => ({ id: way.id, name: way.label, _meta: { casper: { provider: way.provider, kind: signInKind(way) } } }));
}

/** A key as /login takes it: printable ASCII with no spaces, and no stored-setting expression (`!command`, `$NAME`). */
const KEY = /^[\x21-\x7e]{1,4096}$/;
const usableKey = (value: unknown): value is string => typeof value === "string" && KEY.test(value) && !value.startsWith("!") && !value.includes("$");

const loginFile = () => path.resolve(getAgentDir(), "auth.json");

/** Casper's login file read the way /login writes it: builtins only, no model catalog, no network. */
const credentials = (signal: AbortSignal) => ModelRuntime.create({ authPath: loginFile(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal });

/** What the sign-in steps met that the app has no screen for, kept as plain facts for the reply. */
interface Met { refused?: true; unverified?: string }

/** The sign-in's screens with no terminal: the key is the one the request brought, a page or a code goes to the app,
 * and a question the app was not asked ends the sign-in with nothing saved. */
function appDisplay(signal: AbortSignal, stop: () => void, key: string | undefined, tell: (step: Json) => void, met: Met): LoginDisplay {
  let keyGiven = false;
  const untilStopped = (ends: AbortSignal = signal) => new Promise<never>((_resolve, reject) => {
    const end = () => reject(new Error("the sign-in ended"));
    if (ends.aborted) end(); else ends.addEventListener("abort", end, { once: true });
  });
  return {
    signal,
    async choose(title, items) {
      // The key check could not reach the provider: /login offers to save unchecked; an app's key is not saved.
      if (items.some((item) => item.id === "save")) { met.unverified = /\(([^()]*(?:\([^()]*\))?[^()]*)\)\.$/.exec(title)?.[1] ?? "no answer"; return items.find((item) => item.id === "cancel")?.id; }
      return undefined;
    },
    setNote() {},
    wait() {},
    async privateInput(_label, asked) {
      // A browser sign-in also takes a pasted code; an app finishes in the browser, so this waits until the sign-in
      // stops asking (the browser finished it) or ends.
      if (key === undefined) return untilStopped(asked ? AbortSignal.any([asked, signal]) : signal);
      // Asked a second time: the provider refused the key. It is not sent again.
      if (keyGiven) { met.refused = true; stop(); return untilStopped(); }
      keyGiven = true;
      return key;
    },
    async textInput() { stop(); return untilStopped(); },
    device(url, code) { tell({ step: "device_code", url, code }); },
    browser(url, options) {
      const opened = !options?.openedByProvider && launchBrowser(url);
      tell({ step: "browser", url, opened: opened || options?.openedByProvider === true });
    },
  };
}

/** The router's sign-in requests. One sign-in runs at a time. `notify` writes to the app. */
export class AcpAuth {
  private running: AbortController | undefined;

  constructor(private readonly notify: (method: string, params: Json) => void, private readonly lifetime: AbortSignal) {}

  /** `authenticate`: resolves once the sign-in is saved. Anything else is an error in plain words, never a provider's. */
  async authenticate(params: Json): Promise<Json> {
    const way = appWays().find((item) => item.id === params.methodId);
    if (!way) throw new RpcFailure(RPC.invalidParams, "Unknown methodId: use one of initialize's authMethods");
    const meta = (params._meta as Json | undefined)?.casper as Json | undefined;
    const given = meta && typeof meta === "object" ? meta.key : undefined;
    const kind = signInKind(way);
    if (kind === "api_key" && given === undefined) throw new RpcFailure(RPC.invalidParams, `${way.id} needs the key in _meta.casper.key`);
    if (kind !== "api_key" && given !== undefined) throw new RpcFailure(RPC.invalidParams, `${way.id} takes no key`);
    if (kind === "api_key" && !usableKey(given)) throw new RpcFailure(RPC.invalidParams, "That is not a key Casper can save: printable characters only, with no spaces, and not starting with ! or holding $");
    if (this.running) throw new RpcFailure(RPC.invalidRequest, "A sign-in is already running; wait for it or send _casper/auth/cancel");
    const running = this.running = new AbortController();
    const name = signInProviderName(way.provider);
    const met: Met = {};
    try {
      const result = await authenticatePi({
        provider: way.provider, way: way.id, others: false, signal: running.signal,
        surface: (signal, work) => work(appDisplay(AbortSignal.any([signal, running.signal]), () => running.abort(), given as string | undefined,
          (step) => this.notify("_casper/auth/update", { methodId: way.id, ...step }), met)),
      }, loginFile(), this.lifetime);
      if (result.status === "saved" || result.status === "saved-needs-refresh") return { _meta: { casper: { provider: way.provider } } };
      const kept = "effect" in result && result.effect === "unknown" ? "Ask _casper/auth/status what was saved." : "Nothing was saved.";
      if (met.refused) throw new RpcFailure(RPC.authRequired, `${name} refused that key. ${kept}`);
      if (met.unverified) throw new RpcFailure(RPC.authRequired, `Casper couldn't check the key with ${name} (${met.unverified}). ${kept}`);
      if (result.status === "cancelled") throw new RpcFailure(RPC.authRequired, `The sign-in was stopped. ${kept}`);
      const why = result.detail ?? (result.reason === "destination" ? "Casper couldn't use its login file" : result.reason === "unavailable" ? "This sign-in can't run here" : `The sign-in to ${name} did not finish`);
      throw new RpcFailure(RPC.authRequired, `${why}. ${kept}`);
    } catch (error) {
      // Only Casper's own words go back: another error's text could hold what was typed.
      if (error instanceof RpcFailure) throw error;
      throw new RpcFailure(RPC.internal, "The sign-in failed inside Casper. Ask _casper/auth/status what was saved.");
    } finally {
      running.abort();
      this.running = undefined;
    }
  }

  /** `_casper/auth/cancel`: stops the sign-in that is running, if one is. */
  cancel(): void { this.running?.abort(); }

  /** `_casper/auth/status`: the saved sign-ins, by provider and kind. A missing login file stays missing. */
  async status(): Promise<Json> {
    if (!existsSync(loginFile())) return { signIns: [] };
    try {
      const saved = await (await credentials(this.lifetime)).listCredentials({ signal: this.lifetime });
      return { signIns: saved.map((credential) => ({ provider: credential.providerId, type: credential.type })) };
    } catch { throw new RpcFailure(RPC.internal, "Casper couldn't read its login file"); }
  }

  /** `_casper/auth/logout { provider }`: removes that provider's saved sign-in. `removed` is false when there was none. */
  async logout(params: Json): Promise<Json> {
    const provider = params.provider;
    if (typeof provider !== "string" || !provider) throw new RpcFailure(RPC.invalidParams, "logout needs a provider, as _casper/auth/status names it");
    if (this.running) throw new RpcFailure(RPC.invalidRequest, "A sign-in is running; wait for it or send _casper/auth/cancel");
    if (!existsSync(loginFile())) return { removed: false };
    let runtime: ModelRuntime;
    try {
      runtime = await credentials(this.lifetime);
      if (!(await runtime.listCredentials({ signal: this.lifetime })).some((credential) => credential.providerId === provider)) return { removed: false };
    } catch { throw new RpcFailure(RPC.internal, "Casper couldn't read its login file"); }
    try { await runtime.logout(provider, { signal: this.lifetime }); }
    catch (error) {
      // Removed, but that runtime's snapshot lagged. Never an SDK error's text: it can hold the credential.
      if (!(error instanceof CredentialSynchronizationError)) throw new RpcFailure(RPC.internal, "Casper couldn't remove that sign-in; the login file is unchanged");
    }
    return { removed: true };
  }
}
