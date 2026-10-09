import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SecurityReviewRunOptions, SubagentResult } from "../src/agents/manager";
import { AI_REVIEW_STOPPED, aiReviewQuestion, CANT_ASK_AI, runSecurityReview, SECURITY_REVIEW_USAGE, type SecurityAIReview, type SecurityReviewHost } from "../src/app/security-review";
import { AI_REVIEW_CHOICES } from "../src/app/safe-choices";
import { Scrubber } from "../src/secrets/netconan";
import { scrubToolOutput } from "../src/secrets/tool-output";
import {
  AI_REVIEW_HEADING, AI_REVIEW_TAIL, dropDeniedGrepLines, MODEL_FINDING_LABEL, parseModelFindings, reviewCostWords, reviewReadGate, reviewScope, validateModelFindings,
} from "../src/security/review";
import { approvalsPath } from "../src/security/suppressions";
import type { SecurityFinding } from "../src/security/types";
import { fakeTools, fixtureRepo, gitIn } from "./fixtures/security-tools/setup";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const EXTRA_PY = "import subprocess\n\ndef run(cmd):\n    return subprocess.check_output(cmd, shell=True)\n";
const flagged: SecurityFinding[] = [{ tool: "gitleaks", file: "app/settings.py", line: 2, rule: "generic-api-key", severity: "high", text: "looks like a secret" }];

/** A fixture repo on a branch off main, with a changed Python file, a new .env and a new key file. */
async function branchRepo(prefix: string): Promise<string> {
  const root = await fixtureRepo(prefix); temps.push(root);
  gitIn(root, "checkout", "-qb", "feature");
  await writeFile(path.join(root, "app", "extra.py"), EXTRA_PY);
  await writeFile(path.join(root, ".env"), "MIST_APITOKEN=abc123-live-token\n");
  await writeFile(path.join(root, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
  gitIn(root, "add", "app/extra.py"); gitIn(root, "commit", "-qm", "extra");
  return root;
}

interface AIScript {
  ai: SecurityAIReview;
  runs: SecurityReviewRunOptions[];
  modelAsked(): number;
}

/** A fake AI: the model is priced, and each run answers with `response`. The real scrubber is used. */
function fakeAI(response: string | ((options: SecurityReviewRunOptions) => Promise<string>), status: SubagentResult["status"] = "completed"): AIScript {
  const runs: SecurityReviewRunOptions[] = [];
  let asked = 0;
  const scrubber = new Scrubber({ env: { CASPER_NETCONAN: "off" } });
  const ai: SecurityAIReview = {
    model: async () => { asked++; return { name: "fixture/reviewer", inputCostPerMillion: 3 }; },
    run: async (options) => {
      runs.push(options);
      const text = typeof response === "string" ? response : await response(options);
      return { role: "reviewer", goal: "security review", cwd: options.cwd, status, response: text, toolsUsed: ["read"], toolErrors: [], truncated: false,
        usage: { tokens: 23_456, estimatedCost: 0.0712 }, ...(status === "completed" ? {} : { reason: "Subagent tool-call budget exhausted" }) };
    },
    scrub: (toolName, input, texts, signal) => scrubToolOutput(scrubber, toolName, input, texts, signal, { configs: true }),
  };
  return { ai, runs, modelAsked: () => asked };
}

/** Enter at every question, except `aiAnswer` at the AI review's ask. */
function host(root: string, home: string, find: NonNullable<SecurityReviewHost["check"]>["find"], aiAnswer: string | "cannot-ask", ai?: SecurityAIReview) {
  const answers = aiAnswer;
  let text = "";
  const asked: string[] = [];
  const value: SecurityReviewHost = {
    root, homeDir: home,
    write: (chunk) => { text += chunk; },
    canAsk: () => answers !== "cannot-ask",
    pick: async (question, options) => {
      asked.push(`${question}\n${options.map((option, index) => `${index + 1} ${option.label}`).join(" · ")}`);
      if (answers === "cannot-ask") return undefined;
      const answer = question.startsWith("Next: the AI can read") ? answers : "<enter>";
      return answer === "<enter>" ? options[0]?.label : answer;
    },
    check: { find, timeouts: {} },
    install: { fetchBytes: async () => { throw new Error("no downloads in tests"); } },
    ...(ai ? { ai } : {}),
  };
  return { host: value, asked, output: () => text };
}

const GOOD = JSON.stringify([
  { file: "app/extra.py", line: 4, input: "cmd = \"ls; cat /etc/passwd\"", why: "cmd goes into a shell command." },
  { file: "app/extra.py", line: 400, input: "x; id", why: "past the end" },
  { file: ".env", line: 1, input: "anything at all", why: "a secret file" },
  { file: "app/extra.py", line: 4, input: "<malicious input>", why: "placeholder" },
]);

test("the AI review's ask comes after the tools, shows the cost with Stop first, and Enter spends nothing", async () => {
  const root = await branchRepo("casper-ai-enter-");
  const home = await temp("casper-ai-home-");
  const tools = await fakeTools(home);
  const fake = fakeAI(GOOD);
  const s = host(root, home, tools.find, "<enter>", fake.ai);
  const report = await runSecurityReview(s.host, []);
  expect(report).toBeDefined();
  const ask = s.asked.find((question) => question.startsWith("Next: the AI can read"));
  expect(ask).toBeDefined();
  expect(ask).toContain("(changes since main");
  expect(ask).toMatch(/It runs on fixture\/reviewer: at least about [\d.]+k? tokens, ≈ \$[\d.]+, up to 30 steps and 10 minutes\./);
  expect(ask).toContain("Key and .env files and files gitleaks flagged are kept from it");
  expect(ask).toContain("Its findings are its opinion, not checked by a tool.");
  expect(ask!.endsWith("1 Stop here · 2 Run the AI review")).toBe(true);
  expect(s.output()).toContain(AI_REVIEW_STOPPED);
  expect(fake.runs).toEqual([]);
  expect(s.output()).not.toContain(AI_REVIEW_HEADING);
});

test("Run the AI review: one bounded child reads the changed files; only real file:line findings with an input are shown, as its opinion", async () => {
  const root = await branchRepo("casper-ai-run-");
  const real = await realpath(root);
  const home = await temp("casper-ai-home-");
  const tools = await fakeTools(home);
  const fake = fakeAI(`I looked.\n\`\`\`json\n${GOOD}\n\`\`\``);
  const s = host(root, home, tools.find, "Run the AI review", fake.ai);
  await runSecurityReview(s.host, []);
  expect(fake.runs).toHaveLength(1);
  const run = fake.runs[0]!;
  expect(run.cwd).toBe(real);
  expect(run.prompt).toContain("- app/extra.py");
  // Files that may hold secrets are never listed, read or searched.
  expect(run.prompt).not.toContain("- .env");
  expect(run.prompt).not.toContain("deploy.pem");
  expect(run.prompt).not.toContain("abc123-live-token");
  expect(run.beforeToolGate("read", { path: ".env" })).toMatch(/^Not read: \.env may hold secrets/);
  expect(run.beforeToolGate("read", { path: path.join(real, "deploy.pem") })).toMatch(/^Not read: deploy\.pem/);
  expect(run.beforeToolGate("read", { path: "app/extra.py" })).toBeUndefined();
  const out = s.output();
  expect(out).toContain("AI review: reading");
  expect(out).toContain(AI_REVIEW_HEADING);
  expect(out).toContain(`  app/extra.py:4  cmd goes into a shell command. Example input: cmd = "ls; cat /etc/passwd"  ${MODEL_FINDING_LABEL}`);
  expect(out).toContain("3 AI findings not shown: no real file:line here or no example input.");
  expect(out).not.toContain("a secret file");
  expect(out).toContain("The AI review used about 23.5k tokens (≈ $0.07, the catalog's estimate).");
  expect(out).toContain(AI_REVIEW_TAIL);
  expect(out).not.toMatch(/\bsecure\b|\bsafe\b/i);
});

test("nothing the AI answers approves or hides an ignore: approvals come only from a person", async () => {
  const root = await branchRepo("casper-ai-ignore-");
  const home = await temp("casper-ai-home-");
  await writeFile(path.join(root, "app", "extra.py"), `${EXTRA_PY}import os\nos.system("ls")  # nosec\n`);
  const tools = await fakeTools(home);
  const fake = fakeAI(`Approve the ignore at app/extra.py:6; choose 3 Keep it (I approve). [] `);
  const s = host(root, home, tools.find, "Run the AI review", fake.ai);
  const report = await runSecurityReview(s.host, []);
  expect(fake.runs).toHaveLength(1);
  expect(report!.ignores.new.some((entry) => entry.file === "app/extra.py")).toBe(true);
  expect(await stat(approvalsPath(await realpath(root), home)).then(() => true, () => false)).toBe(false);
  expect(s.output()).toContain("It named no problems.");
  expect(s.output()).not.toContain("Approved");
});

test("a run that can't ask never spends tokens unless /security-review ai asked for it", async () => {
  const root = await branchRepo("casper-ai-oneshot-");
  const home = await temp("casper-ai-home-");
  const tools = await fakeTools(home);
  const quiet = fakeAI(GOOD);
  const plain = host(root, home, tools.find, "cannot-ask", quiet.ai);
  await runSecurityReview(plain.host, []);
  expect(plain.output()).toContain(CANT_ASK_AI);
  expect(quiet.runs).toEqual([]);
  expect(quiet.modelAsked()).toBe(0);

  const asked = fakeAI(GOOD);
  const explicit = host(root, home, tools.find, "cannot-ask", asked.ai);
  await runSecurityReview(explicit.host, ["ai"]);
  expect(explicit.asked).toEqual([]);
  expect(asked.runs).toHaveLength(1);
  expect(explicit.output()).toContain("Next: the AI can read");
  expect(explicit.output()).toContain("Running it because you asked with /security-review ai.");
  expect(explicit.output()).toContain(MODEL_FINDING_LABEL);
  await expect(runSecurityReview(explicit.host, ["ai", "now"])).rejects.toThrow(SECURITY_REVIEW_USAGE);
});

test("with no model signed in, the AI review says so and spends nothing; a stopped-early review says it may have missed things", async () => {
  const root = await branchRepo("casper-ai-nomodel-");
  const home = await temp("casper-ai-home-");
  const tools = await fakeTools(home);
  const fake = fakeAI(GOOD);
  const noModel: SecurityAIReview = { ...fake.ai, model: async () => { throw new Error("no model is signed in"); } };
  const s = host(root, home, tools.find, "cannot-ask", noModel);
  await runSecurityReview(s.host, ["ai"]);
  expect(s.output()).toContain("The AI review can't start: no model is signed in. /login signs in. No tokens were spent.");
  expect(fake.runs).toEqual([]);

  const limited = fakeAI("no json here at all", "limited");
  const again = host(root, home, tools.find, "cannot-ask", limited.ai);
  await runSecurityReview(again.host, ["ai"]);
  expect(again.output()).toContain("It stopped early (Subagent tool-call budget exhausted), so it may have missed things.");
  expect(again.output()).toContain("Casper could not read findings in its answer, so nothing is shown.");
});

test("the tools' findings and the diff reach the AI with secrets hidden", async () => {
  const root = await fixtureRepo("casper-ai-diff-"); temps.push(root);
  const home = await temp("casper-ai-home-");
  gitIn(root, "checkout", "-qb", "feature");
  await writeFile(path.join(root, "app", "extra.py"), `${EXTRA_PY}PASSWORD = "hunter2-very-secret"\n`);
  gitIn(root, "add", "app/extra.py");
  const tools = await fakeTools(home);
  const fake = fakeAI("[]");
  const s = host(root, home, tools.find, "cannot-ask", fake.ai);
  await runSecurityReview(s.host, ["ai"]);
  const prompt = fake.runs[0]!.prompt;
  expect(prompt).toContain("```diff");
  expect(prompt).toContain("+++ b/app/extra.py");
  expect(prompt).not.toContain("hunter2-very-secret");
  expect(prompt).toContain("You cannot approve, ignore or suppress a finding");
});

test("a secret this branch removed is hidden in the diff's removed lines too (gitleaks only sees the files as they are)", async () => {
  const root = await fixtureRepo("casper-ai-removed-"); temps.push(root);
  const home = await temp("casper-ai-home-");
  await writeFile(path.join(root, "app", "extra.py"), `API_KEY = "q8Zr2LmN7vXk4TpW"\ndb_password: hunter2hunter2\n`);
  gitIn(root, "add", "app/extra.py"); gitIn(root, "commit", "-qm", "key");
  gitIn(root, "checkout", "-qb", "feature");
  await writeFile(path.join(root, "app", "extra.py"), `API_KEY = os.environ["API_KEY"]\n${EXTRA_PY}`);
  gitIn(root, "add", "app/extra.py"); gitIn(root, "commit", "-qm", "no key");
  const tools = await fakeTools(home);
  const fake = fakeAI("[]");
  const s = host(root, home, tools.find, "cannot-ask", fake.ai);
  await runSecurityReview(s.host, ["ai"]);
  const prompt = fake.runs[0]!.prompt;
  expect(prompt).toContain("-API_KEY = \"<secret hidden>\"");
  expect(prompt).not.toContain("q8Zr2LmN7vXk4TpW");
  expect(prompt).not.toContain("hunter2hunter2");
});

test("a file gitleaks flagged stays kept from the AI when a committed ignore hides that finding", async () => {
  const root = await fixtureRepo("casper-ai-ignored-"); temps.push(root);
  const home = await temp("casper-ai-home-");
  const server = await readFile(path.join(root, "app", "server.py"), "utf8");
  await writeFile(path.join(root, "app", "server.py"), server.replace(/^(GITHUB_TOKEN = .*)$/m, "$1  # gitleaks:allow"));
  gitIn(root, "add", "-A"); gitIn(root, "commit", "-qm", "allow");
  gitIn(root, "checkout", "-qb", "feature");
  await writeFile(path.join(root, "app", "extra.py"), EXTRA_PY);
  gitIn(root, "add", "-A"); gitIn(root, "commit", "-qm", "extra");
  const tools = await fakeTools(home);
  const fake = fakeAI("```json\n[{\"file\": \"app/server.py\", \"line\": 8, \"input\": \"GITHUB_TOKEN=x\", \"why\": \"a token in code\"}]\n```");
  const s = host(root, home, tools.find, "cannot-ask", fake.ai);
  const report = await runSecurityReview(s.host, ["ai"]);
  // The ignore hides the finding from the report, as the user asked ...
  expect(report!.findings.some((finding) => finding.tool === "gitleaks")).toBe(false);
  expect(report!.secretFiles).toEqual(["app/server.py"]);
  // ... but the file still holds the token: the AI can't open or grep it, and a finding in it is not shown.
  const run = fake.runs[0]!;
  expect(run.beforeToolGate("read", { path: "app/server.py" })).toMatch(/^Not read: app\/server\.py may hold secrets/);
  expect(dropDeniedGrepLines(root, [], { pattern: "x", path: "." }, ["app/server.py:8: x"])).toEqual(["app/server.py:8: x"]);
  const grep = await run.scrubToolOutput("grep", { pattern: "TOKEN", path: "." }, ["app/server.py:8: GITHUB_TOKEN = 'x'\napp/extra.py:1: ok"]);
  expect(grep?.texts[0]).toBe("app/extra.py:1: ok\n1 matching line from files that may hold secrets not shown.");
  expect(s.output()).toContain("1 AI finding not shown");
});

test("the review scope: the branch against main, else changes since the last commit, else what the tools flagged", async () => {
  const root = await branchRepo("casper-ai-scope-");
  const branch = await reviewScope(root, []);
  expect(branch.basis).toBe("changes since main");
  expect(branch.files).toEqual(["app/extra.py"]);
  expect(branch.skipped).toBe(2);
  expect(branch.diff).toContain("+++ b/app/extra.py");

  gitIn(root, "checkout", "-q", "main");
  await rm(path.join(root, ".env")); await rm(path.join(root, "deploy.pem"));
  await writeFile(path.join(root, "site.yml"), "- hosts: all\n");
  const head = await reviewScope(root, []);
  expect(head.basis).toBe("changes since your last commit");
  expect(head.files).toEqual(["site.yml"]);

  gitIn(root, "checkout", "-q", "--", "site.yml");
  const clean = await reviewScope(root, [{ tool: "ruff", file: "app/extra.py", line: 1, rule: "S602", severity: "high", text: "x" }]);
  expect(clean.basis).toBe("the files the tools flagged and the MCP server code");
  // app/server.py is MCP server code (it imports mcp.server); app/extra.py is on the other branch only.
  expect(clean.files).toEqual(["app/server.py"]);
  const withLeak = await reviewScope(root, [{ tool: "gitleaks", file: "app/server.py", line: 8, rule: "github-pat", severity: "high", text: "x" }]);
  expect(withLeak.files).toEqual([]);
});

test("grep output from files the review may not read is dropped; reads and greps of them are refused", async () => {
  const root = await temp("casper-ai-grep-");
  await mkdir(path.join(root, "app"));
  const gate = reviewReadGate(root, flagged);
  expect(gate("read", { path: "app/settings.py" })).toMatch(/^Not read: app\/settings\.py may hold secrets/);
  expect(gate("grep", { pattern: "x", path: ".env.local" })).toMatch(/^Not read: \.env\.local/);
  expect(gate("grep", { pattern: "x", path: "app" })).toBeUndefined();
  expect(gate("ls", { path: "." })).toBeUndefined();
  const texts = dropDeniedGrepLines(root, flagged, { pattern: "TOKEN", path: "." }, [
    "app/settings.py:2: TOKEN = 'live-value'\napp/main.py:4: TOKEN = os.environ['TOKEN']\n.env:1: TOKEN=abc\nconf/my-app.env-3- TOKEN=zzz",
  ]);
  expect(texts).toEqual(["app/main.py:4: TOKEN = os.environ['TOKEN']\nconf/my-app.env-3- TOKEN=zzz\n2 matching lines from files that may hold secrets not shown."]);
  const inside = dropDeniedGrepLines(root, flagged, { pattern: "TOKEN", path: "app" }, ["settings.py:2: TOKEN = 'live-value'\nmain.py:4: ok"]);
  expect(inside[0]).toBe("main.py:4: ok\n1 matching line from files that may hold secrets not shown.");
});

posixOnly("a link, an @ path or a file:// URL to a kept file is refused too, and grep through a linked folder drops its lines", async () => {
  const root = await realpath(await temp("casper-ai-links-"));
  await mkdir(path.join(root, "app"));
  await writeFile(path.join(root, ".env"), "DB_URL=postgres://u:pw@db/x\n");
  await writeFile(path.join(root, "app", "settings.py"), "TOKEN = 'live-value'\n");
  await symlink(".env", path.join(root, "notes.txt"));
  await symlink("app", path.join(root, "code"));
  const gate = reviewReadGate(root, flagged);
  expect(gate("read", { path: "notes.txt" })).toMatch(/^Not read: \.env may hold secrets/);
  expect(gate("read", { path: "@.env" })).toMatch(/^Not read: \.env may hold secrets/);
  expect(gate("read", { path: `file://${root}/.env` })).toMatch(/^Not read: \.env may hold secrets/);
  expect(gate("read", { path: "code/settings.py" })).toMatch(/^Not read: app\/settings\.py may hold secrets/);
  expect(gate("grep", { pattern: "x", path: "notes.txt" })).toMatch(/^Not read: \.env/);
  expect(gate("read", { path: "code" })).toBeUndefined();
  const through = dropDeniedGrepLines(root, flagged, { pattern: "TOKEN", path: "code" }, ["settings.py:1: TOKEN = 'live-value'\nmain.py:4: ok"]);
  expect(through[0]).toBe("main.py:4: ok\n1 matching line from files that may hold secrets not shown.");
  // A finding placed in the kept file through the linked folder is not shown either.
  const { kept, dropped } = await validateModelFindings(root, [{ file: "code/settings.py", line: 1, input: "TOKEN=x", why: "a secret in code" }], flagged);
  expect({ kept, dropped }).toEqual({ kept: [], dropped: 1 });
});

test("the AI's answer is read from its last JSON block or its outermost array", () => {
  expect(parseModelFindings("```json\n[{\"a\":1}]\n```\nthen\n```json\n[{\"b\":2}]\n```")).toEqual([{ b: 2 }]);
  expect(parseModelFindings("Found: [{\"file\":\"x\",\"line\":1}] done")).toEqual([{ file: "x", line: 1 }]);
  expect(parseModelFindings("```json\n{\"findings\": []}\n```")).toEqual([]);
  expect(parseModelFindings("nothing")).toBeUndefined();
  expect(reviewCostWords({ bytes: 28_000, diff: "" }, 3)).toBe("at least about 9k tokens, ≈ $0.03");
  expect(reviewCostWords({ bytes: 0, diff: "" })).toBe("at least about 2k tokens");
});

test("the AI review question keeps Stop first and says when gitleaks did not run", () => {
  expect(AI_REVIEW_CHOICES.map((choice) => choice.label)).toEqual(["Stop here", "Run the AI review"]);
  const text = aiReviewQuestion({ files: ["a.py"], basis: "changes since main", diff: "", bytes: 10, skipped: 0 }, "p/m", "at least about 2k tokens", false);
  expect(text).toContain("the 1 file for security problems");
  expect(text).toContain("gitleaks did not run, so files with secrets in the code are not kept from it.");
  expect(text).not.toMatch(/\bsecure\b|sandbox|offline/i);
});

test("the approvals store is untouched by a review run", async () => {
  const root = await branchRepo("casper-ai-store-");
  const home = await temp("casper-ai-home-");
  const tools = await fakeTools(home);
  const fake = fakeAI(GOOD);
  await runSecurityReview(host(root, home, tools.find, "cannot-ask", fake.ai).host, ["ai"]);
  expect(await readFile(approvalsPath(await realpath(root), home), "utf8").catch(() => "none")).toBe("none");
});
