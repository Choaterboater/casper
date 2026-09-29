import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { COMMANDS } from "../src/tui/commands";
import { describeChecksPlan } from "../src/verify/mode";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

test("the checks line says what runs and when, in plain words", () => {
  expect(describeChecksPlan({ mode: "auto", checks: ["typecheck", "test"] })).toBe("typecheck, test — run after each change");
  expect(describeChecksPlan({ mode: "offer", checks: ["test"], slow: true })).toBe("test — offered with /verify (they take a minute or more)");
  expect(describeChecksPlan({ mode: "offer", checks: ["test"] })).toBe("test — offered with /verify (verification.mode: offer)");
  expect(describeChecksPlan({ mode: "off", checks: ["test"] })).toBe("off for this session (--no-verify or verification.mode: off)");
  expect(describeChecksPlan({ mode: "auto", checks: [] })).toBe("none found; add verify.test to .casper/project.yaml");
});

test("/receipt is in the command list", () => {
  expect(COMMANDS.find((command) => command.name === "receipt")?.description).toBe("Evidence behind the last task's receipt");
});

test("/status says which checks run after a change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-checks-")); dirs.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/project.yaml"), "verify:\n  test: npm test\n  lint: npm run lint\n");
  let output = "";
  const app = new CasperApp({ runtimeFactory: () => { throw new Error("no runtime"); }, sessionHomeDir: path.join(home, ".casper"),
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    output: { write(text: string) { output += text; } } });
  try {
    await app.runOnce("/status", project);
    expect(output).toContain(" checks    lint, test — run after each change");
  } finally { await app.close(); }

  // Offer chosen in configuration is not described as slow checks.
  await writeFile(path.join(project, ".casper/project.yaml"), "verify:\n  test: npm test\nverification:\n  mode: offer\n");
  output = "";
  const configured = new CasperApp({ runtimeFactory: () => { throw new Error("no runtime"); }, sessionHomeDir: path.join(home, ".casper"),
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    output: { write(text: string) { output += text; } } });
  try {
    await configured.runOnce("/status", project);
    expect(output).toContain(" checks    test — offered with /verify (verification.mode: offer)");
  } finally { await configured.close(); }
});

test("the checks line names the dev server Casper starts for page checks, and the migrations check", () => {
  expect(describeChecksPlan({ mode: "auto", checks: ["test"], pages: "bun run dev" })).toBe("test, pages (bun run dev) — run after each change");
  expect(describeChecksPlan({ mode: "auto", checks: [], pages: "streamlit run app.py" })).toBe("pages (streamlit run app.py) — run after each change");
  expect(describeChecksPlan({ mode: "auto", checks: ["test", "migrations"] })).toBe("test, migrations — run after each change");
  // Casper opens pages only when it checks each change itself.
  expect(describeChecksPlan({ mode: "offer", checks: ["test"], pages: "bun run dev" })).toBe("test — offered with /verify (verification.mode: offer)");
});

test("/status names the dev server of a web project before it ever runs; pages: off leaves it out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-checks-")); dirs.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true }); await mkdir(path.join(project, "node_modules"));
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "web", scripts: { dev: "vite" }, devDependencies: { vite: "6.0.0" } }));
  await writeFile(path.join(project, "bun.lock"), "");
  const status = async (yaml: string) => {
    await writeFile(path.join(project, ".casper/project.yaml"), yaml);
    let output = "";
    const app = new CasperApp({ runtimeFactory: () => { throw new Error("no runtime"); }, sessionHomeDir: path.join(home, ".casper"),
      loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
      output: { write(text: string) { output += text; } } });
    try { await app.runOnce("/status", project); } finally { await app.close(); }
    return output;
  };
  expect(await status("verify:\n  test: bun test\n")).toContain(" checks    test, pages (bun run dev) — run after each change");
  expect(await status("verify:\n  test: bun test\npages: off\n")).toContain(" checks    test — run after each change");
});
