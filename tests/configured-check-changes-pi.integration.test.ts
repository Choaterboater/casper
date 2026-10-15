import { expect } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { answer, calls, cleanUpAfterEach, fixture } from "./support/phase8-pi";
import { posixOnly } from "./support/platform";

cleanUpAfterEach();
for (const choice of ["save", "session", "no"]) {
  posixOnly(`real Pi native edit protects configured commands (${choice})`, async () => {
    let turn = 0;
    const setup = await fixture(() => turn++ === 0 ? calls([{ name: "edit", args: { path: ".casper/project.yaml", edits: [{ oldText: "bun .casper/quick-test.ts", newText: "bun test" }] } }]) : answer("done"));
    await mkdir(path.join(setup.project, ".casper"));
    const before = "commands:\n  test: bun .casper/quick-test.ts\n";
    await writeFile(path.join(setup.project, ".casper/project.yaml"), before);
    await writeFile(path.join(setup.project, ".casper/quick-test.ts"), "throw new Error('real check');\n");
    const { stdout, stderr, exit } = await setup.run([path.join(import.meta.dir, "fixtures/pi-check-changes.ts"), setup.project, choice]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout.slice(stdout.indexOf("CHECK_CHANGES=") + "CHECK_CHANGES=".length).trim());
    expect(result.asked).toHaveLength(1);
    expect(result.asked[0].before).toBe(before);
    expect(result.asked[0].after).toBe("commands:\n  test: bun test\n");
    expect(result.toolEnds[0].isError).toBe(choice !== "save");
    expect(result.commands.test).toBe(choice === "no" ? "bun .casper/quick-test.ts" : "bun test");
    expect(await readFile(path.join(setup.project, ".casper/project.yaml"), "utf8")).toBe(choice === "save" ? "commands:\n  test: bun test\n" : before);
  }, 25_000);
}

posixOnly("real Pi recursive shell copy cannot overwrite a configured root check", async () => {
  let turn = 0;
  const setup = await fixture(() => turn++ === 0 ? calls(["cp -r replacement/. .", "cp -r replacement/. ~+"].map((command) => ({ name: "bash", args: { command } }))) : answer("done"));
  await mkdir(path.join(setup.project, ".casper"));
  await mkdir(path.join(setup.project, "replacement"));
  await writeFile(path.join(setup.project, ".casper/project.yaml"), "commands:\n  test: bun check.ts\n");
  const before = "throw new Error('real check');\n";
  await writeFile(path.join(setup.project, "check.ts"), before);
  await writeFile(path.join(setup.project, "replacement/check.ts"), "console.log('skip');\n");
  const { stdout, stderr, exit } = await setup.run([path.join(import.meta.dir, "fixtures/pi-check-changes.ts"), setup.project, "save"]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(stdout.slice(stdout.indexOf("CHECK_CHANGES=") + "CHECK_CHANGES=".length).trim());
  expect(result.asked).toEqual([]); // Shell cannot supply an exact old → new preview: native edit/write is required.
  expect(result.toolEnds).toHaveLength(2);
  for (const end of result.toolEnds) {
    expect(end.isError).toBe(true);
    expect(JSON.stringify(end)).toContain("Use native edit/write");
  }
  expect(await readFile(path.join(setup.project, "check.ts"), "utf8")).toBe(before);
}, 25_000);

posixOnly("real Pi native write cannot silently replace the configured check script", async () => {
  let turn = 0;
  const setup = await fixture(() => turn++ === 0 ? calls([{ name: "write", args: { path: ".casper/quick-test.ts", content: "console.log('skip');\n" } }]) : answer("done"));
  await mkdir(path.join(setup.project, ".casper"));
  await writeFile(path.join(setup.project, ".casper/project.yaml"), "commands:\n  test: bun .casper/quick-test.ts\n");
  await writeFile(path.join(setup.project, ".casper/quick-test.ts"), "throw new Error('real check');\n");
  const { stdout, stderr, exit } = await setup.run([path.join(import.meta.dir, "fixtures/pi-check-changes.ts"), setup.project, "no"]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(stdout.slice(stdout.indexOf("CHECK_CHANGES=") + "CHECK_CHANGES=".length).trim());
  expect(result.asked[0].file).toBe(".casper/quick-test.ts");
  expect(result.toolEnds[0].isError).toBe(true);
  expect(await readFile(path.join(setup.project, ".casper/quick-test.ts"), "utf8")).toContain("real check");
}, 25_000);
