import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { copyRequest, copyStep, mainBlock, pasteBlocks } from "../src/app/copy-words";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/**
 * A real session on a NAS's Home Assistant folder: a running container rewrites its database and log all the time, the
 * AI gave a prompt to paste later as a quote, and the person copied the quote's "│" gutter along with it.
 */

const PROMPT_ANSWER = "When you're ready, paste this into Casper:\n\n> Upgrade my Home Assistant to 2026.10 safely: back up config first, then pull the new image and restart.\n";

test("an answer's code and quote blocks, in order; the main block is the one the answer is mostly made of", () => {
  const blocks = pasteBlocks("Run:\n\n```bash\ncd /srv/ha\ndocker compose pull\n```\n\nThen paste:\n\n> Check the logs\n> for errors\n");
  expect(blocks).toEqual([{ kind: "code", language: "bash", text: "cd /srv/ha\ndocker compose pull" }, { kind: "quote", text: "Check the logs\nfor errors" }]);
  expect(mainBlock(PROMPT_ANSWER)).toEqual({ kind: "quote", text: "Upgrade my Home Assistant to 2026.10 safely: back up config first, then pull the new image and restart." });
  expect(copyStep(PROMPT_ANSWER)).toEqual({ label: "Copy the prompt", command: "/copy 1", note: "free" });
  expect(copyStep("Run it:\n\n```sh\ndocker compose restart homeassistant\n```\n")?.label).toBe("Copy the command");
  // Two blocks, or a long explanation with a short snippet: no step.
  expect(copyStep("Run:\n```sh\nls\n```\nand\n```sh\npwd\n```\n")).toBeUndefined();
  expect(copyStep(`${"Home Assistant keeps its history in a SQLite database next to its config. ".repeat(4)}\n\n\`\`\`sh\nls\n\`\`\`\n`)).toBeUndefined();
  // A quote line inside a fence is code, not a quote.
  expect(pasteBlocks("```md\n> not a quote\n```\n")).toEqual([{ kind: "code", language: "md", text: "> not a quote" }]);
});

test("the words that copy the block, and the ones that don't", () => {
  for (const line of ["copy that", "copy the prompt", "Copy it.", "please copy the command", "copy the code to clipboard"]) expect([line, copyRequest(line)]).toEqual([line, "/copy 1"]);
  for (const line of ["copy the config from /srv to /backup", "copy that file into the container", "how do I copy that?"]) expect([line, copyRequest(line)]).toEqual([line, undefined]);
  expect(copyRequest("copy that", ["copy that"])).toBeUndefined();
});

/** An interactive session on the plain terminal over a Home Assistant folder, a fake model per turn, the clipboard faked
 * and every box Casper opens counted. */
async function session(turn: (emit: (event: Parameters<RuntimeEventListener>[0]) => void, project: string) => Promise<string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-ha-"));
  const home = path.join(root, "home"), project = path.join(root, "homeassistant");
  await mkdir(home, { recursive: true }); await mkdir(path.join(project, "config"), { recursive: true });
  await writeFile(path.join(project, "config", "automations.yaml"), "[]\n");
  await writeFile(path.join(project, "config", "home-assistant_v2.db"), "db v1");
  await writeFile(path.join(project, "config", "home-assistant.log"), "started\n");
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const answers: string[] = [];
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        recentTurns: () => answers.map((text) => ({ role: "assistant" as const, text })),
        abort: async () => {}, setTools: () => {},
        prompt: async () => {
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          const answer = await turn(emit, project);
          answers.push(answer);
          emit({ type: "assistant_text_delta", delta: answer });
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const copied: string[] = [];
  const app = new CasperApp({
    input, output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    copyText: async (text) => { copied.push(text); },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  // Every box that waits for the person.
  let boxes = 0;
  for (const name of ["pick", "ask", "approve", "pickPlan", "askLine"] as const) {
    const original = (app.terminal as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!.bind(app.terminal);
    (app.terminal as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { boxes++; return original(...args); };
  }
  const running = app.runInteractive(project);
  const send = async (line: string) => {
    const from = output.length;
    input.write(`${line}\n`);
    const deadline = Date.now() + 25_000;
    while (!/\n> $/.test(output.slice(from))) {
      if (Date.now() > deadline) throw new Error(`no prompt after ${JSON.stringify(line)}:\n${output.slice(from)}`);
      await Bun.sleep(20);
    }
    return output.slice(from);
  };
  return { app, copied, send, boxes: () => boxes, close: async () => { input.end(); await running; await app.close(); await removeTempDir(root); } };
}

test("Home Assistant writes its database and log while the AI's command runs: the app's, not checked, and no box asks anything", async () => {
  const s = await session(async (emit, project) => {
    emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command: "docker compose logs --tail 50 homeassistant > /tmp/ha.txt" } });
    // The container, meanwhile.
    await writeFile(path.join(project, "config", "home-assistant_v2.db"), "db v2");
    await writeFile(path.join(project, "config", "home-assistant_v2.db-wal"), "wal");
    await writeFile(path.join(project, "config", "home-assistant.log"), "started\nping\n");
    emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command: "docker compose logs --tail 50 homeassistant > /tmp/ha.txt" } });
    return "Nothing changed: Home Assistant is running and its log shows no errors.\n";
  });
  try {
    const shown = await s.send("check why home assistant is slow");
    const task = s.app.getLastTaskResult()!;
    expect(task.changedPaths ?? []).toEqual([]);
    expect(task.changedNotByModel).toEqual(["config/home-assistant.log", "config/home-assistant_v2.db", "config/home-assistant_v2.db-wal"]);
    expect(shown).not.toContain("Changed 3 files");
    expect(shown).not.toContain("over 8 MB");
    // A normal task opens no box: the same as before these changes.
    expect(s.boxes()).toBe(0);
  } finally { await s.close(); }
}, 60_000);

test("an answer that is a prompt to paste later: the row offers to copy it, and 1 or 'copy that' copies it without the quote marks", async () => {
  const s = await session(async () => PROMPT_ANSWER);
  try {
    const shown = await s.send("write me a prompt for the upgrade I can paste later");
    expect(shown).toContain("Next: 1 Copy the prompt (free)");
    await s.send("1");
    expect(s.copied).toEqual(["Upgrade my Home Assistant to 2026.10 safely: back up config first, then pull the new image and restart."]);
    const words = await s.send("copy that");
    expect(words).toContain("[copy] Handled here, no model call: /copy 1 does the same.");
    expect(s.copied).toHaveLength(2);
    expect(s.copied[1]).not.toContain(">");
    expect(s.boxes()).toBe(0);
  } finally { await s.close(); }
}, 60_000);
