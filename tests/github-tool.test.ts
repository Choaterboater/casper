import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assembleTaskTools, type TaskCapabilitySource } from "../src/app/capabilities";
import { loadConfiguration } from "../src/config/load";
import { githubEnv, GH_MISSING, GH_SIGNED_OUT, parseRemote } from "../src/github/gh";
import { githubTool, grantText, NOT_ASKABLE, RERUN_GAP_MS, UNTRUSTED, UNTRUSTED_END, type GithubHost } from "../src/github/tool";
import type { RuntimeTool } from "../src/runtime/types";
import type { ToolRunOptions, ToolRunResult } from "../src/security/spawn";
import { removeTempDir } from "./support/temp-dir";

const REPO = { owner: "acme", name: "widgets" };
const FAKE_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const ok = (stdout: string): ToolRunResult => ({ exitCode: 0, signal: null, stdout, stderr: "" });
const rollup = [
  { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/widgets/actions/runs/111/job/501" },
  { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/widgets/actions/runs/222/job/602" },
  { __typename: "StatusContext", context: "legacy/ci", state: "PENDING", targetUrl: "https://ci.example.invalid/1" },
];
const prJson = { number: 7, title: "Fix the thing", state: "OPEN", author: { login: "alice" }, headRefName: "fix-thing", baseRefName: "main", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "APPROVED", statusCheckRollup: rollup };

function setup(overrides: Partial<GithubHost> = {}, answer: (key: string) => boolean = () => true) {
  const calls: ToolRunOptions[] = [];
  const asked: Array<{ key: string; preview: string; question: string }> = [];
  const granted = new Set<string>();
  let log = "";
  const host: GithubHost = {
    root: () => "/tmp/none", interactive: () => true, reruns: new Map(), env: { PATH: "/usr/bin" },
    repo: async () => REPO,
    approve: async (key, preview, question) => {
      if (granted.has(key)) return true;
      asked.push({ key, preview, question });
      const yes = answer(key);
      if (yes) granted.add(key);
      return yes;
    },
    run: async (options) => {
      calls.push(options);
      const args = options.args;
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([prJson, { ...prJson, number: 8, title: "Draft\u001b[31m work", isDraft: true, statusCheckRollup: [] }]));
      if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify(prJson));
      if (args[0] === "run" && args[1] === "view") return ok(log);
      return ok("");
    },
    ...overrides,
  };
  return { host, tool: githubTool(host), calls, asked, setLog: (text: string) => { log = text; } };
}

test("argv is built exactly for each verb and never goes through a shell", async () => {
  const t = setup();
  await t.tool.execute({ verb: "prs" });
  await t.tool.execute({ verb: "pr", number: 7 });
  t.setLog("test\tRun tests\t2026-01-01T00:00:00.0000000Z boom");
  await t.tool.execute({ verb: "ci", number: 7 });
  await t.tool.execute({ verb: "rerun", number: 7 });
  expect(t.calls.map((call) => [call.file, ...call.args])).toEqual([
    ["gh", "pr", "list", "-R", "acme/widgets", "--state", "open", "--limit", "20", "--json", "number,title,author,headRefName,isDraft,mergeable,reviewDecision,statusCheckRollup"],
    ["gh", "pr", "view", "7", "-R", "acme/widgets", "--json", "number,title,state,author,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup"],
    ["gh", "pr", "view", "7", "-R", "acme/widgets", "--json", "number,title,state,author,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup"],
    ["gh", "run", "view", "--job", "602", "-R", "acme/widgets", "--log-failed"],
    ["gh", "pr", "view", "7", "-R", "acme/widgets", "--json", "number,title,state,author,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup"],
    ["gh", "run", "rerun", "222", "--failed", "-R", "acme/widgets"],
  ]);
  for (const call of t.calls) { expect(call.timeoutMs).toBe(30_000); expect(call.maxStdoutBytes).toBeGreaterThan(0); }
});

test("a pull request number must be a positive whole number; nothing runs for a bad one", async () => {
  const t = setup();
  for (const number of [0, -3, 1.5, "7; rm -rf /", "--web", undefined, null, Number.NaN, 2 ** 60]) {
    const result = await t.tool.execute({ verb: "pr", number });
    expect(result.isError).toBe(true);
  }
  expect((await t.tool.execute({ verb: "merge", number: 1 })).isError).toBe(true);
  expect(t.calls).toEqual([]);
  expect(t.asked).toEqual([]);
});

test("remotes: only github.com owner/name made of safe characters", () => {
  expect(parseRemote("https://github.com/acme/widgets.git")).toEqual(REPO);
  expect(parseRemote("git@github.com:acme/widgets.git")).toEqual(REPO);
  expect(parseRemote("ssh://git@github.com/acme/widgets")).toEqual(REPO);
  for (const bad of ["https://gitlab.com/acme/widgets", "https://github.com/-x/widgets", "https://github.com/acme/..", "https://github.com/a b/c", "https://github.com.evil.example/a/b", "https://github.com/acme/widgets/extra", ""]) {
    expect(parseRemote(bad)).toBeUndefined();
  }
});

test("output is labelled untrusted, cleaned of escape codes, and shows the checks and the failed ones", async () => {
  const t = setup();
  const prs = (await t.tool.execute({ verb: "prs" })).text;
  expect(prs.split("\n")[1]).toBe(UNTRUSTED);
  expect(prs.endsWith(UNTRUSTED_END)).toBe(true);
  expect(prs).toContain("#7 Fix the thing | alice | fix-thing | CI: 1 failing, 1 running, 1 passing");
  expect(prs).toContain("#8 Draft work");
  expect(prs).not.toContain("\u001b");
  const one = (await t.tool.execute({ verb: "pr", number: 7 })).text;
  expect(one).toContain("branch: fix-thing -> main");
  expect(one).toContain("check: test | completed | failure");
  expect(one).toContain("failed: test");
});

test("ci: the last 40 log lines, the failing step, secrets and escape codes gone", async () => {
  const t = setup();
  const lines = Array.from({ length: 100 }, (_, i) => `test\tRun tests\t2026-01-01T00:00:00.0000000Z line ${i + 1}`);
  lines.push(`test\tRun tests\t2026-01-01T00:00:01.0000000Z \u001b[31mError\u001b[0m token=${FAKE_TOKEN} Authorization: Bearer abcdef123456 and ${FAKE_TOKEN}`);
  t.setLog(lines.join("\n"));
  const text = (await t.tool.execute({ verb: "ci", number: 7 })).text;
  expect(text).toContain("failing step: Run tests");
  expect(text).toContain("last 40 log lines:");
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain("abcdef123456");
  expect(text).not.toContain("\u001b");
  expect(text).toContain("<redacted>");
  const logLines = text.split("\n").filter((line) => line.startsWith("  "));
  expect(logLines.length).toBe(40);
  expect(text).not.toContain("line 60");
  expect(text).toContain("line 100");
  expect(text.endsWith(UNTRUSTED_END)).toBe(true);
});

test("a token set for gh and one of Casper's own secrets are hidden even without a token shape", async () => {
  const t = setup({ env: { PATH: "/usr/bin", GH_TOKEN: "plain-secret-value-1" }, secrets: () => ["another-own-secret-9"] });
  t.setLog("test\tRun tests\t2026-01-01T00:00:00.0000000Z saw plain-secret-value-1 and another-own-secret-9");
  const text = (await t.tool.execute({ verb: "ci", number: 7 })).text;
  expect(text).not.toContain("plain-secret-value-1");
  expect(text).not.toContain("another-own-secret-9");
});

test("first use asks about the repo; No refuses and nothing runs; a yes is asked once", async () => {
  const no = setup({}, () => false);
  const refused = await no.tool.execute({ verb: "prs" });
  expect(refused.isError).toBe(true);
  expect(no.asked[0]!.question).toBe(grantText(REPO));
  expect(no.asked[0]!.question).toBe("Let Casper read this repo's pull requests and CI on GitHub (github.com/acme/widgets)? It re-runs failed checks only when you say yes.");
  expect(no.calls).toEqual([]);
  const yes = setup();
  await yes.tool.execute({ verb: "prs" });
  await yes.tool.execute({ verb: "pr", number: 7 });
  expect(yes.asked.filter((entry) => entry.key.startsWith("github:"))).toHaveLength(1);
});

test("a run that cannot ask refuses before any gh call", async () => {
  const t = setup({ interactive: () => false });
  const result = await t.tool.execute({ verb: "prs" });
  expect(result).toEqual({ text: NOT_ASKABLE, isError: true });
  expect(t.calls).toEqual([]);
});

test("rerun asks first, says what it does, and a No runs nothing", async () => {
  const t = setup({}, (key) => !key.startsWith("github-rerun"));
  const result = await t.tool.execute({ verb: "rerun", number: 7 });
  expect(result.isError).toBe(true);
  const box = t.asked.find((entry) => entry.key.startsWith("github-rerun"))!;
  expect(box.preview).toBe("Casper will re-run the failed jobs of pull request #7 on github.com/acme/widgets (1 run), with gh run rerun --failed.\nThis starts new CI runs on GitHub.\n");
  expect(box.question).toBe("Re-run the failed checks of pull request #7?");
  expect(t.calls.some((call) => call.args[1] === "rerun")).toBe(false);
});

test("rerun is limited to once per pull request per 10 minutes", async () => {
  let now = 1_000_000;
  const t = setup({ now: () => now });
  expect((await t.tool.execute({ verb: "rerun", number: 7 })).isError).toBeUndefined();
  now += RERUN_GAP_MS - 1000;
  const again = await t.tool.execute({ verb: "rerun", number: 7 });
  expect(again.isError).toBe(true);
  expect(again.text).toContain("waits 10 minutes");
  expect(t.calls.filter((call) => call.args[1] === "rerun")).toHaveLength(1);
  expect(t.asked.filter((entry) => entry.key.startsWith("github-rerun"))).toHaveLength(1);
  now += 2000;
  expect((await t.tool.execute({ verb: "rerun", number: 7 })).isError).toBeUndefined();
  expect(t.calls.filter((call) => call.args[1] === "rerun")).toHaveLength(2);
});

test("gh missing and gh signed out say one plain line with the next step", async () => {
  const missing = setup({ run: async () => ({ exitCode: null, signal: null, stdout: "", stderr: "", ended: "no_start" }) });
  expect(await missing.tool.execute({ verb: "prs" })).toEqual({ text: GH_MISSING, isError: true });
  const out = setup({ run: async () => ({ exitCode: 4, signal: null, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }) });
  expect(await out.tool.execute({ verb: "prs" })).toEqual({ text: GH_SIGNED_OUT, isError: true });
  expect(GH_SIGNED_OUT).toContain("gh auth login");
  const other = setup({ run: async () => ({ exitCode: 1, signal: null, stdout: "", stderr: `boom ${FAKE_TOKEN}` }) });
  const text = (await other.tool.execute({ verb: "prs" })).text;
  expect(text).not.toContain(FAKE_TOKEN);
});

test("the environment gh gets: a short allowlist; only GH_TOKEN and GITHUB_TOKEN of the token-looking names", () => {
  const env = githubEnv({ PATH: "/bin", HOME: "/home/x", USER: "x", GH_TOKEN: "a", GITHUB_TOKEN: "b", OPENROUTER_API_KEY: "c", AWS_SECRET_ACCESS_KEY: "d", NPM_TOKEN: "e", GH_HOST: "evil.example", GH_REPO: "x/y", GH_DEBUG: "api", SOMETHING: "f" }, "linux");
  expect(Object.keys(env).sort()).toEqual(["GH_NO_EXTENSION_UPDATE_NOTIFIER", "GH_NO_UPDATE_NOTIFIER", "GH_PROMPT_DISABLED", "GH_SPINNER_DISABLED", "GH_TOKEN", "GITHUB_TOKEN", "HOME", "NO_COLOR", "PATH", "USER"]);
});

// The switch.
const tool = (name: string): RuntimeTool => ({ name, description: name, inputSchema: { type: "object" }, execute: async () => ({ text: "" }) });
function source(overrides: Partial<TaskCapabilitySource> = {}): TaskCapabilitySource {
  return {
    broker: { prepare: async () => [] } as never, delegate: tool("delegate"), ask: tool("ask"),
    lsp: { status: () => [] } as never, confirmRename: async () => false, references: { tools: () => [] } as never,
    visualization: { providerNames: () => ["mermaid"] } as never, projectRoot: "/tmp/none",
    browserReady: false, browserInstalled: false, browser: () => { throw new Error("not started"); },
    services: { declared: false, live: false }, serviceTool: () => tool("service"), githubTool: () => tool("github"),
    ...overrides,
  };
}
const names = async (task: string, overrides: Partial<TaskCapabilitySource> = {}) => (await assembleTaskTools(task, source(overrides))).map((entry) => entry.name);

test("the tool comes in only when the request names pull requests or CI, then stays; github: off takes it away", async () => {
  expect(await names("Add a sum function to src/math.ts")).not.toContain("github");
  expect(await names("check my PRs and see why CI failed")).toContain("github");
  expect(await names("any open pull requests?")).toContain("github");
  expect(await names("add a sum function", { offered: new Set(["github"]) })).toContain("github");
  expect(await names("check my PRs", { githubOff: true })).not.toContain("github");
  expect(await names("add a sum function", { githubOff: true, offered: new Set(["github"]) })).not.toContain("github");
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

test("github: off loads from your config; a project file cannot set it, and neither can a profile it picks", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-github-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  const config = path.join(home, ".casper", "config.yaml"), projectFile = path.join(project, ".casper", "project.yaml");
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect((await load()).github).toBeUndefined();
  await writeFile(config, "github: off\n");
  expect((await load()).github).toBe(false);
  await writeFile(projectFile, "github: on\n");
  await expect(load()).rejects.toThrow("github is a user setting");
  await mkdir(path.join(home, ".casper", "profiles", "lab"), { recursive: true });
  await writeFile(path.join(home, ".casper", "profiles", "lab", "config.yaml"), "github: on\n");
  await writeFile(projectFile, "profile: lab\n");
  expect((await load()).github).toBe(false);
  await writeFile(config, "github: maybe\n");
  await expect(load()).rejects.toThrow("github must be on or off");
});
