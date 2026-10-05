import { expect, test } from "bun:test";
import path from "node:path";

// --help, --version and usage errors answer from text Casper already has: loading the whole app first cost about
// 110 ms of every such run (and of every CLI start in the suite).
test("loading the CLI does not load the app until a session starts", () => {
  const cliMain = path.resolve(import.meta.dir, "../src/cli-main.ts");
  const script = `await import(${JSON.stringify(cliMain)});
    console.log(JSON.stringify(Object.keys(require.cache).filter((file) => file.endsWith("/src/app.ts") || file.endsWith("\\\\src\\\\app.ts"))));`;
  const child = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  expect(child.stderr.toString()).toBe("");
  expect(JSON.parse(child.stdout.toString().trim())).toEqual([]);
});
