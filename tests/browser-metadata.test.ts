import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { METADATA_HOSTS, MetadataGuard, metadataHost, type MetadataWire } from "../src/browser/metadata";
import { BrowserSession, type MetadataApproval } from "../src/browser/session";
import { NO, YES_ONCE, YES_SESSION } from "../src/app/safe-choices";
import { SessionYes } from "../src/app/session-yes";
import { metadataQuestion } from "../src/app/task-tools";
import { removeTempDir } from "./support/temp-dir";

/**
 * The AI's browser asks once before it reaches a cloud metadata address (a page there can hand out a cloud machine's
 * login); LAN, private, loopback and other link-local addresses open as before. Nothing here contacts a real
 * address: the guard tests use a fake browser connection, and the Chrome tests stand [::1] in for a metadata
 * address and serve it from this machine.
 */

test("cloud metadata addresses are named however a URL writes them; LAN, private and loopback are not", () => {
  for (const url of ["http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/", "http://METADATA.google.internal./computeMetadata/v1/",
    "http://169.254.170.2/v2/credentials", "http://100.100.100.200/latest/meta-data", "http://[::ffff:169.254.169.254]/", "http://[::ffff:a9fe:a9fe]/",
    "http://2852039166/", "http://169.254.169.254:80/", "https://169.254.169.254/"]) expect(metadataHost(url)).toBeDefined();
  for (const url of ["http://10.0.0.1/", "http://192.168.1.1/", "http://172.16.0.1/", "http://127.0.0.1:3000/", "http://localhost/", "http://169.254.1.1/",
    "http://169.254.169.253/", "http://100.100.100.201/", "http://[fe80::1]/", "http://switch.lan/", "https://example.com/", "not a url"]) expect(metadataHost(url)).toBeUndefined();
  expect(METADATA_HOSTS).toContain("169.254.169.254");
});

/** A stand-in for Chrome's DevTools connection: records what the guard sends, and pauses requests on demand. */
function fakeWire() {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let paused: ((event: unknown) => void) | undefined;
  const wire: MetadataWire = {
    async send(method, params) { sent.push({ method, params }); return method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {}; },
    on(event, handler) { if (event === "Fetch.requestPaused") paused = handler; },
  };
  let next = 0;
  const pause = async (url: string, resourceType = "Document", frameId = "main") => {
    const requestId = `r${++next}`;
    paused!({ requestId, request: { url }, resourceType, frameId });
    for (let i = 0; i < 50 && !sent.some(entry => entry.params?.requestId === requestId); i++) await new Promise(resolve => setTimeout(resolve, 2));
    return sent.find(entry => entry.params?.requestId === requestId)!.method;
  };
  return { wire, sent, pause };
}

test("the guard holds back a metadata address however it is reached, and lets everything else through", async () => {
  const allowed = new Set<string>(), looked: string[] = [];
  const guard = new MetadataGuard({ allowed: address => allowed.has(address), lookup: async host => { looked.push(host); return host === "sneaky.example" ? ["169.254.169.254"] : ["203.0.113.7"]; } });
  const { wire, sent, pause } = fakeWire();
  await guard.attach(wire);
  // Only page documents and the metadata addresses themselves pause; other traffic never reaches Casper.
  const patterns = sent.find(entry => entry.method === "Fetch.enable")!.params!.patterns as Array<{ urlPattern: string; resourceType?: string }>;
  expect(patterns[0]).toMatchObject({ urlPattern: "*", resourceType: "Document" });
  expect(patterns.slice(1).every(pattern => !pattern.resourceType && pattern.urlPattern !== "*")).toBe(true);
  expect(patterns.map(pattern => pattern.urlPattern)).toContain("*://169.254.169.254/*");

  expect(await pause("http://169.254.169.254/latest/meta-data/iam/")).toBe("Fetch.failRequest");
  expect(await pause("http://169.254.169.254/latest/", "Image", "main")).toBe("Fetch.failRequest");
  expect(await pause("http://169.254.169.254/x", "Document", "child-frame")).toBe("Fetch.failRequest");
  expect(await pause("http://sneaky.example/")).toBe("Fetch.failRequest");
  for (const url of ["http://10.0.0.1/", "http://192.168.1.20/", "http://127.0.0.1:5173/", "http://169.254.10.10/", "http://localhost:3000/", "https://example.com/"]) {
    expect(await pause(url)).toBe("Fetch.continueRequest");
  }
  // A page document whose name resolves to a metadata address is looked up once; IPs and localhost never are.
  expect(looked.sort()).toEqual(["example.com", "sneaky.example"]);
  expect(guard.take()).toEqual([
    { url: "http://169.254.169.254/latest/meta-data/iam/", address: "169.254.169.254", mainFrame: true },
    { url: "http://169.254.169.254/latest/", address: "169.254.169.254", mainFrame: false },
    { url: "http://169.254.169.254/x", address: "169.254.169.254", mainFrame: false },
    { url: "http://sneaky.example/", address: "169.254.169.254", mainFrame: true },
  ]);
  allowed.add("169.254.169.254");
  expect(await pause("http://169.254.169.254/latest/meta-data/")).toBe("Fetch.continueRequest");
  expect(guard.take()).toEqual([]);
});

test("a session yes covers that address only, and never comes from a yes to other browser actions", async () => {
  const asked: string[] = [];
  let answer = YES_SESSION;
  const sessionYes = new SessionYes(async (_preview, question, options) => {
    asked.push(question);
    expect(options.map(option => option.label)).toEqual([NO, YES_ONCE, YES_SESSION]);
    return answer;
  });
  const confirm = metadataQuestion(sessionYes);
  const signal = new AbortController().signal;
  expect(await sessionYes.approve("browser", "", "Allow this browser action?", signal)).toBe(true);
  expect(await confirm({ address: "169.254.169.254", url: "http://169.254.169.254/" }, signal)).toBe(true);
  expect(await confirm({ address: "169.254.169.254", url: "http://169.254.169.254/other" }, signal)).toBe(true);
  answer = NO;
  expect(await confirm({ address: "100.100.100.200", url: "http://100.100.100.200/" }, signal)).toBe(false);
  expect(asked).toEqual(["Allow this browser action?", "Open 169.254.169.254?", "Open 100.100.100.200?"]);
});

const executable = process.env.CASPER_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserTest = existsSync(executable) ? test : test.skip;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A page on 127.0.0.1, and [::1] standing in for a metadata address: both served here, and hits lists what was reached. */
async function fixture(answer: (request: MetadataApproval) => boolean) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-metadata-test-")));
  cleanup.push(() => removeTempDir(root));
  const project = path.join(root, "project"), state = path.join(root, "state");
  await mkdir(project); await mkdir(state);
  const hits: string[] = [];
  const html = (body: string) => new Response(`<!doctype html><title>t</title>${body}`, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
  const stand = Bun.serve({ hostname: "::1", port: 0, fetch(request): Response {
    hits.push(`metadata${new URL(request.url).pathname}`);
    return html("<h1>Secret</h1>");
  } });
  cleanup.push(async () => { stand.stop(true); });
  const metadata = `http://[::1]:${stand.port}`, secret = `${metadata}/secret`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
    const url = new URL(request.url);
    hits.push(`home${url.pathname}`);
    if (url.pathname === "/redirect") return Response.redirect(secret, 302);
    if (url.pathname === "/parts") return html(`<h1>Parts</h1><img src="${secret}.png"><iframe src="${secret}"></iframe><script>fetch("${secret}-api").catch(() => {})</script>`);
    if (url.pathname === "/link") return html(`<a id="go" href="${secret}">Go</a>`);
    return html("<h1>Home</h1>");
  } });
  cleanup.push(async () => { server.stop(true); });
  const asked: MetadataApproval[] = [];
  const session = new BrowserSession({ projectRoot: project, stateDirectory: state, executablePath: executable, metadataHosts: ["::1"],
    lookup: async () => [], confirmMetadata: async request => { asked.push(request); return answer(request); } });
  cleanup.push(() => session.close());
  return { session, hits, asked, home: `http://127.0.0.1:${server.port}`, metadata };
}

const reached = (hits: string[]) => hits.filter(hit => hit.startsWith("metadata"));

browserTest("opening a metadata address asks once; a no leaves it unopened and nobody to ask is a no", async () => {
  const f = await fixture(() => false);
  await expect(f.session.run({ action: "open", url: `${f.metadata}/secret` })).rejects.toThrow("cloud metadata address");
  expect(f.asked).toEqual([{ address: "::1", url: `${f.metadata}/secret` }]);
  expect(reached(f.hits)).toEqual([]);
  // A LAN or loopback address opens with no question, exactly as before.
  expect(await f.session.run({ action: "open", url: f.home })).toMatchObject({ title: "t" });
  expect(f.asked).toHaveLength(1);

  const nobody = new BrowserSession({ projectRoot: os.tmpdir(), stateDirectory: os.tmpdir(), executablePath: executable, metadataHosts: ["::1"], lookup: async () => [] });
  cleanup.push(() => nobody.close());
  await expect(nobody.run({ action: "open", url: `${f.metadata}/secret` })).rejects.toThrow("nobody was there to ask");
  expect(reached(f.hits)).toEqual([]);
}, 30_000);

browserTest("a yes opens it; a redirect there asks first and then follows", async () => {
  const f = await fixture(() => true);
  expect(await f.session.run({ action: "open", url: `${f.home}/redirect` })).toMatchObject({ url: `${f.metadata}/secret` });
  expect(f.asked).toEqual([{ address: "::1", url: `${f.metadata}/secret` }]);
  // Chrome may also ask for the page's icon there while the yes still holds (it ends with the action), or not.
  expect(reached(f.hits).filter(hit => hit !== "metadata/favicon.ico")).toEqual(["metadata/secret"]);
}, 30_000);

browserTest("a no to a redirect, a picture, a frame or a fetch there keeps them all from reaching it, one question each time", async () => {
  const f = await fixture(() => false);
  expect(await f.session.run({ action: "open", url: `${f.home}/redirect` })).toMatchObject({ notOpened: ["::1"] });
  const before = f.asked.length;
  expect(await f.session.run({ action: "open", url: `${f.home}/parts` })).toMatchObject({ title: "t", notOpened: ["::1"] });
  expect(f.asked.length - before).toBe(1);
  expect(await f.session.run({ action: "inspect" })).toMatchObject({ text: expect.stringContaining("Parts") });
  // A link the page follows on a click is asked about too.
  await f.session.run({ action: "open", url: `${f.home}/link` });
  // The click's navigation may start after the click returns: then the next action asks.
  const click = await f.session.run({ action: "click", selector: "#go", impact: "local-test", reason: "Synthetic link" });
  for (let i = 0; i < 20 && !click.notOpened && f.asked.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 25));
  const next = await f.session.run({ action: "inspect" });
  expect(click.notOpened ?? next.notOpened).toEqual(["::1"]);
  expect(f.asked.length).toBeGreaterThanOrEqual(3);
  expect(new Set(f.asked.map(request => request.address))).toEqual(new Set(["::1"]));
  expect(reached(f.hits)).toEqual([]);
}, 30_000);

browserTest("a page check whose URL is a metadata address asks before it loads", async () => {
  const f = await fixture(() => false);
  await expect(f.session.run({ action: "check", scenario: { name: "Secret", url: `${f.metadata}/secret`, steps: [], assertions: [{ kind: "visible", selector: "h1" }] } }))
    .rejects.toThrow("cloud metadata address");
  expect(reached(f.hits)).toEqual([]);
}, 30_000);

browserTest("the automatic page check is not the AI's browser: its pages load as before, with no question and no block", async () => {
  const f = await fixture(() => false);
  const checks = new BrowserSession({ projectRoot: os.tmpdir(), stateDirectory: os.tmpdir(), executablePath: executable, metadataHosts: ["::1"], lookup: async () => [] });
  cleanup.push(() => checks.close());
  const load = await checks.load(`${f.home}/parts`);
  expect(load.status).toBe(200);
  // Chrome's own picture and cross-site rules may still fail a part; Casper never holds one back.
  expect(load.failedRequests.filter(request => /BLOCKED_BY_CLIENT/.test(request.error ?? ""))).toEqual([]);
  expect(f.asked).toEqual([]);
  expect(reached(f.hits)).toEqual(expect.arrayContaining(["metadata/secret", "metadata/secret.png", "metadata/secret-api"]));
}, 30_000);
