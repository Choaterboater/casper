// One ACP session in its own process: `casper acp` starts one of these for each session/new or session/load, so two
// sessions never share a working folder, a shell sandbox or anything else that is one per process. It speaks ACP on
// its stdin and stdout to the router (src/acp/server.ts), which passes the client's messages on.
//
// A prompt runs as `casper --json "<prompt>"` runs it (trust, sandbox, checks and receipt), except that a person
// answers: the approval boxes a one-shot run must refuse are put to the client as session/request_permission (anything
// but a picked choice is No), and the terminal's defaults hold: the checklist for a code change, and the screenshot
// question once a session. A / command's output is its reply (src/acp/commands.ts lists the commands).

import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import type { CliOptions } from "../cli-args";
import type { CasperApp } from "../app";
import { receiptEvent, type CasperEvent } from "../app/json-events";
import { cancelCurrent } from "../app/command-loop";
import { networkLoginFile, ownSecretValues } from "../app/network-host";
import { ensureRuntime } from "../app/runtime-start";
import { transcriptsIn, withoutTranscripts } from "../app/request-words";
import { promptWords } from "../app/rewind";
import { taskExitCode } from "../task/result";
import { CASPER_VERSION } from "../version";
import type { AwayAsker } from "../tui/terminal";
import { readAcpMcpSetting, type AcpMcpSetting } from "../config/load";
import type { MCPServerDefinition } from "../mcp/config";
import type { RuntimeEvent } from "../runtime/types";
import { fileTextHoldsSecret, onlyNetconanChecks } from "../secrets/tool-output";
import { leadingImagePath, startsWithImageFile } from "../app/images";
import { clientServers } from "./client-servers";
import { acpCommands, acpRefusal } from "./commands";
import { AcpAsker } from "./permission";
import { promptContent } from "./prompt";
import { RpcConnection, RpcFailure, RPC, type Json } from "./rpc";
import { acpReceipt, commandsUpdate, hider, receiptUpdate, UpdateMapper, valuesHider } from "./updates";

/** ACP's protocol version this agent speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** The initialize reply, the same from the router and from each session. `acp_mcp: off` says no http server is taken
 * (stdio ones are ACP's baseline; Casper connects none of them either). */
export function initializeResult(setting: AcpMcpSetting = "on"): Json {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: setting !== "off", sse: false } },
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

/** The prompt's words as Casper runs them (src/acp/prompt.ts): a picture as `[image N]`, a file as its quoted path. */
export function promptText(blocks: unknown): string {
  return promptContent(blocks).text;
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
  createApp(input: { conversation: { continue: true } | { resume: string } | undefined; onEvent: (event: CasperEvent) => void;
    /** The runtime's own events: tool steps with their arguments, output and diffs (decision 79). */
    onRuntimeEvent: (event: RuntimeEvent) => void; output: { write(text: string): void };
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
  // A step shows a file's text only when it holds no secret by the rules a read of that file gets. Those rules take
  // netconan in too when it is installed, and it can't run on text shown at once, so then no device config is shown.
  let netconanInUse = false;
  // A step's relative path is resolved from where the runtime works (the git top level of a session opened in a
  // subfolder), so its locations and diffs name the file it really wrote.
  const mapper = new UpdateMapper(hide, { cwd: () => app?.projectContext ? app.activeWorkspaceRoot() : folder ?? process.cwd(), mcpTool: (name, args) => app?.broker?.named(name, args),
    holdsSecret: (file, text) => fileTextHoldsSecret(file, text, app ? { configs: app.scrubFiles, networkLoginFile: networkLoginFile(app) } : {}),
    unchecked: (file) => onlyNetconanChecks(file, { configs: app?.scrubFiles, netconan: netconanInUse }) });
  // A box is a step on the wire: the text so far, and a command's open block, end before it (and before its answer).
  const boxUpdate = (update: Json) => { for (const done of mapper.flush()) sendUpdate(done); sendUpdate(update); };
  // The / command a prompt runs (decision 80), until the model speaks in it: what the terminal shows for it then is its
  // output, Casper's reply.
  let commandRun: { spoke: boolean } | undefined;
  // Lines for the person (`[image] …`: a picture that was not sent; `[plan] …`: what /plan did) go to the client as
  // they are, never inside a command's block.
  const forPerson = (line: string) => line.startsWith("[image] ") || line.startsWith("[plan] ");
  // Whole lines from a stream, so a secret is hidden whole.
  const lineReader = (route: (line: string) => void) => {
    let pending = "";
    return {
      write(text: string) {
        pending += text;
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          const line = pending.slice(0, end + 1);
          pending = pending.slice(end + 1);
          route(line);
        }
      },
      /** A part line left over, routed as a line. */
      rest() { const rest = pending; pending = ""; if (rest) route(rest); },
    };
  };
  // What the terminal writes (Casper's transcript, its panels and lists) goes to stderr as it is written; during a
  // command, before its model speaks, it is the command's output too.
  const shown = lineReader((line) => {
    if (commandRun && !commandRun.spoke && !app?.modelTaskActive && !forPerson(line)) for (const update of mapper.commandText(line)) sendUpdate(update);
  });
  const output = { write: (text: string) => { process.stderr.write(withoutClientValues(text)); shown.write(text); } };
  // Casper's own lines (app.onOutput: never the model's words, which reach the client as events): the ones for the
  // person also go to the client.
  const own = lineReader((line) => { if (forPerson(line)) for (const update of mapper.note(line)) sendUpdate(update); });
  const ownLines = (text: string) => own.write(text);
  const routeRest = () => { own.rest(); shown.rest(); };
  // The commands the client lists, sent again only when they changed (your own command files are read each time).
  let offeredCommands = "";
  const sendCommands = () => {
    if (!app || !sessionId) return;
    const list = acpCommands(options.homeDir ?? os.homedir(), hide);
    const json = JSON.stringify(list);
    if (json === offeredCommands) return;
    offeredCommands = json;
    sendUpdate(commandsUpdate(list));
  };

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
        onEvent: (event) => {
          if (event.type === "assistant_delta" && commandRun) commandRun.spoke = true;
          for (const update of mapper.map(event)) sendUpdate(update);
        },
        onRuntimeEvent: (event) => {
          // A response starts before the terminal writes any of its words, so none of them reads as the command's.
          if (event.type === "assistant_response_start" && commandRun) commandRun.spoke = true;
          for (const update of mapper.runtime(event)) sendUpdate(update);
        } });
      // A call to the app's server names the step it is, as the client saw it start.
      created.acpToolCallId = (id) => mapper.acpId(id);
      created.onOutput = ownLines;
      learnSecrets();
      try {
        await created.start(folder);
        netconanInUse = (await created.scrubber.netconan().catch(() => undefined))?.state === "found";
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
    answerThroughClient(created, new AcpAsker(sessionId, { request: (permission, signal) => connection.request("session/request_permission", permission, signal), update: boxUpdate }, hide), output.write);
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
  // The commands follow the reply, which names the session (a load's, after the conversation it replays).
  connection.onRequest("session/new", (params) => open(params, false), sendCommands);
  connection.onRequest("session/load", (params) => open(params, true), sendCommands);
  connection.onRequest("session/prompt", async (params) => {
    if (!app || !sessionId || params.sessionId !== sessionId) throw new RpcFailure(RPC.notFound, "Unknown session");
    if (busy) throw new RpcFailure(RPC.invalidRequest, "This session is already working on a prompt; cancel it or wait");
    learnSecrets();
    let content: ReturnType<typeof promptContent>;
    try { content = promptContent(params.prompt); }
    catch (error) { throw error instanceof RpcFailure ? new RpcFailure(error.code, hide(error.message)) : error; }
    busy = true;
    cancelled = false;
    // A part line left from before this prompt (the start's transcript) ends here, not inside this prompt's first line.
    routeRest();
    let report: Awaited<ReturnType<CasperApp["runOnce"]>>;
    let failure: { error: unknown } | undefined;
    let isCommand = false;
    try {
      // A command as the terminal tells one (src/app/command-loop.ts): a leading "/" that is not a picture file's path.
      const line = content.text.trim();
      isCommand = line.startsWith("/") && !(leadingImagePath(line) !== undefined && await startsWithImageFile(line, { cwd: app.activeWorkspaceRoot() }));
      const refusal = isCommand ? acpRefusal(line) : undefined;
      if (refusal) {
        for (const update of mapper.note(refusal)) sendUpdate(update);
        return { stopReason: "end_turn", _meta: { casper: { refused: hide(refusal) } } };
      }
      // What was not sent (audio, a ninth picture, a HEIC photo) is said first, as the terminal says it.
      for (const note of content.notes) app.output.write(`[image] ${note}\n`);
      commandRun = isCommand ? { spoke: false } : undefined;
      // A command's line is not written back: its output is the reply.
      report = await app.runOnce(content.text, folder, askedWithout(params.prompt, content.text), { images: content.images, echo: !isCommand });
    } catch (error) {
      failure = { error };
    } finally {
      busy = false;
      routeRest();
      commandRun = undefined;
    }
    // A cancelled task ends with the stop itself; its receipt still follows. A command's error (an unknown name, words
    // it does not take) is its reply, as in the terminal; anything else is an error reply.
    let commandError: string | undefined;
    if (failure && !cancelled) {
      const message = hide(failure.error instanceof Error ? failure.error.message : String(failure.error));
      if (!isCommand) {
        for (const update of mapper.flush()) sendUpdate(update);
        throw new RpcFailure(RPC.internal, message);
      }
      commandError = message;
      for (const update of mapper.note(`[error] ${message}`)) sendUpdate(update);
    }
    const task = app.getCommandTaskResult();
    const exitCode = taskExitCode(report, task, { requireVerification: options.cli.requireVerification });
    learnSecrets();
    for (const update of mapper.flush()) sendUpdate(update);
    const receipt = acpReceipt(receiptEvent(report, task, exitCode, app.sandboxReceipt(), app.commandUsage()), task, hide);
    // A command that is not a task (/status) has no receipt to show.
    if (receipt.text.trim()) sendUpdate(receiptUpdate(receipt));
    // Before the reply: a command may have changed the list (a new file in ~/.casper/commands).
    sendCommands();
    const stopReason = cancelled || task?.execution === "cancelled" ? "cancelled" : task?.turnLimit ? "max_turn_requests" : "end_turn";
    return { stopReason, _meta: { casper: { receipt, ...(commandError !== undefined ? { error: commandError } : {}) } } };
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
