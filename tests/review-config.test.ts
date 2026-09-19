import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

for (const kind of ["mcp", "lsp"] as const) {
  test(`${kind} discovery rejects a project FIFO without blocking startup`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-config-review-"));
    try {
      await mkdir(path.join(root, ".casper"));
      const fifo = Bun.spawn(["mkfifo", path.join(root, ".casper", `${kind}.json`)], { stdout: "ignore", stderr: "pipe" });
      expect(await fifo.exited).toBe(0);
      const name = kind === "mcp" ? "discoverMCPConfiguration" : "discoverLSPConfiguration";
      const child = Bun.spawn([process.execPath, "-e", `
        import { ${name} as discover } from ${JSON.stringify(path.resolve(`src/${kind}/config.ts`))};
        const result = await discover({ projectRoot: process.argv[1], homeDir: process.argv[1] + "/home" });
        console.log(JSON.stringify(result));
      `, root], { stdout: "pipe", stderr: "pipe" });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 1000);
      try {
        const exitCode = await child.exited;
        expect(timedOut).toBe(false);
        expect(exitCode).toBe(0);
        const result = JSON.parse(await new Response(child.stdout).text());
        expect(result.servers).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toContain(`Cannot read ${kind.toUpperCase()} configuration`);
      } finally { clearTimeout(timer); child.kill(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
