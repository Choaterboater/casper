import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillRegistry } from "../src/skills/registry";
import { classifyTask } from "../src/task/classify";
import { needsFifos, needsSymlinks, posixModes, posixOnly } from "./support/platform";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
interface Payload { tools: Array<{ function: { name: string } }>; messages: unknown[] }
function stream(delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify({ id: "learn-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
function answer(text: string, finish = "stop"): Response {
  return new Response(stream({ role: "assistant", content: text }, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function readEvidence(): Response {
  return new Response(stream({ role: "assistant", tool_calls: [{ index: 0, id: "read_evidence", type: "function", function: {
    name: "read", arguments: JSON.stringify({ path: "pattern.txt" }),
  } }] }, null) + stream({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
const candidate = {
  name: "Atomic publication", problem: "Readers must not see half-written state.", context: "Small local configuration files.",
  pattern: "Write a temporary file and rename it into place.", whyItMightHelp: "A rename may avoid exposing a partial file; durability is unproven.",
  tradeoffs: ["Filesystem semantics and concurrent writers need separate review."],
  useWhen: ["Publishing one local file."], avoidWhen: ["A multi-file transaction is required."],
  evidence: [{ file: "pattern.txt", startLine: 1, endLine: 1, quote: "hello" }],
};
async function fixture(respond?: (payload: Payload, index: number) => Response | Promise<Response>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-learn-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const project = path.join(root, "source repo");
  const cwd = path.join(root, "caller"); const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(project); await mkdir(cwd);
  await writeFile(path.join(project, "pattern.txt"), "hello\n");
  const payloads: Payload[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const payload: Payload = await request.json(); payloads.push(payload);
    return respond ? respond(payload, payloads.length - 1) : payloads.length === 1 ? readEvidence() : answer(JSON.stringify({ candidates: [candidate] }));
  } });
  cleanup.push(async () => { server.stop(true); });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }],
  } } }));
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  function spawn(args: string[]) {
    return Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  }
  async function run(args: string[]) {
    const child = spawn(args);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exit };
    } finally { clearTimeout(timer); child.kill(); }
  }
  return { root, home, project, cwd, agent, env, payloads, run, spawn };
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const absolute = path.join(entry.parentPath, entry.name);
      files[path.relative(root, absolute)] = (await readFile(absolute)).toString("base64");
    }
  }
  return files;
}

test("learn produces an unpromoted draft with host-checked provenance, inspectable locally after restart", async () => {
  const f = await fixture();
  const before = await snapshot(f.project);
  const stateBefore = await snapshot(path.join(f.home, ".casper"));
  const result = await f.run(["learn", f.project]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const generated = JSON.parse(result.stdout);
  expect(generated.status).toBe("saved");
  expect(generated.draft).toMatchObject({
    sourceRoot: await realpath(f.project), status: "unpromoted", verification: "not-run", accepted: null, coverage: "not-certified",
  });
  expect(generated.draft.candidates[0]).toMatchObject({ ...candidate, evidence: [{ ...candidate.evidence[0],
    sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  }] });
  expect(generated.draft.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(generated.guidance).toContain("not verification");
  expect(f.payloads).toHaveLength(2);
  for (const payload of f.payloads) expect(payload.tools.map((tool) => tool.function.name).sort()).toEqual(["find", "grep", "ls", "read"]);
  expect(JSON.stringify(f.payloads[1]?.messages)).toContain("hello");
  await rm(path.join(f.agent, "models.json")); await rm(path.join(f.agent, "settings.json"));
  const listed = await f.run(["learn", "list", f.project]);
  expect(listed.exit).toBe(0);
  expect(JSON.parse(listed.stdout).drafts).toEqual([{ id: generated.draft.id, createdAt: generated.draft.createdAt,
    sha256: generated.draft.sha256, candidates: 1, decisions: 0, status: "unpromoted" }]);
  const inspected = await f.run(["learn", "inspect", f.project, generated.draft.id]);
  expect(inspected.exit).toBe(0);
  expect(JSON.parse(inspected.stdout).draft).toEqual(generated.draft);
  expect(f.payloads).toHaveLength(2);
  expect(await snapshot(f.project)).toEqual(before);
  expect(await snapshot(f.cwd)).toEqual({});
  const stateAfter = await snapshot(path.join(f.home, ".casper"));
  for (const [file, content] of Object.entries(stateBefore)) expect(stateAfter[file]).toBe(content);
  const state = Object.fromEntries(Object.entries(stateAfter).filter(([file]) => !(file in stateBefore)));
  expect(Object.keys(state)).toHaveLength(1);
  expect(Object.keys(state)[0]).toEndWith("/learning-candidates.jsonl");
  // Mode bits are a POSIX guarantee; Windows synthesizes them (tests/support/platform.ts).
  if (posixModes) expect((await stat(path.join(f.home, ".casper", Object.keys(state)[0]!))).mode & 0o777).toBe(0o600);
}, 15_000);

test("digest-bound human promotion makes one candidate a searchable reference without another model call", async () => {
  const f = await fixture();
  const generated = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const promoted = await f.run(["learn", "promote", f.project, generated.id, generated.sha256, "1", "reference"]);
  expect({ exit: promoted.exit, stderr: promoted.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(promoted.stdout)).toMatchObject({ status: "promoted", decision: { draftId: generated.id,
    draftSha256: generated.sha256, candidateIndex: 1, disposition: "reference" } });
  expect(f.payloads).toHaveLength(2);
  const searched = await f.run(["/references", "search", "casper-promoted", "atomic"]);
  expect(searched.exit).toBe(0);
  expect(searched.stdout).toContain('"source":"casper-promoted"');
  expect(searched.stdout).toContain("Atomic publication");
  expect(f.payloads).toHaveLength(2);
  const inspected = JSON.parse((await f.run(["learn", "inspect", f.project, generated.id])).stdout);
  expect(inspected.decisions).toHaveLength(1);
  expect(inspected.decisions[0]).toEqual(JSON.parse(promoted.stdout).decision);
}, 15_000);

for (const disposition of ["project-skill", "global-skill"] as const) test(`human promotion activates a trusted ${disposition} from owner-controlled state`, async () => {
  const f = await fixture();
  const generated = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const name = disposition === "project-skill" ? "atomic-project-pattern" : "atomic-global-pattern";
  const promoted = await f.run(["learn", "promote", f.project, generated.id, generated.sha256, "1", disposition, name]);
  expect({ exit: promoted.exit, stderr: promoted.stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(promoted.stdout);
  expect(result).toMatchObject({ status: "promoted", decision: { disposition, skillName: name } });
  expect(f.payloads).toHaveLength(2);
  const registry = await SkillRegistry.discover({ projectRoot: f.project, homeDir: f.home });
  const skill = registry.list().find((entry) => entry.name === name);
  expect(skill).toMatchObject({ name, trust: "trusted", source: disposition === "project-skill" ? "project" : "user" });
  expect(skill!.filePath.startsWith(f.project)).toBe(false);
  const loaded = await registry.loadForTask(`use ${name}`, {
    schemaVersion: 1, project: { name: "fixture", root: f.project, git: false }, languages: [], frameworks: [], packageManager: null,
    commands: {}, architecture: {}, conventions: [], detectedAt: new Date(0).toISOString(),
  }, classifyTask(`use ${name}`));
  expect(loaded.map((entry) => entry.skill.name)).toContain(name);
  expect(loaded[0]?.body).toContain("human explicitly promoted this exact digest-bound candidate");
}, 15_000);

test("ignore and promotion consent are exact, immutable, idempotent and local", async () => {
  const f = await fixture(); const before = await snapshot(f.project);
  const draft = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const wrong = await f.run(["learn", "promote", f.project, draft.id, "0".repeat(64), "1", "reference"]);
  expect(wrong.exit).toBe(1);
  expect(wrong.stderr).toContain("inspect it again");
  let inspected = JSON.parse((await f.run(["learn", "inspect", f.project, draft.id])).stdout);
  expect(inspected.decisions).toEqual([]);
  const ignored = await f.run(["learn", "promote", f.project, draft.id, draft.sha256, "1", "ignore"]);
  expect(ignored.exit).toBe(0);
  expect(JSON.parse(ignored.stdout)).toMatchObject({ status: "ignored", decision: { disposition: "ignore" } });
  expect(JSON.parse(ignored.stdout).decision).not.toHaveProperty("artifact");
  const repeated = await f.run(["learn", "promote", f.project, draft.id, draft.sha256, "1", "ignore"]);
  expect(JSON.parse(repeated.stdout)).toMatchObject({ status: "already-decided", decision: { id: JSON.parse(ignored.stdout).decision.id } });
  const conflict = await f.run(["learn", "promote", f.project, draft.id, draft.sha256, "1", "reference"]);
  expect(conflict.exit).toBe(1);
  expect(conflict.stderr).toContain("different immutable promotion decision");
  inspected = JSON.parse((await f.run(["learn", "inspect", f.project, draft.id])).stdout);
  expect(inspected.decisions).toHaveLength(1);
  expect(await snapshot(f.project)).toEqual(before);
  expect(f.payloads).toHaveLength(2);
}, 15_000);

test("concurrent identical promotion commits one decision and one create-only artifact", async () => {
  const f = await fixture();
  const draft = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const args = ["learn", "promote", f.project, draft.id, draft.sha256, "1", "global-skill", "atomic-concurrent"];
  const [first, second] = await Promise.all([f.run(args), f.run(args)]);
  expect([first.exit, second.exit]).toEqual([0, 0]);
  expect(new Set([JSON.parse(first.stdout).status, JSON.parse(second.stdout).status])).toEqual(new Set(["promoted", "already-decided"]));
  expect(JSON.parse(first.stdout).decision.id).toBe(JSON.parse(second.stdout).decision.id);
  const inspected = JSON.parse((await f.run(["learn", "inspect", f.project, draft.id])).stdout);
  expect(inspected.decisions).toHaveLength(1);
  const registry = await SkillRegistry.discover({ projectRoot: f.project, homeDir: f.home });
  expect(registry.list().filter((entry) => entry.name === "atomic-concurrent")).toHaveLength(1);
  expect(f.payloads).toHaveLength(2);
}, 15_000);

test("promotion never overwrites existing skills and corrupted decisions fail closed", async () => {
  const f = await fixture();
  const draft = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const target = path.join(f.home, ".casper/skills/protected/SKILL.md");
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, "KEEP\n");
  const collision = await f.run(["learn", "promote", f.project, draft.id, draft.sha256, "1", "global-skill", "protected"]);
  expect(collision.exit).toBe(1);
  expect(collision.stderr).toContain("already exists");
  expect(await readFile(target, "utf8")).toBe("KEEP\n");
  let inspected = JSON.parse((await f.run(["learn", "inspect", f.project, draft.id])).stdout);
  expect(inspected.decisions).toEqual([]);
  const ignored = JSON.parse((await f.run(["learn", "promote", f.project, draft.id, draft.sha256, "1", "ignore"])).stdout);
  const stateFiles = await snapshot(path.join(f.home, ".casper"));
  const promotionRelative = Object.keys(stateFiles).find((file) => file.endsWith("/learning-promotions.jsonl"))!;
  const promotionFile = path.join(f.home, ".casper", promotionRelative);
  await writeFile(promotionFile, "corrupt\n");
  for (const args of [["learn", "list", f.project], ["learn", "inspect", f.project, draft.id],
    ["learn", "promote", f.project, draft.id, draft.sha256, "1", "ignore"]]) {
    const result = await f.run(args);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("preserve the file");
  }
  expect(await readFile(promotionFile, "utf8")).toBe("corrupt\n");
  expect(ignored.decision.disposition).toBe("ignore");
  expect(f.payloads).toHaveLength(2);
}, 15_000);

test("exact replay recovers only a recorded staged artifact and never repairs changed active content", async () => {
  const f = await fixture();
  const draft = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const args = ["learn", "promote", f.project, draft.id, draft.sha256, "1", "reference"];
  const first = JSON.parse((await f.run(args)).stdout);
  const artifact = first.decision.artifact as { path: string; stagingPath: string };
  await rename(path.dirname(artifact.path), path.dirname(artifact.stagingPath));
  const recovered = await f.run(args);
  expect(recovered.exit).toBe(0);
  expect(JSON.parse(recovered.stdout)).toMatchObject({ status: "already-decided", decision: { id: first.decision.id } });
  expect(await readFile(artifact.path, "utf8")).toContain("Atomic publication");
  await writeFile(artifact.path, "CHANGED\n");
  const changed = await f.run(args);
  expect(changed.exit).toBe(1);
  expect(changed.stderr).toContain("changed; refusing recovery or replacement");
  expect(await readFile(artifact.path, "utf8")).toBe("CHANGED\n");
  expect(f.payloads).toHaveLength(2);
}, 15_000);

for (const redirected of ["active", "staged"] as const) needsSymlinks(`promotion replay refuses a redirected ${redirected} artifact directory`, async () => {
  const f = await fixture();
  const draft = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const args = ["learn", "promote", f.project, draft.id, draft.sha256, "1", "reference"];
  const first = JSON.parse((await f.run(args)).stdout);
  const artifact = first.decision.artifact as { path: string; stagingPath: string };
  const outside = path.join(f.root, "redirected-artifact");
  await rename(path.dirname(artifact.path), outside);
  const redirectedPath = path.dirname(redirected === "active" ? artifact.path : artifact.stagingPath);
  await symlink(outside, redirectedPath, "dir");
  const before = await snapshot(outside);
  const replay = await f.run(args);
  expect(replay.exit).toBe(1);
  expect(replay.stderr).toContain("real directories, not symlinks");
  expect(await snapshot(outside)).toEqual(before);
  expect(await realpath(redirectedPath)).toBe(await realpath(outside));
  expect(f.payloads).toHaveLength(2);
}, 15_000);

needsSymlinks("promotion rejects symlinked artifact roots without writing through them", async () => {
  const f = await fixture();
  const draft = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const outside = await mkdtemp(path.join(os.tmpdir(), "casper-promoted-outside-"));
  cleanup.push(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(f.home, ".casper", "promoted-references"), "dir");
  const result = await f.run(["learn", "promote", f.project, draft.id, draft.sha256, "1", "reference"]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("real directories, not symlinks");
  expect(await readdir(outside)).toEqual([]);
  const inspected = JSON.parse((await f.run(["learn", "inspect", f.project, draft.id])).stdout);
  expect(inspected.decisions).toEqual([]);
  expect(f.payloads).toHaveLength(2);
}, 15_000);

test("learning rejects source overlap with Pi state before creating files or calling a provider", async () => {
  const f = await fixture(() => answer('{"candidates":[]}'));
  const agent = path.join(f.project, ".pi/agent");
  await mkdir(path.dirname(agent), { recursive: true });
  await rename(f.agent, agent);
  f.env.PI_CODING_AGENT_DIR = agent;
  const before = await snapshot(f.project);
  const result = await f.run(["learn", f.project]);
  const after = await snapshot(f.project);
  expect(Object.keys(after)).toEqual(Object.keys(before));
  expect(after).toEqual(before);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("overlaps writable runtime state");
  expect(f.payloads).toEqual([]);
  expect(JSON.parse((await f.run(["learn", "list", f.project])).stdout).drafts).toEqual([]);
});

for (const layout of ["default-root", "state-alias", "missing-state"]) needsSymlinks(`learning state preflight handles ${layout} without modifying the source`, async () => {
  const f = await fixture(() => answer('{"candidates":[]}'));
  let source = f.project;
  let requested = source;
  if (layout === "default-root") {
    delete f.env.PI_CODING_AGENT_DIR;
    // The default store is ~/.casper/agent; pre-seed the two files the one-time import
    // would copy so the preflight exercise never mutates the source.
    source = path.join(f.home, ".casper/agent"); requested = source;
    await mkdir(source, { recursive: true, mode: 0o700 });
    await writeFile(path.join(source, "auth.json"), "{}\n", { mode: 0o600 });
    await writeFile(path.join(source, "models.json"), "{}\n", { mode: 0o600 });
  } else if (layout === "state-alias") {
    const state = path.join(f.project, "state");
    await rename(f.agent, state);
    const alias = path.join(f.root, "state-alias");
    await symlink(state, alias);
    f.env.PI_CODING_AGENT_DIR = alias;
    requested = path.join(f.root, "source-alias");
    await symlink(source, requested);
  } else f.env.PI_CODING_AGENT_DIR = path.join(f.project, "missing/.pi/agent");
  const before = await snapshot(source);
  const entries = await readdir(source, { recursive: true });
  const result = await f.run(["learn", requested]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("overlaps writable runtime state");
  expect(f.payloads).toEqual([]);
  expect(await readdir(source, { recursive: true })).toEqual(entries);
  expect(await snapshot(source)).toEqual(before);
});

for (const file of ["auth.json", "models-store.json"]) needsSymlinks(`learning refuses a separate Pi state's ${file} symlink into source`, async () => {
  const f = await fixture(() => answer('{"candidates":[]}'));
  const protectedFile = path.join(f.project, file);
  await writeFile(protectedFile, "{}\n");
  await symlink(protectedFile, path.join(f.agent, file));
  const before = await snapshot(f.project);
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("overlaps writable runtime state");
  expect(f.payloads).toEqual([]);
  expect(await snapshot(f.project)).toEqual(before);
});

test("learning still permits sibling Pi state without changing source or model defaults", async () => {
  const f = await fixture(() => answer('{"candidates":[]}'));
  const state = f.project + "-state";
  await rename(f.agent, state);
  f.env.PI_CODING_AGENT_DIR = path.relative(f.cwd, state);
  const before = await snapshot(f.project);
  const settings = await readFile(path.join(state, "settings.json"), "utf8");
  const result = await f.run(["learn", f.project]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(result.stdout).status).toBe("no-candidates");
  expect(f.payloads).toHaveLength(1);
  expect(await snapshot(f.project)).toEqual(before);
  expect(await readFile(path.join(state, "settings.json"), "utf8")).toBe(settings);
});

test("learning output escapes terminal controls without altering the saved candidate", async () => {
  const unsafe = { ...candidate, name: "Pattern\u009b31m\u202e\u001b[0m" };
  const f = await fixture(() => answer(JSON.stringify({ candidates: [unsafe] })));
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(0);
  expect(result.stdout).not.toMatch(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069\u001b]/u);
  expect(JSON.parse(result.stdout).draft.candidates[0].name).toBe(unsafe.name);
});

for (const [name, response, finish] of [
  ["malformed JSON", "not JSON", "stop"],
  ["unknown fields", JSON.stringify({ candidates: [candidate], promote: true }), "stop"],
  ["model acceptance", JSON.stringify({ candidates: [{ ...candidate, accepted: true }] }), "stop"],
  ["model digests", JSON.stringify({ candidates: [{ ...candidate, evidence: [{ ...candidate.evidence[0], sha256: "0".repeat(64) }] }] }), "stop"],
  ["excess candidates", JSON.stringify({ candidates: Array(5).fill(candidate) }), "stop"],
  ["cut-off completion", JSON.stringify({ candidates: [candidate] }), "length"],
  ["oversized response", "x".repeat(13_000), "stop"],
]) test(`learning refuses ${name} without publishing a draft`, async () => {
  const f = await fixture(() => answer(response!, finish));
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).status).toBe("failed");
  const listed = await f.run(["learn", "list", f.project]);
  expect(listed.exit).toBe(0);
  expect(JSON.parse(listed.stdout).drafts).toEqual([]);
  expect(f.payloads).toHaveLength(1);
});

for (const [name, evidence] of [
  ["invented quote", { ...candidate.evidence[0], quote: "invented" }],
  ["incorrect lines", { ...candidate.evidence[0], startLine: 2, endLine: 2 }],
  ["traversal", { ...candidate.evidence[0], file: "../caller/secret.txt" }],
  ["absolute path", { ...candidate.evidence[0], file: "/etc/passwd" }],
  ["hidden file", { ...candidate.evidence[0], file: ".env" }],
  ["missing file", { ...candidate.evidence[0], file: "missing.txt" }],
]) test(`host evidence checks reject ${name} and publish no part of a mixed batch`, async () => {
  const f = await fixture(() => answer(JSON.stringify({ candidates: [candidate, { ...candidate, evidence: [evidence] }] })));
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(1);
  expect(JSON.parse(result.stderr).status).toBe("failed");
  expect(JSON.parse((await f.run(["learn", "list", f.project])).stdout).drafts).toEqual([]);
});

test("source changes after model reading cannot supply a matching evidence quote", async () => {
  const f = await fixture(async (_payload, index) => {
    if (!index) return readEvidence();
    await writeFile(path.join(f.project, "pattern.txt"), "changed externally\n");
    return answer(JSON.stringify({ candidates: [candidate] }));
  });
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("does not match");
  expect(JSON.parse((await f.run(["learn", "list", f.project])).stdout).drafts).toEqual([]);
});

test("no supported patterns is a qualified empty result, not a fabricated candidate", async () => {
  const f = await fixture(() => answer('{"candidates":[]}'));
  const before = await snapshot(path.join(f.home, ".casper"));
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "no-candidates" });
  expect(JSON.parse((await f.run(["learn", "list", f.project])).stdout).drafts).toEqual([]);
  expect(await snapshot(path.join(f.home, ".casper"))).toEqual(before);
});

test("invalid learning commands stay local and never fall through to an unrestricted prompt", async () => {
  const f = await fixture();
  for (const args of [
    ["learn"], ["learn", "inspect", f.project], ["learn", f.project, "--promote"],
    ["learn", "promote", f.project],
    ["learn", "promote", f.project, "bad-id", "0".repeat(64), "1", "reference"],
    ["learn", "promote", f.project, "00000000-0000-0000-0000-000000000000", "0".repeat(64), "zero", "reference"],
    ["learn", "promote", f.project, "00000000-0000-0000-0000-000000000000", "0".repeat(64), "1", "automatic"],
    ["learn", "promote", f.project, "00000000-0000-0000-0000-000000000000", "0".repeat(64), "1", "global-skill"],
    ["learn", "promote", f.project, "00000000-0000-0000-0000-000000000000", "0".repeat(64), "1", "reference", "extra-name"],
    ["learn", "https://example.com/repo"], ["learn", "git@example.com:repo"],
    ["learn", path.join(f.root, "missing")], ["learn", path.join(f.project, "pattern.txt")], ["learn", f.home],
    ["--verify", "learn", f.project], ["--mcp", "fixture", "learn", f.project], ["--lsp", "fixture", "learn", f.project],
  ]) {
    const result = await f.run(args);
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
  }
  expect(f.payloads).toEqual([]);
  expect(JSON.parse((await f.run(["learn", "list", f.project])).stdout).drafts).toEqual([]);
});

test("learning cannot activate ambient extensions, project commands, skills, facts or reference configuration", async () => {
  const f = await fixture();
  await mkdir(path.join(f.agent, "extensions"));
  await writeFile(path.join(f.agent, "extensions/ambient.ts"), `throw new Error("AMBIENT_EXTENSION_EXECUTED");`);
  await writeFile(path.join(f.agent, "SYSTEM.md"), "AMBIENT_SYSTEM_GUIDANCE");
  await mkdir(path.join(f.project, ".pi/extensions"), { recursive: true });
  await writeFile(path.join(f.project, ".pi/extensions/project.ts"), `throw new Error("PROJECT_EXTENSION_EXECUTED");`);
  await writeFile(path.join(f.project, ".pi/settings.json"), JSON.stringify({ defaultProvider: "unauthorized" }));
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), "verify:\n  test: touch PROJECT_COMMAND_EXECUTED\n");
  await writeFile(path.join(f.project, "AGENTS.md"), "AMBIENT_PROJECT_GUIDANCE");
  await mkdir(path.join(f.home, ".casper/skills/sample"), { recursive: true });
  await writeFile(path.join(f.home, ".casper/skills/sample/SKILL.md"), "---\nname: sample\ndescription: sample\n---\nAMBIENT_SKILL_GUIDANCE\n");
  await writeFile(path.join(f.home, ".casper/references.yaml"), "references: {}\n");
  const sourceBefore = await snapshot(f.project);
  const homeBefore = await snapshot(f.home);
  const result = await f.run(["learn", f.project]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(await snapshot(f.project)).toEqual(sourceBefore);
  expect(JSON.stringify(f.payloads)).not.toContain("AMBIENT_");
  const homeAfter = await snapshot(f.home);
  for (const [file, value] of Object.entries(homeBefore)) expect(homeAfter[file]).toBe(value);
  const added = Object.keys(homeAfter).filter((file) => file.startsWith(".casper/") && !(file in homeBefore));
  expect(added).toHaveLength(1);
  expect(added[0]).toEndWith("/learning-candidates.jsonl");
  // Pi's model/auth bookkeeping and Bun caches are not learning drafts or session history.
  expect(Object.keys(homeAfter).filter((file) => file.startsWith(".pi/agent/sessions/") && file.endsWith(".jsonl"))).toEqual([]);
}, 15_000);

test("concurrent learning processes preserve both immutable drafts and keep repositories isolated", async () => {
  const f = await fixture(() => answer(JSON.stringify({ candidates: [candidate] })));
  const [first, second] = await Promise.all([f.run(["learn", f.project]), f.run(["learn", f.project])]);
  expect([first.exit, second.exit]).toEqual([0, 0]);
  const a = JSON.parse(first.stdout).draft; const b = JSON.parse(second.stdout).draft;
  expect(a.id).not.toBe(b.id);
  const listed = JSON.parse((await f.run(["learn", "list", f.project])).stdout);
  expect(new Set(listed.drafts.map((draft: { id: string }) => draft.id))).toEqual(new Set([a.id, b.id]));
  expect(JSON.parse((await f.run(["learn", "inspect", f.project, a.id])).stdout).draft).toEqual(a);
  expect(JSON.parse((await f.run(["learn", "list", f.cwd])).stdout).drafts).toEqual([]);
  expect((await f.run(["learn", "inspect", f.cwd, a.id])).exit).toBe(1);
});

test("inspection retains observed provenance after source edits or removal, never claiming refreshed evidence", async () => {
  const f = await fixture(() => answer(JSON.stringify({ candidates: [candidate] })));
  const draft = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  await writeFile(path.join(f.project, "pattern.txt"), "new bytes\n");
  let result = await f.run(["learn", "inspect", f.project, draft.id]);
  expect(JSON.parse(result.stdout).draft).toEqual(draft);
  expect(JSON.parse(result.stdout).guidance).toContain("inspection does not refresh");
  await rm(f.project, { recursive: true });
  result = await f.run(["learn", "inspect", draft.sourceRoot, draft.id]);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout).draft).toEqual(draft);
  expect(f.payloads).toHaveLength(1);
});

test("corrupted draft state fails closed before model startup and stays untouched", async () => {
  const f = await fixture(() => answer(JSON.stringify({ candidates: [candidate] })));
  const draft = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const state = Object.keys(await snapshot(path.join(f.home, ".casper"))).find(file => file.endsWith("/learning-candidates.jsonl"))!;
  const file = path.join(f.home, ".casper", state);
  draft.candidates[0].pattern = "tampered content";
  const corrupt = JSON.stringify(draft) + "\n";
  await writeFile(file, corrupt);
  for (const args of [["learn", f.project], ["learn", "list", f.project], ["learn", "inspect", f.project, draft.id]]) {
    const result = await f.run(args);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("preserve the file");
  }
  expect(await readFile(file, "utf8")).toBe(corrupt);
  expect(f.payloads).toHaveLength(1);
});

needsSymlinks("symlinked evidence parents, binary text and oversized files cannot become draft provenance", async () => {
  let evidenceFile = "pattern.txt";
  const f = await fixture(() => answer(JSON.stringify({ candidates: [{ ...candidate, evidence: [{ ...candidate.evidence[0], file: evidenceFile }] }] })));
  const file = path.join(f.project, "pattern.txt");
  await writeFile(path.join(f.cwd, "outside.txt"), "hello\n");
  await rm(file); await symlink(path.join(f.cwd, "outside.txt"), file);
  expect((await f.run(["learn", f.project])).exit).toBe(1);
  await rm(file); await writeFile(file, Buffer.from([0xff, 0xfe]));
  expect((await f.run(["learn", f.project])).exit).toBe(1);
  await writeFile(file, "hello\n" + "x".repeat(131_072));
  expect((await f.run(["learn", f.project])).exit).toBe(1);
  await rm(file); await symlink(f.cwd, path.join(f.project, "linked"));
  await writeFile(file, "hello\n");
  evidenceFile = "linked/outside.txt";
  expect((await f.run(["learn", f.project])).exit).toBe(1);
  evidenceFile = "pattern.txt";
  // Source roots can be explicitly resolved aliases; entries within them cannot.
  const alias = path.join(f.root, "alias"); await symlink(f.project, alias);
  const result = await f.run(["learn", alias]);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout).draft.sourceRoot).toBe(await realpath(f.project));
});

needsSymlinks("learning refuses a state directory redirected into source files before model startup", async () => {
  const f = await fixture();
  await rm(path.join(f.home, ".casper"), { recursive: true });
  await symlink(f.project, path.join(f.home, ".casper"));
  const before = await snapshot(f.project);
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("not symlinks");
  expect(f.payloads).toEqual([]);
  expect(await snapshot(f.project)).toEqual(before);
});

test("a read-only tool failure or attempted mutation cannot publish an apparently complete draft", async () => {
  const f = await fixture((_payload, index) => index ? answer(JSON.stringify({ candidates: [candidate] })) : new Response(stream({
    role: "assistant", tool_calls: [{ index: 0, id: "bad_tool", type: "function", function: {
      name: "bash", arguments: JSON.stringify({ command: "touch SOURCE_MUTATED" }),
    } }],
  }, null) + stream({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
  const before = await snapshot(f.project);
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("tool errors");
  expect(await snapshot(f.project)).toEqual(before);
  expect(JSON.parse((await f.run(["learn", "list", f.project])).stdout).drafts).toEqual([]);
});

test("exhausting the existing explorer turn limit saves no truncated draft and starts no repair", async () => {
  const f = await fixture(() => readEvidence());
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("incomplete (limited");
  expect(f.payloads.length).toBeLessThanOrEqual(12);
  expect(JSON.parse((await f.run(["learn", "list", f.project])).stdout).drafts).toEqual([]);
});

test("provider failure does not expose raw provider text or record an outcome as a learning draft", async () => {
  const f = await fixture(() => new Response(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_ERROR" } }), { status: 500 }));
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("incomplete");
  expect(result.stdout + result.stderr).not.toContain("PRIVATE_PROVIDER_ERROR");
  expect(JSON.parse((await f.run(["learn", "list", f.project])).stdout).drafts).toEqual([]);
  expect(f.payloads).toHaveLength(1);
});

needsFifos("FIFO evidence and stored drafts fail without waiting for a writer", async () => {
  const f = await fixture(() => answer(JSON.stringify({ candidates: [candidate] })));
  const file = path.join(f.project, "pattern.txt");
  await rm(file);
  expect(await Bun.spawn(["mkfifo", file], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
  expect((await f.run(["learn", f.project])).exit).toBe(1);
  await rm(file); await writeFile(file, "hello\n");
  expect((await f.run(["learn", f.project])).exit).toBe(0);
  const state = path.join(f.home, ".casper", Object.keys(await snapshot(path.join(f.home, ".casper"))).find(file => file.endsWith("/learning-candidates.jsonl"))!);
  await rm(state);
  expect(await Bun.spawn(["mkfifo", state], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
  expect((await f.run(["learn", f.project])).exit).toBe(1);
  expect((await f.run(["learn", "list", f.project])).exit).toBe(1);
  expect(f.payloads).toHaveLength(2);
}, 15_000);

posixOnly("CLI cancellation drains the read-only run without publishing late candidates", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const f = await fixture(() => {
    enter();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(stream({ role: "assistant", content: "partial" }, null)));
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const child = f.spawn(["learn", f.project]);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
    await Promise.race([entered, child.exited.then(() => { throw new Error("Learning exited before provider request"); })]);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await stdout).toBe("");
    await stderr;
    expect(JSON.parse((await f.run(["learn", "list", f.project])).stdout).drafts).toEqual([]);
    expect(f.payloads).toHaveLength(1);
  } finally { clearTimeout(timer); child.kill(); }
}, 10_000);

test("Unicode and CRLF citations retain exact quoted lines and a digest of raw file bytes", async () => {
  const evidence = { file: "pattern.txt", startLine: 1, endLine: 2, quote: "α hello\n😀 world" };
  const f = await fixture(() => answer(JSON.stringify({ candidates: [{ ...candidate, evidence: [evidence] }] })));
  await writeFile(path.join(f.project, "pattern.txt"), "\ufeffα hello\r\n😀 world\r\n");
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout).draft.candidates[0].evidence).toEqual([{ ...evidence,
    sha256: "f572bbd90f62d578ed4f5964cb31707f74b9094b5a924e163d95b6fac78c9103",
  }]);
});

needsSymlinks("invalid, duplicated and oversized draft stores are never reset or sent to a model", async () => {
  const f = await fixture(() => answer(JSON.stringify({ candidates: [candidate] })));
  const draft = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const file = path.join(f.home, ".casper", Object.keys(await snapshot(path.join(f.home, ".casper"))).find(file => file.endsWith("/learning-candidates.jsonl"))!);
  for (const bytes of [Buffer.from("not JSON"), Buffer.from([0xff]), Buffer.alloc(1_048_577, 120),
    Buffer.from(JSON.stringify(draft) + "\n" + JSON.stringify(draft) + "\n")]) {
    await writeFile(file, bytes);
    const result = await f.run(["learn", f.project]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("preserve the file");
    expect(await readFile(file)).toEqual(bytes);
  }
  await rm(file);
  const outside = path.join(f.cwd, "protected.jsonl"); await writeFile(outside, JSON.stringify(draft) + "\n");
  await symlink(outside, file);
  expect((await f.run(["learn", f.project])).exit).toBe(1);
  expect(await readFile(outside, "utf8")).toBe(JSON.stringify(draft) + "\n");
  expect(f.payloads).toHaveLength(1);
});

test("a full draft store refuses further generation rather than pruning earlier drafts", async () => {
  const f = await fixture(() => answer(JSON.stringify({ candidates: [candidate] })));
  const { sha256: _digest, ...body } = JSON.parse((await f.run(["learn", f.project])).stdout).draft;
  const file = path.join(f.home, ".casper", Object.keys(await snapshot(path.join(f.home, ".casper"))).find(file => file.endsWith("/learning-candidates.jsonl"))!);
  // Construct public-format artifacts, not model calls, to reach the documented storage cap.
  const full = Array.from({ length: 100 }, (_, index) => {
    const record = { ...body, id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000` };
    return JSON.stringify({ ...record, sha256: createHash("sha256").update(JSON.stringify(record)).digest("hex") }) + "\n";
  }).join("");
  await writeFile(file, full);
  const listed = await f.run(["learn", "list", f.project]);
  expect(listed.exit).toBe(0);
  expect(JSON.parse(listed.stdout).drafts).toHaveLength(100);
  const result = await f.run(["learn", f.project]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("store is full");
  expect(await readFile(file, "utf8")).toBe(full);
  expect(f.payloads).toHaveLength(1);
});
