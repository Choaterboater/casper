import net from "node:net";

/**
 * The ssh side of the private ssh login: OpenSSH runs the program named in SSH_ASKPASS with the prompt as its only
 * argument and reads the answer from its output. That program is Casper itself; it starts here (before anything else
 * loads) when Casper's own variables are set, asks the Casper that started ssh over a local socket (a Unix socket, or a
 * named pipe on Windows), and prints the answer. Only built-in modules: this runs in a hurry, once per prompt.
 *
 * The answer goes to this program's output and nowhere else: not an argument, not an environment variable, not a file.
 */

/** Where Casper listens for this run (a socket path or a pipe name). Not a secret. */
export const ASKPASS_ENDPOINT_ENV = "CASPER_ASKPASS_ENDPOINT";
/** Proof that the caller is the ssh Casper started, not another program on the machine. */
export const ASKPASS_TOKEN_ENV = "CASPER_ASKPASS_TOKEN";

/** Casper was started by ssh as its askpass program (it is never set in a normal start). */
export function askpassRequested(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[ASKPASS_ENDPOINT_ENV] && env[ASKPASS_TOKEN_ENV]);
}

/** What ssh passed: the prompt, as one line. Windows batch launchers pass it quoted. */
export function promptFromArguments(args: readonly string[]): string {
  return args.join(" ").replace(/^"(.*)"$/s, "$1").slice(0, 2000);
}

export interface AskpassIO {
  out(text: string): Promise<void>;
  err(text: string): Promise<void>;
}

/** Ask the running Casper and print the answer. Returns the exit code: 0 with the answer printed, 1 with a plain line
 * on the error output (ssh then gives up on that login instead of asking again). */
export async function runAskpassHelper(args: readonly string[], env: NodeJS.ProcessEnv, io: AskpassIO): Promise<number> {
  const endpoint = env[ASKPASS_ENDPOINT_ENV]!;
  const token = env[ASKPASS_TOKEN_ENV]!;
  const prompt = promptFromArguments(args);
  const reply = await new Promise<{ secret?: string; refuse?: string }>((resolve) => {
    let buffer = "";
    let done = false;
    const finish = (value: { secret?: string; refuse?: string }) => { if (!done) { done = true; resolve(value); } };
    const socket = net.connect(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ token, prompt })}\n`));
    socket.on("data", (chunk: string) => { buffer += chunk; });
    socket.on("error", () => finish({ refuse: "Casper's password box is not available any more." }));
    socket.on("close", () => {
      try {
        const parsed = JSON.parse(buffer) as { secret?: unknown; refuse?: unknown };
        if (typeof parsed.secret === "string") finish({ secret: parsed.secret });
        else finish({ refuse: typeof parsed.refuse === "string" ? parsed.refuse : "Casper did not give a password." });
      } catch { finish({ refuse: "Casper did not give a password." }); }
    });
  });
  if (reply.secret !== undefined) { await io.out(`${reply.secret}\n`); return 0; }
  await io.err(`${reply.refuse ?? "Casper did not give a password."}\n`);
  return 1;
}

/** The real streams, flushed before the caller exits. */
export const processIO: AskpassIO = {
  out: (text) => new Promise((resolve) => { process.stdout.write(text, () => resolve()); }),
  err: (text) => new Promise((resolve) => { process.stderr.write(text, () => resolve()); }),
};
