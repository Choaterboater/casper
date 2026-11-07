import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { offerOf, setOption } from "../src/acp/config-options";
import { ACCESS_MODES, accessModeOf, FULL_REFUSED, modeState, setAccessMode, withModeTold, type AccessHost } from "../src/acp/modes";
import { AcpAsker, READ_ONLY_NO } from "../src/acp/permission";
import { hider } from "../src/acp/updates";
import { PLANNING_BLOCKED, planToolGate, READ_ONLY_BLOCKED } from "../src/flows/plan";
import { NO, YES_ONCE, YES_SESSION } from "../src/app/safe-choices";
import { loadConfiguration } from "../src/config/load";
import { stopAsking } from "../src/app/commands";
import { formatTaskPrompt, READ_ONLY_TYPED, classifyTask } from "../src/task/classify";
import { describeChecksPlan } from "../src/verify/mode";
import { InteractiveTerminal, type AwayQuestion } from "../src/tui/terminal";
import { sandboxHost } from "../src/app/wiring";
import type { CasperApp } from "../src/app";
import { removeTempDir } from "./support/temp-dir";
import { until } from "./support/acp-client";

// The access an ACP app's chip sets (decision 82): Read only, Ask first and Don't ask, as session modes and as the
// `mode` config option.
const plainHide = hider(() => []);
const host = (context: AccessHost["projectContext"] = undefined): AccessHost & { footer: number } => {
  const app = { readOnlyAccess: false, stopAsking: false, clientAccess: undefined, projectContext: context, footer: 0,
    updateFooter() { app.footer++; } } as AccessHost & { footer: number };
  return app;
};
const offAccess = { acpAccess: "off" } as AccessHost["projectContext"];

test("the modes and the mode option list the same three, Ask first current; the option is last, with or without a model", () => {
  const app = host();
  const modes = modeState(app, plainHide);
  expect(modes.currentModeId).toBe("ask");
  expect((modes.availableModes as Array<{ id: string }>).map((mode) => mode.id)).toEqual(["read", "ask", "full"]);
  const option = offerOf(undefined, plainHide, app).wire;
  expect(option).toEqual([{ id: "mode", name: "Access", category: "mode", type: "select", currentValue: "ask",
    options: ACCESS_MODES.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })) }]);
  expect(modes.availableModes).toEqual((option[0]!.options as Array<{ value: string; name: string; description: string }>).map((entry) => ({ id: entry.value, name: entry.name, description: entry.description })));
  // With a model, model and effort come first and the mode stays last.
  const runtime = { getStatus: () => ({ auth: "configured" as const, provider: "p", model: "m", configuredEffort: "auto", availableThinkingLevels: ["off", "low", "high"] }),
    offeredModels: () => [{ provider: "p", id: "m", name: "M", levels: ["off", "low", "high"] }] };
  expect(offerOf(runtime, plainHide, app).wire.map((entry) => entry.id)).toEqual(["model", "effort", "mode"]);
  // Don't ask says what still asks: the app's own tools ask in Casper's box.
  expect(ACCESS_MODES.find((mode) => mode.id === "full")!.description).toContain("The app's own tools ask in Casper's box");
});

test("each mode sets Read only and /permissions all's switch; Read only holds whatever else is set", () => {
  const app = host();
  const lines: string[] = [];
  expect(setAccessMode(app, "read", (text) => lines.push(text))).toBe("ask");
  expect([app.readOnlyAccess, app.stopAsking, app.clientAccess, accessModeOf(app)]).toEqual([true, false, "read", "read"]);
  expect(setAccessMode(app, "full", (text) => lines.push(text))).toBe("read");
  expect([app.readOnlyAccess, app.stopAsking, app.clientAccess, accessModeOf(app)]).toEqual([false, true, "full", "full"]);
  expect(setAccessMode(app, "ask", (text) => lines.push(text))).toBe("full");
  expect([app.readOnlyAccess, app.stopAsking, app.clientAccess, accessModeOf(app)]).toEqual([false, false, "ask", "ask"]);
  // The same mode again writes nothing.
  setAccessMode(app, "ask", (text) => lines.push(text));
  expect(lines).toHaveLength(3);
  expect(lines[0]).toStartWith("[permissions] The app set Read only:");
  expect(app.footer).toBe(4);
  expect(accessModeOf({ readOnlyAccess: true, stopAsking: true })).toBe("read");
});

test("an unknown mode, a value that is not a string and Don't ask with acp_access off are refused and change nothing", async () => {
  const app = host();
  setAccessMode(app, "read", () => {});
  const refused = (value: unknown, on = app) => { try { setAccessMode(on, value, () => {}); return undefined; } catch (error) { return { code: (error as { code: number }).code, message: (error as Error).message }; } };
  expect(refused("everything")).toEqual({ code: -32602, message: "Unknown mode: everything (read, ask, full)" });
  expect(refused(true)).toEqual({ code: -32602, message: "mode takes one of its listed values" });
  expect(accessModeOf(app)).toBe("read");
  // acp_access off: only Read only and Ask first are offered, and Don't ask is refused in plain words.
  const off = host(offAccess);
  expect((modeState(off, plainHide).availableModes as Array<{ id: string }>).map((mode) => mode.id)).toEqual(["read", "ask"]);
  expect(refused("full", off)).toEqual({ code: -32602, message: FULL_REFUSED });
  expect([off.stopAsking, off.clientAccess]).toEqual([false, undefined]);
  // /permissions all typed in the chat is the person's own: the mode in use stays listed.
  off.stopAsking = true;
  expect((modeState(off, plainHide).availableModes as Array<{ id: string }>).map((mode) => mode.id)).toEqual(["read", "ask", "full"]);
  // Through the option: the mode branch needs no runtime; another option name is still unknown.
  await setOption(undefined, offerOf(undefined, plainHide, app), "mode", "ask", () => {}, app);
  expect(accessModeOf(app)).toBe("ask");
  await expect(setOption(undefined, offerOf(undefined, plainHide, app), "colour", "red", () => {}, app)).rejects.toThrow("Unknown option: colour");
});

const box: AwayQuestion = { kind: "approve", question: "The AI wants to run touch x.txt. Allow it?", choices: [{ label: NO }, { label: YES_ONCE }, { label: YES_SESSION }], from: "approval" };

test("withdrawAll closes an open box as No; a box asked while Read only is No without a request", async () => {
  const sent: Record<string, any>[] = [];
  const updates: Record<string, any>[] = [];
  let answer!: (value: unknown) => void;
  const channel = {
    // The client answers Yes only after the switch: it counts for nothing.
    request: (params: Record<string, any>) => { sent.push(params); return new Promise((resolve) => { answer = resolve; }); },
    update: (update: Record<string, any>) => { updates.push(update); },
  };
  let readOnly = false;
  const asker = new AcpAsker("s1", channel);
  asker.readOnly = () => readOnly;
  const open = asker.ask(box);
  await Bun.sleep(0);
  expect(sent).toHaveLength(1);
  readOnly = true;
  asker.withdrawAll();
  answer({ outcome: { outcome: "selected", optionId: "2" } });
  expect(await open).toBeUndefined();
  expect(updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "casper-approval-1", status: "failed",
    content: [{ type: "content", content: { type: "text", text: READ_ONLY_NO } }] });
  // The box queued behind it: No, and the client is never asked.
  expect(await asker.ask(box)).toBeUndefined();
  expect(sent).toHaveLength(1);
  expect(updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "casper-approval-2", status: "failed",
    content: [{ type: "content", content: { type: "text", text: READ_ONLY_NO } }] });
  // A box asked once the app allows changes again goes to the client.
  readOnly = false;
  void asker.ask(box);
  await Bun.sleep(0);
  expect(sent).toHaveLength(2);
  asker.withdrawAll();
});

test("a shell or host box queued behind an open one is No without a card once the app sets Read only, though it was asked before", async () => {
  const sent: Record<string, any>[] = [];
  const asker = new AcpAsker("s1", {
    // The first card stays open; any later one would be answered with its first yes.
    request: (params: Record<string, any>, signal?: AbortSignal) => {
      sent.push(params);
      if (sent.length === 1) return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled"))));
      return Promise.resolve({ outcome: { outcome: "selected", optionId: (params.options as Array<{ kind: string; optionId: string }>).find((option) => option.kind !== "reject_once")!.optionId } });
    },
    update: () => {},
  });
  const screen = { isTTY: false, columns: 80, rows: 24, write() {} };
  const terminal = new InteractiveTerminal(new PassThrough(), screen as never, () => {}, () => {});
  terminal.leave(screen, asker);
  const app = { readOnlyAccess: false, interactive: false, remoteApprovals: true, terminal, closing: false, approvalQueue: Promise.resolve(),
    output: { write() {} }, changesBlocked: () => undefined } as unknown as CasperApp;
  asker.readOnly = () => app.readOnlyAccess;
  const sandbox = sandboxHost(app);
  // What the shell's approval does for each of two commands the AI runs at once: canAsk, then the box (a pick).
  const approve = (question: string) => sandbox.canAsk() ? sandbox.pick(question, [{ label: NO }, { label: YES_ONCE }, { label: YES_SESSION }]) : Promise.resolve("not asked");
  const first = approve("A shell command wants to reach example.com. Allow it?");
  const second = approve("A shell command wants to reach example.org. Allow it?");
  await until(() => sent.length > 0, 5_000, "the first card");
  app.readOnlyAccess = true;
  asker.withdrawAll();
  expect(await first).toBeUndefined();
  expect(await second).toBeUndefined();
  expect(sent).toHaveLength(1);
});

test("Read only uses the plan turn's gate with its own words; reads and look commands still run", () => {
  expect(planToolGate("write", { path: "a" }, undefined, READ_ONLY_BLOCKED)).toBe(`Not run: ${READ_ONLY_BLOCKED}.`);
  expect(planToolGate("edit", { path: "a" }, undefined, READ_ONLY_BLOCKED)).toStartWith("Not run: Read only:");
  expect(planToolGate("bash", { command: "touch x.txt" }, undefined, READ_ONLY_BLOCKED)).toStartWith(`Not run: ${READ_ONLY_BLOCKED}. It runs only look commands`);
  expect(planToolGate("service", {}, undefined, READ_ONLY_BLOCKED)).toEndWith("It allows only read, grep, find, ls, web, GitHub and MCP lookups and read-only helpers, not service.");
  expect(planToolGate("bash", { command: "ls -la" }, undefined, READ_ONLY_BLOCKED)).toBeUndefined();
  expect(planToolGate("read", { path: "a" }, undefined, READ_ONLY_BLOCKED)).toBeUndefined();
  // The plan turn keeps its words.
  expect(planToolGate("write", { path: "a" })).toBe(`Not run: ${PLANNING_BLOCKED}.`);
});

test("a Read only request gets one line in its prompt, and no other request does; the checks line names it", () => {
  const model = { languages: [], frameworks: [], commands: {} } as unknown as Parameters<typeof formatTaskPrompt>[2];
  const plain = formatTaskPrompt("Add a line to notes.txt", classifyTask("Add a line to notes.txt"), model);
  expect(plain).not.toContain(READ_ONLY_TYPED);
  const readOnly = formatTaskPrompt("Add a line to notes.txt", classifyTask("Add a line to notes.txt"), model, { readOnly: true });
  expect(readOnly).toContain(`- ${READ_ONLY_TYPED}`);
  expect(readOnly.split("\n").length).toBe(plain.split("\n").length + 1);
  expect(describeChecksPlan({ mode: "off", checks: [], readOnly: true })).toBe("off: read only (set by the app)");
});

test("acp_access is read from ~/.casper/config.yaml only: on by default, and a project or profile cannot set it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-acp-access-"));
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await mkdir(path.join(home, ".casper/profiles/default"), { recursive: true });
    await mkdir(path.join(project, ".casper"), { recursive: true });
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpAccess).toBeUndefined();
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_access: off\n");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpAccess).toBe("off");
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_access: false\n");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpAccess).toBe("off");
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_access: sometimes\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_access must be");
    await writeFile(path.join(home, ".casper/config.yaml"), "");
    await writeFile(path.join(project, ".casper/project.yaml"), "acp_access: on\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_access is a user setting");
    await writeFile(path.join(project, ".casper/project.yaml"), "");
    await writeFile(path.join(home, ".casper/profiles/default/config.yaml"), "acp_access: off\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_access is set in ~/.casper/config.yaml only");
  } finally { await removeTempDir(root); }
});

test("\"Yes to everything this session\" and /permissions all turn the same switch, and tell the app at once", () => {
  // The shell box's Yes to everything calls this switch (askNoMore), as /permissions all's box does.
  let told = 0;
  const lines: string[] = [];
  const app = { stopAsking: false, updateFooter() {}, output: { write: (text: string) => { lines.push(text); } }, onAccessChange: () => { told++; } };
  stopAsking(app);
  expect([app.stopAsking, told, accessModeOf({ readOnlyAccess: false, stopAsking: app.stopAsking })]).toEqual([true, 1, "full"]);
  expect(lines[0]).toStartWith("[permissions] Not asking until you quit");
});

test("over ACP the shell box's \"Yes to everything this session\" is Don't ask: the app is told, and the sandbox stops asking", () => {
  let told = 0;
  const app = { stopAsking: false, readOnlyAccess: false, interactive: false, remoteApprovals: true, closing: false, terminal: { canAsk: true },
    updateFooter() {}, output: { write() {} }, onAccessChange: () => { told++; } } as unknown as CasperApp;
  const sandbox = sandboxHost(app);
  expect(sandbox.stopAsking?.()).toBe(false);
  // The shell box's answer (src/app/sandbox.ts): askNoMore turns /permissions all's switch.
  sandbox.askNoMore?.();
  expect([told, accessModeOf(app), sandbox.stopAsking?.()]).toEqual([1, "full", true]);
  // A run nobody answers never stops asking this way.
  expect(sandboxHost({ ...app, remoteApprovals: false } as unknown as CasperApp).stopAsking?.()).toBe(false);
});

test("after session/set_mode only the mode counts as told: a model change Casper made and has not sent is still sent", () => {
  const model = (value: string) => ({ id: "model", type: "select", currentValue: value, options: [] });
  const mode = (value: string) => ({ id: "mode", type: "select", currentValue: value, options: [] });
  const told = JSON.stringify([model("fixture/first"), mode("ask")]);
  // Casper moved to another model mid-prompt, then the app set Read only.
  const now = [model("fixture/second"), mode("read")];
  const after = withModeTold(told, now);
  expect(JSON.parse(after)).toEqual([model("fixture/first"), mode("read")]);
  expect(after).not.toBe(JSON.stringify(now));
  // With nothing else changed, the next update has nothing to say.
  expect(withModeTold(told, [model("fixture/first"), mode("read")])).toBe(JSON.stringify([model("fixture/first"), mode("read")]));
});

test("acp_questions is a user setting, on by default, and refused in a project or profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-acp-questions-"));
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await mkdir(path.join(home, ".casper/profiles/default"), { recursive: true });
    await mkdir(path.join(project, ".casper"), { recursive: true });
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpQuestions).toBeUndefined();
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_questions: off\n");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpQuestions).toBe("off");
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_questions: false\n");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpQuestions).toBe("off");
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_questions: true\n");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpQuestions).toBe("on");
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_questions: sometimes\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_questions must be");
    await writeFile(path.join(home, ".casper/config.yaml"), "");
    await writeFile(path.join(project, ".casper/project.yaml"), "acp_questions: on\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_questions is a user setting");
    await writeFile(path.join(project, ".casper/project.yaml"), "");
    await writeFile(path.join(home, ".casper/profiles/default/config.yaml"), "acp_questions: off\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_questions is set in ~/.casper/config.yaml only");
  } finally { await removeTempDir(root); }
});
