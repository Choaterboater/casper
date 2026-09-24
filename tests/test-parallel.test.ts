import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTests } from "../scripts/test-parallel";

test("parallel runner propagates failures and still runs every queued file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-test-runner-"));
  try {
    const pass = path.join(dir, "pass.test.ts");
    const fail = path.join(dir, "fail.test.ts");
    const last = path.join(dir, "last.test.ts");
    const marker = path.join(dir, "ran");
    await writeFile(pass, 'import { test, expect } from "bun:test"; test("pass", () => expect(true).toBe(true));');
    await writeFile(fail, 'import { test, expect } from "bun:test"; test("intentional failure", () => expect(true).toBe(false));');
    await writeFile(last, `import { test } from "bun:test"; test("last", async () => { await Bun.write(${JSON.stringify(marker)}, "yes"); });`);
    let output = "";
    const write = (text: string) => { output += text; };
    expect(await runTests([pass, fail, last], 2, write)).toBe(1);
    expect(output).toContain("2 passed, 1 failed, 3 total");
    expect(output).toContain(`=== ${fail} ===`);
    expect(output).toContain(`✓ ${pass}`);
    expect(await Bun.file(marker).text()).toBe("yes");
    output = "";
    expect(await runTests([pass, last], 2, write)).toBe(0);
    expect(output).not.toContain(`=== ${pass} ===`);
    await expect(runTests([])).rejects.toThrow("No test files");
    await expect(runTests([pass], 0)).rejects.toThrow("Concurrency");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
