import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { runningFromBinary } from "../update/mode";
import { ASKPASS_ENDPOINT_ENV, ASKPASS_TOKEN_ENV } from "./askpass-helper";

/**
 * The Casper side of the private ssh login. For one ssh command you allowed, Casper listens on a local socket that only
 * it knows the name of (a Unix socket in a private folder, a named pipe on Windows) and points OpenSSH's SSH_ASKPASS at
 * itself. When ssh needs a password it runs that program, which asks here; the answer goes back the same way and is
 * printed for ssh alone. The password is never in a command, an argument, an environment variable or a file.
 */

export interface AskpassReply { secret?: string; refuse?: string }
/** Called once per prompt ssh makes. `signal` aborts when ssh gave up waiting (the box then closes). */
export type AskpassHandler = (prompt: string, signal: AbortSignal) => Promise<AskpassReply>;

export interface AskpassRun {
  /** Added to the one ssh command's environment (and no other command's). */
  env: Record<string, string>;
  /** Stop listening and remove the private folder. */
  close(): Promise<void>;
  /** Where it listens (tests read this; the AI never has it). */
  endpoint: string;
  /** The private folder, when there is one. */
  dir?: string;
}

export interface AskpassOptions {
  /** The user's home; the private folder is ~/.casper/run (on the private-places list). */
  home: string;
  /** The program ssh runs as its askpass; unset: Casper itself. */
  program?: string;
  platform?: NodeJS.Platform;
  /** A connection that has not sent its whole request line after this long is dropped (default 5 s). */
  idleMs?: number;
  /** The most prompts one command may ask about (default 8): ssh asks a handful at most. */
  maxRequests?: number;
}

const SOCKET_LIMIT = 100;
const MAX_REQUEST = 16 * 1024;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Casper as a program ssh can start with the prompt as its argument. A release binary is itself (on Windows too: no
 * batch file, so a prompt from a hostile server never goes through cmd). From a source checkout on macOS and Linux a
 * two-line launcher in the private folder starts it, away from the project's own bunfig.toml and .env. From a source
 * checkout on Windows there is none: undefined, and ssh is not given the box (the installed Casper has it). */
async function askpassProgram(dir: string, platform: NodeJS.Platform): Promise<string | undefined> {
  if (runningFromBinary(import.meta.path)) return process.execPath;
  if (platform === "win32") return undefined;
  const entry = path.join(import.meta.dir, "..", "cli.ts");
  const launcher = path.join(dir, "askpass.sh");
  await writeFile(launcher, `#!/bin/sh\ncd ${shellQuote(dir)} || exit 1\nexec ${shellQuote(process.execPath)} --no-env-file --config=/dev/null ${shellQuote(entry)} "$@"\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  return launcher;
}

/** Start listening for one ssh command. Returns undefined when the private folder or socket can't be made (ssh then runs as it did). */
export async function startAskpass(handler: AskpassHandler, options: AskpassOptions): Promise<AskpassRun | undefined> {
  const platform = options.platform ?? process.platform;
  const token = randomBytes(24).toString("hex");
  let dir: string | undefined;
  let server: net.Server | undefined;
  try {
    const base = path.join(options.home, ".casper", "run");
    await mkdir(base, { recursive: true, mode: 0o700 });
    dir = await mkdtemp(path.join(base, "ask-"));
    await chmod(dir, 0o700);
    // A Unix socket's path is limited (about 104 characters). A long home folder gets no box: the temp folder is not
    // one of Casper's private places, so it is not used instead.
    if (platform !== "win32" && path.join(dir, "s").length > SOCKET_LIMIT) throw new Error("socket path too long");
    const endpoint = platform === "win32" ? `\\\\.\\pipe\\casper-askpass-${randomBytes(16).toString("hex")}` : path.join(dir, "s");
    const program = options.program ?? await askpassProgram(dir, platform);
    if (!program) throw new Error("no program for ssh to run");
    const sockets = new Set<net.Socket>();
    const wanted = Buffer.from(token);
    const idleMs = options.idleMs ?? 5000;
    const mostRequests = options.maxRequests ?? 8;
    // The token is good only while this ssh command runs, for a few prompts, one at a time.
    let closed = false;
    let requests = 0;
    let busy = false;
    server = net.createServer((socket) => {
      sockets.add(socket);
      const gone = new AbortController();
      // A connection that never says who it is does not get to hold a socket open.
      const idle = setTimeout(() => socket.destroy(), idleMs);
      socket.on("close", () => { clearTimeout(idle); sockets.delete(socket); gone.abort(); });
      socket.on("error", () => {});
      socket.setEncoding("utf8");
      let buffer = "";
      let handled = false;
      socket.on("data", (chunk: string) => {
        try {
          if (handled) return;
          buffer += chunk;
          if (buffer.length > MAX_REQUEST) { handled = true; socket.destroy(); return; }
          const end = buffer.indexOf("\n");
          if (end < 0) return;
          handled = true;
          clearTimeout(idle);
          let request: unknown;
          try { request = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; }
          // Anything but {"token": text, "prompt": text} is dropped without a word.
          if (!request || typeof request !== "object" || Array.isArray(request)) { socket.destroy(); return; }
          const { token: given, prompt } = request as { token?: unknown; prompt?: unknown };
          if (typeof given !== "string" || typeof prompt !== "string") { socket.destroy(); return; }
          const sent = Buffer.from(given);
          if (closed || sent.length !== wanted.length || !timingSafeEqual(sent, wanted)) { socket.destroy(); return; }
          if (busy || ++requests > mostRequests) { socket.end(`${JSON.stringify({ refuse: "Casper's password box is busy or has been asked too often for this command." })}\n`); return; }
          busy = true;
          handler(prompt, gone.signal).then(
            (reply) => { busy = false; if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`); },
            () => { busy = false; if (!socket.destroyed) socket.end(`${JSON.stringify({ refuse: "Casper could not ask for the password." })}\n`); });
        } catch { socket.destroy(); }
      });
    });
    server.on("error", () => {});
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(endpoint, () => resolve()); });
    if (platform !== "win32") await chmod(endpoint, 0o600).catch(() => {});
    const folder = dir;
    const listening = server;
    return {
      endpoint, dir: folder,
      env: {
        SSH_ASKPASS: program,
        // OpenSSH 8.4+ uses the program even with a terminal; older ones need a display set and no terminal.
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || "casper:0",
        [ASKPASS_ENDPOINT_ENV]: endpoint,
        [ASKPASS_TOKEN_ENV]: token,
      },
      async close() {
        closed = true;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => { listening.close(() => resolve()); });
        await rm(folder, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch {
    server?.close();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    return undefined;
  }
}
