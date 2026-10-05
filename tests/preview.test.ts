import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServiceManager } from "../src/services/manager";
import { SmokeChecks } from "../src/services/smoke";
import { serviceTool } from "../src/services/tool";
import { findTunnel, lanAddress, previewSpec, PUBLIC_SLOT, runPreview, tunnelSpec, tunnelUrl, type PreviewHost, type Tunnel } from "../src/services/preview";

/** /preview: on your network by default; a public link only after a numbered yes, through a tunnel tool you have. */

const posixOnly = process.platform === "win32" ? test.skip : test;
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const iface = (address: string, internal = false) => ({ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null }) as os.NetworkInterfaceInfo;

test("the network address is a private IPv4 address on a real interface: not loopback, containers, VPNs or link-local", () => {
  expect(lanAddress({ lo0: [iface("127.0.0.1", true)], docker0: [iface("172.17.0.1")], utun3: [iface("10.8.0.2")],
    en0: [iface("192.168.1.20")] })).toBe("192.168.1.20");
  expect(lanAddress({ eth0: [iface("169.254.3.4")], bridge0: [iface("172.17.0.1")], wlan0: [iface("10.0.0.7")] })).toBe("10.0.0.7");
  expect(lanAddress({ en0: [iface("203.0.113.9")] })).toBeUndefined();
  expect(lanAddress({})).toBeUndefined();
});

test("the preview listens on every interface: loopback host flags become 0.0.0.0, $HOST stays, Vite accepts tunnel hosts", () => {
  const spec = { command: "vite --port $PORT --strictPort --host 127.0.0.1", port: "auto" as const, ready: { http: "/" }, timeoutMs: 30_000 };
  expect(previewSpec(spec).command).toBe("vite --port $PORT --strictPort --host 0.0.0.0");
  expect(previewSpec({ ...spec, command: "python -m streamlit run app.py --server.port $PORT --server.address 127.0.0.1" }).command)
    .toBe("python -m streamlit run app.py --server.port $PORT --server.address 0.0.0.0");
  expect(previewSpec({ ...spec, command: "vite --host $HOST --port $PORT" }).command).toBe("vite --host $HOST --port $PORT");
  expect(previewSpec(spec).env).toEqual({ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".trycloudflare.com,.ts.net" });
});

test("tunnel commands and the link in their output", () => {
  expect(tunnelSpec({ tool: "cloudflared", path: "/usr/local/bin/cloudflared" }, 4173).command).toBe('"/usr/local/bin/cloudflared" tunnel --no-autoupdate --url http://127.0.0.1:4173');
  expect(tunnelSpec({ tool: "tailscale", path: "/usr/bin/tailscale" }, 4173).command).toBe('"/usr/bin/tailscale" funnel 4173');
  expect(tunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com...\nINF |  https://quiet-river-maple.trycloudflare.com  |")).toBe("https://quiet-river-maple.trycloudflare.com");
  expect(tunnelUrl("Available on the internet:\n\nhttps://laptop.tail1234.ts.net/\n|-- proxy http://127.0.0.1:4173")).toBe("https://laptop.tail1234.ts.net");
  expect(tunnelUrl("nothing yet")).toBeUndefined();
});

posixOnly("a tunnel tool is found on PATH, cloudflared first; none is none", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-preview-path-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  expect(await findTunnel(dir)).toBeUndefined();
  for (const tool of ["tailscale", "cloudflared"]) { await writeFile(path.join(dir, tool), "#!/bin/sh\n"); await chmod(path.join(dir, tool), 0o755); }
  expect(await findTunnel(dir)).toEqual({ tool: "cloudflared", path: path.join(dir, "cloudflared") });
});

/** A dev server stand-in that says which address it was told to listen on. */
const SERVER = `const server = Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch() { return new Response("<html>ok</html>", { headers: { "content-type": "text/html" } }); } });
console.log("listening on", process.env.HOST, server.port);`;
/** A cloudflared stand-in: prints a quick-tunnel link and stays up. */
const TUNNEL = `#!/bin/sh
echo "INF Requesting new quick Tunnel on trycloudflare.com..."
echo "INF |  https://quiet-river-maple.trycloudflare.com  |"
exec sleep 60
`;

async function fixture(answers: string[], options: { tunnel?: boolean; canAsk?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-preview-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "server.ts"), SERVER);
  await mkdir(path.join(root, "bin"));
  await writeFile(path.join(root, "bin/cloudflared"), TUNNEL);
  await chmod(path.join(root, "bin/cloudflared"), 0o755);
  const manager = new ServiceManager({ projectRoot: root, services: {} });
  cleanups.push(() => manager.close().catch(() => {}));
  let text = "";
  const asked: string[] = [];
  const tunnel: Tunnel = { tool: "cloudflared", path: path.join(root, "bin/cloudflared") };
  const host: PreviewHost = {
    output: { write: (chunk) => { text += chunk; } }, canAsk: options.canAsk ?? true,
    ask: async (question, choices) => { asked.push(`${question}\n${choices.map((choice, index) => `${index + 1} ${choice.label}`).join("\n")}`); return answers.shift(); },
    manager: () => manager,
    webService: async () => ({ spec: { command: `"${process.execPath}" server.ts`, port: "auto", ready: { http: "/" }, timeoutMs: 10_000 }, label: "bun run dev" }),
    // Loopback stands in for the network address: the server listens on 0.0.0.0, so it answers there too.
    lanAddress: () => "127.0.0.1",
    findTunnel: async () => options.tunnel === false ? undefined : tunnel,
  };
  return { manager, host, asked, text: () => text };
}

posixOnly("by default it runs on your network with no question, then asks once before a public link; 1 No keeps it local", async () => {
  const f = await fixture(["No"]);
  await runPreview(f.host, "");
  await expect(new SmokeChecks([], () => f.manager).record({ name: "link", service: PUBLIC_SLOT, request: { method: "GET", path: "/" }, expect: { status: 200 } },
    new AbortController().signal)).rejects.toThrow("must name a declared service");
  const origin = f.manager.origin("preview")!;
  const port = new URL(origin).port;
  expect(f.text()).toContain(`[preview] On your network: http://127.0.0.1:${port} · open it on a phone on the same Wi-Fi. Anyone on this network can open it; it stops when you leave Casper (or /preview stop).`);
  expect(f.manager.logs("preview").text).toContain("listening on 0.0.0.0");
  expect(f.asked).toEqual(["Share a public link too? Anyone with the link can open your app while Casper runs.\n1 No\n2 Yes, make a public link (cloudflared)"]);
  expect(f.manager.status().map((entry) => entry.name)).toEqual(["preview"]);
}, 30_000);

posixOnly("2 Yes starts the tunnel and prints its link; /preview stop ends both", async () => {
  const f = await fixture(["Yes, make a public link (cloudflared)"]);
  await runPreview(f.host, "");
  expect(f.text()).toContain("[preview] Public link: https://quiet-river-maple.trycloudflare.com · anyone with it can open your app. /preview stop ends it.");
  expect(f.manager.status().find((entry) => entry.name === PUBLIC_SLOT)?.state).toBe("ready");
  await runPreview(f.host, "stop");
  expect(f.text()).toContain("[preview] Stopped. Nothing is shared now.");
  expect(f.manager.status()).toEqual([]);
}, 30_000);

posixOnly("the AI's service tool can't start the preview or the public link, before or after /preview stop", async () => {
  const f = await fixture(["Yes, make a public link (cloudflared)"]);
  await runPreview(f.host, "");
  const tool = serviceTool(() => f.manager);
  const call = async (args: Record<string, unknown>) => {
    const result = await tool.execute(args, new AbortController().signal);
    return { isError: result.isError === true, text: result.text };
  };
  // Casper's own slots are left out of what the AI sees.
  expect((await call({ action: "status" })).text).not.toContain(PUBLIC_SLOT);
  for (const service of [PUBLIC_SLOT, "preview"]) {
    for (const action of ["start", "restart"]) {
      const refused = await call({ action, service });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("/preview");
    }
    expect((await call({ action: "request", service, path: "/" })).isError).toBe(true);
  }
  const origin = f.manager.origin("preview")!;
  expect((await call({ action: "request", url: `${origin}/` })).isError).toBe(true);
  await runPreview(f.host, "stop");
  for (const service of [PUBLIC_SLOT, "preview"]) {
    for (const action of ["start", "restart"]) expect((await call({ action, service })).isError).toBe(true);
  }
  expect(f.manager.status()).toEqual([]);
}, 30_000);

posixOnly("without a tunnel tool, one line and no question; without a person to ask, no public link", async () => {
  const none = await fixture([], { tunnel: false });
  await runPreview(none.host, "");
  expect(none.text()).toContain("[preview] A public link needs cloudflared or Tailscale installed; Casper doesn't install them.");
  expect(none.asked).toEqual([]);
  const script = await fixture([], { canAsk: false });
  await runPreview(script.host, "");
  expect(script.asked).toEqual([]);
  expect(script.manager.status().map((entry) => entry.name)).toEqual(["preview"]);
}, 30_000);

test("no web app to preview says why and starts nothing", async () => {
  const manager = new ServiceManager({ projectRoot: os.tmpdir(), services: {} });
  let text = "";
  await runPreview({ output: { write: (chunk) => { text += chunk; } }, canAsk: true, ask: async () => undefined, manager: () => manager,
    webService: async () => ({ reason: "Casper found no web app here to preview." }) }, "");
  expect(text).toBe("[preview] Casper found no web app here to preview.\n");
  expect(manager.status()).toEqual([]);
});
