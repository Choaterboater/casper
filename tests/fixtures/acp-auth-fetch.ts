// Preloaded into a `casper acp` child by tests/acp-auth.integration.test.ts (BUN_OPTIONS): the provider's key check
// answers from here, and nothing else leaves the machine. A key that starts with "sk-or-good" is accepted, one that
// starts with "sk-or-down" finds no network, any other is refused (401). Each call is one line in ACP_AUTH_FETCH_LOG: the address only, never a header. The file is made
// as this loads.
import { appendFileSync, existsSync } from "node:fs";

const log = process.env.ACP_AUTH_FETCH_LOG;
// The test reads this line before it sends a key: no line, no fake, and it stops there.
if (log) appendFileSync(log, "");
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (log) appendFileSync(log, `${url}\n`);
  if (url === "https://openrouter.ai/api/v1/auth/key") {
    const sent = new Headers(init?.headers).get("authorization") ?? "";
    if (sent.startsWith("Bearer sk-or-down")) throw new TypeError("fetch failed");
    return sent.startsWith("Bearer sk-or-good") ? Response.json({ data: {} }) : Response.json({ error: "no" }, { status: 401 });
  }
  // GitHub's code sign-in: the code is shown, and the wait ends once the test makes the `.approved` file.
  if (url === "https://github.com/login/device/code") return Response.json({ device_code: "synthetic-device", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 600 });
  if (url === "https://github.com/login/oauth/access_token") return Response.json(log && existsSync(`${log}.approved`) ? { access_token: "synthetic-github-secret" } : { error: "authorization_pending" });
  if (url === "https://api.github.com/copilot_internal/v2/token") return Response.json({ token: "synthetic-copilot-secret", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  if (url === "https://api.individual.githubcopilot.com/models") return Response.json({ data: [] });
  throw new TypeError(`fetch failed: ${url} is not faked`);
}, { preconnect: () => {} }) as typeof fetch;
