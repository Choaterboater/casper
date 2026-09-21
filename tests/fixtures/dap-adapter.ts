import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "normal";
writeFileSync("adapter-started", String(process.pid));
let sequence = 0;
let launch: { seq: number; command: string } | undefined;
let child: ReturnType<typeof spawn> | undefined;
let pending = Buffer.alloc(0);
function send(message: Record<string, unknown>) {
  const json = JSON.stringify({ seq: ++sequence, ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
function event(event: string, body = {}) { send({ type: "event", event, body }); }
function response(request: { seq: number; command: string }, body = {}, success = true) {
  send({ type: "response", request_seq: request.seq, command: request.command, success, body, ...(!success ? { message: "PRIVATE_ADAPTER_DIAGNOSTIC\x1b]0;BAD\x07" } : {}) });
}
function stopped() { event("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true }); }
function receive(request: { type: string; seq: number; command: string; arguments?: Record<string, unknown>; success?: boolean }) {
  if (request.type === "response") { writeFileSync("reverse-response", JSON.stringify(request)); return; }
  appendFileSync("requests.jsonl", JSON.stringify({ command: request.command, arguments: request.arguments }) + "\n");
  if (mode === "hang" && request.command === "initialize") return;
  if (mode === "malformed") { process.stdout.write("Content-Length: 999999999\r\n\r\n"); return; }
  if (request.command === "initialize") { response(request, { supportsConfigurationDoneRequest: mode !== "unsupported", supportTerminateDebuggee: true }); return; }
  if (request.command === "launch") {
    launch = request;
    child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    writeFileSync("debuggee-pid", String(child.pid));
    event("process", { systemProcessId: child.pid, isLocalProcess: true, startMethod: "launch" });
    // A hostile adapter-reported PID must never be used as kill authority.
    event("process", { systemProcessId: Number(process.argv[3] ?? 1), isLocalProcess: true, startMethod: "launch" });
    if (mode !== "hang-launch") event("initialized");
    return;
  }
  if (request.command === "setBreakpoints") { response(request, { breakpoints: (request.arguments?.breakpoints as Array<{ line: number }>).map(item => ({ ...item, verified: true })) }); return; }
  if (request.command === "configurationDone") {
    response(request); response(launch!); stopped();
    if (mode === "reverse") send({ type: "request", command: "runInTerminal", arguments: { args: ["touch", "UNAUTHORIZED"] } });
    return;
  }
  if (request.command === "threads") { response(request, { threads: [{ id: 1, name: "Main" }] }); return; }
  if (request.command === "stackTrace") {
    if (mode === "error") { response(request, {}, false); return; }
    response(request, { stackFrames: [{ id: 10, name: "fixture", line: 2, column: 1, source: { path: "program.py" } }] }); return;
  }
  if (request.command === "scopes") { response(request, { scopes: [{ name: "Locals", variablesReference: 20, expensive: false }] }); return; }
  if (request.command === "variables") {
    if (mode === "late") { event("continued", { threadId: 1 }); setTimeout(() => { stopped(); response(request, { variables: [{ name: "stale", value: "OLD", variablesReference: 0 }] }); }, 10); return; }
    const variables = mode === "large" ? Array.from({ length: 1000 }, () => ({ name: "\x1b\x9b".repeat(1000), value: "\x1b\x9b".repeat(10000), variablesReference: 0 })) : [{ name: "answer", value: "42", type: "int", variablesReference: 0 }];
    // Keep protocol frame under 1 MiB while making escaped display substantially larger.
    response(request, { variables: mode === "large" ? variables.slice(0, 5).map(item => ({ ...item, value: item.value.slice(0, 10000) })) : variables }); return;
  }
  if (request.command === "continue") { response(request, { allThreadsContinued: true }); setTimeout(stopped, 10); return; }
  if (request.command === "disconnect") {
    // Intentionally don't terminate the detached debuggee: host cleanup must own it.
    if (mode === "ignore-disconnect") return;
    response(request); event("terminated"); setTimeout(() => process.exit(0), 10); return;
  }
  response(request, {}, false);
}
process.stdin.on("data", chunk => {
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const header = pending.indexOf("\r\n\r\n"); if (header === -1) return;
    const size = Number(pending.subarray(0, header).toString().split(":")[1]);
    if (pending.length < header + 4 + size) return;
    const body = pending.subarray(header + 4, header + 4 + size); pending = pending.subarray(header + 4 + size);
    receive(JSON.parse(body.toString()));
  }
});
