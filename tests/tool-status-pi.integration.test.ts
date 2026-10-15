import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeEvent } from "../src/runtime/types";
import { answer, calls, cleanUpAfterEach, fixture } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();

test("real Pi lookup output stays bounded and reaches neutral live, folded and plain rows", async () => {
  let step = 0;
  const f = await fixture(() => {
    const now = step++;
    if (now === 0) return calls([
      { name: "grep", args: { pattern: "ABSENT_LOOKUP", path: "fixture.txt" } },
      { name: "find", args: { pattern: "absent-lookup-*.ts", path: "." } },
      { name: "ls", args: { path: "empty" } },
      { name: "read", args: { path: "large.txt" } },
    ]);
    if (now <= 5) return calls([{ name: "read", args: { path: "fixture.txt" } }]);
    return answer("Done");
  });
  await mkdir(path.join(f.project, "empty"));
  await writeFile(path.join(f.project, "large.txt"), "BOUNDED_LOOKUP_HEAD\n" + "lookup content\n".repeat(1000) + "BOUNDED_LOOKUP_TAIL\n");
  const harness = path.join(f.agent, "lookup-view.ts");
  // Keep the real Pi lookup tools and adapter, but supply their external fd/rg subprocess boundary.
  // Offline CI has neither binary on every OS; no host installation or download belongs in this UI test.
  const search = `const [kind, ...args] = process.argv.slice(1);
const [pattern, root] = args.slice(args.indexOf('--') + 1);
try {
  if (kind === 'fd' || kind === 'fdfind') {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) console.log(require('node:path').resolve(root, file));
  } else {
    if (new RegExp(pattern).test(require('node:fs').readFileSync(root, 'utf8'))) throw new Error('lookup fixture unexpectedly matched');
    process.exit(1);
  }
} catch (error) { console.error(error); process.exit(2); }`;
  // rg reserves exit 1 for no matches. A fixture error must not masquerade as an empty successful lookup.
  const guard = await f.run(["-e", search, "rg", "--", "LOCAL_EVIDENCE_8", path.join(f.project, "fixture.txt")]);
  expect(guard.exit).toBe(2);
  expect(guard.stderr).toContain("lookup fixture unexpectedly matched");
  await writeFile(harness, `import { mock } from 'bun:test';
import * as childProcess from 'node:child_process';
const originalSpawn = childProcess.spawn, originalSpawnSync = childProcess.spawnSync;
const searches = [];
const tool = command => ['fd', 'fdfind', 'rg'].find(name => require('node:path').basename(command).replace(/\\.exe$/i, '') === name);
mock.module('node:child_process', () => ({ ...childProcess,
  spawn(command, args, options) {
    const name = tool(command);
    if (name) searches.push(name);
    return name ? originalSpawn(process.execPath, ['-e', ${JSON.stringify(search)}, name, ...args], options) : originalSpawn(command, args, options);
  },
  spawnSync(command, args, options) {
    return tool(command) && args[0] === '--version'
      ? originalSpawnSync(process.execPath, ['-e', 'console.log("fixture search 1.0")'], options)
      : originalSpawnSync(command, args, options);
  },
}));
const { PiRuntime } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/runtime/pi.ts"))});
import { RuntimeEventView } from ${JSON.stringify(path.join(import.meta.dir, "../src/app/events.ts"))};
import { renderFold } from ${JSON.stringify(path.join(import.meta.dir, "../src/tui/terminal.ts"))};
const runtime = new PiRuntime();
const events = [], live = [], folded = [], plain = [], failures = [];
const views = [true, false].map(rich => new RuntimeEventView({
  rich, columns: 120, questionsShown: 0, questionOpen: false,
  endAssistant() {}, assistant() {},
  setWork(work) { if (rich && work) live.push(...work.rows); },
  writeFold(fold) { folded.push(...renderFold(fold, 120, false, false)); failures.push(...fold.failures); },
}, { write(text) { if (!rich) plain.push(text); } }, {
  updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
}));
try {
  const session = await runtime.start({ cwd: process.cwd(), localModels: false });
  session.subscribe(event => { events.push(event); for (const view of views) view.handle(event); });
  await session.prompt('Run the fixture lookups.');
  console.log('LOOKUP_VIEW=' + JSON.stringify({ events, live, folded, plain, failures, searches }));
} finally { for (const view of views) view.reset(); await runtime.dispose(); }
`);
  const run = await f.run([harness]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const result: { events: RuntimeEvent[]; live: string[]; folded: string[]; plain: string[]; failures: unknown[]; searches: string[] } = JSON.parse(run.stdout.split("LOOKUP_VIEW=")[1]!);
  expect(result.searches).toEqual(expect.arrayContaining(["rg", "fd"]));
  const ends = result.events.filter(event => event.type === "tool_end");
  for (const toolName of ["grep", "find", "ls"]) {
    expect(ends.find(event => event.toolName === toolName)).toMatchObject({ isError: false, output: { truncated: false } });
  }
  const large = ends.find(event => event.toolName === "read" && event.input?.path === "large.txt");
  expect(large?.output?.truncated).toBe(true);
  expect(Buffer.byteLength(large?.output?.text ?? "")).toBeLessThanOrEqual(8192);
  expect(large?.output?.text).toContain("BOUNDED_LOOKUP_HEAD");
  expect(large?.output?.text).toContain("BOUNDED_LOOKUP_TAIL");
  expect(ends.at(-1)?.output?.text).toStartWith("Skipped as a repeat");
  expect(result.failures).toEqual([]);
  for (const rows of [result.live, result.folded, result.plain]) {
    const text = rows.join("\n");
    expect(text).toContain("– grep · ABSENT_LOOKUP · fixture.txt — nothing found");
    expect(text).toContain("– find · absent-lookup-*.ts · . — nothing found");
    expect(text).toContain("– ls · empty — nothing found");
    expect(text).toContain("– read · fixture.txt — skipped repeated lookup");
    expect(text).not.toMatch(/✗|— failed|BOUNDED_LOOKUP_HEAD/);
  }
}, childTestLimit());
