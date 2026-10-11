import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hideFolders, parseArgs } from "../scripts/compare/compare";
import { serveJudge, type JudgeApp } from "../scripts/compare/judge";
import { defaultModelIn, skyn3tModelEnv } from "../scripts/compare/model";
import { runOwned } from "../scripts/compare/proc";
import { pickPrompt, PROMPT_SETS, PROMPTS } from "../scripts/compare/prompts";
import { formatTally, shuffleLabels, tally, type PickRecord, type RunRecord } from "../scripts/compare/results";
import { builtApp, failureReason, runCasperSide, runSkyn3tSide, type SideJob } from "../scripts/compare/sides";
import { appEnvironment, localUrlIn, planStart, serveStatic, startApp } from "../scripts/compare/start-app";
import { removeTempDir } from "./support/temp-dir";

const temp = () => mkdtemp(path.join(os.tmpdir(), "casper-compare-"));
const prompt = PROMPTS.find((candidate) => candidate.id === "web-budget")!;
const improve = PROMPTS.find((candidate) => candidate.starter === "plain-html")!;

describe("model matching", () => {
  test("Casper's startup default is read from settings.json; anything else is no default", () => {
    expect(defaultModelIn(JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5-5" }))).toBe("anthropic/claude-sonnet-5-5");
    expect(defaultModelIn(JSON.stringify({ defaultProvider: "anthropic" }))).toBeUndefined();
    expect(defaultModelIn("not json")).toBeUndefined();
  });

  test("each provider SkyN3t can reach gets its backend and model; Claude is let through only when asked for", () => {
    const claude = skyn3tModelEnv("anthropic/claude-sonnet-5-5");
    expect("env" in claude && claude.env).toMatchObject({ SKYN3T_LLM_BACKEND: "claude_cli", SKYN3T_CODEGEN_CLI_MODEL: "claude-sonnet-5-5", SKYN3T_NO_CLAUDE: "false", SKYN3T_CODEGEN_CLI_PROVIDER: "" });
    const codex = skyn3tModelEnv("openai-codex/gpt-5.1-codex");
    expect("env" in codex && codex.env).toMatchObject({ SKYN3T_LLM_BACKEND: "codex_cli", SKYN3T_CODEGEN_CLI_MODEL: "gpt-5.1-codex" });
    expect("env" in codex && codex.env.SKYN3T_NO_CLAUDE).toBeUndefined();
    const paid = skyn3tModelEnv("openrouter/deepseek/deepseek-chat");
    expect("env" in paid && paid.env).toMatchObject({ SKYN3T_LLM_BACKEND: "openrouter", SKYN3T_PREFERRED_MODEL: "deepseek/deepseek-chat", SKYN3T_FREE_ONLY: "false", SKYN3T_MODEL_STRONG: "deepseek/deepseek-chat" });
    const free = skyn3tModelEnv("openrouter/qwen/qwen3-coder:free");
    expect("env" in free && free.env.SKYN3T_FREE_ONLY).toBe("true");
  });

  test("a provider SkyN3t can't use, or a name without a provider, is refused with what to do", () => {
    expect(skyn3tModelEnv("ollama/llama3")).toEqual({ error: expect.stringContaining("SkyN3t can't use ollama models") });
    expect(skyn3tModelEnv("claude-sonnet")).toEqual({ error: expect.stringContaining("not a provider/model name") });
  });
});

describe("prompts, labels and the scoreboard", () => {
  test("every set has prompts, ids are unique, and every starter an improve prompt names exists", () => {
    for (const set of PROMPT_SETS) expect(PROMPTS.some((candidate) => candidate.set === set)).toBe(true);
    expect(new Set(PROMPTS.map((candidate) => candidate.id)).size).toBe(PROMPTS.length);
    for (const candidate of PROMPTS.filter((item) => item.set === "improve")) {
      expect(candidate.starter).toBeDefined();
      expect(existsSync(path.join(import.meta.dir, "..", "scripts", "compare", "starters", candidate.starter!, "index.html"))).toBe(true);
    }
  });

  test("the least-judged prompt in the set comes next", () => {
    const web = PROMPTS.filter((candidate) => candidate.set === "web");
    const counts = new Map(web.map((candidate, index) => [candidate.id, index === 2 ? 0 : 1]));
    expect(pickPrompt("web", counts, () => 0.99).id).toBe(web[2]!.id);
    expect(pickPrompt("web", new Map(), () => 0).id).toBe(web[0]!.id);
  });

  test("X, Y and Z are always the three sides, once each, in an order the random source decides", () => {
    for (let i = 0; i < 20; i++) expect(Object.values(shuffleLabels()).sort()).toEqual(["A", "B", "C"]);
    expect(shuffleLabels(() => 0)).toEqual({ X: "B", Y: "C", Z: "A" });
    expect(shuffleLabels(() => 0.99)).toEqual({ X: "A", Y: "B", Z: "C" });
  });

  test("the tally counts wins and ties per side and set, and narrows by day and experiment", () => {
    const pick = (overrides: Partial<PickRecord>): PickRecord => ({
      v: 1, time: "2026-10-12T10:00:00.000Z", runId: "r", set: "web", promptId: "web-budget", model: "m", pick: "B",
      labels: { X: "A", Y: "B", Z: "C" }, experiment: { commit: "abc1234", dirty: false }, started: { A: true, B: true, C: true }, ...overrides,
    });
    const picks = [pick({}), pick({ pick: "C", set: "hobby" }), pick({ pick: "tie" }), pick({ pick: "A", time: "2026-10-01T10:00:00.000Z", experiment: { commit: "def5678", dirty: true } })];
    const all = tally(picks);
    expect(all.total).toEqual({ picks: 4, wins: { A: 1, B: 1, C: 1 }, ties: 1 });
    expect(all.bySet.web?.picks).toBe(3);
    expect(all.experiments).toEqual(["abc1234", "def5678+changes"]);
    expect(tally(picks, { since: "2026-10-10" }).total.picks).toBe(3);
    expect(tally(picks, { experiment: "def" }).total.wins.A).toBe(1);
    expect(formatTally(all)).toContain("B  Casper experiment    1   25%");
    expect(formatTally(tally([]))).toContain("No picks yet");
  });
});

describe("the command line", () => {
  test("options take values with a space or =, and an unknown one is an error, not a prompt", () => {
    const { positional, flags } = parseArgs(["run", "web", "--model=anthropic/x", "--minutes", "5", "--yes"]);
    expect(positional).toEqual(["run", "web"]);
    expect([...flags]).toEqual([["model", "anthropic/x"], ["minutes", "5"], ["yes", true]]);
    expect(() => parseArgs(["run", "--modle", "x"])).toThrow("Unknown option --modle");
    expect(() => parseArgs(["run", "--model"])).toThrow("--model needs a value");
  });

  test("logs on the judge page name no side: app folders and the run folder are replaced", () => {
    const run = path.join("/home", "u", "casper-compare", "runs", "r1");
    const appC = path.join(run, "C", "projects", "app");
    const appA = path.join(run, "A", "app");
    const text = `npm ERR! in ${appC}/node_modules\nwrote ${path.join(run, "A", "start.log")} and ${appA}`;
    const hidden = hideFolders(text, run, [path.join(run, "B", "app"), appA, appC]);
    expect(hidden).toBe(`npm ERR! in <app folder>/node_modules\nwrote <run folder>${path.sep}<side>${path.sep}start.log and <app folder>`);
    expect(hidden).not.toContain("projects");
  });
});

describe("starting an app", () => {
  test("a dev script wins over index.html; a front-end subfolder is found; plain files are served as they are", async () => {
    const dir = await temp();
    try {
      const vite = path.join(dir, "vite");
      await mkdir(path.join(vite, "node_modules"), { recursive: true });
      await writeFile(path.join(vite, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }));
      await writeFile(path.join(vite, "index.html"), "<p>hi</p>");
      expect(await planStart(vite)).toEqual({ kind: "command", dir: vite, install: [], command: ["npm", "run", "dev"] });

      const split = path.join(dir, "split");
      await mkdir(path.join(split, "frontend"), { recursive: true });
      await mkdir(path.join(split, "api"), { recursive: true });
      await writeFile(path.join(split, "api", "package.json"), JSON.stringify({ scripts: { start: "node api.js" } }));
      await writeFile(path.join(split, "frontend", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      await writeFile(path.join(split, "frontend", "bun.lock"), "");
      expect(await planStart(split)).toMatchObject({ kind: "command", dir: path.join(split, "frontend"), install: [[process.execPath, "install"]], command: [process.execPath, "run", "dev"] });

      const fastapi = path.join(dir, "py");
      await mkdir(fastapi);
      await writeFile(path.join(fastapi, "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
      const plan = await planStart(fastapi);
      expect(plan.kind === "command" && plan.command.slice(1)).toEqual(["-m", "uvicorn", "main:app", "--port", "{port}"]);

      const plain = path.join(dir, "plain");
      await mkdir(path.join(plain, "public"), { recursive: true });
      await writeFile(path.join(plain, "public", "index.html"), "<p>hi</p>");
      expect(await planStart(plain)).toEqual({ kind: "static", root: path.join(plain, "public") });

      await mkdir(path.join(dir, "empty"));
      expect(await planStart(path.join(dir, "empty"))).toMatchObject({ kind: "none" });
      expect(await planStart(null)).toMatchObject({ kind: "none", reason: "This side left no app folder." });
    } finally { await removeTempDir(dir); }
  });

  test("an app's install and dev scripts see no keys, tokens or passwords from this shell", () => {
    const env = appEnvironment({ PATH: "/bin", HOME: "/home/u", OPENROUTER_API_KEY: "k", GITHUB_TOKEN: "t", DB_PASSWORD: "p", SSH_AUTH_SOCK: "s", LANG: "C" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/u", LANG: "C" });
  });

  test("the address a dev server prints is found through its colors", () => {
    expect(localUrlIn("  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m")).toBe("http://localhost:5173/");
    expect(localUrlIn("   - Local:        http://localhost:3000\n")).toBe("http://localhost:3000");
    expect(localUrlIn("Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)")).toBe("http://127.0.0.1:8000");
    expect(localUrlIn("listening on http://0.0.0.0:4000")).toBe("http://localhost:4000");
    expect(localUrlIn("see https://example.com")).toBeUndefined();
  });

  test("the plain-file server sends the folder's files and nothing outside it", async () => {
    const dir = await temp();
    const root = path.join(dir, "site");
    await mkdir(root);
    await writeFile(path.join(root, "index.html"), "<p>inside</p>");
    await writeFile(path.join(dir, "secret.txt"), "outside");
    const server = serveStatic(root);
    try {
      expect(await (await fetch(server.url)).text()).toBe("<p>inside</p>");
      const escape = await fetch(`${server.url}..%2fsecret.txt`);
      expect(escape.status).toBe(404);
      expect(await escape.text()).not.toContain("outside");
    } finally { await server.stop(); await removeTempDir(dir); }
  });

  test("a dev script is started, answers on the address it printed, and is gone after stop", async () => {
    const dir = await temp();
    try {
      await mkdir(path.join(dir, "node_modules"));
      await writeFile(path.join(dir, "bun.lock"), "");
      await writeFile(path.join(dir, "server.js"), "const s = Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('app') });\nconsole.log(`ready at http://localhost:${s.port}/`);\n");
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: `${JSON.stringify(process.execPath)} server.js` } }));
      const app = await startApp(dir, path.join(dir, "start.log"));
      expect(app.error).toBeUndefined();
      expect(await (await fetch(app.url!)).text()).toBe("app");
      await app.stop();
      expect(await fetch(app.url!).then(() => "up", () => "down")).toBe("down");
    } finally { await removeTempDir(dir); }
  });
});

describe("the sides", () => {
  const job = (runDir: string, side: "A" | "C", which = prompt): SideJob => ({ side, runDir, prompt: which, model: "anthropic/claude-sonnet-5-5", timeoutMs: 30_000, signal: new AbortController().signal });

  test("a Casper side gets the prompt on stdin with --json --model, works in a fresh app folder, and keeps its events", async () => {
    const dir = await temp();
    try {
      const fake = path.join(dir, "fake-casper.ts");
      await writeFile(fake, "const prompt = await Bun.stdin.text();\nawait Bun.write('index.html', `<h1>${prompt}</h1>`);\nconsole.log(JSON.stringify({ args: process.argv.slice(2) }));\n");
      const result = await runCasperSide(job(dir, "A"), [process.execPath, fake]);
      expect(result).toMatchObject({ side: "A", status: "done", exitCode: 0, appDir: path.join(dir, "A", "app") });
      expect(await readFile(path.join(dir, "A", "app", "index.html"), "utf8")).toBe(`<h1>${prompt.text}</h1>`);
      expect(JSON.parse(await readFile(path.join(dir, "A", "events.jsonl"), "utf8")).args).toEqual(["--json", "--model", "anthropic/claude-sonnet-5-5", "-"]);

      const started = await runCasperSide({ ...job(dir, "A", improve), runDir: path.join(dir, "improve") }, [process.execPath, fake]);
      expect(await readFile(path.join(started.appDir!, "app.js"), "utf8")).toContain("localStorage");
    } finally { await removeTempDir(dir); }
  });

  test("a failed side says why: Casper's last error event, else the end of its log", async () => {
    const dir = await temp();
    try {
      const fake = path.join(dir, "fail.ts");
      await writeFile(fake, "console.log(JSON.stringify({ v: 1, type: 'error', message: 'Not signed in to Anthropic.' }));\nprocess.exit(1);\n");
      expect(await runCasperSide(job(dir, "A"), [process.execPath, fake])).toMatchObject({ status: "failed", exitCode: 1, error: "Not signed in to Anthropic." });
      await mkdir(path.join(dir, "other"));
      await writeFile(path.join(dir, "other", "run.log"), "starting\nTraceback ...\nModuleNotFoundError: No module named 'typer'\n\n");
      expect(await failureReason(path.join(dir, "other"))).toBe("Traceback ... / ModuleNotFoundError: No module named 'typer'");
    } finally { await removeTempDir(dir); }
  });

  test("SkyN3t builds into the run's own projects folder with the model settings; an improve imports the starter first", async () => {
    const dir = await temp();
    try {
      const fake = path.join(dir, "fake-skyn3t.ts");
      await writeFile(fake, [
        "import { appendFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2), projects = process.env.SKYN3T_PROJECTS_DIR!;",
        "appendFileSync(projects + '/../calls.txt', JSON.stringify({ args, backend: process.env.SKYN3T_LLM_BACKEND }) + '\\n');",
        "if (args[0] === 'studio' && args[1] === 'build') { mkdirSync(projects + '/app'); writeFileSync(projects + '/app/index.html', args[2]!); }",
        "if (args[0] === 'project') cpSync(args[2]!, projects + '/' + args[4], { recursive: true });",
      ].join("\n"));
      const env = { SKYN3T_LLM_BACKEND: "claude_cli" };
      const built = await runSkyn3tSide(job(dir, "C"), [process.execPath, fake], env);
      expect(built).toMatchObject({ side: "C", status: "done", appDir: path.join(dir, "C", "projects", "app") });
      expect(await readFile(path.join(dir, "C", "projects", "app", "index.html"), "utf8")).toBe(prompt.text);

      const runDir = path.join(dir, "improve");
      const improved = await runSkyn3tSide(job(runDir, "C", improve), [process.execPath, fake], env);
      const calls = (await readFile(path.join(runDir, "C", "calls.txt"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.map((call) => call.args.slice(0, 2))).toEqual([["project", "import"], ["studio", "improve"]]);
      expect(calls[1].args).toEqual(["studio", "improve", "app", "--goal", improve.text, "--activity-file", path.join(runDir, "C", "activity.jsonl")]);
      expect(calls.every((call) => call.backend === "claude_cli")).toBe(true);
      expect(improved.appDir).toBe(path.join(runDir, "C", "projects", "app"));
      expect(await builtApp(path.join(dir, "nothing-here"))).toBeNull();
    } finally { await removeTempDir(dir); }
  });

  test.skipIf(process.platform === "win32")("a side past its time is stopped with everything it started", async () => {
    const dir = await temp();
    try {
      const fake = path.join(dir, "slow.ts");
      await writeFile(fake, `const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"]);\nawait Bun.write(${JSON.stringify(path.join(dir, "pid"))}, String(child.pid));\nawait Bun.sleep(60000);\n`);
      const run = await runOwned([process.execPath, fake], { cwd: dir, env: process.env, stdout: "ignore", stderr: "ignore", timeoutMs: 1500 });
      expect(run).toMatchObject({ exitCode: null, timedOut: true });
      const pid = Number(await readFile(path.join(dir, "pid"), "utf8"));
      // Gone, or a zombie where PID 1 doesn't reap (some containers): either way it no longer runs.
      const state = (await Bun.$`ps -o stat= -p ${pid}`.nothrow().text()).trim();
      expect(state === "" || state.startsWith("Z")).toBe(true);
    } finally { await removeTempDir(dir); }
  });
});

describe("the judge page", () => {
  test("shows X/Y/Z without sides or folders, saves the first valid pick as a side, reveals, and ends on Finish", async () => {
    const apps: JudgeApp[] = [
      { label: "X", side: "C", url: null, error: "No way to start it was found.", log: "npm ERR!", folder: "/runs/r/C/projects/app" },
      { label: "Y", side: "A", url: "http://localhost:1/", log: "", folder: "/runs/r/A/app" },
      { label: "Z", side: "B", url: "http://localhost:2/", log: "", folder: "/runs/r/B/app" },
    ];
    const run = { set: "web", promptId: prompt.id, prompt: `${prompt.text} </script><b>`, model: "m" } as RunRecord;
    const saved: unknown[] = [];
    let url = "";
    const done = serveJudge({
      run, apps, open: false, signal: new AbortController().signal, log: (line) => { url = line.replace("Judge page: ", ""); },
      async save(pick, labels, note) { saved.push({ pick, labels, note }); },
    });
    while (!url) await Bun.sleep(10);
    const page = await (await fetch(url)).text();
    expect(page).toContain("Blind compare");
    for (const hidden of ["SkyN3t", "Casper v0.2.32", "/runs/r/", "</script><b>"]) expect(page).not.toContain(hidden);
    const token = JSON.parse(/<script id="data" type="application\/json">(.*?)<\/script>/s.exec(page)![1]!).token;
    const post = (where: string, body: object) => fetch(url + where, { method: "POST", body: JSON.stringify(body) });

    expect((await post("pick", { token: "wrong", pick: "X" })).status).toBe(403);
    expect((await post("pick", { token, pick: "W" })).status).toBe(400);
    const answer = await (await post("pick", { token, pick: "Y", note: "  nicer  " })).json();
    expect(saved).toEqual([{ pick: "A", labels: { X: "C", Y: "A", Z: "B" }, note: "nicer" }]);
    expect(answer.reveal[0]).toEqual({ label: "X", side: "C", name: "SkyN3t", folder: "/runs/r/C/projects/app" });
    expect((await post("pick", { token, pick: "Z" })).status).toBe(409);
    expect((await post("finish", { token })).status).toBe(200);
    await done;
    expect(await fetch(url).then(() => "up", () => "down")).toBe("down");
  });
});
