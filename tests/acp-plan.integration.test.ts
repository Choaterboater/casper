import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentText, startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixture, isChecklist, lastUser, type Payload, type Step } from "./support/scripting";

// /plan in an app over a real `casper acp` and the scripted provider (decision 84): the Build box, Change the plan in
// the same prompt, the build's steps as plan entries, and the `plan` option.
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const FORMS = { ...INIT, clientCapabilities: { ...INIT.clientCapabilities, elicitation: { form: {} } } };
const text = (words: string) => [{ type: "text", text: words }];
const ofSession = (client: AcpClient, sessionId: string) => client.updates.filter((update) => update.sessionId === sessionId).map((update) => update.update);
type Json = Record<string, any>;
/** The option of a box by its name. */
const choose = (params: Json, name: string) => ({ optionId: (params.options as Array<{ name: string; optionId: string }>).find((option) => option.name === name)!.optionId });
const isPlanBox = (params: Json) => params.toolCall?._meta?.casper?.plan !== undefined;

const PLAN = "Title: Add a greeting\n\nSteps:\n1. Write greeting.txt\n2. Say hello in it\n\nDone means:\n1. greeting.txt says hello";
const REWRITTEN = "Title: Add a greeting\n\nSteps:\n1. Write greeting.txt\n\nDone means:\n1. greeting.txt says hello";
const QUESTIONS = JSON.stringify({ questions: [{ question: "Which greeting?", options: [{ label: "Hello there" }, { label: "Good morning" }] }] });
const ANSWER = "Step 2 puts the words in, so the file is not empty.";

/** The model plans (`first`), rewrites, answers a question about the plan, and builds with plan_step reports. */
const planner = (first = PLAN) => (_request: number, payload: Payload): Step => {
  if (isChecklist(payload)) return { text: "[]" };
  if (payload.messages.at(-1)?.role === "tool") return { text: "Built." };
  const asked = lastUser(payload);
  if (asked.includes("Rewrite the current plan")) return { text: REWRITTEN };
  if (asked.includes("is reviewing this plan and asks a question")) return { text: ANSWER };
  if (asked.includes("Question round finished")) return { text: PLAN };
  if (asked.includes("Casper plan (the user read and accepted it)")) {
    return { tools: [{ name: "write", args: { path: "greeting.txt", content: "hello\n" } }, { name: "plan_step", args: { step: 1, status: "done" } },
      { name: "plan_step", args: { step: 2, status: "done" } }] };
  }
  if (asked.includes("plan-first")) return { text: first };
  return { text: "Done." };
};

async function planProject(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(path.join(f.project, ".casper"), { recursive: true });
  await writeFile(path.join(f.project, ".casper/project.yaml"), "verification:\n  mode: off\n");
  await writeFile(path.join(f.project, "README.md"), "A project.\n");
}
const savedPlans = async (f: Awaited<ReturnType<typeof fixture>>) => (await readdir(path.join(f.project, ".casper/plans")).catch(() => [])).filter((name) => name.endsWith(".md"));
const STOPPED = "[plan] Stopped without building.";
const KEPT = "[plan] The plan is saved: /plan reopens it.";
/** Both notes, each a line of its own, the saved one after the stop. */
const stoppedThenKept = (words: string) => words.includes(`${STOPPED}\n`) && words.indexOf(`${KEPT}\n`) > words.indexOf(STOPPED);

describe("an ACP app reviews and builds Casper's plan (decision 84)", () => {
  test("Slash plan in a form app shows the Build box, and Build builds with the steps as entries", async () => {
    const f = await fixture(planner());
    await planProject(f);
    const client = open(f);
    await client.request("initialize", FORMS);
    client.answerPermissions((params) => choose(params, "Build"));
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("/plan add a greeting file") })).stopReason).toBe("end_turn");
    expect(client.permissions).toHaveLength(1);
    const box = client.permissions[0]!;
    expect(box.toolCall.title).toBe("Build this plan?");
    expect(box.toolCall._meta).toEqual({ casper: { plan: { approve: "Build", change: "Change the plan" } } });
    expect(box.options.map((option: Json) => [option.name, option.kind])).toEqual([["Stop", "reject_once"], ["Build", "allow_once"], ["Change the plan", "reject_once"]]);
    const markdown = box.toolCall.content[0].content.text as string;
    expect(markdown).toStartWith("# Add a greeting\n");
    expect(markdown).toContain("## Steps\n1. Write greeting.txt\n2. Say hello in it");
    expect(markdown).toContain("## Done means\n1. greeting.txt says hello");
    expect(existsSync(path.join(f.project, "greeting.txt"))).toBe(true);
    // The plan's own words were thoughts, never the app's message: the box carries the plan.
    const updates = ofSession(client, sessionId);
    expect(updates.filter((update) => update.sessionUpdate === "agent_thought_chunk").map((update) => update.content.text).join("")).toContain("Steps:");
    expect(agentText(client.updates, sessionId)).not.toContain("Title: Add a greeting");
    // The build's steps are the plan entries, each as the model reported it.
    const plans = updates.filter((update) => update.sessionUpdate === "plan").map((update) => update.entries.map((entry: Json) => [entry.content, entry.status]));
    expect(plans[0]).toEqual([["Write greeting.txt", "in_progress"], ["Say hello in it", "pending"]]);
    expect(plans.at(-1)).toEqual([["Write greeting.txt", "completed"], ["Say hello in it", "completed"]]);
    expect(plans.flat().map(([content]) => content)).not.toContain("Do the task");
  }, childTestLimit(1));

  test("Change the plan asks what should change, rewrites the plan and shows the box again in the same prompt", async () => {
    const f = await fixture(planner());
    await planProject(f);
    const client = open(f);
    await client.request("initialize", FORMS);
    client.answerPermissions((params) => choose(params, client.permissions.length === 1 ? "Change the plan" : "Stop"));
    client.answerForms(() => ({ action: "accept", content: { answer: "drop step 2" } }));
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("/plan add a greeting file") })).stopReason).toBe("end_turn");
    expect(client.forms.map((form) => form.message)).toEqual(["What should change?"]);
    expect(JSON.stringify(f.payloads)).toContain("drop step 2");
    expect(client.permissions).toHaveLength(2);
    const again = client.permissions[1]!.toolCall.content[0].content.text as string;
    expect(again).toContain("1. Write greeting.txt");
    expect(again).not.toContain("Say hello in it");
    expect(existsSync(path.join(f.project, "greeting.txt"))).toBe(false);
    expect(stoppedThenKept(agentText(client.updates, sessionId))).toBe(true);
    expect(await savedPlans(f)).toHaveLength(1);
  }, childTestLimit(1));

  test("A question as the change is answered and the box comes back", async () => {
    const f = await fixture(planner());
    await planProject(f);
    const client = open(f);
    await client.request("initialize", FORMS);
    client.answerPermissions((params) => choose(params, client.permissions.length === 1 ? "Change the plan" : "Stop"));
    client.answerForms(() => ({ action: "accept", content: { answer: "why step 2?" } }));
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("/plan add a greeting file") })).stopReason).toBe("end_turn");
    // The answer is words for the person, a message; the plan stays as it was.
    expect(agentText(client.updates, sessionId)).toContain(ANSWER);
    expect(client.permissions).toHaveLength(2);
    expect(client.permissions[1]!.toolCall.content).toEqual(client.permissions[0]!.toolCall.content);
  }, childTestLimit(1));

  test("A cancelled answer, an error reply or a closed connection stops without building and keeps the plan", async () => {
    // No answer in time is the same No as these (tests/acp.test.ts); here the app cancels, fails, then goes away.
    const f = await fixture(planner());
    await planProject(f);
    const client = open(f);
    await client.request("initialize", FORMS);
    const answers: Array<"cancelled" | "error" | "never"> = ["cancelled", "error", "never"];
    client.answerPermissions(() => answers[client.permissions.length - 1]!);
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    for (const round of [1, 2]) {
      expect((await client.request("session/prompt", { sessionId, prompt: text("/plan add a greeting file") })).stopReason).toBe("end_turn");
      expect(client.permissions).toHaveLength(round);
      expect(await savedPlans(f)).toHaveLength(round);
    }
    expect(agentText(client.updates, sessionId).split(KEPT)).toHaveLength(3);
    void client.request("session/prompt", { sessionId, prompt: text("/plan add a greeting file") }).catch(() => {});
    await until(() => client.permissions.length === 3, 60_000, "the third box");
    expect(await client.close()).toBe(0);
    expect(await savedPlans(f)).toHaveLength(3);
    expect(existsSync(path.join(f.project, "greeting.txt"))).toBe(false);
  }, childTestLimit(1));

  test("Without form support Change the plan stops", async () => {
    const f = await fixture(planner());
    await planProject(f);
    const client = open(f);
    await client.request("initialize", INIT);
    client.answerPermissions((params) => choose(params, "Change the plan"));
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("/plan add a greeting file") })).stopReason).toBe("end_turn");
    expect(client.forms).toEqual([]);
    expect(client.permissions).toHaveLength(1);
    expect(stoppedThenKept(agentText(client.updates, sessionId))).toBe(true);
    expect(existsSync(path.join(f.project, "greeting.txt"))).toBe(false);
  }, childTestLimit(1));

  test("The question round asks through a form", async () => {
    const f = await fixture(planner(QUESTIONS));
    await planProject(f);
    const client = open(f);
    await client.request("initialize", FORMS);
    client.answerPermissions((params) => choose(params, "Stop"));
    client.answerForms(() => ({ action: "accept", content: { answer: "1" } }));
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("/plan add a greeting file") })).stopReason).toBe("end_turn");
    expect(client.forms.map((form) => form.message)).toEqual(["Which greeting?"]);
    expect(JSON.stringify(f.payloads)).toContain("Which greeting?: Hello there");
    expect(client.permissions.filter(isPlanBox)).toHaveLength(1);
  }, childTestLimit(1));

  test("Bare slash plan offers to reopen a plan with Stop as reject_once", async () => {
    const f = await fixture(planner());
    await planProject(f);
    const client = open(f);
    await client.request("initialize", FORMS);
    client.answerPermissions((params) => params.toolCall.title === "Reopen a plan?" ? { optionId: params.options[1].optionId } : choose(params, "Stop"));
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    await client.request("session/prompt", { sessionId, prompt: text("/plan add a greeting file") });
    expect((await client.request("session/prompt", { sessionId, prompt: text("/plan") })).stopReason).toBe("end_turn");
    expect(client.permissions).toHaveLength(3);
    const reopen = client.permissions[1]!;
    expect(reopen.toolCall.title).toBe("Reopen a plan?");
    expect(reopen.options.map((option: Json) => [option.name, option.kind])).toEqual([["Stop", "reject_once"], ["1. Add a greeting", "allow_once"]]);
    // The plan it reopened is shown in the Build box again, as it was saved.
    expect(isPlanBox(client.permissions[2]!)).toBe(true);
    expect(client.permissions[2]!.toolCall.content).toEqual(client.permissions[0]!.toolCall.content);
    expect(existsSync(path.join(f.project, "greeting.txt"))).toBe(false);
  }, childTestLimit(1));
});

describe("the plan option of an ACP app (decision 84)", () => {
  type Option = { id: string; currentValue: string };
  const planOf = (options: Option[]) => options.find((option) => option.id === "plan")?.currentValue;
  const configUpdates = (client: AcpClient, sessionId: string) => ofSession(client, sessionId).filter((update) => update.sessionUpdate === "config_option_update");

  test("A typed plan on is announced", async () => {
    const f = await fixture(planner());
    await planProject(f);
    const client = open(f);
    await client.request("initialize", FORMS);
    client.answerPermissions((params) => choose(params, "Stop"));
    const created = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    expect(planOf(created.configOptions)).toBe("off");
    const sessionId = created.sessionId as string;
    await client.request("session/prompt", { sessionId, prompt: text("/plan on") });
    expect(configUpdates(client, sessionId).map((update) => planOf(update.configOptions))).toEqual(["on"]);
    // Plan first holds for the next request: it gets the Build box.
    expect((await client.request("session/prompt", { sessionId, prompt: text("add a greeting file") })).stopReason).toBe("end_turn");
    expect(client.permissions.filter(isPlanBox)).toHaveLength(1);
    expect(existsSync(path.join(f.project, "greeting.txt"))).toBe(false);
  }, childTestLimit(1));

  test("Setting plan during a prompt is accepted", async () => {
    const f = await fixture(planner());
    await planProject(f);
    const client = open(f);
    await client.request("initialize", FORMS);
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    client.answerPermissions(async (params) => { await held; return choose(params, "Stop"); });
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    const running = client.request("session/prompt", { sessionId, prompt: text("/plan add a greeting file") });
    await until(() => client.permissions.length > 0, 60_000, "the Build box");
    const set = await client.request("session/set_config_option", { sessionId, configId: "plan", value: "on" });
    expect(planOf(set.configOptions)).toBe("on");
    // An unknown value is refused, and changes nothing.
    const refused = await client.request("session/set_config_option", { sessionId, configId: "plan", value: "always" }).then(() => undefined, (error: { code: number }) => error.code);
    expect(refused).toBe(-32602);
    release();
    expect((await running).stopReason).toBe("end_turn");
    // What the app set is not sent back to it.
    expect(configUpdates(client, sessionId)).toEqual([]);
  }, childTestLimit(1));
});
