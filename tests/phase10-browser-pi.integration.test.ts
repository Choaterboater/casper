import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const executable = process.env.CASPER_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserTest = existsSync(executable) ? test : test.skip;

for (const termination of ["normal", "SIGTERM"] as const) browserTest(`native screenshot image delivery and owned browser cleanup (${termination})`, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-pi-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), project = path.join(root, "project"), agent = path.join(home, ".casper", "agent"), tmp = path.join(root, "tmp");
  await Promise.all([mkdir(agent, { recursive: true }), mkdir(project), mkdir(tmp)]);
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><h1>Screenshot fixture</h1>", { headers: { "content-type": "text/html" } }) });
  cleanup.push(async () => { site.stop(true); });
  let calls = 0, imageSeen = false, screenshotPath = "";
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const payload = await request.json() as { messages: Array<{ role: string; content: unknown }> };
    imageSeen ||= JSON.stringify(payload.messages).includes("data:image/png;base64,");
    for (const message of payload.messages) {
      if (message.role !== "tool") continue;
      const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map(part => part.text ?? "").join("\n") : "";
      try { const result = JSON.parse(content); if (typeof result.data?.path === "string" && result.data.path.endsWith(".png")) screenshotPath = result.data.path; } catch {}
    }
    const call = calls++;
    if (termination === "SIGTERM" && call === 3) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": waiting for cancellation\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    const tool = call === 0 ? { name: "browser", arguments: { action: "open", url: `http://127.0.0.1:${site.port}` } }
      : call === 1 ? { name: "browser", arguments: { action: "screenshot" } }
      : call === 2 ? { name: "read", arguments: { path: screenshotPath || "/missing-fixture-screenshot" } } : undefined;
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${call}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: "assistant", content: "Image fixture complete. Inspection is not verification." };
    const chunks = [{ id: `fixture_${call}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: `fixture_${call}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(async () => { provider.stop(true); });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "synthetic-only", models: [{ id: "fixture", name: "Fixture", input: ["text", "image"], contextWindow: 32768, maxTokens: 1024 }] } } }));
  await writeFile(path.join(home, ".casper", "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), "inspect this website and read its screenshot"], {
    cwd: project, env: { HOME: home, CASPER_HOME: path.join(home, ".casper"), PATH: process.env.PATH ?? "", TMPDIR: tmp,
      CASPER_BROWSER_EXECUTABLE: executable, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  cleanup.push(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; });
  const ownedProcesses = async () => {
    const ps = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(ps.stdout).text(); await ps.exited;
    return output.split("\n").filter(line => line.includes(`--user-data-dir=${tmp}/casper-browser-`)).map(line => Number(line.trim().split(/\s+/)[0]));
  };
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  if (termination === "SIGTERM") {
    for (let i = 0; i < 600 && !imageSeen && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 25));
    const owned = await ownedProcesses();
    cleanup.push(async () => { for (const pid of owned) { try { process.kill(-pid, "SIGKILL"); } catch {} } });
    expect(owned.length).toBeGreaterThan(0);
    child.kill("SIGTERM");
  }
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  expect({ code, stderr }).toEqual({ code: termination === "normal" ? 0 : 143, stderr: "" });
  expect(await ownedProcesses()).toEqual([]);
  expect(calls).toBe(4);
  expect({ screenshotPath, stdout }).toMatchObject({ screenshotPath: expect.stringContaining(path.join(home, ".casper")) });
  expect(imageSeen).toBe(true);
  if (termination === "normal") expect(stdout).toContain("Image fixture complete");
}, 25_000);
