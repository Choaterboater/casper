import { SIDE_NAMES, type Side } from "./config";
import { LABELS, type Label, type RunRecord, type Winner } from "./results";

/** One app as the judge page shows it. `side` and `folder` stay on the server until the pick is saved. */
export interface JudgeApp {
  label: Label;
  side: Side;
  url: string | null;
  error?: string;
  log: string;
  folder: string | null;
}

/** JSON that is safe inside a <script> element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

export function judgePage(run: Pick<RunRecord, "set" | "promptId" | "prompt" | "model">, apps: readonly JudgeApp[], token: string): string {
  const data = {
    token, set: run.set, promptId: run.promptId, prompt: run.prompt, model: run.model,
    apps: apps.map(({ label, url, error, log }) => ({ label, url, error: error ?? null, log })),
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blind Compare</title>
<style>
  :root { --bg: #f6f7f9; --panel: #fff; --text: #1d2330; --muted: #5b6475; --line: #d9dde5; --accent: #2f5bd3; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15181e; --panel: #1e232b; --text: #e6e9ef; --muted: #9aa3b5; --line: #343b47; --accent: #7aa2ff; --bad: #ff8a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  h1 { font-size: 17px; margin: 0 0 4px; }
  .prompt { margin: 0; color: var(--muted); max-width: 1100px; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 16px; }
  button, .link { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; text-decoration: none; }
  button.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .spacer { flex: 1; }
  #frames { display: grid; gap: 12px; padding: 0 16px 16px; }
  #frames.all { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .app { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
  .app-head { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  .app-head strong { font-size: 18px; margin-right: auto; }
  .stage { display: flex; justify-content: center; background: var(--bg); }
  iframe { border: 0; width: 100%; height: calc(100vh - 250px); min-height: 420px; background: #fff; }
  .phone iframe { width: 390px; max-width: 100%; }
  .broken { padding: 16px; color: var(--bad); }
  pre { white-space: pre-wrap; word-break: break-word; max-height: 50vh; overflow: auto; color: var(--muted); font-size: 12px; }
  form { padding: 12px 16px 24px; border-top: 1px solid var(--line); background: var(--panel); }
  .choices { display: flex; flex-wrap: wrap; gap: 16px; margin: 8px 0; }
  textarea { width: 100%; max-width: 640px; min-height: 60px; font: inherit; padding: 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); }
  #reveal li { margin: 4px 0; }
  @media (max-width: 900px) { #frames.all { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Blind compare · <span id="set"></span> · <span id="pid"></span></h1>
  <p class="prompt" id="prompt"></p>
</header>
<div class="bar" id="tabs"></div>
<div id="frames"></div>
<form id="pick">
  <strong>Which one is best?</strong>
  <div class="choices" id="choices"></div>
  <textarea name="note" placeholder="Why? (optional, saved with the pick)"></textarea>
  <p><button type="submit">Save pick</button> <span id="status"></span></p>
  <div id="after" hidden>
    <p>Saved. Here is who was who:</p>
    <ul id="reveal"></ul>
    <button type="button" id="finish">Finish (stop the apps)</button>
  </div>
</form>
<script id="data" type="application/json">${scriptJson(data)}</script>
<script>
  const data = JSON.parse(document.getElementById("data").textContent);
  const el = (tag, props = {}, ...kids) => { const node = Object.assign(document.createElement(tag), props); node.append(...kids); return node; };
  document.getElementById("set").textContent = data.set;
  document.getElementById("pid").textContent = data.promptId;
  document.getElementById("prompt").textContent = data.prompt + "  (model: " + data.model + ")";
  const frames = document.getElementById("frames");
  const panels = data.apps.map((app) => {
    const head = el("div", { className: "app-head" }, el("strong", { textContent: app.label }));
    const panel = el("section", { className: "app" }, head);
    if (app.url) {
      const frame = el("iframe", { src: app.url, title: "App " + app.label });
      head.append(el("button", { type: "button", textContent: "Reload", onclick: () => { frame.src = app.url; } }),
        el("a", { className: "link", href: app.url, target: "_blank", rel: "noopener", textContent: "Open in new tab" }));
      panel.append(el("div", { className: "stage" }, frame));
    } else {
      panel.append(el("div", { className: "broken" }, el("p", { textContent: "Could not show this app: " + app.error }), el("pre", { textContent: app.log })));
    }
    frames.append(panel);
    return panel;
  });
  const tabs = document.getElementById("tabs");
  const views = [...data.apps.map((app, index) => ({ name: app.label, show: (i) => i === index })), { name: "All three", show: () => true }];
  const viewButtons = views.map((view) => el("button", { type: "button", textContent: view.name, onclick: () => showView(view) }));
  const phone = el("button", { type: "button", textContent: "Phone width", onclick: () => { frames.classList.toggle("phone"); phone.classList.toggle("on"); } });
  tabs.append(...viewButtons, el("span", { className: "spacer" }), phone);
  function showView(view) {
    views.forEach((other, i) => viewButtons[i].classList.toggle("on", other === view));
    panels.forEach((panel, i) => { panel.hidden = !view.show(i); });
    frames.classList.toggle("all", view.name === "All three");
  }
  showView(views[0]);
  const choices = document.getElementById("choices");
  for (const value of [...data.apps.map((app) => app.label), "tie"]) {
    choices.append(el("label", {}, el("input", { type: "radio", name: "pick", value, required: true }), " ", value === "tie" ? "Tie (no clear best)" : value + " is best"));
  }
  const form = document.getElementById("pick");
  const status = document.getElementById("status");
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: data.token, ...body }) });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = new FormData(form);
    status.textContent = "Saving ...";
    const response = await post("/pick", { pick: fields.get("pick"), note: fields.get("note") });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) { status.textContent = answer.error || "Could not save."; return; }
    status.textContent = "";
    form.querySelector("button[type=submit]").disabled = true;
    const reveal = document.getElementById("reveal");
    for (const item of answer.reveal) reveal.append(el("li", { textContent: item.label + " = " + item.side + " " + item.name + (item.folder ? "  (" + item.folder + ")" : "") }));
    document.getElementById("after").hidden = false;
  });
  document.getElementById("finish").addEventListener("click", async () => {
    await post("/finish", {}).catch(() => {});
    document.body.replaceChildren(el("p", { style: "padding:16px", textContent: "Done. The apps are stopped; you can close this tab." }));
  });
</script>
</body>
</html>
`;
}

export function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try { Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); } catch { /* the address is printed too */ }
}

/** Serves the judge page until Finish is clicked or `signal` aborts. `save` runs once, for the first valid pick. */
export async function serveJudge(options: {
  run: RunRecord; apps: readonly JudgeApp[]; open: boolean; signal: AbortSignal;
  save(pick: Winner, labels: Record<Label, Side>, note: string): Promise<void>;
  log(line: string): void;
}): Promise<void> {
  const token = crypto.randomUUID();
  const labels = Object.fromEntries(options.apps.map((app) => [app.label, app.side])) as Record<Label, Side>;
  const page = judgePage(options.run, options.apps, token);
  let saved = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (request.method !== "POST" || (pathname !== "/pick" && pathname !== "/finish")) return new Response("Not found", { status: 404 });
      const body = await request.json().catch(() => null) as { token?: unknown; pick?: unknown; note?: unknown } | null;
      if (body?.token !== token) return Response.json({ error: "This page is out of date; reload it." }, { status: 403 });
      // The answer goes out before the server closes.
      if (pathname === "/finish") { setTimeout(finish, 100); return Response.json({ ok: true }); }
      if (saved) return Response.json({ error: "A pick is already saved for this run." }, { status: 409 });
      const label = body.pick;
      if (label !== "tie" && !(LABELS as readonly unknown[]).includes(label)) return Response.json({ error: "Pick X, Y, Z or tie." }, { status: 400 });
      const pick: Winner = label === "tie" ? "tie" : labels[label as Label];
      saved = true;
      try { await options.save(pick, labels, typeof body.note === "string" ? body.note.trim().slice(0, 2000) : ""); }
      catch (error) { saved = false; return Response.json({ error: `Could not save: ${(error as Error).message}` }, { status: 500 }); }
      return Response.json({ reveal: options.apps.map((app) => ({ label: app.label, side: app.side, name: SIDE_NAMES[app.side], folder: app.folder })) });
    },
  });
  const url = `http://localhost:${server.port}/`;
  options.log(`Judge page: ${url}`);
  if (options.open) openInBrowser(url);
  const abort = () => finish();
  options.signal.addEventListener("abort", abort, { once: true });
  try { await finished; } finally {
    options.signal.removeEventListener("abort", abort);
    await server.stop(true);
  }
}
