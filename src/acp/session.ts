// One ACP session in its own process: `casper acp` starts one of these for each session/new or session/load, so two
// sessions never share a working folder, a shell sandbox or anything else that is one per process. It speaks ACP on
// its stdin and stdout to the router (src/acp/server.ts), which passes the client's messages on.
//
// A prompt runs as `casper --json "<prompt>"` runs it (trust, sandbox, checks and receipt), except that a person
// answers: the approval boxes a one-shot run must refuse are put to the client as session/request_permission (anything
// but a picked choice is No), and the terminal's defaults hold: the checklist for a code change, and the screenshot
// question once a session.

import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import type { CliOptions } from "../cli-args";
import type { CasperApp } from "../app";
import { receiptEvent, type CasperEvent } from "../app/json-events";
import { cancelCurrent } from "../app/command-loop";
import { ownSecretValues } from "../app/network-host";
import { ensureRuntime } from "../app/runtime-start";
import { transcriptsIn, withoutTranscripts } from "../app/request-words";
import { promptWords } from "../app/rewind";
import { taskExitCode } from "../task/result";
import { CASPER_VERSION } from "../version";
import type { AwayAsker } from "../tui/terminal";
import { readAcpMcpSetting, type AcpMcpSetting } from "../config/load";
import type { MCPServerDefinition } from "../mcp/config";
import { clientServers } from "./client-servers";
import { AcpAsker } from "./permission";
import { RpcConnection, RpcFailure, RPC, type Json } from "./rpc";
import { acpReceipt, hider, receiptUpdate, UpdateMapper, valuesHider } from "./updates";

/** ACP's protocol version this agent speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** The initialize reply, the same from the router and from each session. `acp_mcp: off` says no http server is taken
 * (stdio ones are ACP's baseline; Casper connects none of them either). */
export function initializeResult(setting: AcpMcpSetting = "on"): Json {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: setting !== "off", sse: false } },
    agentInfo: { name: "casper", title: "Casper", version: CASPER_VERSION },
    authMethods: [],
  };
}

/** The folder a session works in: the client's (ACP sends an absolute path), resolved from --cd when it is relative. */
export async function sessionFolder(params: Json): Promise<string> {
  const given = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd : ".";
  const folder = path.resolve(process.cwd(), given);
  if (!(await stat(folder).then((entry) => entry.isDirectory(), () => false))) throw new RpcFailure(RPC.invalidParams, `Not a folder: ${given}`);
  return folder;
}

/** The prompt without the agent transcripts pasted into its text blocks, or undefined when it has none: what such a
 * paste says ("fix", "add tests") is context, so the checklist rule reads only the rest, as for a typed line. */
export function askedWithout(blocks: unknown, prompt: string): string | undefined {
  const texts = Array.isArray(blocks) ? blocks.flatMap((block: Json) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []) : [];
  return withoutTranscripts(prompt, transcriptsIn(texts));
}

/** The prompt's words: text blocks as they are, a linked or embedded file by its address (and text when it has some). */
export function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) throw new RpcFailure(RPC.invalidParams, "prompt must be a list of content blocks");
  const parts = blocks.map((block: Json) => {
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    if (block?.type === "resource_link" && typeof block.uri === "string") return block.uri;
    const resource = block?.resource as Json | undefined;
    if (block?.type === "resource" && typeof resource?.uri === "string") return typeof resource.text === "string" ? `${resource.uri}\n${resource.text}` : resource.uri;
    return "";
  }).filter(Boolean);
  const prompt = parts.join("\n").trim();
  if (!prompt) throw new RpcFailure(RPC.invalidParams, "The prompt has no text");
  return prompt;
}

/**
 * Casper's boxes go to the client from here on: the terminal hands every question to `asker`, as for a walk-away job.
 * A person answers them, so the session keeps the terminal's defaults: the checklist for a code change, and the
 * screenshot question (showPages: ask) once a session.
 */
export function answerThroughClient(app: CasperApp, asker: AwayAsker, write: (text: string) => void): void {
  app.remoteApprovals = true;
  app.terminal.leave({ isTTY: false, columns: 100, rows: 40, write }, asker);
}

export interface SessionOptions {
  cli: CliOptions;
  /** Builds the app (the CLI passes the one --json would build, with this session's events and output). */
  createApp(input: { conversation: { continue: true } | { resume: string } | undefined; onEvent: (event: CasperEvent) => void; output: { write(text: string): void };
    /** The client's MCP servers for this session (decision 77), added after the ones Casper's files define. */
    mcpServers: MCPServerDefinition[] }): Promise<CasperApp>;
  /** Your home folder (the client's stdio servers start there). Default: os.homedir(). */
  homeDir?: string;
}

/** Runs one session on stdin/stdout until stdin ends; then closes the app. */
export async function runAcpSession(options: SessionOptions): Promise<void> {
  const connection = new RpcConnection(Bun.stdin.stream(), (line) => { process.stdout.write(line); });
  // The values the client gave its MCP servers (a bearer token), longest first: never on stderr either.
  let clientSecrets: string[] = [];
  const withoutClientValues = valuesHider(() => clientSecrets);
  const output = { write: (text: string) => { process.stderr.write(withoutClientValues(text)); } };
  let app: CasperApp | undefined;
  let sessionId: string | undefined;
  let folder: string | undefined;
  let busy = false;
  let cancelled = false;
  const sendUpdate = (update: Json) => { if (sessionId) connection.notify("session/update", { sessionId, update }); };
  // The user's own secrets (logins, keys, secret-looking variables), read again at each prompt, and every value the
  // client gave its MCP servers: never in an update.
  let secrets: string[] = [];
  const learnSecrets = () => {
    try { if (app) secrets = [...ownSecretValues(app), ...clientSecrets].sort((a, b) => b.length - a.length); }
    catch { secrets = [...clientSecrets].sort((a, b) => b.length - a.length); }
  };
  const hide = hider(() => secrets);
  const mapper = new UpdateMapper(hide);

  const open = async (params: Json, load: boolean): Promise<Json> => {
    if (app) throw new RpcFailure(RPC.invalidRequest, "This Casper process already holds a session");
    folder = await sessionFolder(params);
    if (load && (typeof params.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(params.sessionId))) throw new RpcFailure(RPC.invalidParams, "session/load needs a sessionId");
    process.chdir(folder);
    // The client's MCP servers connect for this session only (decision 77); the notes name them, never a value.
    const home = options.homeDir ?? os.homedir();
    const client = clientServers(params.mcpServers, { home, setting: await readAcpMcpSetting(home) });
    clientSecrets = [...client.secrets].sort((a, b) => b.length - a.length);
    for (const note of client.notes) output.write(`${note}\n`);
    const conversation = load ? { resume: params.sessionId as string } : options.cli.resume ? { resume: options.cli.resume } : options.cli.continueConversation ? { continue: true as const } : undefined;
    let created: CasperApp | undefined;
    try {
      created = app = await options.createApp({ conversation, output, mcpServers: client.definitions,
        onEvent: (event) => { for (const update of mapper.map(event)) sendUpdate(update); } });
      // A call to the app's server names the step it is, as the client saw it start.
      created.acpToolCallId = (id) => mapper.acpId(id);
      learnSecrets();
      try {
        await created.start(folder);
        const runtime = await ensureRuntime(created);
        sessionId = runtime.getSessionInfo?.().sessionId;
      } catch (error) {
        throw new RpcFailure(load ? RPC.notFound : RPC.internal, hide(error instanceof Error ? error.message : String(error)));
      }
      if (!sessionId) throw new RpcFailure(RPC.internal, "This runtime keeps no conversations, so it has no session ID");
      if (load && sessionId !== params.sessionId) throw new RpcFailure(RPC.notFound, `No saved conversation ${params.sessionId as string} in ${folder}`);
    } catch (error) {
      // A session that did not open leaves nothing behind: its app closes (and the client's servers with it), so the
      // client's next session/new on this process starts clean.
      await created?.close().catch(() => {});
      app = undefined;
      sessionId = undefined;
      clientSecrets = [];
      secrets = [];
      throw error;
    }
    answerThroughClient(created, new AcpAsker(sessionId, { request: (permission, signal) => connection.request("session/request_permission", permission, signal), update: sendUpdate }, hide), output.write);
    if (load) {
      // The conversation so far, as the person typed it.
      for (const entry of app.session?.conversationEntries?.() ?? []) {
        // Casper's own rounds (review, repair) are left out, and its notes around a request are taken off.
        const words = entry.prompt === undefined ? undefined : promptWords(entry.prompt);
        if (words) sendUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: hide(words) } });
      }
      return {};
    }
    return { sessionId };
  };

  connection.onRequest("initialize", async () => initializeResult(await readAcpMcpSetting(options.homeDir ?? os.homedir())));
  connection.onRequest("session/new", (params) => open(params, false));
  connection.onRequest("session/load", (params) => open(params, true));
  connection.onRequest("session/prompt", async (params) => {
    if (!app || !sessionId || params.sessionId !== sessionId) throw new RpcFailure(RPC.notFound, "Unknown session");
    if (busy) throw new RpcFailure(RPC.invalidRequest, "This session is already working on a prompt; cancel it or wait");
    const prompt = promptText(params.prompt);
    busy = true;
    cancelled = false;
    learnSecrets();
    let report: Awaited<ReturnType<CasperApp["runOnce"]>>;
    try {
      report = await app.runOnce(prompt, folder, askedWithout(params.prompt, prompt));
    } catch (error) {
      // A cancelled task ends with the stop itself; its receipt still follows. Anything else is an error reply.
      if (!cancelled) {
        for (const update of mapper.flush()) sendUpdate(update);
        throw new RpcFailure(RPC.internal, hide(error instanceof Error ? error.message : String(error)));
      }
    } finally { busy = false; }
    const task = app.getCommandTaskResult();
    const exitCode = taskExitCode(report, task, { requireVerification: options.cli.requireVerification });
    learnSecrets();
    for (const update of mapper.flush()) sendUpdate(update);
    const receipt = acpReceipt(receiptEvent(report, task, exitCode, app.sandboxReceipt(), app.commandUsage()), task, hide);
    sendUpdate(receiptUpdate(receipt));
    const stopReason = cancelled || task?.execution === "cancelled" ? "cancelled" : task?.turnLimit ? "max_turn_requests" : "end_turn";
    return { stopReason, _meta: { casper: { receipt } } };
  });
  connection.onNotification("session/cancel", (params) => {
    if (!app || params.sessionId !== sessionId || !busy) return;
    cancelled = true;
    // The same stop as Ctrl+C in a session: the model and the checks stop, and the changes made so far stay.
    cancelCurrent(app);
  });

  const close = async () => { await app?.close().catch(() => {}); };
  const stop = (code: number) => { const deadline = setTimeout(() => process.exit(code), 5_000); void close().finally(() => { clearTimeout(deadline); process.exit(code); }); };
  process.once("SIGTERM", () => stop(143));
  process.on("SIGINT", () => stop(130));
  await connection.closed;
  await close();
}
