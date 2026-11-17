import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AccountInfo, Options, SDKMessage, SDKRateLimitInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_SUBSCRIPTION, streamClaudeSubscription } from "../src/runtime/claude-subscription";
import { ClaudeSessions } from "../src/runtime/claude-session";
import { Failover, failoverCause } from "../src/runtime/failover";
import { explainModelError, modelErrorNext, retryUpstreamErrors } from "../src/runtime/model-errors";
import { clockTime, planLimitError, planLimitInError, PlanLimits, planLimitText, planWindowName } from "../src/runtime/plan-limits";
import { formatReceipt } from "../src/task/result";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const seconds = (ms: number) => Math.floor(ms / 1000);
const info = (extra: Partial<SDKRateLimitInfo>): SDKRateLimitInfo => ({ status: "allowed", ...extra });

test("Claude Code's rate-limit events keep the latest share and reset per window, the one that matters most first", () => {
  const limits = new PlanLimits();
  expect(limits.current(NOW)).toEqual([]);
  limits.record(info({ rateLimitType: "seven_day", utilization: 0.31, resetsAt: seconds(NOW + 72 * HOUR) }));
  limits.record(info({ rateLimitType: "five_hour", utilization: 0.4, resetsAt: seconds(NOW + 2 * HOUR) }));
  limits.record(info({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.824, resetsAt: seconds(NOW + 2 * HOUR) }));
  expect(limits.current(NOW).map((limit) => [limit.window, limit.status, limit.used])).toEqual([
    ["five_hour", "allowed_warning", 0.824], ["seven_day", "allowed", 0.31],
  ]);
  expect(limits.blocked(NOW)).toBeUndefined();
  // A window whose reset is past says nothing about now.
  expect(limits.current(NOW + 3 * HOUR).map((limit) => limit.window)).toEqual(["seven_day"]);
  // Shapes this version can't read are left out.
  limits.record({ status: "unknown" } as never);
  limits.record(undefined as never);
  expect(limits.current(NOW)).toHaveLength(2);
});

test("a used-up window refuses requests until its reset; extra usage in use never reads as refused", () => {
  const limits = new PlanLimits();
  limits.record(info({ status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: seconds(NOW + HOUR) }));
  expect(limits.blocked(NOW)).toMatchObject({ window: "five_hour", status: "rejected", blocked: true, overage: false, resetsAt: NOW + HOUR });
  expect(limits.blocked(NOW + HOUR)).toBeUndefined();
  // A request that goes through again means nothing refuses requests now.
  limits.record(info({ rateLimitType: "seven_day", utilization: 0.5, resetsAt: seconds(NOW + 72 * HOUR) }));
  expect(limits.blocked(NOW)).toBeUndefined();
  for (const overage of [{ isUsingOverage: true }, { overageInUse: true }, { overageStatus: "allowed" as const }]) {
    const using = new PlanLimits();
    using.record(info({ status: "rejected", rateLimitType: "five_hour", resetsAt: seconds(NOW + HOUR), ...overage }));
    expect(using.blocked(NOW)).toBeUndefined();
    expect(using.current(NOW)[0]).toMatchObject({ overage: true, blocked: false });
  }
  // No known reset: nothing to wait for, so the ordinary rate-limit advice stands.
  const unknown = new PlanLimits();
  unknown.record(info({ status: "rejected", rateLimitType: "five_hour" }));
  expect(unknown.blocked(NOW)).toBeUndefined();
});

test("a warning or a switch to extra usage is said once per window and reset", () => {
  const limits = new PlanLimits();
  limits.record(info({ rateLimitType: "five_hour", utilization: 0.5, resetsAt: seconds(NOW + 2 * HOUR) }));
  expect(limits.takeNotice(NOW)).toBeUndefined();
  const warning = info({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.8, resetsAt: seconds(NOW + 2 * HOUR) });
  limits.record(warning);
  expect(limits.takeNotice(NOW)).toMatchObject({ window: "five_hour", status: "allowed_warning", used: 0.8 });
  limits.record({ ...warning, utilization: 0.85 });
  expect(limits.takeNotice(NOW)).toBeUndefined();
  // The next window, after the reset, warns again; so does a switch to extra usage.
  limits.record({ ...warning, resetsAt: seconds(NOW + 7 * HOUR) });
  expect(limits.takeNotice(NOW)).toMatchObject({ resetsAt: NOW + 7 * HOUR });
  limits.record(info({ status: "rejected", rateLimitType: "five_hour", isUsingOverage: true, resetsAt: seconds(NOW + 7 * HOUR) }));
  expect(limits.takeNotice(NOW)).toMatchObject({ overage: true });
  expect(limits.takeNotice(NOW)).toBeUndefined();
});

test("one window in plain words: its share, its name and its reset time", () => {
  const at = (hours: number) => NOW + hours * HOUR;
  expect(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage", "new_window"].map(planWindowName))
    .toEqual(["5-hour", "weekly", "weekly Opus", "weekly Sonnet", "extra usage", "new window"]);
  const text = (limit: Parameters<typeof planLimitText>[0]) => planLimitText(limit, NOW, "UTC");
  expect(text({ window: "five_hour", status: "allowed", used: 0.824, resetsAt: at(3.67), overage: false, blocked: false }))
    .toBe("82% of 5-hour limit, resets 3:40 PM");
  expect(text({ window: "seven_day", status: "allowed_warning", used: 0.9, resetsAt: at(24), overage: false, blocked: false }))
    .toBe("90% of weekly limit, resets Tue 12:00 PM");
  expect(text({ window: "seven_day_opus", status: "rejected", resetsAt: at(24 * 9), overage: false, blocked: true }))
    .toBe("weekly Opus limit reached, resets Nov 25, 12:00 PM");
  expect(text({ window: "five_hour", status: "rejected", resetsAt: at(1), overage: true, blocked: false }))
    .toBe("5-hour limit reached, using extra usage, resets 1:00 PM");
  expect(text({ window: "five_hour", status: "allowed_warning", overage: false, blocked: false })).toBe("near 5-hour limit");
  expect(clockTime(at(-30), NOW, "UTC")).toBe("Nov 15, 6:00 AM");
});

test("a used-up window's error names it and its reset; one past its reset or from another provider keeps the usual advice", () => {
  const resetsAt = NOW + 2 * HOUR;
  const message = `Claude subscription request failed: You've hit your limit ${planLimitError({ window: "five_hour", resetsAt })}`;
  expect(planLimitInError(message)).toEqual({ window: "five_hour", resetsAt });
  expect(explainModelError(message)).toEqual({ cause: "rate",
    line: `Your Claude plan's 5-hour limit is used up; it resets at ${clockTime(resetsAt)}. Next: wait until then, or /model to pick another model.` });
  // Switch at once while the window is used up; afterwards it's an ordinary rate limit again.
  expect(failoverCause(message, NOW)).toBe("quota");
  expect(failoverCause(message, resetsAt + 1)).toBe("rate");
  expect(failoverCause("429 Rate limit exceeded: too many requests", NOW)).toBe("rate");
  // A key problem stays a key problem.
  expect(explainModelError(`401 Unauthorized ${planLimitError({ window: "five_hour", resetsAt })}`)?.cause).toBe("key");
  // The general advice stays for every other rate limit.
  expect(modelErrorNext("rate", false)).toBe("wait a minute, then ask again");
  const plan = { window: "five_hour", resetsAt };
  expect(modelErrorNext("rate", false, plan, NOW)).toBe(`wait until the 5-hour limit resets at ${clockTime(resetsAt, NOW)}, or /model to pick another model`);
  expect(formatReceipt({ execution: "failed", changedPaths: [], modelError: "rate", planLimit: plan }, { surface: "one-shot" }).split("\n").at(-1))
    .toBe(`– Next: wait until the 5-hour limit resets at ${clockTime(resetsAt)}, then run it again, or casper --model <provider/id> "…" to use another model`);
});

test("Pi doesn't try a used-up Claude plan window again before its reset", () => {
  const session: { _isRetryableError: (message: unknown) => boolean; model: undefined } = { _isRetryableError: () => true, model: undefined };
  retryUpstreamErrors(session);
  const retry = (errorMessage: string) => session._isRetryableError({ stopReason: "error", errorMessage });
  expect(retry(`Claude subscription request failed: rate_limit ${planLimitError({ window: "five_hour", resetsAt: Date.now() + HOUR })}`)).toBe(false);
  expect(retry(`Claude subscription request failed: rate_limit ${planLimitError({ window: "five_hour", resetsAt: Date.now() - HOUR })}`)).toBe(true);
  expect(retry("429 Too Many Requests")).toBe(true);
});

// The subscription runtime with Claude Code's messages faked: no process, no network.
const account: AccountInfo = { apiProvider: "firstParty", subscriptionType: "max", apiKeySource: "none" };
const model = { id: "claude-opus-4-8", name: "Claude Opus", api: "anthropic-messages", provider: CLAUDE_SUBSCRIPTION, baseUrl: "claude-code://local",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_000 } as unknown as Model<Api>;
const context = normalizeContext({ systemPrompt: "Fixture.", messages: [{ role: "user", content: "Say hello.", timestamp: 1 }], tools: [] });
const event = (rate_limit_info: SDKRateLimitInfo) => ({ type: "rate_limit_event", rate_limit_info, uuid: "00000000-0000-4000-8000-000000000001", session_id: "fixture" }) as SDKMessage;
const raw = (value: unknown) => ({ type: "stream_event", event: value, parent_tool_use_id: null, uuid: "00000000-0000-4000-8000-000000000000", session_id: "fixture" }) as SDKMessage;
const answer: SDKMessage[] = [
  raw({ type: "message_start", message: { id: "msg_fixture", model: model.id, usage: { input_tokens: 5, output_tokens: 0 } } }),
  raw({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  raw({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
  raw({ type: "content_block_stop", index: 0 }),
  raw({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
  raw({ type: "message_stop" }),
  { type: "result", subtype: "success", is_error: false } as SDKMessage,
];
const refused = { type: "assistant", error: "rate_limit", parent_tool_use_id: null, uuid: "00000000-0000-4000-8000-000000000002", session_id: "fixture",
  message: { content: [{ type: "text", text: "You've hit your limit" }] } } as unknown as SDKMessage;
const fake = (messages: SDKMessage[]) => (input: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => ({
  accountInfo: async () => account, close: () => {},
  async *[Symbol.asyncIterator]() { for await (const _ of input.prompt) break; yield* messages; },
});

test("the subscription runtime keeps the plan's limits from Claude Code's events, with no extra call", async () => {
  const limits = new PlanLimits();
  const resetsAt = seconds(Date.now() + 2 * HOUR);
  const response = await streamClaudeSubscription(model, context, undefined, { query: fake([
    event({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.82, resetsAt }), ...answer]), executable: "fixture", sessions: new ClaudeSessions(0), limits }).result();
  expect(response.stopReason).toBe("stop");
  expect(limits.current()).toEqual([{ window: "five_hour", status: "allowed_warning", used: 0.82, resetsAt: resetsAt * 1000, overage: false, blocked: false }]);
  expect(limits.takeNotice()).toMatchObject({ window: "five_hour" });
});

test("a refusal while Claude Code says a window is used up names that window and its reset in the error", async () => {
  const limits = new PlanLimits();
  const resetsAt = seconds(Date.now() + 2 * HOUR);
  const response = await streamClaudeSubscription(model, context, undefined, { query: fake([
    event({ status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt }), refused]), executable: "fixture", sessions: new ClaudeSessions(0), limits }).result();
  expect(response.stopReason).toBe("error");
  expect(response.errorMessage).toBe(`Claude subscription request failed: You've hit your limit ${planLimitError({ window: "five_hour", resetsAt: resetsAt * 1000 })}`);
  expect(failoverCause(response.errorMessage!)).toBe("quota");
  // With extra usage in use, nothing is used up: the error is Claude Code's own.
  const overage = new PlanLimits();
  const other = await streamClaudeSubscription(model, context, undefined, { query: fake([
    event({ status: "rejected", rateLimitType: "five_hour", isUsingOverage: true, resetsAt }), refused]), executable: "fixture", sessions: new ClaudeSessions(0), limits: overage }).result();
  expect(other.errorMessage).toBe("Claude subscription request failed: You've hit your limit");
});

test("a used-up Claude plan window switches at once to your listed model, and tasks stay there until it resets", async () => {
  const fixture = (provider: string, id: string) => ({ provider, id, contextWindow: 128_000, maxTokens: 16_384 }) as unknown as Model<Api>;
  const notices: string[] = [];
  let passingRetries = 0;
  const engine = {
    model: fixture(CLAUDE_SUBSCRIPTION, "claude-opus-4-8"), _retryAttempt: 0,
    sessionManager: { buildSessionProjection: () => ({ messages: [] }), getBranch: () => [] },
    settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }) },
    _isRetryableError: () => true, _willRetryAfterAgentEnd: (_: unknown) => false, _prepareRetry: async (_: unknown) => { passingRetries++; return true; },
    _omitRecoveryAttempt: () => {}, _exceedsCompactionThreshold: () => false, _runAutoCompaction: async () => false,
  };
  const listed = ["claude-subscription/claude-opus-4-8", "fixture/second"];
  const failover = new Failover(engine as unknown as AgentSession, {
    listed: () => listed, usable: (provider, id) => fixture(provider, id),
    switchTo: async (target) => { engine.model = target; },
    notice: (message) => notices.push(message), failed: () => {}, aborted: () => false,
  });
  expect(failover.install()).toBe(true);
  const resetsAt = Date.now() + 2 * HOUR;
  const limit = { role: "assistant", stopReason: "error", errorMessage: `Claude subscription request failed: You've hit your limit ${planLimitError({ window: "five_hour", resetsAt })}` };
  expect(failover.startTask()).toBe(false);
  expect(await engine._prepareRetry(limit)).toBe(true);
  // No passing-limit tries on the used-up plan first.
  expect(passingRetries).toBe(0);
  expect(engine.model).toMatchObject({ provider: "fixture", id: "second" });
  expect(notices).toEqual([`Switched to fixture/second because claude-subscription/claude-opus-4-8 hit its usage limit. Your requests stay on fixture/second until the Claude plan's 5-hour limit resets at ${clockTime(resetsAt)}, then go back to claude-subscription/claude-opus-4-8.`]);
  // The task ends and the next one starts while the window is still used up: no going back yet.
  expect(failover.endTask()).toBe(false);
  expect(failover.startTask(resetsAt - 1)).toBe(false);
  expect(failover.endTask(resetsAt - 1)).toBe(false);
  // Once it has reset, the next task starts on your model again, and the hold is gone.
  expect(failover.startTask(resetsAt + 1)).toBe(true);
  expect(failover.endTask(resetsAt + 1)).toBe(false);
  expect(failover.startTask(resetsAt + 2)).toBe(false);
});

test("/usage shows the Claude plan in one line, and only once Claude Code has reported it", async () => {
  const { runSlashCommand } = await import("../src/app/commands");
  const usage = async (planLimits?: () => unknown[]) => {
    let written = "";
    const host = { output: { write: (text: string) => { written += text; } }, sideQuestions: undefined,
      ensureRuntime: async () => ({ getUsage: () => undefined, ...(planLimits ? { planLimits } : {}) }) } as unknown as Parameters<typeof runSlashCommand>[0];
    await runSlashCommand(host, "/usage");
    return written;
  };
  expect(await usage()).not.toContain("Claude plan");
  expect(await usage(() => [])).not.toContain("Claude plan");
  const resetsAt = Date.now() + HOUR;
  const shown = await usage(() => [{ window: "five_hour", status: "allowed", used: 0.82, resetsAt, overage: false, blocked: false },
    { window: "seven_day", status: "allowed", used: 0.3, resetsAt, overage: false, blocked: false }]);
  expect(shown.split("\n").filter((line) => line.startsWith("Claude plan"))).toEqual([`Claude plan: 82% of 5-hour limit, resets ${clockTime(resetsAt)}`]);
});
