/** A notes server that honors PORT/HOST; the unsolved one has no POST /notes. `pidLog` (absolute) receives each started server's PID. */
export function notesServer(solved: boolean, pidLog?: string): string {
  return `${pidLog ? `require("node:fs").appendFileSync(${JSON.stringify(pidLog)}, process.pid + "\\n");\n` : ""}const notes = [];
Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), async fetch(request) {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return new Response("ok");
  if (pathname === "/notes" && request.method === "GET") return Response.json(notes);
  ${solved ? `if (pathname === "/notes" && request.method === "POST") { const note = { id: notes.length + 1, ...(await request.json()) }; notes.push(note); return Response.json(note, { status: 201 }); }` : ""}
  return new Response("not found", { status: 404 });
} });
console.log("listening");
`;
}

/** How a crashed service's exit reads. Windows has no signals: a kill there is TerminateProcess, which gives exit code 1. */
export const CRASH_EXIT: { code: number | null; signal: NodeJS.Signals | null } = process.platform === "win32" ? { code: 1, signal: null } : { code: null, signal: "SIGKILL" };

/** Kills a service's server the way a crash would. On Windows the service's pid is the cmd.exe that runs its command,
 * and killing that leaves the server running: kill the processes under it, and cmd.exe exits with their code. */
export async function crashService(pid: number): Promise<void> {
  if (process.platform !== "win32") { process.kill(pid, "SIGKILL"); return; }
  const { hostProcessPlatform } = await import("../../src/platform/processes");
  const all = [...(await hostProcessPlatform().list()).values()];
  const under = (parent: number): number[] => all.filter(entry => entry.parent === parent).flatMap(entry => [...under(entry.pid), entry.pid]);
  const children = under(pid);
  for (const child of children.length ? children : [pid]) process.kill(child, "SIGKILL");
}
