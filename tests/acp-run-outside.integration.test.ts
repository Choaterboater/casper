import { afterEach, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { OUTSIDE_RUN_DECLINED, OUTSIDE_RUN_LINE, OUTSIDE_RUN_UNASKED_LINE } from "../src/app/sandbox";
import { isOutside } from "../src/platform/inside";
import { systemTempDirs } from "../src/sandbox/policy";
import { startAcp, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { sandboxAvailable } from "./support/platform";
import { cleanUpAfterEach, fixture, lastUser, type Payload, type Step } from "./support/scripting";

// Decision 94 against a real `casper acp` child, its real sandbox (sandbox-exec on macOS, bubblewrap on Linux) and the
// scripted provider: a command the sandbox kept from writing outside the project asks the app to run it outside, and
// Don't ask runs it outside without the box, as Claude Code's bypass mode does.
const clients: AcpClient[] = [];
const outsideFolders: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const folder of outsideFolders.splice(0)) await rm(folder, { recursive: true, force: true });
});
cleanUpAfterEach();

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
const isChecklistCall = (payload: Payload) => JSON.stringify(payload.messages).includes("Casper checklist.");

/** A folder outside the project that is no system temp folder: the sandbox lets commands write temp. The checkout's
 * .scratch is ignored by git; a checkout in temp has no such place, so the test is skipped there. */
const SCRATCH = path.resolve(import.meta.dir, "..", ".scratch");
const scratchInTemp = systemTempDirs().some((temp) => !isOutside(path.relative(temp, realpathSync(path.dirname(SCRATCH)))));

/** The model touches outside-<word>.txt in `folder`, the word taken from "session <word>" in the request, then says Done. */
const touchOutside = (folder: string) => (_request: number, payload: Payload): Step =>
  isChecklistCall(payload) ? { text: "[]" } : payload.messages.at(-1)?.role === "tool" ? { text: "Done." }
    : { tools: [{ name: "bash", args: { command: `touch ${path.join(folder, `outside-${/session (\w+)/.exec(lastUser(payload))?.[1]}.txt`)}` } }] };
/** What the model read back from its command, for the request that named `word`. */
const toolResult = (payloads: Payload[], word: string) => JSON.stringify(payloads.filter((payload) => lastUser(payload).includes(`session ${word}`))
  .flatMap((payload) => payload.messages.filter((message) => message.role === "tool")));

test.skipIf(!sandboxAvailable || scratchInTemp)("a command the sandbox blocks asks the app to run it outside, naming its step: Yes, this once and Don't ask write; No and Read only do not", async () => {
  await mkdir(SCRATCH, { recursive: true });
  const outside = await realpath(await mkdtemp(path.join(SCRATCH, "acp-run-outside-")));
  outsideFolders.push(outside);
  const f = await fixture(touchOutside(outside));
  // A protected place inside the folder: the write box never offers a folder that holds one, so only this box asks.
  await mkdir(path.join(outside, "kept"));
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), `sandbox:\n  denyWrite:\n    - ${JSON.stringify(path.join(outside, "kept"))}\n`);
  const client = startAcp(f);
  clients.push(client);
  await client.request("initialize", INIT);
  const answers: Record<string, string> = {};
  client.answerPermissions((params) => {
    const kind = answers[params.sessionId] === "yes" ? "allow_once" : "reject_once";
    return { optionId: (params.options as Array<{ kind: string; optionId: string }>).find((choice) => choice.kind === kind)!.optionId };
  });
  for (const [word, mode] of [["yes", "ask"], ["no", "ask"], ["full", "full"], ["read", "read"]] as const) {
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    answers[sessionId] = word;
    if (mode !== "ask") await client.request("session/set_mode", { sessionId, modeId: mode });
    const done = await client.request("session/prompt", { sessionId, prompt: text(`Make the file for session ${word}`) });
    expect(done.stopReason).toBe("end_turn");
    expect(existsSync(path.join(outside, `outside-${word}.txt`))).toBe(word === "yes" || word === "full");
    const asked = client.permissions.filter((params) => params.sessionId === sessionId);
    if (mode === "full") expect(toolResult(f.payloads, word)).toContain(OUTSIDE_RUN_UNASKED_LINE);
    if (mode !== "ask") { expect(asked).toEqual([]); continue; }
    expect(asked).toHaveLength(1);
    // The sandbox's own report, or (where it names nothing) the command's denial words.
    expect(asked[0].toolCall.title).toMatch(/^(?:The sandbox blocked it \(wanted to write |The command said "(?:Operation not permitted|Read-only file system)"; )/);
    expect(asked[0].toolCall.title).toContain("Run this command outside the sandbox?");
    expect(asked[0].options.map((choice: { name: string; kind: string }) => [choice.name, choice.kind])).toEqual([["No", "reject_once"], ["Yes, this once", "allow_once"]]);
    // The box names the bash step that raised it (decision 85).
    const bash = client.updates.filter((update) => update.sessionId === sessionId).map((update) => update.update)
      .find((update) => update.sessionUpdate === "tool_call" && update._meta?.casper?.tool === "bash");
    expect(asked[0].toolCall._meta.casper.step).toBe(bash.toolCallId);
    const read = toolResult(f.payloads, word);
    if (word === "yes") expect(read).toContain(OUTSIDE_RUN_LINE);
    else { expect(read).toContain(OUTSIDE_RUN_DECLINED); expect(read).not.toContain(OUTSIDE_RUN_LINE); }
  }
}, childTestLimit(1));
