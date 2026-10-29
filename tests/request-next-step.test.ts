import { expect, test } from "bun:test";
import { findNextStep, requestStepCount, NEXT_STEP_DONE } from "../src/task/next-step";

/**
 * A real session: the request pasted a five-step Cloudflare guide; the AI did step one and stopped, with no "Still not
 * done" lines and no "next" ending (the model doesn't follow that format). The Next row offered only "Add a test", and the
 * person had to type "what next".
 */

const GUIDE = `Set this up for Home Assistant:
1. Create the tunnel in the Cloudflare dashboard and copy its token
2. Add cloudflared to docker-compose.yml with that token
3. Publish ha.example.org as a public hostname pointing at http://homeassistant:8123
4. Add the tunnel to Home Assistant's trusted_proxies
5. Add a WAF rule that only allows my country`;

test("a request with steps: numbered, bulleted or 'Step N'; a plain request has none", () => {
  expect(requestStepCount(GUIDE)).toBe(5);
  expect(requestStepCount("- add the route\n- restart the service\n- check the page")).toBe(3);
  expect(requestStepCount("Step 1: make the tunnel\nStep 2: publish it")).toBe(2);
  expect(requestStepCount("fix the failing test in sum.js")).toBe(0);
  // Pasted where the line breaks were lost: the numbers in order still count.
  expect(requestStepCount(GUIDE.replaceAll("\n", " "))).toBe(5);
  // One numbered line is not a list of steps.
  expect(requestStepCount("see item 1. in the docs and fix it")).toBe(0);
});

test("the next step comes from one small call with the request and the AI's last words; its usage is kept", async () => {
  const calls: Array<{ systemPrompt: string; user: string; role?: string; maxTokens?: number }> = [];
  const complete = async (input: { systemPrompt: string; user: string; role?: "fast"; maxTokens?: number }) => {
    calls.push(input);
    return { text: "Publish ha.example.org as a public hostname\n", usage: { tokens: 2100, estimatedCost: 0.002 } };
  };
  const found = await findNextStep({ complete, request: GUIDE, answer: "The tunnel is created and its token is in secrets/tunnel_token." });
  expect(found).toEqual({ step: "Publish ha.example.org as a public hostname", usage: { tokens: 2100, estimatedCost: 0.002 } });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.role).toBe("fast");
  expect(calls[0]!.user).toContain(GUIDE);
  expect(calls[0]!.user).toContain("The tunnel is created");
});

test("all done, an empty or odd answer, or a failed call: no step", async () => {
  for (const text of [NEXT_STEP_DONE, "", "1. a\n2. b\n3. c\n4. d", "x".repeat(400)]) {
    const found = await findNextStep({ complete: async () => ({ text, usage: null }), request: GUIDE, answer: "Done." });
    expect([text.slice(0, 20), found.step]).toEqual([text.slice(0, 20), undefined]);
  }
  const failed = await findNextStep({ complete: async () => ({ text: "", error: "rate limited", usage: null }), request: GUIDE, answer: "Done." });
  expect(failed.step).toBeUndefined();
});
