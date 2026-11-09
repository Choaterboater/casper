// One ACP session in its own process: `casper acp` starts one of these for each session/new or session/load, so two
// sessions never share a working folder, a shell sandbox or anything else that is one per process. It speaks ACP on
// its stdin and stdout to the router (src/acp/server.ts), which passes the client's messages on.
//
// A prompt runs as `casper --json "<prompt>"` runs it (trust, sandbox, checks and receipt), except that a person
// answers: the approval boxes a one-shot run must refuse are put to the client as session/request_permission (anything
// but a picked choice is No), and the terminal's defaults hold: the checklist for a code change, and the screenshot
// question once a session. A / command's output is its reply (src/acp/commands.ts lists the commands). The app's
// model and effort picker shows Casper's own models (src/acp/config-options.ts), and its access chip sets Read only,
// Ask first or Don't ask (src/acp/modes.ts). An app that shows forms gets the AI's questions and Casper's typed ones as
// elicitation/create (src/acp/permission.ts, decision 83). /plan's Build box carries the plan, the build's checklist is
// the app's plan, and the `plan` option is /plan on (decision 84). A line the app sends during a prompt
// (`_casper/steer`) reaches the AI at its next step, as a line typed in the terminal does (decision 86). Each model
// response is followed by a usage_update, and Casper's lines for the person are notes (decision 88). A session/load
// goes on with the conversation's own model and effort (decision 89). `_casper/idle` tells the app whether it may close
// this process now, by kind only (decision 91). The conversation's name, the plain-words title its first request gives
// it with no model call, is the app's chat title (session_info_update, decision 96).

import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import type { CliOptions } from "../cli-args";
import type { CasperApp } from "../app";
import { receiptEvent, type CasperEvent } from "../app/json-events";
import { cancelCurrent } from "../app/command-loop";
import { displayLevel } from "../app/footer";
import { networkLoginFile, ownSecretValues } from "../app/network-host";
import { ensureRuntime } from "../app/runtime-start";
import { transcriptsIn, withoutPasted } from "../app/request-words";
import { promptWords } from "../app/rewind";
import { taskExitCode } from "../task/result";
import { CASPER_VERSION } from "../version";
import type { AwayAsker } from "../tui/terminal";
import { readAcpIdleExitSetting, readAcpMcpSetting, type AcpMcpSetting } from "../config/load";
import type { MCPServerDefinition } from "../mcp/config";
import { toolCallId } from "../runtime/tool-reason";
import type { RuntimeEvent, RuntimeStatus } from "../runtime/types";
import { fileTextHoldsSecret, onlyNetconanChecks } from "../secrets/tool-output";
import { attachImages, leadingImagePath, startsWithImageFile } from "../app/images";
import { terminalText } from "../tui/format";
import { forgetSteered, settleAppSteers, steerFromApp } from "../app/during-work";
import { clientServers } from "./client-servers";
import { acpCommands, acpRefusal } from "./commands";
import { offerOf, restoreSelection, setOption } from "./config-options";
import { accessModeOf, modeState, setAccessMode, withModeTold } from "./modes";
import { AcpAsker } from "./permission";
import { promptContent } from "./prompt";
import { RpcConnection, RpcFailure, RPC, type Json } from "./rpc";
import { acpReceipt, commandsUpdate, configUpdate, hider, titleShown, UpdateMapper, valuesHider } from "./updates";

/** ACP's protocol version this agent speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** The initialize reply, the same from the router and from each session. `acp_mcp: off` says no http server is taken
 * (stdio ones are ACP's baseline; Casper connects none of them either). `_meta.casper.steer`: `_casper/steer` takes a
 * line during a prompt (decision 86). `_meta.casper.title`: Casper sends the chat's title (decision 96). */
export function initializeResult(setting: AcpMcpSetting = "on"): Json {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: setting !== "off", sse: false },
      _meta: { casper: { steer: true, title: true } } },
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

/** The prompt without the agent transcripts pasted into its text blocks and without `context`, the embedded text that
 * is no file (another chat, an editor's buffer: src/acp/prompt.ts), or undefined when it has neither: what those say
 * ("fix", "add tests") is context, so the checklist rule reads only the rest, as for a typed line (decision 90). */
export function askedWithout(blocks: unknown, prompt: string, context: readonly string[] = []): string | undefined {
  const texts = Array.isArray(blocks) ? blocks.flatMap((block: Json) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []) : [];
  const pieces = [...transcriptsIn(texts), ...context];
  return pieces.length ? withoutPasted(prompt, pieces) : undefined;
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

/** What `_casper/idle` names as still running (decision 91): kinds only, in this order. The browser for page checks is
 * not one: it holds nothing that closing would lose. */
export const IDLE_KINDS = ["dev server", "command", "debugger", "helper", "checks"] as const;
export type IdleKind = typeof IDLE_KINDS[number];
export type IdleHost = Pick<CasperApp, "backgroundTasks"> & { backgroundCommands?: Pick<NonNullable<CasperApp["backgroundCommands"]>, "notifying">;
  subagents: Pick<CasperApp["subagents"], "isBusy"> };

/** The `_casper/idle` reply (decision 91): `idle` only with acp_idle_exit on (read again now, from your own file), no
 * prompt or model change under way and nothing running, a command's note still being written and a helper still
 * draining included. It never holds a name, a command's text, a path or a secret. */
export async function idleReply(app: IdleHost, state: { busy: boolean; changing: boolean }, homeDir: string): Promise<Json> {
  if (await readAcpIdleExitSetting(homeDir) === "off") return { idle: false, running: [], reason: "off" };
  if (state.busy || state.changing) return { idle: false, running: [], reason: "busy" };
  const kinds = new Set<string>(app.backgroundTasks().map((task) => task.kind));
  if ((app.backgroundCommands?.notifying() ?? 0) > 0) kinds.add("command");
  if (app.subagents.isBusy) kinds.add("helper");
  const running = IDLE_KINDS.filter((kind) => kinds.has(kind));
  return { idle: running.length === 0, running };
}

/** A line the app steered in during a prompt (decision 86), until the AI reads it: `text` as the app sent it, `sent`
 * as the AI reads it (its pictures as `[image N]`). */
interface AppSteer { text: string; sent: string; messageId: string; kind: "pending" | "steered" | "joined" }

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
  // A model or effort change the client asked for is being applied: no prompt starts meanwhile.
  let changing = false;
  let cancelled = false;
  // The client said at initialize that it shows forms (elicitation/create): the AI's questions may go to it.
  let formQuestions = false;
  // The app's lines taken during this prompt (decision 86), oldest first, until the AI reads each: "joined" ones go with
  // the first model turn's request, "steered" ones at the AI's next step; "pending" is still being handed over.
  let steers: AppSteer[] = [];
  // Steers are taken one at a time, in the order they arrived, and only for the prompt that was running then.
  let steerChain: Promise<unknown> = Promise.resolve();
  let promptGeneration = 0;
  let steerN = 0;
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
    unchecked: (file) => onlyNetconanChecks(file, { configs: app?.scrubFiles, netconan: netconanInUse }),
    // The words of a plan being written are thoughts: the Build box shows the plan (decision 84).
    planning: () => app?.events.holdingText === true,
    // The model's reasoning headline is a thought, under the status row's own switch and never at quiet (decision 87).
    headlines: () => app?.projectContext?.reasoningHeadline !== false && (!app || displayLevel(app) !== "quiet"),
    values: () => secrets,
    // The main runtime's usage after each of its responses (decision 88).
    usage: () => app?.session?.getUsage?.(), status: () => app?.session?.getStatus?.() });
  // A box is a step on the wire: the text so far, and a command's open block, end before it (and before its answer).
  const boxUpdate = (update: Json) => { for (const done of mapper.flush()) sendUpdate(done); sendUpdate(update); };
  /** The app's line, as the AI reads it: after the model's words so far, and before its next ones (a message of their
   * own). Its words are hidden like the rest. */
  const readNotice = (entry: AppSteer) => {
    const at = steers.indexOf(entry);
    if (at >= 0) steers.splice(at, 1);
    for (const done of mapper.flush()) sendUpdate(done);
    sendUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: hide(entry.text) }, messageId: entry.messageId, _meta: { casper: { steered: true } } });
    mapper.newMessage();
  };
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
  // Casper's notes for the person written while no prompt runs (decision 88), at most 20: the next prompt sends them
  // first.
  let held: string[] = [];
  const hold = (line: string) => { if (held.length < 20) held.push(line); };
  /** A note for the person (personNote): sent at once during a prompt, held until the next one otherwise. A command's
   * own output before its model speaks already carries it. */
  const personNote = (line: string) => {
    if (commandRun && !commandRun.spoke && !app?.modelTaskActive) return;
    if (busy) for (const update of mapper.note(line)) sendUpdate(update);
    else hold(line);
  };
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
  // The options and the access mode the client was last told (decisions 81 and 82): Casper says only what changed since.
  let lastOffer = "";
  let lastMode = "";
  const offerNow = () => offerOf(app?.session, hide, app);
  const configOptions = () => {
    const offer = offerNow();
    lastOffer = JSON.stringify(offer.wire);
    if (app) lastMode = accessModeOf(app);
    return offer.wire;
  };
  /** A change Casper made itself (a typed /model or /permissions, a failover, a model server found later, "Yes to
   * everything this session"), sent once. A change the client asked for is never sent back. */
  const announce = () => {
    if (!app || !sessionId) return;
    const mode = accessModeOf(app);
    if (mode !== lastMode) {
      lastMode = mode;
      sendUpdate({ sessionUpdate: "current_mode_update", currentModeId: mode });
    }
    const offer = offerNow();
    const json = JSON.stringify(offer.wire);
    if (json === lastOffer) return;
    lastOffer = json;
    sendUpdate(configUpdate(offer.wire));
  };
  // The conversation's name the app was last told (decision 96): a name is sent once, when it is new.
  let toldTitle: string | undefined;
  /** The conversation's name as the app's chat title, when it changed: the first request's plain-words title (no model
   * call), a typed /rename, or a loaded conversation's own. Hidden like every other word, also where the title cut or
   * trimmed a secret (titleShown). */
  const sendTitle = () => {
    if (!app || !sessionId) return;
    let name: string | undefined;
    try { name = app.session?.getSessionInfo?.().name; } catch { name = undefined; }
    if (!name || name === toldTitle) return;
    toldTitle = name;
    sendUpdate({ sessionUpdate: "session_info_update", title: titleShown(name, hide, secrets), updatedAt: new Date().toISOString() });
  };
  let asker: AcpAsker | undefined;
  /** The access the app picked (session/set_mode, or the `mode` option): it holds from the next tool call, also during
   * a prompt. A switch to Read only closes every open box as No. */
  const setMode = (value: unknown) => {
    if (!app) return;
    const before = setAccessMode(app, value, output.write);
    if (value === "read" && before !== "read") asker?.withdrawAll();
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
    for (const note of client.notes) {
      output.write(`${note}\n`);
      // A server the app asked for that Casper refused is said in the app too; one that connects only on stderr.
      if (note.includes(" is not connected: ")) hold(note);
    }
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
          // The AI reads a line the app steered in; one the prompt ended before reading is forgotten, with no notice.
          if (event.type === "steer_read") { const entry = steers.find((item) => item.kind !== "joined" && item.sent === event.text); if (entry) readNotice(entry); }
          if (event.type === "steer_unsent" && app) {
            forgetSteered(app, event.lines);
            for (const line of event.lines) { const at = steers.findIndex((item) => item.kind !== "joined" && item.sent === line); if (at >= 0) steers.splice(at, 1); }
          }
          for (const update of mapper.runtime(event)) sendUpdate(update);
        } });
      // A call to the app's server names the step it is, as the client saw it start.
      created.acpToolCallId = (id) => mapper.acpId(id);
      created.onOutput = ownLines;
      created.onPersonNote = personNote;
      // The first request names the conversation as its work starts: the app's chat gets the title at once.
      created.onConversationNamed = sendTitle;
      // The accepted plan's checklist is the app's plan; planning words that were no plan are a message (decision 84).
      created.onPlanSteps = (steps) => { for (const update of mapper.planSteps(steps)) sendUpdate(update); };
      created.onPlanWords = (words) => { for (const update of mapper.words(words)) sendUpdate(update); };
      // Lines the app sent before the model started go with its first request: each is read now.
      created.onLinesJoined = (lines) => {
        for (const line of lines) { const entry = steers.find((item) => item.kind !== "steered" && item.sent === line); if (entry) readNotice(entry); }
      };
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
      // The conversation's own model and effort, over the ones the app started Casper with, for this session only.
      if (load) await restoreSelection(created.session, created.resumedSelection, output.write);
    } catch (error) {
      // A session that did not open leaves nothing behind: its app closes (and the client's servers with it), so the
      // client's next session/new on this process starts clean.
      await created?.close().catch(() => {});
      app = undefined;
      sessionId = undefined;
      held = [];
      clientSecrets = [];
      secrets = [];
      throw error;
    }
    // Again now the session has started (its logins are read), so the options the reply carries are hidden with them.
    learnSecrets();
    asker = new AcpAsker(sessionId, { request: (permission, signal) => connection.request("session/request_permission", permission, signal), update: boxUpdate,
      elicit: (form, signal) => connection.request("elicitation/create", form, signal),
      // The AI's question is asked on the ask tool's step, as the client saw it start.
      stepFor: (question) => question.from === "ai" ? mapper.runningStep("ask") : undefined }, hide);
    asker.readOnly = () => app?.readOnlyAccess === true;
    // A box a running step raises names that step and repeats its diffs and file (decision 85).
    asker.stepOf = () => { const id = toolCallId(); return id === undefined ? undefined : mapper.step(id); };
    // acp_questions is read when the session opens: a change applies from the next one.
    created.remoteQuestions = formQuestions && created.projectContext?.acpQuestions !== "off";
    asker.questions = () => created.remoteQuestions;
    answerThroughClient(created, asker, output.write);
    // "Yes to everything this session", /permissions all or ask: the app's chip hears it at once, mid-prompt too.
    created.onAccessChange = announce;
    if (load) {
      // The conversation so far, as the person typed it.
      for (const entry of app.session?.conversationEntries?.() ?? []) {
        // Casper's own rounds (review, repair) are left out, and its notes around a request are taken off.
        const words = entry.prompt === undefined ? undefined : promptWords(entry.prompt);
        if (words) sendUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: hide(words) } });
      }
      return { configOptions: configOptions(), modes: modeState(created, hide) };
    }
    return { sessionId, configOptions: configOptions(), modes: modeState(created, hide) };
  };

  connection.onRequest("initialize", async (params) => {
    const capabilities = params.clientCapabilities as { elicitation?: { form?: unknown } } | undefined;
    formQuestions = Boolean(capabilities?.elicitation?.form);
    return initializeResult(await readAcpMcpSetting(options.homeDir ?? os.homedir()));
  });
  // The commands follow the reply, which names the session (a load's, after the conversation it replays), and then the
  // conversation's name, when it has one (a loaded or continued one).
  const afterOpen = () => { sendCommands(); sendTitle(); };
  connection.onRequest("session/new", (params) => open(params, false), afterOpen);
  connection.onRequest("session/load", (params) => open(params, true), afterOpen);
  connection.onRequest("session/prompt", async (params) => {
    if (!app || !sessionId || params.sessionId !== sessionId) throw new RpcFailure(RPC.notFound, "Unknown session");
    if (busy) throw new RpcFailure(RPC.invalidRequest, "This session is already working on a prompt; cancel it or wait");
    if (changing) throw new RpcFailure(RPC.invalidRequest, "Casper is changing its model or effort; send the prompt again when it is done");
    learnSecrets();
    let content: ReturnType<typeof promptContent>;
    try { content = promptContent(params.prompt); }
    catch (error) { throw error instanceof RpcFailure ? new RpcFailure(error.code, hide(error.message)) : error; }
    busy = true;
    cancelled = false;
    promptGeneration++;
    mapper.newPrompt();
    // A part line left from before this prompt (the start's transcript) ends here, not inside this prompt's first line.
    routeRest();
    // Notes written since the last prompt come first.
    for (const line of held.splice(0)) for (const update of mapper.note(line)) sendUpdate(update);
    let report: Awaited<ReturnType<CasperApp["runOnce"]>>;
    let failure: { error: unknown } | undefined;
    let isCommand = false;
    try {
      // A command as the terminal tells one (src/app/command-loop.ts): a leading "/" that is not a picture file's path.
      // It takes only the person's words: embedded context sent with it (another chat) is never its words (decision 90).
      const line = content.context.length ? withoutPasted(content.text, content.context) : content.text.trim();
      isCommand = line.startsWith("/") && !(leadingImagePath(line) !== undefined && await startsWithImageFile(line, { cwd: app.activeWorkspaceRoot() }));
      const refusal = isCommand ? acpRefusal(line) : undefined;
      if (refusal) {
        for (const update of mapper.note(refusal)) sendUpdate(update);
        return { stopReason: "end_turn", _meta: { casper: { refused: hide(refusal) } } };
      }
      // What was not sent (audio, a ninth picture, a HEIC photo) is said first, as the terminal says it.
      for (const note of content.notes) app.output.write(`[image] ${note}\n`);
      if (isCommand && content.context.length) {
        app.output.write(`[image] The text the app sent with ${terminalText(line.split(/\s/, 1)[0]!)} did not go with it: a / command takes only the words you typed. Send it without the / command for the AI to read it.\n`);
      }
      commandRun = isCommand ? { spoke: false } : undefined;
      // From here until the model's first turn, a line the app steers in joins this request (decision 86).
      if (!isCommand) {
        app.beforeFirstModelTurn = true;
        app.linesBeforeModel = [];
        app.steeredInTask = [];
      }
      // A command's line is not written back: its output is the reply.
      report = await app.runOnce(isCommand ? line : content.text, folder, askedWithout(params.prompt, content.text, content.context), { images: content.images, echo: !isCommand });
    } catch (error) {
      failure = { error };
    } finally {
      busy = false;
      routeRest();
      commandRun = undefined;
      // Lines the AI never read stay with the app: nothing typed during this prompt is kept for the next.
      settleAppSteers(app);
      steers = [];
    }
    // A cancelled task ends with the stop itself; its receipt still follows. A command's error (an unknown name, words
    // it does not take) is its reply, as in the terminal; anything else is an error reply.
    let commandError: string | undefined;
    if (failure && !cancelled) {
      const message = hide(failure.error instanceof Error ? failure.error.message : String(failure.error));
      if (!isCommand) {
        for (const update of mapper.flush()) sendUpdate(update);
        announce();
        throw new RpcFailure(RPC.internal, message);
      }
      commandError = message;
      for (const update of mapper.note(`[error] ${message}`)) sendUpdate(update);
    }
    const task = app.getCommandTaskResult();
    const exitCode = taskExitCode(report, task, { requireVerification: options.cli.requireVerification });
    learnSecrets();
    for (const update of mapper.flush()) sendUpdate(update);
    // A typed /model, a failover or a model server found since: the picker follows, before the receipt. So does a name
    // a typed /rename gave the conversation.
    announce();
    sendTitle();
    let status: RuntimeStatus | undefined;
    try { status = app.session?.getStatus?.(); } catch { status = undefined; }
    const receipt = acpReceipt(receiptEvent(report, task, exitCode, app.sandboxReceipt(), app.commandUsage()), task, hide, { status, root: app.activeWorkspaceRoot() });
    // A command that is not a task (/status) has no receipt to show.
    if (receipt.text.trim()) for (const update of mapper.receipt(receipt)) sendUpdate(update);
    // Before the reply: a command may have changed the list (a new file in ~/.casper/commands).
    sendCommands();
    const stopReason = cancelled || task?.execution === "cancelled" ? "cancelled" : task?.turnLimit ? "max_turn_requests" : "end_turn";
    return { stopReason, _meta: { casper: { receipt, ...(commandError !== undefined ? { error: commandError } : {}) } } };
  });
  // The app's model and effort picker (decision 81). Refused while a prompt runs: the runtime takes a change only
  // between prompts. The reply is the whole list after the change, so it is not sent again as an update.
  connection.onRequest("session/set_config_option", async (params) => {
    if (!app || !sessionId || params.sessionId !== sessionId) throw new RpcFailure(RPC.notFound, "Unknown session");
    // The access chip is taken during a prompt too: Read only must stop work that is already running. So is plan, which
    // applies from the next request, as a typed /plan on does.
    if (params.configId === "mode" || params.configId === "plan") {
      try {
        if (params.configId === "mode") setMode(params.value);
        else await setOption(app.session, offerNow(), "plan", params.value, output.write, app);
      } catch (error) { throw new RpcFailure(error instanceof RpcFailure ? error.code : RPC.internal, hide(error instanceof Error ? error.message : String(error))); }
      return { configOptions: configOptions() };
    }
    if (busy || changing) throw new RpcFailure(RPC.invalidRequest, "Casper is working on a prompt; change the model or effort when it ends");
    changing = true;
    try {
      learnSecrets();
      await setOption(app.session, offerNow(), params.configId, params.value, output.write);
    } catch (error) {
      // What the runtime changed before it failed (a model it took but could not save as the default) still reaches
      // the app before the refusal, so the app shows the model the next prompt goes to.
      try { announce(); } catch { /* the refusal still goes */ }
      throw new RpcFailure(error instanceof RpcFailure ? error.code : RPC.internal, hide(error instanceof Error ? error.message : String(error)));
    } finally { changing = false; }
    return { configOptions: configOptions() };
  });
  // The same access for a client that knows only session modes.
  connection.onRequest("session/set_mode", async (params) => {
    if (!app || !sessionId || params.sessionId !== sessionId) throw new RpcFailure(RPC.notFound, "Unknown session");
    try { setMode(params.modeId); }
    catch (error) { throw new RpcFailure(error instanceof RpcFailure ? error.code : RPC.internal, hide(error instanceof Error ? error.message : String(error))); }
    // What the client set is not sent back, as the mode or as the option; a model change it has not heard of still is.
    lastMode = accessModeOf(app);
    lastOffer = withModeTold(lastOffer, offerNow().wire);
    return {};
  });
  // A line the app sends while a prompt runs (decision 86): the same rules as a line typed during a task in the
  // terminal. Refused (steered: false) when no prompt runs or it is being stopped, while the model or effort changes,
  // during a / command, for a / line and once the prompt it came for has ended; the app then keeps it. Nothing is
  // queued here.
  connection.onRequest("_casper/steer", async (params) => {
    if (!app || !sessionId || params.sessionId !== sessionId) throw new RpcFailure(RPC.notFound, "Unknown session");
    const current = app;
    const generation = promptGeneration;
    const messageId = typeof params.messageId === "string" && params.messageId ? params.messageId : `casper-steer-${++steerN}`;
    const refused = { steered: false, messageId };
    if (!busy || cancelled || changing || commandRun) return refused;
    try {
      learnSecrets();
      const content = promptContent(params.prompt);
      const line = content.text.trim();
      if (line.startsWith("/") && !(leadingImagePath(line) !== undefined && await startsWithImageFile(line, { cwd: current.activeWorkspaceRoot() }))) return refused;
      const taking = steerChain.then(async () => {
        if (!busy || cancelled || generation !== promptGeneration || commandRun) return refused;
        // Its pictures, and picture files it names or links, go with it, as a prompt's do (a share path is not opened:
        // nothing can be asked during work).
        const attached = await attachImages(line, { cwd: current.activeWorkspaceRoot(), pasted: content.images, saveTo: current.pastedImageFiles })
          .catch(() => ({ text: line, images: [...content.images.values()], notes: [] }));
        if (!busy || cancelled || generation !== promptGeneration || commandRun) return refused;
        // Listed before the runtime has it, so a read that comes at once finds it.
        const entry: AppSteer = { text: line, sent: attached.text, messageId, kind: "pending" };
        steers.push(entry);
        const taken = await steerFromApp(current, attached.text, attached.images);
        if (taken === "not_taken") {
          const at = steers.indexOf(entry);
          if (at >= 0) steers.splice(at, 1);
          return refused;
        }
        entry.kind = taken;
        // What was not sent with it (audio, a ninth picture) is said, as for a prompt.
        for (const note of [...content.notes, ...attached.notes.map(terminalText)]) current.output.write(`[image] ${note}\n`);
        return { steered: true, messageId };
      });
      steerChain = taking.catch(() => {});
      return await taking;
    } catch (error) {
      throw new RpcFailure(error instanceof RpcFailure ? error.code : RPC.internal, hide(error instanceof Error ? error.message : String(error)));
    }
  });
  // Whether the app may close this process now (decision 91). Asked between prompts; a prompt or a model change under
  // way is busy.
  connection.onRequest("_casper/idle", async (params) => {
    if (!app || !sessionId || params.sessionId !== sessionId) throw new RpcFailure(RPC.notFound, "Unknown session");
    return await idleReply(app, { busy, changing }, options.homeDir ?? os.homedir());
  });
  connection.onNotification("session/cancel", (params) => {
    if (!app || params.sessionId !== sessionId || !busy) return;
    cancelled = true;
    // A stopped step never reads the app's lines: none gets a notice.
    steers = [];
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
