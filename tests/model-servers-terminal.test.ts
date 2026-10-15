import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"]).status === 0;

for (const entry of ["/model", "/login"] as const) for (const kind of ["sglang", "mlx"] as const) test.skipIf(!hasTmux)(`real tmux ${entry} adds ${kind} and shows its selectable models without a login`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-server-terminal-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project);
  await writeFile(path.join(home, ".casper/config.yaml"), "localModels: false\n");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const route = new URL(request.url).pathname;
    if (kind === "sglang" && route === "/get_model_info") return Response.json({ model_path: "fixture-chat" });
    if (route === "/v1/models") return Response.json({ data: [{ id: "fixture-chat" }] });
    return new Response("not here", { status: 404 });
  } });
  const socket = path.join(root, "sock");
  const env = cleanEnv({ HOME: home, CASPER_LOCAL_MODELS: undefined, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color", NO_COLOR: "1" });
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, encoding: "utf8", timeout: 5000 });
  const screen = () => tmux("capture-pane", "-p", "-t", "fixture").stdout;
  const until = async (words: string) => {
    const deadline = Date.now() + 20_000;
    let shown = "";
    while (Date.now() < deadline) {
      shown = screen();
      if (shown.includes(words)) return shown;
      await Bun.sleep(50);
    }
    throw new Error(`Never saw ${words}:\n${shown}`);
  };
  const keys = (...values: string[]) => expect(tmux("send-keys", "-t", "fixture", ...values).status).toBe(0);
  const text = (value: string) => expect(tmux("send-keys", "-t", "fixture", "-l", value).status).toBe(0);
  try {
    const cli = path.resolve(import.meta.dir, "../src/cli.ts");
    expect(tmux("new-session", "-d", "-s", "fixture", "-x", "180", "-y", "50", "-c", project,
      `${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(cli)}`).status).toBe(0);
    await until("/model");
    text(entry); keys("Enter");
    if (entry === "/model") {
      await until("+ Add server");
      keys("Down", "Enter");
    } else {
      const login = await until("Model server on another computer");
      expect(login).not.toContain("SGLang");
      expect(login).not.toContain("MLX");
      keys("8");
    }
    const choices = await until("Model server type");
    expect(choices).toContain("SGLang · port 30000");
    expect(choices).toContain("MLX (MLX LM / vllm-mlx) · port 8080");
    keys(kind === "sglang" ? "1" : "7");
    await until("Where is the server?");
    text(`127.0.0.1:${server.port}`); keys("Enter");
    const naming = await until("Name it.");
    expect(naming).toContain(`Found ${kind === "sglang" ? "SGLang" : "MLX"}`);
    keys("Enter");
    const listed = await until(`${kind}-127-0-0-1-${server.port}/fixture-chat`);
    expect(listed).toContain("fixture-chat");
    expect(listed).toContain(`${kind}-127-0-0-1-${server.port}`);
    // The screen can show the new server a moment before its config file is written.
    let config = "";
    for (let i = 0; i < 200 && !config.includes(`kind: ${kind}`); i++) {
      config = await readFile(path.join(home, ".casper/config.yaml"), "utf8").catch(() => "");
      await Bun.sleep(25);
    }
    expect(config).toContain(`kind: ${kind}`);
    expect(config).not.toMatch(/apiKey|token|password/);
    // The add flow opens on the new server's models. Save one, not merely its added-server notice.
    keys("Enter");
    const settingsFile = path.join(home, ".casper/settings.json");
    let settings: { defaultProvider?: string; defaultModel?: string } = {};
    // A slow runner can drop the first Enter while the list is still drawing: press it again if the list stays open.
    for (let i = 0; i < 600; i++) {
      settings = JSON.parse(await readFile(settingsFile, "utf8").catch(() => "{}"));
      if (settings.defaultModel === "fixture-chat") break;
      if (i === 80 && screen().includes("+ Add server")) keys("Enter");
      await Bun.sleep(25);
    }
    expect(settings, screen()).toMatchObject({ defaultProvider: `${kind}-127-0-0-1-${server.port}`, defaultModel: "fixture-chat" });
    expect((await readFile(path.join(home, ".casper/agent/auth.json"), "utf8").catch(() => ""))).not.toContain(`${kind}-127-0-0-1-${server.port}`);
  } finally {
    tmux("kill-server");
    server.stop(true);
    await removeTempDir(root);
  }
}, 90_000);
