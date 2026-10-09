import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServiceSpec } from "./config";
import type { ServiceManager } from "./manager";

/**
 * /preview: the project's web app on your own network, so a phone on the same Wi-Fi can open it. That is the
 * default and asks nothing (you typed /preview). A public link goes through a tunnel tool you already have
 * (cloudflared or Tailscale Funnel; Casper never installs one) and only after a numbered yes, 1 No first. Both stop
 * when you leave Casper, or with /preview stop. No model call.
 */

export const PREVIEW_SLOT = "preview";
export const PUBLIC_SLOT = "public-link";

export type TunnelTool = "cloudflared" | "tailscale";
export interface Tunnel { tool: TunnelTool; path: string }

/** What /preview needs from the app. */
export interface PreviewHost {
  readonly output: { write(text: string): void };
  /** A person can answer a numbered question here. */
  readonly canAsk: boolean;
  ask(question: string, options: { label: string; description?: string }[], signal?: AbortSignal): Promise<string | undefined>;
  manager(): ServiceManager;
  /** How the project's web app starts (a declared services.web, or the dev server Casper found), or why there is none. */
  webService(): Promise<{ spec: ServiceSpec; label: string } | { reason: string }>;
  /** Seams for tests: this machine's network address, and the tunnel tool on PATH. */
  lanAddress?: () => string | undefined;
  findTunnel?: () => Promise<Tunnel | undefined>;
}

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];
/** Interfaces that aren't the Wi-Fi or wired network a phone is on: containers, VPNs, tunnels. */
const VIRTUAL = /^(docker|br-|veth|virbr|vboxnet|vmnet|utun|tun|tap|tailscale|zt|wg|lo)/i;

/** This machine's address on the local network: a private IPv4 address on a real interface, else none. */
export function lanAddress(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | undefined {
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      if (VIRTUAL.test(name) || !PRIVATE.some((range) => range.test(entry.address))) continue;
      candidates.push({ name, address: entry.address });
    }
  }
  // Docker's default bridge sits in 172.17.0.0/16 even when its interface has another name.
  const real = candidates.filter((candidate) => !candidate.address.startsWith("172.17."));
  return (real[0] ?? candidates[0])?.address;
}

/** The web app's start command, listening on every interface instead of loopback. Commands Casper wrote with a fixed
 * loopback host get 0.0.0.0; ones that use $HOST follow it. Vite also accepts the tunnel's host names. */
export function previewSpec(spec: ServiceSpec): ServiceSpec {
  const command = spec.command
    .replace(/(--host(?:name)?[ =])(?:127\.0\.0\.1|localhost)\b/g, "$10.0.0.0")
    .replace(/(--server\.address[ =])(?:127\.0\.0\.1|localhost)\b/g, "$10.0.0.0");
  return { ...spec, command, env: { ...spec.env, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".trycloudflare.com,.ts.net" } };
}

/** The first tunnel tool on PATH: cloudflared, then tailscale. */
export async function findTunnel(pathValue = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform): Promise<Tunnel | undefined> {
  const suffixes = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const tool of ["cloudflared", "tailscale"] as const) {
    for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
      for (const suffix of suffixes) {
        const file = path.join(dir, `${tool}${suffix}`);
        if (await access(file, platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false)) return { tool, path: file };
      }
    }
  }
  return undefined;
}

const quote = (file: string) => `"${file.replace(/"/g, '\\"')}"`;

/** The tunnel command for a local port, and the log text that says the link is up. */
export function tunnelSpec(tunnel: Tunnel, port: number): ServiceSpec {
  return tunnel.tool === "cloudflared"
    ? { command: `${quote(tunnel.path)} tunnel --no-autoupdate --url http://127.0.0.1:${port}`, port: "auto", ready: { log: ".trycloudflare.com" }, timeoutMs: 45_000 }
    : { command: `${quote(tunnel.path)} funnel ${port}`, port: "auto", ready: { log: ".ts.net" }, timeoutMs: 45_000 };
}

/** The public link in a tunnel's output. */
export function tunnelUrl(log: string): string | undefined {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i.exec(log)?.[0] ?? /https:\/\/[a-z0-9.-]+\.ts\.net\b/i.exec(log)?.[0];
}

const TOOL_NAME: Record<TunnelTool, string> = { cloudflared: "cloudflared", tailscale: "Tailscale Funnel" };

async function answers(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3000)]) });
    await response.body?.cancel();
    return true;
  } catch { return false; }
}

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);

/** /preview [stop]. */
export async function runPreview(host: PreviewHost, args: string, signal?: AbortSignal): Promise<void> {
  const manager = host.manager();
  const ours = (name: string) => manager.status().some((entry) => entry.name === name);
  if (args === "stop") {
    const stopped = [PUBLIC_SLOT, PREVIEW_SLOT].filter(ours);
    // Dropped, not just stopped: only a new /preview (and, for the link, a new yes) starts them again.
    for (const name of stopped) await (manager.casperOnly(name) ? manager.drop(name) : manager.stop(name));
    host.output.write(stopped.length ? "[preview] Stopped. Nothing is shared now.\n" : "[preview] Nothing to stop.\n");
    return;
  }
  if (args) throw new Error("Usage: /preview | /preview stop");
  const web = await host.webService();
  if ("reason" in web) { host.output.write(`[preview] ${web.reason}\n`); return; }
  const lan = (host.lanAddress ?? lanAddress)();
  const own = signal ?? new AbortController().signal;
  try {
    manager.ensureSlot(PREVIEW_SLOT, previewSpec(web.spec), { listen: "network", owner: "casper" });
    await manager.ensureFresh(PREVIEW_SLOT, own);
  } catch (error) {
    host.output.write(`[preview] The app didn't start: ${firstLine(error)}\n`);
    return;
  }
  const origin = manager.origin(PREVIEW_SLOT);
  const port = origin ? Number(new URL(origin).port) : undefined;
  if (!origin || !port) { host.output.write("[preview] The app didn't start.\n"); return; }
  const local = `http://localhost:${port}`;
  if (!lan) {
    host.output.write(`[preview] ${local} on this computer. Casper found no network address (Wi-Fi or wired), so a phone can't open it.\n`);
  } else if (await answers(`http://${lan}:${port}/`, own)) {
    host.output.write(`[preview] On your network: http://${lan}:${port} · open it on a phone on the same Wi-Fi. Anyone on this network can open it; it stops when you leave Casper (or /preview stop).\n`);
  } else {
    host.output.write(`[preview] ${local} on this computer only: ${web.label} sets its own address. Make it listen on $HOST and run /preview again.\n`);
  }

  const tunnel = await (host.findTunnel ?? (() => findTunnel()))();
  if (!tunnel) {
    host.output.write("[preview] A public link needs cloudflared or Tailscale installed; Casper doesn't install them.\n");
    return;
  }
  if (!host.canAsk) return;
  const yes = `Yes, make a public link (${TOOL_NAME[tunnel.tool]})`;
  const answer = await host.ask("Share a public link too? Anyone with the link can open your app while Casper runs.",
    [{ label: "No", description: "keep it on your network" }, { label: yes, description: "until you leave Casper or /preview stop" }], signal);
  if (answer !== yes || signal?.aborted) return;
  try {
    manager.ensureSlot(PUBLIC_SLOT, tunnelSpec(tunnel, port), { sandbox: false, owner: "casper" });
    await manager.ensureFresh(PUBLIC_SLOT, own);
  } catch (error) {
    host.output.write(`[preview] No public link: ${TOOL_NAME[tunnel.tool]} didn't give one. ${firstLine(error)}\n`);
    return;
  }
  const link = tunnelUrl(manager.logs(PUBLIC_SLOT).text);
  host.output.write(link
    ? `[preview] Public link: ${link} · anyone with it can open your app. /preview stop ends it.\n`
    : `[preview] ${TOOL_NAME[tunnel.tool]} started but printed no link; /services logs ${PUBLIC_SLOT} shows what it said.\n`);
}
