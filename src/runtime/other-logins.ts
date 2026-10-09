import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GITHUB_COPILOT_MODELS } from "@earendil-works/pi-ai/providers/github-copilot.models";
import { otherLoginPaths } from "../platform/project-paths";

/** Sign-ins other tools left on this computer (Claude Code, Codex CLI, GitHub CLI), offered at /login, never
 * taken silently. Finding one reads no secret: only that a file or a field is there. A key is read when you pick it.
 * An API key copies safely. A GitHub CLI token is never refreshed or rotated, so Casper exchanging it for Copilot
 * leaves gh signed in. Claude Code's and Codex's plan sign-ins are not shared: their refresh tokens change on use,
 * so one copy would sign the other tool out. For those Casper offers its own sign-in to the same account. */
export type OtherLoginUse = "api_key" | "github" | "own";
/** Under the found list when it offers a plan sign-in: why Casper signs in on its own instead of copying it. */
export const NOT_SHARED = "A plan sign-in is not copied: sharing it would sign the other tool out.";
export interface OtherLogin {
  id: string;
  tool: "Claude Code" | "Codex CLI" | "GitHub CLI";
  provider: "anthropic" | "openai" | "openai-codex" | "github-copilot";
  use: OtherLoginUse;
  label: string;
}

type Env = Record<string, string | undefined>;

export { otherLoginPaths };

/** A small JSON object file, or undefined (missing, too big, not JSON). Other tools' files are only parsed, never run. */
function readJson(file: string): Record<string, unknown> | undefined {
  try {
    if (statSync(file).size > 4 * 1024 * 1024) return undefined;
    const value: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** The sign-ins found for providers that have none yet (`signedIn`), in the order /login shows them. */
export function findOtherLogins(signedIn: ReadonlySet<string>, env: Env = process.env, platform: NodeJS.Platform = process.platform): OtherLogin[] {
  const where = otherLoginPaths(env, platform);
  const found: OtherLogin[] = [];
  if (!signedIn.has("anthropic")) {
    const config = readJson(where.claudeConfig);
    if (nonEmpty(config?.primaryApiKey)) {
      found.push({ id: "claude-code:key", tool: "Claude Code", provider: "anthropic", use: "api_key", label: "Claude Code · use its Anthropic API key" });
    } else if (existsSync(where.claudeCredentials) || (config?.oauthAccount && typeof config.oauthAccount === "object")) {
      found.push({ id: "claude-code:own", tool: "Claude Code", provider: "anthropic", use: "own",
        label: "Claude Code · sign in to the same Claude account here" });
    }
  }
  const codex = readJson(where.codexAuth);
  if (!signedIn.has("openai-codex") && codex?.tokens && typeof codex.tokens === "object") {
    found.push({ id: "codex:own", tool: "Codex CLI", provider: "openai-codex", use: "own",
      label: "Codex CLI · sign in to the same ChatGPT plan here" });
  }
  if (!signedIn.has("openai") && nonEmpty(codex?.OPENAI_API_KEY)) {
    found.push({ id: "codex:key", tool: "Codex CLI", provider: "openai", use: "api_key", label: "Codex CLI · use its OpenAI API key" });
  }
  if (!signedIn.has("github-copilot") && ghSignedIn(where.ghHosts)) {
    found.push({ id: "gh:copilot", tool: "GitHub CLI", provider: "github-copilot", use: "github", label: "GitHub CLI · use its sign-in for GitHub Copilot" });
  }
  return found;
}

/** gh lists each signed-in host as a top-level key in hosts.yml (the token itself may be in the system keyring). */
function ghSignedIn(file: string): boolean {
  try { return statSync(file).size < 1024 * 1024 && /^github\.com:\s*$/m.test(readFileSync(file, "utf8")); }
  catch { return false; }
}

/** The API key a found sign-in holds, read only now that you picked it. Undefined when it is gone. */
export function readOtherKey(login: OtherLogin, env: Env = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const where = otherLoginPaths(env, platform);
  const value = login.id === "claude-code:key" ? readJson(where.claudeConfig)?.primaryApiKey
    : login.id === "codex:key" ? readJson(where.codexAuth)?.OPENAI_API_KEY : undefined;
  return typeof value === "string" && /^[\x21-\x7e]{1,4096}$/.test(value.trim()) ? value.trim() : undefined;
}

/** Token kinds Copilot takes: gh's own sign-in (gho_), an app's (ghu_) and fine-grained tokens. A classic token (ghp_) it refuses. */
export function copilotTokenKind(token: string): "ok" | "classic" | "unknown" {
  if (/^(gho_|ghu_|github_pat_)[A-Za-z0-9_]{10,500}$/.test(token)) return "ok";
  return token.startsWith("ghp_") ? "classic" : "unknown";
}

/** `gh auth token` for github.com, with GH_TOKEN and GITHUB_TOKEN left out so it is gh's own saved sign-in. */
export async function ghToken(signal: AbortSignal, env: Env = process.env): Promise<string | undefined> {
  const { GH_TOKEN: _gh, GITHUB_TOKEN: _github, ...rest } = env;
  try {
    const child = Bun.spawn(["gh", "auth", "token", "--hostname", "github.com"], {
      env: rest as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "ignore", signal, timeout: 15_000 });
    const [text, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const token = text.trim();
    return exit === 0 && token && !/\s/.test(token) && token.length <= 512 ? token : undefined;
  } catch { return undefined; }
}

const COPILOT_HEADERS = { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" };

/** Shown beside the GitHub CLI row: what Pi's own Copilot sign-in says before it turns models on. */
export const COPILOT_POLICIES = "Using it may turn on model policies on your GitHub account.";

/** Pi's reading of Copilot's model list: usable models (picker on, not disabled; on the Individual plan, when no
 * model has the picker on, those with policy enabled) and models Pi knows whose policy is still "unconfigured". */
function copilotCatalog(raw: unknown, individual: boolean): { available: string[]; policy: string[] } {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { available: [], policy: [] };
  const models = data.flatMap((item: { id?: unknown; model_picker_enabled?: unknown; policy?: { state?: unknown }; capabilities?: { supports?: { tool_calls?: unknown } } } | null) =>
    item && typeof item.id === "string" && item.capabilities?.supports?.tool_calls !== false
      ? [{ id: item.id, picker: item.model_picker_enabled === true, state: item.policy?.state }] : []);
  const picker = models.filter((model) => model.picker && model.state !== "disabled").map((model) => model.id);
  const fallback = individual && picker.length === 0;
  return { available: fallback ? models.filter((model) => model.state === "enabled").map((model) => model.id) : picker,
    policy: models.filter((model) => model.state === "unconfigured" && Object.hasOwn(GITHUB_COPILOT_MODELS, model.id) && (model.picker || fallback)).map((model) => model.id) };
}

/** The same steps Pi's own Copilot sign-in takes after GitHub: exchange the GitHub token for a short Copilot token,
 * read the account's models, turn on the ones whose policy is unconfigured (stopping at a rate limit), and save the
 * usable list. The saved sign-in is the shape Pi refreshes itself: the GitHub token stays as it is, so gh stays
 * signed in. Failures are plain words, never provider text. */
export async function copilotFromGithub(github: string, signal: AbortSignal): Promise<
  { ok: true; credential: { type: "oauth"; refresh: string; access: string; expires: number; availableModelIds: string[] } } | { ok: false; detail: string }> {
  const within = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    const response = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: { Accept: "application/json", Authorization: `Bearer ${github}`, ...COPILOT_HEADERS }, signal: within() });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, detail: `GitHub didn't give GitHub CLI's sign-in Copilot access (HTTP ${response.status}); pick Sign in separately` };
    }
    const raw = await response.json() as { token?: unknown; expires_at?: unknown };
    if (typeof raw.token !== "string" || typeof raw.expires_at !== "number") return { ok: false, detail: "GitHub sent an answer Casper can't use" };
    const access = raw.token;
    // The token names its API host (proxy-ep=proxy.X); without one, the Individual plan's.
    const proxy = /proxy-ep=([^;]+)/.exec(access)?.[1];
    const api = proxy ? `https://${proxy.replace(/^proxy\./, "api.")}` : "https://api.individual.githubcopilot.com";
    const headers = { Authorization: `Bearer ${access}`, ...COPILOT_HEADERS };
    const list = await fetch(`${api}/models`, { headers: { Accept: "application/json", ...headers, "X-GitHub-Api-Version": "2026-06-01" }, signal: within() });
    if (!list.ok) {
      await list.body?.cancel();
      return { ok: false, detail: `Copilot didn't give its model list (HTTP ${list.status}); try again, or pick Sign in separately` };
    }
    const catalog = copilotCatalog(await list.json(), api === "https://api.individual.githubcopilot.com");
    const enabled: string[] = [];
    for (const id of catalog.policy) {
      let turnedOn: Response;
      try {
        turnedOn = await fetch(`${api}/models/${id}/policy`, { method: "POST", body: JSON.stringify({ state: "enabled" }), signal: within(),
          headers: { "Content-Type": "application/json", ...headers, "openai-intent": "chat-policy", "x-interaction-type": "chat-policy" } });
      } catch (error) { if (signal.aborted) throw error; continue; }
      await turnedOn.body?.cancel();
      if (turnedOn.status === 429) break;
      if (turnedOn.ok) enabled.push(id);
    }
    return { ok: true, credential: { type: "oauth", refresh: github, access, expires: raw.expires_at * 1000 - 5 * 60_000,
      availableModelIds: [...new Set([...catalog.available, ...enabled])] } };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, detail: "couldn't reach GitHub" };
  }
}

/** Write one provider's credential into Casper's login file the way Pi does: under Pi's lock folder (auth.json.lock),
 * in place (an existing file keeps its mode and ACL), new files 0600. Other providers are kept. A held lock is waited
 * for briefly, then a plain failure: never taken over. */
export async function saveCredential(file: string, provider: string, credential: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { writeFileSync(file, "{}", { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 40) throw new Error("another Casper is saving a sign-in; try again");
      await Bun.sleep(50);
    }
  }
  try {
    const text = readFileSync(file, "utf8").replace(/^﻿/, "");
    // A JSON error quotes the text it failed on, which can be a key: never let it through.
    let data: unknown;
    try { data = text.trim() ? JSON.parse(text) : {}; } catch { throw new Error("the login file is not valid JSON"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("the login file is not a JSON object");
    (data as Record<string, unknown>)[provider] = credential;
    writeFileSync(file, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  } finally { rmdirSync(lock); }
}
