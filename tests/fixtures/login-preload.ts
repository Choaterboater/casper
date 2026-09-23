#!/usr/bin/env bun
import { appendFile, access } from "node:fs/promises";
import path from "node:path";

const control = process.env.CASPER_TTY_CONTROL;
if (!control) throw new Error("Missing CASPER_TTY_CONTROL");
const payload = Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
})).toString("base64url");
const accessToken = `x.${payload}.x`;
const record = async (url: string) => appendFile(path.join(control, "login-fetches.txt"), `${url}\n`);

Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input); await record(url);
  if (url === "https://platform.claude.com/v1/oauth/token") return Response.json({ access_token: "synthetic-anthropic-private-access", refresh_token: "synthetic-anthropic-private-refresh", expires_in: 3600 });
  if (url === "https://github.com/login/device/code") return Response.json({ device_code: "synthetic-device", user_code: "GHUB-CODE", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 60 });
  if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "synthetic-github-private-access" });
  if (url === "https://api.github.com/copilot_internal/v2/token") return Response.json({ token: "synthetic-copilot-private-access", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  if (url === "https://api.individual.githubcopilot.com/models") return Response.json({ data: [] });
  if (url.endsWith("/api/accounts/deviceauth/usercode")) {
    return Response.json({ device_auth_id: "synthetic-device", user_code: "ABCD-EFGH", interval: 0 });
  }
  if (url.endsWith("/api/accounts/deviceauth/token")) {
    while (true) {
      init?.signal?.throwIfAborted();
      try { await access(path.join(control, "authorize")); break; } catch {}
      await Bun.sleep(10);
    }
    return Response.json({ authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" });
  }
  if (url.endsWith("/oauth/token")) {
    return Response.json({ access_token: accessToken, refresh_token: "synthetic-refresh", expires_in: 3600 });
  }
  throw new Error("Unexpected network destination");
} });
