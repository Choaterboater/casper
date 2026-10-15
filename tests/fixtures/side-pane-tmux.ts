// Real synchronous SidePane code runs outside Bun's parallel test worker; its parent enforces a deadline.
import { existsSync } from "node:fs";
import { SidePane } from "../../src/tui/side-pane";
import { run } from "../support/run";

const mode = process.argv[2], server = process.argv[3]!;
const userPane = process.env.TMUX_PANE!;
const tmux = async (...args: string[]) => {
  const result = await run(["tmux", "-L", server, ...args], { timeoutMs: 3_000 });
  if (result.status !== 0 || result.timedOut) throw new Error(`fixture tmux: ${result.stderr}`);
  return result.stdout;
};
const panes = async () => (await tmux("list-panes", "-s", "-t", "user", "-F", "#{pane_id} #{pane_active} #{pane_input_off}")).trim().split("\n");
const capture = (id: string) => tmux("capture-pane", "-p", "-t", id);
async function until(check: () => Promise<boolean>) {
  const limit = Date.now() + 8_000;
  while (Date.now() < limit) { if (await check()) return; await Bun.sleep(25); }
  throw new Error("Side pane condition was not reached before its deadline");
}
// The parent owns/reaps this process even if this fixture times out or cannot open a pane.
const watched = mode === "watch" ? Number(process.argv[4]) : undefined;
const pane = SidePane.open({ host: { tmux: true, tmuxPane: userPane, iterm: false }, ...(watched ? { pid: watched } : {}) });
if (!pane) process.exit(3);
if (mode === "crash") { console.log(pane.file); throw new Error("crash"); }
try {
  const opened = await panes();
  if (watched) {
    process.kill(watched, "SIGKILL");
    await until(async () => (await panes()).length === 1);
    console.log(JSON.stringify({ opened, remaining: await panes() }));
  } else {
    const id = opened.find(line => !line.startsWith(`${userPane} `))!.split(" ")[0]!;
    pane.show(["• bash · npm test", "Waiting for model · 3s"]);
    pane.show(["• bash · npm test", "Waiting for model · 4s"]);
    pane.log("helper explorer · ✓ read · src/app.ts");
    await until(async () => (await capture(id)).includes("helper explorer"));
    const screen = await capture(id);
    await tmux("send-keys", "-t", id, "rm -rf /tmp/x", "Enter");
    const afterKeys = await capture(id);
    pane.close();
    await until(async () => (await panes()).length === 1);
    console.log(JSON.stringify({ opened, screen, afterKeys, remaining: await panes(), fileExists: existsSync(pane.file) }));
  }
} finally {
  pane.close();
}
