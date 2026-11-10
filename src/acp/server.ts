// `casper acp`: an Agent Client Protocol agent on stdin and stdout (agentclientprotocol.com), so an app or an editor
// drives the real Casper. This process only routes: each session runs in a Casper process of its own
// (src/acp/session.ts), started for session/new or session/load, so sessions run side by side without sharing a
// folder or a sandbox. The client's messages go to the session they name; the session's updates, permission requests
// and forms (elicitation/create) come back as they are. Each session is told the client's capabilities. A line the app
// sends during a prompt (`_casper/steer`, decision 86) goes to its session as a prompt does, and so does its question
// whether it may close an idle Casper (`_casper/idle`, decision 91).

import path from "node:path";
import type { Subprocess } from "bun";
import { runningFromBinary } from "../update/mode";
import { RpcConnection, RpcFailure, RPC, type Json } from "./rpc";
import { readAcpMcpSetting } from "../config/load";
import { initializeResult, sessionFolder } from "./session";

/** Set only on the session processes this router starts (removed from their own environment at once). */
export const SESSION_ENV = "CASPER_ACP_SESSION";

interface SessionProcess {
  child: Subprocess<"pipe", "pipe", "pipe">;
  connection: RpcConnection;
  /** The session's command list and chat title, held until this router has written the reply that names the session. */
  held?: Json[];
}

/** The requests that name a session and go to its process as they are: a steer too (decision 86), and the idle check
 * (decision 91). */
export const SESSION_REQUESTS = ["session/prompt", "session/set_config_option", "session/set_mode", "_casper/steer", "_casper/idle"] as const;

/** The session `params` names; an unknown one is not found (-32002). */
export function sessionFor<T>(sessions: ReadonlyMap<string, T>, params: Json): T {
  const session = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
  if (!session) throw new RpcFailure(RPC.notFound, "Unknown session");
  return session;
}

/** The router's own arguments for each session process, without --cd: the session gets its folder from the client. */
export function sessionArgs(argv: readonly string[]): string[] {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--cd") { index++; continue; }
    if (arg.startsWith("--cd=")) continue;
    args.push(arg);
  }
  return args;
}

/** What a session sends right after its reply to session/new or session/load (decision 96). */
const AFTER_REPLY = new Set(["available_commands_update", "session_info_update"]);

/** How this Casper starts itself: the release program, or Bun with the checkout's cli.ts. */
function selfCommand(): string[] {
  return runningFromBinary(import.meta.path) ? [process.execPath] : [process.execPath, path.join(import.meta.dir, "..", "cli.ts")];
}

/** `argv`: this process's arguments (each session gets them, without --cd). `launchedFrom`: where the command was typed,
 * so a session reads --allow-write folders from the same place. */
export async function runAcpServer(argv: readonly string[], launchedFrom: string): Promise<void> {
  const client = new RpcConnection(Bun.stdin.stream(), (line) => { process.stdout.write(line); });
  const sessions = new Map<string, SessionProcess>();
  // Every session process until it has exited, a failed start's too: this one never exits before them, so a client
  // that saw it exit can remove the folders the sessions worked in (Windows refuses while a process is in one).
  const running = new Set<SessionProcess["child"]>();
  const args = sessionArgs(argv);
  // What the client said it can do (forms, decision 83), passed to each session as it starts.
  let clientCapabilities: Json | undefined;

  const start = async (method: "session/new" | "session/load", params: Json): Promise<Json> => {
    // Checked here too, so a wrong folder costs no process.
    const folder = await sessionFolder(params);
    if (method === "session/load" && typeof params.sessionId === "string" && sessions.has(params.sessionId)) {
      throw new RpcFailure(RPC.invalidRequest, `Session ${params.sessionId} is already open`);
    }
    const child = Bun.spawn([...selfCommand(), ...args], { cwd: launchedFrom, env: { ...process.env, [SESSION_ENV]: "1" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    running.add(child);
    void child.exited.then(() => { running.delete(child); });
    const connection = new RpcConnection(child.stdout, (line) => { child.stdin.write(line); child.stdin.flush(); });
    const session: SessionProcess = { child, connection, held: [] };
    // What the session says for a person (Casper's transcript) goes to this process's stderr, as --json's does.
    void (async () => { for await (const chunk of child.stderr) process.stderr.write(chunk); })().catch(() => {});
    connection.onNotification("session/update", (update) => {
      // The session sends its commands and its chat's title right after its own reply; the client gets them after this
      // router's.
      if (session.held && AFTER_REPLY.has((update.update as Json | undefined)?.sessionUpdate as string)) session.held.push(update);
      else client.notify("session/update", update);
    });
    connection.onRequest("session/request_permission", (request) => client.request("session/request_permission", request));
    connection.onRequest("elicitation/create", (request) => client.request("elicitation/create", request));
    try {
      await connection.request("initialize", { protocolVersion: initializeResult().protocolVersion, ...(clientCapabilities ? { clientCapabilities } : {}) });
      const result = await connection.request(method, { ...params, cwd: folder }) as Json;
      const id = method === "session/new" ? result.sessionId : params.sessionId;
      if (typeof id !== "string" || sessions.has(id)) throw new RpcFailure(RPC.internal, "The session did not start");
      sessions.set(id, session);
      void child.exited.then(() => { if (sessions.get(id) === session) sessions.delete(id); });
      return result;
    } catch (error) {
      child.stdin.end();
      setTimeout(() => child.kill(), 5_000).unref();
      throw error;
    }
  };
  const route = (params: Json): SessionProcess => sessionFor(sessions, params);

  // Once the reply is out, what the session held for after it goes too, and from then on as it comes. A start that
  // failed has no session: what it held is dropped with it.
  const release = (id: unknown) => {
    const session = typeof id === "string" ? sessions.get(id) : undefined;
    const held = session?.held;
    if (!session || !held) return;
    session.held = undefined;
    for (const update of held) client.notify("session/update", update);
  };

  client.onRequest("initialize", async (params) => {
    clientCapabilities = params.clientCapabilities && typeof params.clientCapabilities === "object" ? params.clientCapabilities as Json : undefined;
    return initializeResult(await readAcpMcpSetting());
  });
  client.onRequest("session/new", (params) => start("session/new", params), (result) => release((result as Json | null)?.sessionId));
  client.onRequest("session/load", (params) => start("session/load", params), (_result, params) => release(params.sessionId));
  for (const method of SESSION_REQUESTS) client.onRequest(method, async (params) => route(params).connection.request(method, params));
  client.onNotification("session/cancel", (params) => { try { route(params).connection.notify("session/cancel", params); } catch { /* an unknown session has nothing to stop */ } });

  // Ctrl+C, SIGTERM or the client gone: each session closes as Casper closes (its checks and services stop), then
  // this one exits. One that has not closed in 10 seconds is stopped, and this one waits until it has gone.
  const stopAll = async () => {
    for (const child of running) { try { child.stdin.end(); } catch { /* already gone */ } }
    const allExited = () => Promise.all([...running].map((child) => child.exited));
    await Promise.race([allExited(), Bun.sleep(10_000)]);
    for (const child of running) child.kill("SIGKILL");
    await Promise.race([allExited(), Bun.sleep(5_000)]);
  };
  let stopping = false;
  const stop = (code: number) => { if (stopping) return; stopping = true; void stopAll().finally(() => process.exit(code)); };
  process.on("SIGINT", () => stop(130));
  process.once("SIGTERM", () => stop(143));
  await client.closed;
  await stopAll();
}
