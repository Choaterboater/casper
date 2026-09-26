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
