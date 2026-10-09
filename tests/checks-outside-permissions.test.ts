import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { permissionsScreen } from "../src/app/permissions";
import { askChecksOutside } from "../src/app/verification";
import { SandboxStore } from "../src/sandbox/store";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

test("'stop asking until I quit' never answers the checks-outside box; it is still asked", async () => {
  const asked: string[] = [];
  const saved: string[] = [];
  const sandbox = { allowChecksOutsideForSession: () => saved.push("session"), rememberChecksOutside: async () => { saved.push("always"); } };
  const app = { stopAsking: true, interactive: true, closing: false, approvalQueue: Promise.resolve(), sandbox, output: { write: () => {} }, events: { ensureLineBreak: () => {} },
    commandAbort: undefined, terminal: { approve: async (_preview: string, question: string) => { asked.push(question); return "No"; } } };
  expect(await askChecksOutside(app as never, [{ name: "test" }] as never, new AbortController().signal)).toBeUndefined();
  expect(asked.length).toBe(1);
  expect(asked[0]).toContain("Run this project's checks outside the sandbox?");
  expect(saved).toEqual([]);
});

test("a remembered 'always' for checks sits beside the remembered write folders and hosts, and each survives a round trip", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-checks-store-")));
  roots.push(base);
  const store = new SandboxStore(base);
  await store.addWrite("/srv/shared");
  await store.setChecksOutside(true);
  await store.addHost("example.org");
  const again = new SandboxStore(base);
  expect(await again.writeFolders()).toEqual(["/srv/shared"]);
  expect(await again.checksOutside()).toBe(true);
  await again.setChecksOutside(false);
  expect(await new SandboxStore(base).writeFolders()).toEqual(["/srv/shared"]);
  expect(await new SandboxStore(base).checksOutside()).toBe(false);
  await again.forgetWrite("/srv/shared");
  await again.setChecksOutside(true);
  expect(await new SandboxStore(base).hosts()).toEqual(["example.org"]);
  expect(await new SandboxStore(base).writeFolders()).toEqual([]);
  expect(await new SandboxStore(base).checksOutside()).toBe(true);
});

test("/permissions lists the checks setting and the remembered 'always' with the way to forget it", () => {
  const view = { shell: "shell", scripts: "scripts", asking: true, sandboxOn: true, outsideWritesAsk: true, commandsSession: 0, commandsSaved: 0, listedHosts: 0, rememberedHosts: [], reachHosts: [],
    labDevices: 0, labAsks: undefined, writesForGood: [], writesSession: [], mcpWritesOn: [], mcpAllowAll: [], web: true, github: true, sshLogin: true, downloads: true, show: (x: string) => x };
  expect(permissionsScreen({ ...view, checks: "ask", checksRemembered: false })).toContain("only if you say so when a check is blocked");
  const remembered = permissionsScreen({ ...view, checks: "ask", checksRemembered: true });
  expect(remembered).toContain("remembered for this project");
  expect(remembered).toContain("/allowed forget");
  expect(permissionsScreen({ ...view, checks: "outside", checksRemembered: false })).toContain("sandbox: checks: outside");
});
