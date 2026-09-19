import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeSession, RuntimeEventListener, RuntimeTool } from "../src/runtime/types";
import { taskExitCode } from "../src/task/result";
import { SkillRegistry } from "../src/skills/registry";

const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-verify-app-"));
  dirs.push(root);
  await mkdir(path.join(root, ".casper"));
  await mkdir(path.join(root, "home"));
  await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  test: "test -f fixed"\nrepair:\n  maxAttempts: 1\n');
  return root;
}

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function createApp(root: string, options: { autoVerify?: boolean; respond?: (prompt: string, emit: RuntimeEventListener) => Promise<void>; onStart?: () => Promise<void>; onAbort?: () => Promise<void>; stopReason?: string; editOnPrompt?: (count: number) => boolean; checkOnPrompt?: boolean; checkFailureOnPrompt?: boolean; selectCheckOnPrompt?: (count: number) => boolean } = {}) {
  const prompts: string[] = [];
  let starts = 0;
  let promptCount = 0;
  let tools: RuntimeTool[] = [];
  let afterFileEdit: ((path: string, signal?: AbortSignal) => Promise<string | undefined>) | undefined;
  let disposals = 0;
  let output = "";
  let listener: RuntimeEventListener | undefined;
  const runtime: AgentRuntime = {
    async start(startOptions): Promise<RuntimeSession> {
      starts++;
      afterFileEdit = startOptions.afterFileEdit;
      tools = startOptions.tools ?? [];
      await options.onStart?.();
      if (!options.respond) throw new Error("Runtime unavailable");
      return {
        setTools(next) { tools = next; },
        async prompt(text) {
          promptCount++;
          prompts.push(text); await options.respond!(text, (event) => listener?.(event));
          if (options.checkOnPrompt || options.checkFailureOnPrompt) listener?.({ type: "tool_end", toolName: "bash", input: { command: "test -f fixed" }, output: { text: options.checkFailureOnPrompt ? "model check failed" : "model check passed", truncated: false }, isError: Boolean(options.checkFailureOnPrompt) });
          if (options.editOnPrompt?.(promptCount)) await afterFileEdit?.("changed.ts");
          if (options.selectCheckOnPrompt?.(promptCount)) {
            const tool = tools.find((entry) => entry.name === "casper_check");
            if (!tool) throw new Error("Managed check tool unavailable");
            await tool.execute({ check: "test" });
          }
          if (options.stopReason) listener?.({ type: "assistant_response_end", stopReason: options.stopReason });
        },
        async abort() { await options.onAbort?.(); }, subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
        getState: () => ({ cwd: root, isStreaming: false }),
      };
    },
    async dispose() { disposals++; },
  };
  const homeDir = path.join(root, "home");
  const app = new CasperApp({
    autoVerify: options.autoVerify,
    runtimeFactory: () => runtime,
    loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
    output: { write: (text) => { output += text; } },
  });
  return { app, prompts, starts: () => starts, disposals: () => disposals, output: () => output };
}

test("runtime error and abort stops are not reported as successful tasks or followed by verification", async () => {
  for (const [stopReason, execution, code] of [["error", "failed", 1], ["aborted", "cancelled", 130]] as const) {
    const root = await fixture();
    const { app, output } = createApp(root, { autoVerify: true, stopReason, respond: async () => {
      await writeFile(path.join(root, "useful-work"), "retained");
    } });
    try {
      const report = await app.runOnce("Fix addition", root);
      expect(report).toBeUndefined();
      expect(app.getLastTaskResult()?.execution).toBe(execution);
      expect(taskExitCode(report, app.getLastTaskResult())).toBe(code);
      expect(output()).toContain(`Execution ${execution}`);
      expect(output()).not.toContain("Checks fail");
      expect(await Bun.file(path.join(root, "useful-work")).text()).toBe("retained");
      await app.runOnce("/project");
      expect(app.getLastTaskResult()).toBeUndefined();
    } finally { await app.close(); }
  }
});

test("a nonthrowing failed repair stops instead of claiming a passing rerun", async () => {
  const root = await fixture();
  const { app, prompts } = createApp(root, { stopReason: "error", respond: async () => {
    await writeFile(path.join(root, "fixed"), "useful edit before provider failure");
  } });
  try {
    const report = await app.runOnce("/verify repair test", root);
    expect(report?.status).toBe("blocked");
    expect(report?.reason).toContain("Repair model stopped unsuccessfully");
    expect(report?.rounds).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(await Bun.file(path.join(root, "fixed")).exists()).toBe(true);
    expect(taskExitCode(report)).toBe(1);
    // A later explicit check can succeed; failure state must not leak across requests.
    expect((await app.runOnce("/verify test"))?.status).toBe("pass");
  } finally { await app.close(); }
});

test("no model-selected checks is unverified, while explicit missing checks stay incomplete", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".casper/project.yaml"), "{}");
  const { app, output } = createApp(root, { autoVerify: true, respond: async () => {} });
  try {
    const report = await app.runOnce("Add pagination", root);
    expect(report).toBeUndefined();
    expect(taskExitCode(report, app.getLastTaskResult())).toBe(0);
    expect(output()).toContain("no Casper verification recorded");
    const explicit = await app.runOnce("/verify build");
    expect(explicit?.status).toBe("incomplete");
    expect(explicit?.results[0]).toMatchObject({ name: "build", status: "skip" });
  } finally { await app.close(); }
});

test("unverified normal completion is labeled separately and the returned task result is detached", async () => {
  const root = await fixture();
  const { app, output } = createApp(root, { respond: async () => {} });
  try {
    await app.runOnce("Fix addition", root);
    const result = app.getLastTaskResult();
    expect(result?.execution).toBe("completed");
    expect(result?.verification).toBeUndefined();
    expect(output()).toContain("no Casper verification recorded");
    if (result) result.execution = "failed";
    expect(app.getLastTaskResult()?.execution).toBe("completed");
    expect(taskExitCode(undefined, app.getLastTaskResult())).toBe(0);
  } finally { await app.close(); }
});

test("fresh requests never reuse evidence; self-mutating scoped checks retain stale qualifications", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  test: "printf x >> check-runs"\nverification:\n  scopes:\n    test:\n      inputs: ["."]\n      exclude: [home]\n');
  const { app, output } = createApp(root, {
    autoVerify: true,
    editOnPrompt: (count) => count === 3,
    selectCheckOnPrompt: () => true,
    respond: async () => {},
  });
  try {
    expect((await app.runOnce("Fix addition", root))?.status).toBe("pass");
    expect((await app.runOnce("Fix addition", root))?.results[0]?.reused).toBeUndefined();
    expect((await app.runOnce("Fix addition", root))?.results[0]?.reused).toBeUndefined();
    expect(await Bun.file(path.join(root, "check-runs")).text()).toBe("xxxxxx"); // Each task checks, then rechecks its invalidated pass once.
    expect(app.getLastTaskResult()?.observedEdits).toEqual(["changed.ts"]);
    expect(output()).toContain("inputs stale");
    expect(output()).toContain("current files unverified");
  } finally { await app.close(); }
});

test("tool-reported success is diagnostic only, never fabricated exit evidence", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  test: "test -f fixed"\nrepair:\n  maxAttempts: 0\n');
  const { app } = createApp(root, { autoVerify: true, checkOnPrompt: true, selectCheckOnPrompt: () => true, respond: async () => {} });
  try {
    const report = await app.runOnce("Fix addition", root);
    expect(report?.status).toBe("fail");
    expect(report?.results[0]).toMatchObject({ status: "fail", exitCode: 1 });
    expect(report?.results[0]?.reused).toBeUndefined();
    expect(app.getLastTaskResult()?.observedChecks?.[0]).toMatchObject({ toolStatus: "success", output: "model check passed" });
  } finally { await app.close(); }
});

test("repair receives actual verifier failure; shell status remains a separate observation", async () => {
  const root = await fixture();
  const { app, prompts } = createApp(root, {
    autoVerify: true,
    checkFailureOnPrompt: true,
    selectCheckOnPrompt: (count) => count === 1,
    respond: async (prompt) => {
      if (prompt.startsWith("Casper verification repair")) await writeFile(path.join(root, "fixed"), "");
    },
  });
  try {
    const report = await app.runOnce("Fix addition", root);
    expect(report?.status).toBe("pass");
    expect(report?.rounds[0]?.[0]).toMatchObject({ status: "fail", exitCode: 1 });
    expect(prompts[1]).toContain('"command": "test -f fixed"');
    expect(app.getLastTaskResult()?.observedChecks?.[0]?.toolStatus).toBe("error");
    expect(report?.rounds).toHaveLength(2);
  } finally { await app.close(); }
});

test("review: failed writes and late shell success cannot certify changed files", async () => {
  for (const toolName of ["bash", "write", "edit", "lsp"]) {
    const root = await fixture();
    await writeFile(path.join(root, "fixed"), "");
    await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  test: "test -f fixed"\nrepair:\n  maxAttempts: 0\n');
    const { app } = createApp(root, { autoVerify: true, selectCheckOnPrompt: () => true, respond: async (_prompt, emit) => {
      emit({ type: "tool_start", toolName: "bash", toolCallId: "check", input: { command: "test -f fixed" } });
      await rm(path.join(root, "fixed"));
      emit({ type: "tool_end", toolName, isError: true, input: { path: "fixed", operation: "rename" } });
      emit({ type: "tool_end", toolName: "bash", toolCallId: "check", input: { command: "test -f fixed" }, isError: false });
    } });
    try {
      expect((await app.runOnce("/verify test", root))?.status).toBe("pass");
      expect((await app.runOnce("Fix addition"))?.status).toBe("fail");
      expect(app.getLastTaskResult()?.possibleMutations).toBe(true);
      expect(app.getLastTaskResult()?.observedEdits).toEqual([]);
    } finally { await app.close(); }
  }
});

test("review: a recovered Pi provider error is not a terminal task failure", async () => {
  const root = await fixture();
  const { app } = createApp(root, { respond: async (_prompt, emit) => {
    emit({ type: "assistant_response_end", stopReason: "error" });
    emit({ type: "assistant_response_end", stopReason: "stop" });
  } });
  try {
    await app.runOnce("Continue", root);
    expect(app.getLastTaskResult()?.execution).toBe("completed");
  } finally { await app.close(); }
});

test("review: external edits between explicit checks cannot reuse an old pass", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "fixed"), "");
  const { app } = createApp(root);
  try {
    expect((await app.runOnce("/verify test", root))?.status).toBe("pass");
    await rm(path.join(root, "fixed"));
    expect((await app.runOnce("/verify test"))?.status).toBe("fail");
  } finally { await app.close(); }
});

test("review: a later verifier can invalidate an earlier passing check", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "fixed"), "");
  await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  test: "test -f fixed"\n  build: "rm -f fixed"\nverification:\n  scopes:\n    test:\n      inputs: ["."]\n      exclude: [home]\n');
  const { app, output } = createApp(root);
  try {
    const report = await app.runOnce("/verify test build", root);
    expect(report?.status).toBe("pass");
    expect(report?.results[0]?.freshness).toBe("stale");
    expect(output()).toContain("current files unverified");
  } finally { await app.close(); }
});

test("/verify is local, exposes failure and skips, validates names before execution, and keeps startup lazy", async () => {
  const root = await fixture();
  const { app, starts, output } = createApp(root);
  try {
    await app.start(root);
    const report = await app.runOnce("/verify");
    expect(starts()).toBe(0);
    expect(report?.status).toBe("fail");
    expect(report?.results.filter((result) => result.status === "skip")).toHaveLength(3);
    expect(output()).toContain("✗ test");
    expect(output()).toContain("Checks fail (command execution)");
    await expect(app.runOnce("/verify repair typo")).rejects.toThrow("Usage:");
    expect(starts()).toBe(0);
    await writeFile(path.join(root, "fixed"), "");
    expect((await app.runOnce("/verify test"))?.status).toBe("pass");
    expect(starts()).toBe(0);
  } finally { await app.close(); }
});

test("/verify repair sends evidence through the runtime seam and reports a real successful rerun", async () => {
  const root = await fixture();
  const { app, prompts, starts, output } = createApp(root, { respond: async () => { await writeFile(path.join(root, "fixed"), ""); } });
  try {
    const report = await app.runOnce("/verify repair test", root);
    expect(report?.status).toBe("pass");
    expect(report?.repairAttempts).toBe(1);
    expect(report?.rounds.map((round) => round[0].status)).toEqual(["fail", "pass"]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"command": "test -f fixed"');
    expect(starts()).toBe(1);
    expect(output()).toContain("↻ repair 1/1");
    expect(output()).toContain("Checks pass (command execution)");
  } finally { await app.close(); }
});

test("explicit repair uses its own objective rather than an unrelated previous request", async () => {
  const root = await fixture();
  const { app, prompts } = createApp(root, { respond: async (prompt) => {
    if (prompt.startsWith("Casper verification repair")) await writeFile(path.join(root, "fixed"), "");
  } });
  try {
    await app.runOnce("Summarize this repository without editing", root);
    expect((await app.runOnce("/verify repair test"))?.status).toBe("pass");
    expect(prompts[1]).toContain("Original request:\nMake the selected verification checks pass: test.");
    expect(prompts[1]).not.toContain("Summarize this repository");
  } finally { await app.close(); }
});

test("managed checks require opt-in and model selection, and repair retains the original session and request", async () => {
  const root = await fixture();
  const normal = createApp(root, { respond: async () => {} });
  try {
    expect(await normal.app.runOnce("Fix the test", root)).toBeUndefined();
    expect(normal.output()).not.toContain("Checks ");
  } finally { await normal.app.close(); }
  const opted = createApp(root, { autoVerify: true, selectCheckOnPrompt: (count) => count === 2, respond: async (prompt) => {
    if (prompt.startsWith("Casper verification repair")) await writeFile(path.join(root, "fixed"), "");
  } });
  try {
    await opted.app.runOnce("Summarize this repository", root);
    await opted.app.runOnce("/project");
    expect(opted.output()).not.toContain("Checks ");
    const report = await opted.app.runOnce("Fix addition, preserve its API");
    expect(report?.status).toBe("pass"); // Absent optional categories are not required checks.
    expect(report?.results).toHaveLength(1);
    expect(opted.output()).toContain("Checks pass (command execution)");
    expect(opted.output()).toContain("test: inputs unavailable");
    expect(report?.results.find((result) => result.name === "test")?.status).toBe("pass");
    expect(opted.prompts).toHaveLength(3);
    expect(opted.prompts[2]).toContain("Original request:\nFix addition, preserve its API");
    expect(opted.starts()).toBe(1);
  } finally { await opted.app.close(); }
});

test("closing the app cancels an active verification command without starting a repair", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  test: "touch started; sleep 10"\n');
  const { app, starts } = createApp(root);
  await app.start(root);
  const pending = app.runOnce("/verify repair test");
  for (let attempt = 0; attempt < 100 && !await Bun.file(path.join(root, "started")).exists(); attempt++) await Bun.sleep(10);
  await app.close();
  expect((await pending)?.status).toBe("blocked");
  expect(starts()).toBe(0);
});

test("cancellation during lazy runtime startup prevents a repair prompt", async () => {
  const root = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { app, prompts } = createApp(root, {
    respond: async () => {},
    onStart: async () => { started.resolve(); await release.promise; },
  });
  const pending = app.runOnce("/verify repair test", root);
  await started.promise;
  const closing = app.close();
  release.resolve();
  await closing;
  expect((await pending)?.status).toBe("blocked");
  expect(prompts).toHaveLength(0);
});

test("closing during the initial prompt prevents post-task verification and repair", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  test: "touch ran-after-close; exit 1"\nrepair:\n  maxAttempts: 1\n');
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { app, prompts } = createApp(root, {
    autoVerify: true,
    respond: async () => { started.resolve(); await release.promise; },
    onAbort: async () => { release.resolve(); },
  });
  const pending = app.runOnce("Fix addition", root);
  await started.promise;
  await app.close();
  await pending;
  expect(await Bun.file(path.join(root, "ran-after-close")).exists()).toBe(false);
  expect(prompts).toHaveLength(1);
});

test("closing drains initial runtime startup without prompting and disposes only once", async () => {
  const root = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { app, prompts, disposals } = createApp(root, {
    autoVerify: true,
    respond: async () => {},
    onStart: async () => { started.resolve(); await release.promise; },
  });
  const pending = app.runOnce("Fix addition", root);
  await started.promise;
  const closing = app.close();
  release.resolve();
  await closing;
  await pending;
  await app.close();
  expect(prompts).toHaveLength(0);
  expect(disposals()).toBe(1);
});

test("shutdown still disposes the runtime when abort rejects", async () => {
  const root = await fixture();
  const { app, disposals } = createApp(root, {
    respond: async () => {},
    onAbort: async () => { throw new Error("abort failed"); },
  });
  await app.runOnce("Summarize this repository", root);
  await expect(app.close()).rejects.toThrow("abort failed");
  expect(disposals()).toBe(1);
});

test("CLI termination cleans up a running verifier process group", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  test: "touch started; (sleep 1; touch leaked) & wait"\n');
  const child = Bun.spawn([process.execPath, path.resolve("src/cli.ts"), "/verify test"], {
    cwd: root, env: { ...process.env, HOME: path.join(root, "home"), CASPER_PROFILE: "default" }, stdout: "ignore", stderr: "ignore",
  });
  try {
    for (let attempt = 0; attempt < 200 && !await Bun.file(path.join(root, "started")).exists(); attempt++) await Bun.sleep(10);
    expect(await Bun.file(path.join(root, "started")).exists()).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    await Bun.sleep(1100);
    expect(await Bun.file(path.join(root, "leaked")).exists()).toBe(false);
  } finally { child.kill(); }
});

test("CLI shutdown has a deadline when runtime startup never settles", async () => {
  const root = await fixture();
  const harness = path.join(root, "stalled-runtime.ts");
  await writeFile(harness, `
    import { CasperApp } from ${JSON.stringify(path.resolve("src/app.ts"))};
    import { installShutdownHandlers } from ${JSON.stringify(path.resolve("src/cli.ts"))};
    const app = new CasperApp({ runtimeFactory: () => ({
      async start() {
        await Bun.write("runtime-started", "");
        setInterval(() => {}, 1000);
        return await new Promise(() => {});
      },
      async dispose() {},
    }) });
    installShutdownHandlers(app);
    await app.runOnce("/verify repair test");
  `);
  const child = Bun.spawn([process.execPath, harness], {
    cwd: root, env: { ...process.env, HOME: path.join(root, "home"), CASPER_PROFILE: "default" }, stdout: "ignore", stderr: "ignore",
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let attempt = 0; attempt < 200 && !await Bun.file(path.join(root, "runtime-started")).exists(); attempt++) await Bun.sleep(10);
    expect(await Bun.file(path.join(root, "runtime-started")).exists()).toBe(true);
    deadline = setTimeout(() => child.kill("SIGKILL"), 2500);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
  } finally { clearTimeout(deadline); child.kill(); }
});

test("one-shot CLI returns meaningful exit codes without model credentials", async () => {
  const root = await fixture();
  const cli = path.resolve("src/cli.ts");
  const run = async (prompt: string) => {
    const child = Bun.spawn([process.execPath, cli, prompt], { cwd: root, env: { ...process.env, HOME: path.join(root, "home"), CASPER_PROFILE: "default" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  expect((await run("/verify test")).code).toBe(1);
  const missing = await run("/verify lint");
  expect(missing.code).toBe(2);
  expect(missing.stdout).toContain("Checks incomplete (command execution)");
  await writeFile(path.join(root, "fixed"), "");
  const passed = await run("/verify test");
  expect(passed.code).toBe(0);
  expect(passed.stdout).toContain("Checks pass (command execution)");
  expect(passed.stderr).toBe("");
  await writeFile(path.join(root, "source.ts"), "before");
  await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  build: "mkdir -p dist; printf built > dist/output.js"\nverification:\n  scopes:\n    build:\n      inputs: [source.ts]\n');
  const built = await run("/verify build");
  expect(built.code).toBe(0);
  expect(built.stdout).toContain("inputs fresh");
  await symlink("/dev/null", path.join(root, "unrelated-link"));
  const linked = await run("/verify build");
  expect(linked.code).toBe(0);
  expect(linked.stdout).toContain("inputs fresh");
  await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  build: "printf after > source.ts"\nverification:\n  scopes:\n    build:\n      inputs: [source.ts]\n');
  const stale = await run("/verify build");
  expect(stale.code).toBe(0); // Exit status describes execution, not input currency.
  expect(stale.stdout).toContain("inputs stale");
  expect(stale.stdout).toContain("current files unverified");
});
