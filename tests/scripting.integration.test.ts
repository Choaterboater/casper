import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanUpAfterEach, fixture, savedConversations, userText } from "./support/scripting";

cleanUpAfterEach();

test("--model and --effort choose this run's model and effort without touching the saved default", async () => {
  const f = await fixture();
  const before = await readFile(f.settings, "utf8");
  const result = await f.run(["--model", "fixture/second", "--effort", "low", "Answer without tools"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("LOCAL_RESPONSE");
  // The banner names the model this run uses, not the saved default it overrides.
  expect(result.stdout).toContain(" model     fixture/second for this run (--model)");
  expect(f.payloads.map((payload) => [payload.model, payload.reasoning_effort])).toEqual([["second", "low"]]);
  const suffix = await f.run(["--model", "fixture/second:minimal", "Answer without tools"]);
  expect(suffix.exit).toBe(0);
  expect(f.payloads[1]).toMatchObject({ model: "second", reasoning_effort: "minimal" });
  // Neither the default model nor a remembered effort was written.
  expect(await readFile(f.settings, "utf8")).toBe(before);
  const plain = await f.run(["Answer without tools"]);
  expect(plain.exit).toBe(0);
  expect(f.payloads[2]!.model).toBe("first");
}, 60_000);

test("casper - takes the one-shot prompt from stdin, keeping it out of the process list", async () => {
  const f = await fixture();
  const result = await f.run(["--json", "-"], undefined, {}, "Answer without tools: kill src/server.ts\n");
  expect(result.exit).toBe(0);
  expect(JSON.stringify(f.payloads[0]!.messages)).toContain("Answer without tools: kill src/server.ts");
  expect(result.stdout).toContain('"type":"receipt"');
  const empty = await f.run(["--json", "-"], undefined, {}, "  \n");
  expect(empty.exit).toBe(64);
  expect(empty.stderr).toContain("No prompt on stdin");
  expect(f.payloads).toHaveLength(1);
}, 60_000);

test("every --effort level runs on every model, mapped to the nearest level it supports", async () => {
  const f = await fixture();
  const sparse = await f.run(["--model", "fixture/sparse", "--effort", "medium", "Answer without tools"]);
  expect(sparse.exit).toBe(0);
  const plain = await f.run(["--model", "fixture/first", "--effort", "high", "Answer without tools"]);
  expect(plain.exit).toBe(0);
  const suffix = await f.run(["--model", "fixture/sparse:xhigh", "Answer without tools"]);
  expect(suffix.exit).toBe(0);
  // medium runs as high, a model without reasoning runs without it, xhigh runs as max.
  expect(f.payloads.map((payload) => [payload.model, payload.reasoning_effort])).toEqual([["sparse", "high"], ["first", undefined], ["sparse", "max"]]);
}, 60_000);

test("an unknown --model or effort word is a usage error before any model request", async () => {
  const f = await fixture();
  for (const [args, message] of [
    [["--model", "fixture/nope", "hi"], "Unknown model"],
    [["--effort", "loud", "hi"], "--effort must be one of"],
    [["--model", "fixture/second:high", "--effort", "low", "hi"], "either in --model"],
    [["--model"], "--model needs a value"],
  ] as const) {
    const result = await f.run([...args]);
    expect({ args, exit: result.exit, stdout: result.stdout.includes("> hi") ? "prompt shown" : "" }).toMatchObject({ args, exit: 64 });
    expect(result.stderr).toContain(message);
  }
  expect(f.payloads).toEqual([]);
}, 60_000);

test("a --model whose provider has no credentials fails (exit 1) with the sign-in hint", async () => {
  const f = await fixture();
  const result = await f.run(["--model", "missing/no-auth", "hi"]);
  expect(result.exit).toBe(1);
  // A provider with an address and no key line gets the models.json hint, not the sign-in one.
  expect(result.stderr).toContain("missing at ");
  expect(result.stderr).toContain("needs an apiKey line in models.json");
  expect(f.payloads).toEqual([]);
}, 180_000);

test("--cd opens the given folder as the workspace; a missing folder is a usage error", async () => {
  const f = await fixture();
  await writeFile(path.join(f.project, "package.json"), JSON.stringify({ name: "cd-target", scripts: { test: "true" } }));
  const opened = await f.run(["--cd", f.project, "/project"], f.root);
  expect({ exit: opened.exit, stderr: opened.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(opened.stdout).toContain(" project   project\n");
  expect(opened.stdout).toContain(" test      npm run test\n");
  for (const target of [path.join(f.root, "missing"), path.join(f.project, "package.json")]) {
    const result = await f.run(["--cd", target, "hi"], f.root);
    expect({ target, exit: result.exit, stdout: result.stdout }).toEqual({ target, exit: 64, stdout: "" });
    expect(result.stderr).toContain("--cd: not a folder");
  }
  expect(f.payloads).toEqual([]);
}, 30_000);

test("--json --continue reports the conversation it continued: the same session id", async () => {
  const f = await fixture();
  const first = await f.run(["--json", "remember ALPHA"]);
  const second = await f.run(["--json", "--continue", "which word?"]);
  const session = (stdout: string) => JSON.parse(stdout.split("\n")[0]!).session;
  expect({ first: first.exit, second: second.exit }).toEqual({ first: 0, second: 0 });
  expect(session(second.stdout)).toBe(session(first.stdout));
  expect(userText(f.payloads.at(-1)!)).toContain("remember ALPHA");
}, 60_000);

test("--continue picks up the latest conversation and --resume the one whose ID starts with a prefix", async () => {
  const f = await fixture();
  const fresh = await f.run(["--continue", "remember ALPHA"]);
  expect({ exit: fresh.exit, stderr: fresh.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(fresh.stdout).toContain("[session] No earlier conversation in this workspace; starting a new one.");
  await Bun.sleep(20);
  expect((await f.run(["remember BRAVO"])).exit).toBe(0);
  const [bravo, alpha] = await savedConversations(f);
  expect(alpha && bravo && alpha !== bravo).toBeTruthy();

  const continued = await f.run(["--continue", "which word?"]);
  expect({ exit: continued.exit, stderr: continued.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(continued.stdout).toContain(`[session] Continuing conversation ${bravo}.`);
  expect(userText(f.payloads.at(-1)!)).toContain("remember BRAVO");
  expect(userText(f.payloads.at(-1)!)).not.toContain("remember ALPHA");

  const resumed = await f.run(["--resume", alpha!.slice(0, 12), "which word?"]);
  expect({ exit: resumed.exit, stderr: resumed.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(userText(f.payloads.at(-1)!)).toContain("remember ALPHA");
  expect(userText(f.payloads.at(-1)!)).not.toContain("remember BRAVO");

  // One-shot flags change nothing for later runs: a plain prompt still starts a new conversation.
  expect((await f.run(["a fresh question"])).exit).toBe(0);
  expect(userText(f.payloads.at(-1)!)).not.toMatch(/remember (ALPHA|BRAVO)/);
  // Continuing left no empty conversations behind: ALPHA, BRAVO and the fresh question.
  const all = await savedConversations(f);
  expect(all).toHaveLength(3);

  const requests = f.payloads.length;
  let shared = 0;
  while (alpha![shared] === bravo![shared]) shared++;
  if (shared) {
    const ambiguous = await f.run(["--resume", alpha!.slice(0, shared), "hi"]);
    expect({ exit: ambiguous.exit, stderr: ambiguous.stderr }).toMatchObject({ exit: 64 });
    const matching = all.filter((id) => id.startsWith(alpha!.slice(0, shared))).length;
    expect(ambiguous.stderr).toContain(`matches ${matching} conversations; give more of the ID`);
  }
  for (const [args, message] of [
    [["--resume", "ffffffffffff", "hi"], "no saved conversation in this workspace starts with"],
    [["--continue", "--resume", alpha!, "hi"], "--continue and --resume cannot be combined"],
    [["--resume", "not a prefix!", "hi"], "--resume needs the start of a conversation ID"],
  ] as const) {
    const result = await f.run([...args]);
    expect({ args, exit: result.exit }).toEqual({ args, exit: 64 });
    expect(result.stderr).toContain(message);
  }
  expect(f.payloads.length).toBe(requests);
}, 120_000);

test("--max-turns stops a model that keeps working, runs no checks and exits 2", async () => {
  const f = await fixture((request) => ({ tools: [{ name: "write", args: { path: `turn-${request}.txt`, content: "x\n" } }] }));
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), "verify:\n  test: \"true\"\n");
  const result = await f.run(["--max-turns", "2", "--verify", "keep writing files"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 2, stderr: "" });
  expect(f.payloads).toHaveLength(2);
  expect(result.stdout).toContain("• Incomplete — stopped after 2 turns (--max-turns); changes so far are kept; casper --continue to go on");
  expect(result.stdout).toContain("✓ changed turn-0.txt, turn-1.txt");
  expect(result.stdout).not.toContain("Casper checking");
}, 60_000);
