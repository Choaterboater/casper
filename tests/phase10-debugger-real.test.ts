import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DebugSession } from "../src/debug/session";

const extensions = path.join(os.homedir(), ".vscode/extensions");
const discovered = (await readdir(extensions).catch(() => [])).filter(name => name.startsWith("ms-python.debugpy-")).sort().at(-1);
const adapter = process.env.CASPER_TEST_DEBUGPY ?? (discovered ? path.join(extensions, discovered, "bundled/libs/debugpy/adapter") : "");
const python = process.env.CASPER_TEST_PYTHON ?? "/usr/bin/python3";
const realTest = adapter && existsSync(adapter) && existsSync(python) ? test : test.skip;

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  expect(check()).toBe(true);
}

for (const finish of ["exit", "stop", "crash"] as const) realTest(`real installed debugpy: breakpoint, variables and ${finish} cleanup`, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-debugpy-")));
  const session = new DebugSession({ projectRoot: root, confirm: async () => true });
  try {
    await mkdir(path.join(root, ".casper"));
    await writeFile(path.join(root, "fixture.py"), `import os, time\nanswer = 41\nanswer += 1\nopen('real-pid', 'w').write(str(os.getpid()))\ntime.sleep(${finish === "exit" ? "0.1" : "30"})\n`);
    await writeFile(path.join(root, ".casper/debug.json"), JSON.stringify({ targets: { fixture: {
      command: python, args: [adapter], adapterID: "python", program: "fixture.py", breakpoints: { "fixture.py": [5] },
    } } }));
    await session.run({ action: "start", target: "fixture" });
    await until(() => session.status().state === "stopped");
    // stopOnEntry is distinct from the requested breakpoint after answer = 42.
    const firstThread = session.status().stoppedThread!;
    await session.run({ action: "threads" });
    await session.run({ action: "continue", threadId: firstThread });
    await until(() => session.status().state === "stopped");
    const stack = await session.run({ action: "stack", threadId: session.status().stoppedThread! });
    expect(stack.items?.[0]).toMatchObject({ line: 5 });
    const scopes = await session.run({ action: "scopes", frame: String(stack.items?.[0]?.handle) });
    const local = scopes.items?.find(item => String(item.name).toLowerCase().includes("local"));
    const variables = await session.run({ action: "variables", reference: String(local?.handle) });
    expect(variables.items).toContainEqual(expect.objectContaining({ name: "answer", value: "42" }));
    const pid = Number(await readFile(path.join(root, "real-pid"), "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow(); // Positive process control.
    if (finish === "exit") {
      await session.run({ action: "continue", threadId: session.status().stoppedThread! });
      await until(() => session.status().state === "closed");
      expect(session.status()).toMatchObject({ debuggeeExit: "adapter-reported", exitCode: 0 });
    } else if (finish === "crash") {
      process.kill(session.status().ownedAdapterPid!, "SIGKILL");
      await until(() => session.status().state === "failed");
    }
    await session.close();
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    expect(session.status().ownedProcessCleanup).toBe("stopped");
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
}, 25_000);
