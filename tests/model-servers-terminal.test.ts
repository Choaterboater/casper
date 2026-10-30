import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateTmux } from "./support/private-tmux";
import { removeTempDir } from "./support/temp-dir";
import { trustFolder } from "./support/trust";

const mux = await privateTmux({ env: {
  CASPER_LOCAL_MODELS: undefined, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", NO_COLOR: "1",
} });
afterAll(async () => { await mux?.close(); });

for (const entry of ["/model", "/login"] as const) for (const kind of ["sglang", "mlx"] as const) test.skipIf(!mux)(`real tmux ${entry} adds ${kind} and shows its selectable models without a login`, async () => {
  const root = await mkdtemp(path.join(mux!.home, "casper-server-terminal-"));
  const home = mux!.home;
  const project = path.join(root, "project");
  // Each case starts without the previous server config, model selection or auth state.
  await removeTempDir(path.join(home, ".casper"));
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project);
  await trustFolder(project, home);
  await writeFile(path.join(home, ".casper/config.yaml"), "localModels: false\n");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const route = new URL(request.url).pathname;
    if (kind === "sglang" && route === "/get_model_info") return Response.json({ model_path: "fixture-chat" });
    if (route === "/v1/models") return Response.json({ data: [{ id: "fixture-chat" }] });
    return new Response("not here", { status: 404 });
  } });
  const screen = () => mux!.run("capture-pane", "-p", "-t", "fixture");
  const until = async (words: string) => {
    const deadline = Date.now() + 20_000;
    let shown = "";
    while (Date.now() < deadline) {
      shown = await screen();
      if (shown.includes(words)) return shown;
      await Bun.sleep(50);
    }
    throw new Error(`Never saw ${words}:\n${shown}`);
  };
  const keys = (...values: string[]) => mux!.run("send-keys", "-t", "fixture", ...values);
  const text = (value: string) => mux!.run("send-keys", "-t", "fixture", "-l", value);
  try {
    const cli = path.resolve(import.meta.dir, "../src/cli.ts");
    await mux!.run("new-session", "-d", "-s", "fixture", "-x", "180", "-y", "50", "-c", project,
      `${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(cli)}`);
    await until("/model");
    await text(entry); await keys("Enter");
    if (entry === "/model") {
      await until("+ Add server");
      await keys("Down", "Enter");
    } else {
      const login = await until("Model server on another computer");
      expect(login).not.toContain("SGLang");
      expect(login).not.toContain("MLX");
      await keys("8");
    }
    // Wait for the server kinds themselves: the /login box before them has the same "Model server type" title, so
    // waiting for the title alone could read that box before 8 had taken effect.
    const choices = await until("SGLang · port 30000");
    expect(choices).toContain("MLX (MLX LM / vllm-mlx) · port 8080");
    await keys(kind === "sglang" ? "1" : "7");
    await until("Where is the server?");
    await text(`127.0.0.1:${server.port}`); await keys("Enter");
    const naming = await until("Name it.");
    expect(naming).toContain(`Found ${kind === "sglang" ? "SGLang" : "MLX"}`);
    await keys("Enter");
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
    await keys("Enter");
    const settingsFile = path.join(home, ".casper/settings.json");
    let settings: { defaultProvider?: string; defaultModel?: string } = {};
    // A slow runner can drop the first Enter while the list is still drawing: press it again if the list stays open.
    for (let i = 0; i < 600; i++) {
      settings = JSON.parse(await readFile(settingsFile, "utf8").catch(() => "{}"));
      if (settings.defaultModel === "fixture-chat") break;
      if (i === 80 && (await screen()).includes("+ Add server")) await keys("Enter");
      await Bun.sleep(25);
    }
    expect(settings, await screen()).toMatchObject({ defaultProvider: `${kind}-127-0-0-1-${server.port}`, defaultModel: "fixture-chat" });
    expect((await readFile(path.join(home, ".casper/agent/auth.json"), "utf8").catch(() => ""))).not.toContain(`${kind}-127-0-0-1-${server.port}`);
  } finally {
    try { await mux!.run("kill-session", "-t", "fixture"); }
    finally {
      server.stop(true);
      await removeTempDir(root);
    }
  }
}, 90_000);
