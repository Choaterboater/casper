import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { browserDefaults } from "../src/browser/discovery";
import { findLookCommand, lookFixesNamed, lookWords, parseLookArgs } from "../src/look/commands";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { closingListAsks } from "../src/task/ending";
import { removeTempDir } from "./support/temp-dir";

const PAGE = "http://127.0.0.1:5173/";

/** A critique that ends with its questions, as the real one did. */
const CRITIQUE = [
  "## Issues",
  "1. **P1: the orders table is cut off at 1280 wide.** Two columns are off-screen.",
  "   - Fix: keep each row on one line.",
  "   - `/look adapt`",
  "2. **P2: the table is cluttered.** Most rows show \"-\".",
  "   - `/look polish`",
  "3. **P2: \"4 items without a price\" does nothing.**",
  "   - `/look clarify`",
  "",
  "## Questions that could change the design",
  "1. Do you mostly use this on a phone or at a desk? That decides which fix comes first.",
  "2. Which price do you act on?",
].join("\n");

/** The answer to its questions: the list again, in a new order, ending without a question. */
const REVISED = [
  "Since you mostly use a desk, the table fix comes first.",
  "",
  "1. **P1: the orders table is cut off at 1280 wide.**",
  "   - `/look adapt`",
  "2. **P2: \"4 items without a price\" does nothing.** Make it a link that filters the table.",
  "   - `/look clarify`",
  "3. **P2: the table is cluttered.**",
  "   - `/look polish` (the \"Why?\" column too)",
  "",
  "No files were changed.",
].join("\n");

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

test("the fixes a look report names for its issues, in the order it names them; report commands and unknown words are left out", () => {
  expect(lookFixesNamed(CRITIQUE).map(({ name }) => name)).toEqual(["adapt", "polish", "clarify"]);
  expect(lookFixesNamed(REVISED).map(({ name }) => name)).toEqual(["adapt", "clarify", "polish"]);
  expect(lookFixesNamed("Run `/look critique` again, then `/look color` and `/look bogus`; /look fix and /LOOK Adapt.").map(({ name }) => name))
    .toEqual(["colour", "adapt"]);
  expect(lookFixesNamed("Everything works well; nothing to fix.")).toEqual([]);
});

test("an answer that ends with a list of questions asks the person; a list of issues, or a closing line under it, doesn't", () => {
  expect(closingListAsks(CRITIQUE)).toBe(true);
  expect(closingListAsks("Questions:\n1. Do you edit the price often, or is it set once when you add the item?\n")).toBe(true);
  expect(closingListAsks("- **Which price?** It decides the order.")).toBe(true);
  expect(closingListAsks(REVISED)).toBe(false);
  expect(closingListAsks(REVISED.split("\n").slice(0, -2).join("\n"))).toBe(false);
  expect(closingListAsks("Open http://127.0.0.1:5173/?tab=orders to see it.")).toBe(false);
});

test("/look fix, typed with or without the slash, with the person's words after it", () => {
  expect(parseLookArgs("fix")).toEqual({ fix: true });
  expect(parseLookArgs("fix but keep the tab name")).toEqual({ fix: true, words: "but keep the tab name" });
  expect(lookWords("look fix")).toEqual({ fix: true });
  expect(lookWords("look fix, and keep the tab name")).toEqual({ fix: true, words: ", and keep the tab name" });
});

/** An app whose model answers each prompt with the next scripted answer; a function answer may change files first. */
async function fixture(answers: Array<string | ((project: string) => Promise<string>)>, input?: PassThrough) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-look-fix-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project);
  // An empty folder would ask about a new project.
  await writeFile(path.join(project, "notes.txt"), "Orders page notes.\n");
  const previous = browserDefaults.installed;
  browserDefaults.installed = async () => true;
  cleanup.push(() => { browserDefaults.installed = previous; });
  const prompts: string[] = [];
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools() {}, async clearConversation() {},
        prompt: async (text: string) => {
          prompts.push(text);
          const next = answers.shift() ?? "ok";
          const answer = typeof next === "string" ? next : await next(project);
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          emit({ type: "assistant_text_delta", delta: `${answer}\n` });
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({
    ...(input ? { input } : {}), output: { write: (text: string) => { output += text; } },
    runtimeFactory: () => runtime, sessionHomeDir: home, verificationMode: "off",
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanup.push(() => app.close());
  // Polls: the text shows once Casper has written it, from `from` on.
  const until = async (text: string, from = 0) => {
    const started = Date.now();
    while (!output.slice(from).includes(text)) {
      if (Date.now() - started > 20_000) throw new Error(`Missing output text: ${JSON.stringify(text)}\n${output.slice(from)}`);
      await Bun.sleep(10);
    }
    return output.indexOf(text, from) + text.length;
  };
  return { app, project, prompts, output: () => output, until };
}

test("in a session, 1 on the row after a look report fixes everything it found in one task, once its questions are answered", async () => {
  const input = new PassThrough();
  const fixed = async (project: string) => {
    await writeFile(path.join(project, "notes.txt"), "Orders page notes, fixed.\n");
    return "Done: the table fits at 1280, the price link filters it, and the rows are calmer. The type could still use `/look type`.";
  };
  const casper = await fixture([CRITIQUE, REVISED, fixed], input);
  const interactive = casper.app.runInteractive(casper.project);
  input.write(`/look critique ${PAGE}\n`);
  // Its last words are questions, numbered: a 1 typed next is an answer, so no row comes under them.
  let at = await casper.until("2. Which price do you act on?");
  at = await casper.until("> ", at);
  expect(casper.output()).not.toContain("Fix all of it");

  input.write("mainly a desk\n");
  at = await casper.until(`Next: 1 Fix all of it (uses tokens)\n  Why: /look adapt, clarify and polish on ${PAGE}, in one task\n`, at);
  at = await casper.until("> ", at);
  input.write("1\n");
  at = await casper.until(`[look] Fixing what the last report found, with adapt, clarify and polish: ${PAGE}\n`, at);
  at = await casper.until("Done: the table fits at 1280", at);
  at = await casper.until("> ", at);
  expect(casper.prompts).toHaveLength(3);
  const fix = casper.prompts[2]!;
  expect(fix).toContain(`Fix the issues your last look report found, most important first and as the person's replies since changed them, on the web page \`${PAGE}\` in the browser (\`/look adapt\`, \`/look clarify\`, \`/look polish\`).`);
  for (const name of ["adapt", "clarify", "polish"]) expect(fix).toContain(findLookCommand(name)!.body.trim());
  for (const name of ["critique", "type", "layout"]) expect(fix).not.toContain(`--- Look ${name} ---`);

  // The fix changed a file: what it says is left is no new report, and the fixes were used once.
  expect(casper.output().slice(at)).not.toContain("Fix all of it");
  input.write("/look fix\n");
  await casper.until("[look] Nothing to fix yet: /look fix fixes what the last /look report (critique or audit) found, after it. Nothing was started.\n", at);
  expect(casper.prompts).toHaveLength(3);
  input.end();
  await interactive;
}, 60_000);

test("one-shot: /look fix before a report starts nothing; after one it fixes what it found, with no row; /clear forgets it", async () => {
  const casper = await fixture([REVISED, "Done.", REVISED]);
  const project = casper.project;
  await casper.app.runOnce("/look fix", project);
  expect(casper.output()).toContain("[look] Nothing to fix yet: /look fix fixes what the last /look report (critique or audit) found, after it. Nothing was started.\n");
  expect(casper.prompts).toHaveLength(0);

  await casper.app.runOnce(`/look critique ${PAGE}`, project);
  expect(casper.output()).not.toContain("Fix all of it");
  await casper.app.runOnce("/look fix keep the old tab name", project);
  expect(casper.output()).toContain(`[look] Fixing what the last report found, with adapt, clarify and polish: ${PAGE}\n`);
  expect(casper.prompts[1]).toContain("The person's own words with it: keep the old tab name");
  for (const name of ["adapt", "clarify", "polish"]) expect(casper.prompts[1]).toContain(findLookCommand(name)!.body.trim());

  await casper.app.runOnce(`/look critique ${PAGE}`, project);
  await casper.app.runOnce("/clear", project);
  await casper.app.runOnce("/look fix", project);
  expect(casper.output().split("[look] Nothing to fix yet").length).toBe(3);
  expect(casper.prompts).toHaveLength(3);
});
