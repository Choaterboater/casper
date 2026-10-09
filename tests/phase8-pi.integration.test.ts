import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeEvent } from "../src/runtime/types";
import { PI_TOOL_RULES } from "../src/runtime/pi";
import { needsSymlinks, posixOnly } from "./support/platform";
import { cleanUpAfterEach, answer, calls, fixture, snapshot, untrustedProjectPi, cli, adapter } from "./support/phase8-pi";

cleanUpAfterEach();

test("OpenRouter traffic carries Casper's app attribution while other providers stay unattributed", async () => {
  const f = await fixture(() => answer("ATTRIBUTION_FIXTURE"));
  const unattributed = await f.run([cli, "Answer without tools"]);
  expect({ exit: unattributed.exit, stderr: unattributed.stderr }).toEqual({ exit: 0, stderr: "" });
  // The banner names the saved model; the first request adds no [model] line that would only repeat it.
  expect(unattributed.stdout).toContain(" model     fixture/fixture (starts on your first request");
  expect(unattributed.stdout).not.toContain("[model]");
  expect(f.headers).toHaveLength(1);
  expect([f.headers[0]!.get("http-referer"), f.headers[0]!.get("x-openrouter-title")]).toEqual([null, null]);

  // The same local endpoint under OpenRouter's provider id; the id is what the runtime classifies by.
  const models = path.join(f.agent, "models.json");
  const configured = JSON.parse(await readFile(models, "utf8"));
  configured.providers.openrouter = configured.providers.fixture;
  delete configured.providers.fixture;
  await writeFile(models, JSON.stringify(configured));
  const routing = { defaultProvider: "openrouter", defaultModel: "fixture" };
  await writeFile(path.join(f.agent, "settings.json"), JSON.stringify({ ...routing, retry: { enabled: false } }));
  await writeFile(path.join(path.dirname(path.dirname(f.agent)), ".casper/settings.json"), JSON.stringify(routing));

  const attributed = await f.run([cli, "Answer without tools"]);
  expect({ exit: attributed.exit, stderr: attributed.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(attributed.stdout).toContain(" model     openrouter/fixture (starts on your first request");
  expect(f.headers).toHaveLength(2);
  const sent = f.headers[1]!;
  expect([sent.get("http-referer"), sent.get("x-openrouter-title"), sent.get("x-openrouter-categories"), sent.get("x-openrouter-app-visibility")])
    .toEqual(["https://choaterboater.github.io/casper/", "Casper", "cli-agent", "hidden"]);

  // CASPER_TELEMETRY=0 (Pi's PI_TELEMETRY=0, mirrored) sends no attribution at all: neither
  // Casper's nor the runtime's own "pi" default, which an inherited PI_TELEMETRY cannot re-enable.
  const quiet = await f.run([cli, "Answer without tools"], { CASPER_TELEMETRY: "0", PI_TELEMETRY: "1" });
  expect({ exit: quiet.exit, stderr: quiet.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(f.headers).toHaveLength(3);
  const none = f.headers[2]!;
  expect([none.get("http-referer"), none.get("x-openrouter-title"), none.get("x-openrouter-categories"), none.get("x-openrouter-app-visibility")])
    .toEqual([null, null, null, null]);
}, 60_000);

test("real /delegate reads evidence but cannot write, shell, recurse, or load ambient extensions/settings", async () => {
  let step = 0;
  const f = await fixture(() => {
    switch (step++) {
      case 0: return calls([{ name: "read", args: { path: "fixture.txt" } }]);
      case 1: return calls([
        { name: "write", args: { path: "PWNED", content: "no" } },
        { name: "bash", args: { command: "touch SHELL_EXECUTED" } },
        { name: "delegate", args: { role: "explorer", goal: "recurse" } },
      ]);
      default: return answer("Evidence at fixture.txt:1 is LOCAL_EVIDENCE_8. Unauthorized tools unavailable.");
    }
  }, true);
  const before = await snapshot(f.project);
  const result = await f.run([cli, "/delegate", "explorer", "Inspect fixture.txt"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("explorer · completed");
  expect(result.stdout).toContain("LOCAL_EVIDENCE_8");
  expect(f.payloads).toHaveLength(3);
  for (const payload of f.payloads) {
    expect(payload.tools.map((tool) => tool.function.name).sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(JSON.stringify(payload)).not.toContain("AMBIENT_");
    expect(JSON.stringify(payload)).not.toContain("OVERRIDE");
  }
  expect(JSON.stringify(f.payloads[1]?.messages)).toContain("LOCAL_EVIDENCE_8");
  expect(JSON.stringify(f.payloads[2]?.messages)).toContain("not found");
  expect(await snapshot(f.project)).toEqual(before);
  const sessions = await readdir(path.join(f.agent, "sessions"), { recursive: true }).catch(() => []);
  expect(sessions.filter((file) => file.endsWith(".jsonl"))).toHaveLength(0);
}, 60_000);


test("a parent session never executes project .pi extensions or injects project system prompts", async () => {
  const f = await fixture(() => answer("PARENT_UNTRUSTED_PROJECT"));
  const marker = await untrustedProjectPi(f.project);
  const result = await f.run([cli, "Answer without tools"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("PARENT_UNTRUSTED_PROJECT");
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(f.payloads).toHaveLength(1);
  expect(JSON.stringify(f.payloads[0])).not.toContain("PROJECT_");
  expect(JSON.stringify(f.payloads[0])).toContain("You are Casper");

  // Startup alone used to execute the extension: no model configured, --no-verify, and /model.
  await rm(path.join(path.dirname(path.dirname(f.agent)), ".casper/settings.json"));
  await writeFile(path.join(f.agent, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  for (const args of [["say hi"], ["--no-verify", "hi"], ["/model"]]) {
    await f.run([cli, ...args]);
    expect({ args, executed: await Bun.file(marker).exists() }).toEqual({ args, executed: false });
  }
  expect(f.payloads).toHaveLength(1);
}, 60_000);

needsSymlinks("a project context file that links outside the project is never sent to the provider", async () => {
  const f = await fixture(() => answer("CONTEXT_FILE_GUARD"));
  const secret = path.join(path.dirname(f.project), "secret.txt");
  await writeFile(secret, "OUTSIDE_SECRET_MUST_NOT_APPEAR");
  await symlink(secret, path.join(f.project, "AGENTS.md"));
  const escaped = await f.run([cli, "Answer without tools"]);
  expect({ exit: escaped.exit, stderr: escaped.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.stringify(f.payloads[0])).not.toContain("OUTSIDE_SECRET");

  // A link that stays inside the repository is still ordinary project context.
  await rm(path.join(f.project, "AGENTS.md"));
  await mkdir(path.join(f.project, "docs"));
  await writeFile(path.join(f.project, "docs/AGENTS.md"), "IN_REPO_CONTEXT_LOADS");
  await symlink(path.join("docs", "AGENTS.md"), path.join(f.project, "AGENTS.md"));
  const contained = await f.run([cli, "Answer without tools"]);
  expect({ exit: contained.exit, stderr: contained.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(f.payloads).toHaveLength(2);
  expect(JSON.stringify(f.payloads[1])).toContain("IN_REPO_CONTEXT_LOADS");
}, 90_000);

test("the parent system prompt states Casper's identity exactly once, first, with or without a user SYSTEM.md", async () => {
  const f = await fixture(() => answer("IDENTITY_FIXTURE"));
  const system = (index: number) => {
    const message = f.payloads[index]?.messages.find((entry) => entry.role === "system");
    return typeof message?.content === "string" ? message.content : JSON.stringify(message?.content);
  };
  expect((await f.run([cli, "Answer without tools"])).exit).toBe(0);
  // The engine store's own SYSTEM.md is the user's; it follows Casper's text instead of leading.
  await writeFile(path.join(f.agent, "SYSTEM.md"), "USER_SYSTEM_PROMPT_LOADS");
  expect((await f.run([cli, "Answer without tools"])).exit).toBe(0);
  expect(f.payloads).toHaveLength(2);
  for (const index of [0, 1]) {
    expect(system(index)).toStartWith("You are Casper, ");
    expect(system(index).split("You are Casper")).toHaveLength(2);
    expect(system(index)).not.toContain("operating inside pi");
  }
  expect(system(0)).not.toContain("USER_SYSTEM_PROMPT_LOADS");
  expect(system(1)).toContain("USER_SYSTEM_PROMPT_LOADS");
  // Pi drops its own read/edit/write rules under a custom prompt; Casper sends them, once.
  for (const index of [0, 1]) {
    expect(system(index).split("Tool rules:")).toHaveLength(2);
    for (const rule of PI_TOOL_RULES) expect(system(index)).toContain(`- ${rule}`);
    expect(system(index)).toContain("caps any timeout at 3600 seconds");
  }
}, 60_000);

test("read-only Pi refuses a source containing its active state before initialization", async () => {
  const f = await fixture(() => answer("must not be requested"));
  const before = await snapshot(f.agent);
  const result = await f.run([adapter, f.agent, "turns"]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("overlaps writable runtime state");
  expect(f.payloads).toEqual([]);
  expect(await snapshot(f.agent)).toEqual(before);
});

needsSymlinks("ordinary parent Pi startup remains allowed when state is inside its workspace", async () => {
  const f = await fixture(() => answer("ORDINARY_PARENT_UNCHANGED"));
  const state = path.join(f.project, ".pi/agent");
  await mkdir(path.dirname(state));
  await rename(f.agent, state);
  await symlink(state, f.agent);
  const result = await f.run([cli, "Inspect this project without edits"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("ORDINARY_PARENT_UNCHANGED");
  expect(result.stdout).toContain(" model     fixture/fixture (starts on your first request");
  expect(result.stdout).not.toContain("credentials missing");
  expect(result.stdout).not.toContain("local-fixture-not-a-secret");
  expect(f.payloads).toHaveLength(1);
  expect(f.payloads[0]?.tools.map((tool) => tool.function.name)).toContain("bash");
}, 60_000);

posixOnly("real Pi forwards correlated bounded shell diagnostics without edit bodies or fabricated exit codes", async () => {
  let step = 0;
  const f = await fixture(() => step++ === 0 ? calls([
    { name: "bash", args: { command: "printf SHELL_DIAGNOSTIC; exit 7" } },
    { name: "write", args: { path: "changed.txt", content: "EDIT_BODY_NOT_AN_OBSERVATION" } },
  ]) : answer("Done"));
  const harness = path.join(f.agent, "observations.ts");
  await writeFile(harness, `import { PiRuntime } from ${JSON.stringify(path.join(import.meta.dir, "../src/runtime/pi.ts"))};
const runtime = new PiRuntime();
const events = [];
try {
  const session = await runtime.start({ cwd: process.cwd() });
  session.subscribe(event => { if (event.type === 'assistant_response_start' || event.type === 'tool_start' || event.type === 'tool_end') events.push(event); });
  await session.prompt('Run the fixture commands.');
  console.log('OBSERVATIONS=' + JSON.stringify(events));
} finally { await runtime.dispose(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const events: RuntimeEvent[] = JSON.parse(result.stdout.split("OBSERVATIONS=")[1]!);
  const response = events.find((event) => event.type === "assistant_response_start");
  expect(response).toMatchObject({ provider: "fixture", model: "fixture" });
  const shell = events.find((event) => event.type === "tool_end" && event.toolName === "bash");
  expect(shell).toMatchObject({ toolCallId: "call_0", input: { command: "printf SHELL_DIAGNOSTIC; exit 7" }, isError: true });
  if (shell?.type !== "tool_end") throw new Error("Missing shell observation");
  expect(shell.output?.text).toContain("SHELL_DIAGNOSTIC");
  expect(shell.output?.text).toContain("code 7");
  expect(shell).not.toHaveProperty("exitCode");
  expect(JSON.stringify(events)).not.toContain("EDIT_BODY_NOT_AN_OBSERVATION");
  expect(await readFile(path.join(f.project, "changed.txt"), "utf8")).toBe("EDIT_BODY_NOT_AN_OBSERVATION");
}, 15_000);

for (const mode of ["default", "explicit", "cancel", "absurd"]) posixOnly(`real Pi releases a stuck shell and remains usable (${mode})`, async () => {
  let step = 0;
  const f = await fixture(() => {
    if (step++ === 0) return calls([{ name: "bash", args: {
      command: "printf BEFORE_WAIT; sleep 5; printf SHOULD_NOT_FINISH",
      ...(mode === "explicit" ? { timeout: 0.1 } : mode === "absurd" ? { timeout: 86_400 } : {}),
    } }]);
    return answer("Recovered");
  });
  const harness = path.join(f.agent, "shell-deadline.ts");
  await writeFile(harness, `import { PiRuntime } from ${JSON.stringify(path.join(import.meta.dir, "../src/runtime/pi.ts"))};
const runtime = new PiRuntime();
const events = [];
const schedule = globalThis.setTimeout;
// Accelerate the production deadline only in this isolated process. The actual
// native shell, descendant termination, streaming, and provider loop still run.
// "absurd": a day-long timeout is capped at one hour, which is accelerated the same way.
globalThis.setTimeout = (callback, ms, ...args) => schedule(callback, (${JSON.stringify(mode)} === "default" && ms === 120_000) || (${JSON.stringify(mode)} === "absurd" && ms === 3_600_000) ? 100 : ms, ...args);
try {
  const session = await runtime.start({ cwd: process.cwd() });
  const controller = new AbortController();
  session.subscribe(event => {
    events.push(event);
    if (${JSON.stringify(mode)} === "cancel" && event.type === "tool_start") {
      schedule(() => controller.abort(), 100);
    }
  });
  await session.prompt('Run the fixture command.', controller.signal).catch(error => {
    if (!controller.signal.aborted) throw error;
  });
  await session.prompt('Confirm recovery.');
  console.log('SHELL_RESULT=' + JSON.stringify({ events, busy: session.busy }));
} finally { globalThis.setTimeout = schedule; await runtime.dispose(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const { events, busy }: { events: RuntimeEvent[]; busy: boolean } = JSON.parse(result.stdout.split("SHELL_RESULT=")[1]!);
  const shell = events.find(event => event.type === "tool_end" && event.toolName === "bash");
  expect(shell).toMatchObject({ isError: true });
  if (shell?.type !== "tool_end") throw new Error("Missing shell result");
  expect(shell.output?.text).not.toContain("SHOULD_NOT_FINISH");
  if (mode !== "cancel") {
    expect(shell.output?.text).toContain("timed out");
  }
  expect(events.some(event => event.type === "assistant_text_delta" && event.delta.includes("Recovered"))).toBe(true);
  expect(busy).toBe(false);
}, 15_000);

test("real Pi refuses a model's git stash, and the model sees why", async () => {
  let step = 0;
  const f = await fixture(() => step++ === 0 ? calls([{ name: "bash", args: { command: "git stash push -m tmp && echo STASHED" } }]) : answer("Done"));
  const harness = path.join(f.agent, "git-guard.ts");
  await writeFile(harness, `import { PiRuntime } from ${JSON.stringify(path.join(import.meta.dir, "../src/runtime/pi.ts"))};
const runtime = new PiRuntime();
const ends = [];
try {
  const session = await runtime.start({ cwd: process.cwd() });
  session.subscribe((event) => { if (event.type === "tool_end") ends.push({ isError: event.isError, text: event.output?.text }); });
  await session.prompt("Stash it.");
  console.log("RESULT=" + JSON.stringify(ends));
} finally { await runtime.dispose(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const ends: Array<{ isError: boolean; text?: string }> = JSON.parse(result.stdout.split("RESULT=")[1]!);
  expect(ends).toHaveLength(1);
  expect(ends[0]!.isError).toBe(true);
  expect(ends[0]!.text).toContain("Casper does not let the model run `git stash push -m tmp`");
  expect(ends[0]!.text).not.toContain("STASHED");
}, 30_000);

test("real Pi's write reports its size: a rewrite counts changed lines, a new file counts all", async () => {
  let step = 0;
  const f = await fixture(() => step++ === 0
    ? calls([{ name: "write", args: { path: "fixture.txt", content: "LOCAL_EVIDENCE_8\nnew line\n" } }, { name: "write", args: { path: "fresh.txt", content: "one\ntwo\nthree\n" } }])
    : answer("Done"));
  const harness = path.join(f.agent, "write-size.ts");
  await writeFile(harness, `import { PiRuntime } from ${JSON.stringify(path.join(import.meta.dir, "../src/runtime/pi.ts"))};
const runtime = new PiRuntime();
const ends = [];
try {
  const session = await runtime.start({ cwd: process.cwd() });
  session.subscribe((event) => { if (event.type === "tool_end") ends.push({ path: event.input?.path, lines: event.lines }); });
  await session.prompt("Write both.");
  console.log("RESULT=" + JSON.stringify(ends));
} finally { await runtime.dispose(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const ends: Array<{ path: string; lines?: { added: number; removed: number } }> = JSON.parse(result.stdout.split("RESULT=")[1]!);
  expect(ends.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: "fixture.txt", lines: { added: 1, removed: 0 } },
    { path: "fresh.txt", lines: { added: 3, removed: 0 } },
  ]);
}, 30_000);

for (const sequential of [false, true]) test(`real Pi runs a batch ${sequential ? "one call at a time when a tool is marked sequential" : "in parallel by default"}`, async () => {
  let step = 0;
  const f = await fixture(() => step++ === 0
    ? calls([{ name: "slow", args: { id: "a" } }, { name: "slow", args: { id: "b" } }])
    : answer("Done"));
  const harness = path.join(f.agent, "sequential.ts");
  await writeFile(harness, `import { PiRuntime } from ${JSON.stringify(path.join(import.meta.dir, "../src/runtime/pi.ts"))};
const runtime = new PiRuntime();
const log = [];
const slow = { name: "slow", description: "Waits briefly.", inputSchema: { type: "object", properties: { id: { type: "string" } } },
  ${sequential ? "sequential: true," : ""}
  execute: async (args) => { log.push("start " + args.id); await new Promise((done) => setTimeout(done, 150)); log.push("end " + args.id); return { text: "ok" }; } };
try {
  const session = await runtime.start({ cwd: process.cwd(), tools: [slow] });
  await session.prompt("Run both.");
  console.log("RESULT=" + JSON.stringify(log));
} finally { await runtime.dispose(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const log: string[] = JSON.parse(result.stdout.split("RESULT=")[1]!);
  expect(log).toEqual(sequential ? ["start a", "end a", "start b", "end b"] : ["start a", "start b", "end a", "end b"]);
}, 30_000);
