import { expect, test } from "bun:test";
import { decide, heavyReason, HEAVY_MS, importedHelpers, OS_PATHS, osReason, tiers } from "../tools/test-tier";
import { suiteFiles } from "../tools/test-shard";

test("every suite file is in exactly one tier, and together the tiers are the whole suite", async () => {
  const { fast, heavy } = await tiers();
  const suite = await suiteFiles();
  expect(fast.filter((file) => heavy.includes(file))).toEqual([]);
  expect([...fast, ...heavy].sort()).toEqual(suite);
  expect(fast.length).toBeGreaterThan(100);
  expect(heavy.length).toBeGreaterThan(100);
});

test("known files land in the tier they belong to", async () => {
  const { fast, heavy } = await tiers();
  // Real processes, the sandbox, a PTY or ConPTY, the browser, a language server.
  for (const file of ["tests/sandbox-live.test.ts", "tests/platform-processes.test.ts", "tests/windows-screen.test.ts", "tests/phase10-browser.test.ts", "tests/phase10-browser-checks.test.ts", "tests/phase5-lsp-real.test.ts", "tests/release-workflows.test.ts"]) {
    expect(heavy, file).toContain(file);
  }
  for (const file of ["tests/test-shard.test.ts", "tests/test-tier.test.ts", "tests/path-inside.test.ts", "tests/help-text.test.ts"]) {
    expect(fast, file).toContain(file);
  }
});

// Built from parts, so this file does not itself read as one that starts processes.
const SPAWN = ["Bun", "spawn"].join(".");
const CHILD = ["child", "process"].join("_");
const importing = (helper: string) => `import { x } from "./support/${helper}";`;

test("a file is heavy when it, or a helper it imports, starts a process, or when it is slow", () => {
  expect(heavyReason("tests/a.test.ts", `const child = ${SPAWN}(['git', 'init']);`, {})).toContain("starts processes");
  expect(heavyReason("tests/a.test.ts", `import { promisify } from 'node:${CHILD}';`, {})).toContain("starts processes");
  const helpers: Record<string, string> = { "tests/support/run.ts": `${SPAWN}(argv)`, "tests/support/wait.ts": "export const x = 1;" };
  expect(heavyReason("tests/a.test.ts", importing("run"), {}, (file) => helpers[file])).toBe("starts processes through tests/support/run.ts");
  expect(heavyReason("tests/a.test.ts", importing("wait"), {}, (file) => helpers[file])).toBeUndefined();
  // A host probe on import (platform.ts) is not the test's own work.
  expect(heavyReason("tests/a.test.ts", importing("platform"), {}, () => `${SPAWN}(probe)`)).toBeUndefined();
  expect(heavyReason("tests/a.test.ts", "expect(1).toBe(1);", { "tests/a.test.ts": HEAVY_MS + 1 })).toContain("takes");
  expect(heavyReason("tests/a.test.ts", "expect(1).toBe(1);", { "tests/a.test.ts": HEAVY_MS })).toBeUndefined();
  expect(importedHelpers(`${importing("run")}\n${importing("temp-dir.ts")}`)).toEqual(["tests/support/run.ts", "tests/support/temp-dir.ts"]);
  // A dynamic or side-effect import counts, and so does a helper imported by a helper.
  const support = ["./sup", "port/"].join("");
  expect(importedHelpers(`const { x } = await import("${support}run");\nimport "${support}wait";`)).toEqual(["tests/support/run.ts", "tests/support/wait.ts"]);
  const chain: Record<string, string> = { "tests/support/outer.ts": `import { run } from "./run";`, "tests/support/run.ts": `${SPAWN}(argv)` };
  expect(heavyReason("tests/a.test.ts", importing("outer"), {}, (file) => chain[file])).toBe("starts processes through tests/support/run.ts");
  // Bun itself as a server or check command, through Casper's own code.
  expect(heavyReason("tests/a.test.ts", `const command = ${["process", "execPath"].join(".")};`, {})).toContain("starts processes");
});

test("a push, nightly or manual run is always the whole suite; a pull request is fast only when it leaves OS behaviour alone", () => {
  const heavy = new Set(["tests/sandbox-live.test.ts"]);
  const pure = () => "export const words = 1;";
  for (const event of ["push", "schedule", "workflow_dispatch", ""]) expect(decide(event, ["docs/README.md"], heavy, pure).tier).toBe("full");
  expect(decide("pull_request", ["docs/DEVELOPING.md", "src/app/prompt-words.ts", "tests/help-text.test.ts"], heavy, pure).tier).toBe("fast");
  // Nothing listed (a diff that failed) runs everything.
  expect(decide("pull_request", [], heavy, pure).tier).toBe("full");
  for (const changed of ["src/sandbox/policy.ts", "src/platform/inside.ts", "src/tui/screen.ts", "src/app/terminal-keys.ts", "tools/stall-guard.sh", ".github/workflows/macos-preview.yml", "tests/support/run.ts", "package.json", "bun.lock", "bunfig.toml", "tests/sandbox-live.test.ts"]) {
    const decision = decide("pull_request", ["docs/README.md", changed], heavy, pure);
    expect(decision.tier, changed).toBe("full");
    expect(decision.why.join("\n"), changed).toContain(changed);
  }
  // Any src file that starts a process or checks the OS counts, wherever it is; so does a removed src file.
  expect(osReason("src/security/run.ts", heavy, () => `${SPAWN}(['semgrep'])`)).toContain("starts processes or checks the OS");
  expect(osReason("src/pictures/open.ts", heavy, () => "if (process.platform === 'win32') {}")).toContain("starts processes or checks the OS");
  expect(osReason("src/security/gone.ts", heavy, () => undefined)).toContain("removed");
  expect(osReason("docs/gone.md", heavy, () => undefined)).toBeUndefined();
});

test("the OS path list includes the platform, process, terminal and build areas", () => {
  for (const entry of ["src/platform/", "src/runtime/", "src/browser/", "src/sandbox/", "src/services/", "src/workspace/", "src/verify/", "src/crew/", "src/agents/", "src/tui/", "src/app/*terminal*", "tools/", ".github/", "tests/support/", "package.json", "bun.lock", "bunfig.toml"]) {
    expect(OS_PATHS).toContain(entry);
  }
});
