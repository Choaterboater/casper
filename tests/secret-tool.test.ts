import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { secretTool, withEnvLine, type SecretAsk, type SecretToolHost } from "../src/secrets/secret-tool";
import { nextCommandNames, takeNextCommandEnv } from "../src/secrets/next-command";
import { forgetTypedSecrets } from "../src/secrets/typed";
import { scrubPlainSecrets } from "../src/secrets/files";
import { secretRequested } from "../src/app/capabilities";
import { removeTempDir } from "./support/temp-dir";

/** casper_secret on its own: the hidden box is a fake that "types" VALUE, and git is a fake that knows what it tracks. */
const VALUE = "eyJhIjoiZmFrZS10dW5uZWwtdG9rZW4tZm9yLXRlc3RzIn0=";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { forgetTypedSecrets(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function world(options: { canAsk?: boolean; typed?: string | undefined; tracked?: string[]; ignored?: string[]; repo?: boolean; planning?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-secret-tool-"));
  cleanup.push(() => removeTempDir(root));
  const project = path.join(root, "project"), home = path.join(root, "home");
  await mkdir(project); await mkdir(home);
  const asked: SecretAsk[] = [], told: string[] = [];
  const typed = "typed" in options ? options.typed : VALUE;
  const host: SecretToolHost = {
    root: () => project, home: () => home,
    canAsk: () => options.canAsk ?? true,
    planning: () => options.planning ?? false,
    ask: async (ask) => { asked.push(ask); return typed; },
    tell: (text) => { told.push(text); },
    git: async (_root, args) => {
      if (options.repo === false) return { code: 128 };
      if (args[0] === "rev-parse") return { code: 0 };
      if (args[0] === "ls-files") return { code: (options.tracked ?? []).includes(args.at(-1)!.replace(":(literal)", "")) ? 0 : 1 };
      if (args[0] === "check-ignore") return { code: (options.ignored ?? []).includes(args.at(-1)!) ? 0 : 1 };
      return { code: 1 };
    },
  };
  return { project, home, asked, told, tool: secretTool(host) };
}

test("a .env save: the box says where it goes, the file is mode 600 with NAME=value, git ignores it, and the AI never gets the value", async () => {
  const w = await world();
  await writeFile(path.join(w.project, ".env"), "OTHER=1\nTUNNEL_TOKEN=old\n");
  const result = await w.tool.execute({ name: "TUNNEL_TOKEN", why: "cloudflared needs it to start the tunnel", saveTo: ".env" });
  expect(result.isError).toBeUndefined();
  expect(result.text).toBe(`Saved TUNNEL_TOKEN to .env (${VALUE.length} characters, mode 600, as TUNNEL_TOKEN=…). Added .env to .gitignore so git won't commit it. Read it from the file; don't print it.`);
  expect(result.text).not.toContain(VALUE);
  expect(w.asked).toEqual([{ name: "TUNNEL_TOKEN", why: "cloudflared needs it to start the tunnel", to: "the file .env (only you can read it; the AI gets only its length)" }]);
  expect(await readFile(path.join(w.project, ".env"), "utf8")).toBe(`OTHER=1\nTUNNEL_TOKEN=${VALUE}\n`);
  if (process.platform !== "win32") expect((await stat(path.join(w.project, ".env"))).mode & 0o777).toBe(0o600);
  expect(await readFile(path.join(w.project, ".gitignore"), "utf8")).toBe("/.env\n");
  expect(w.told.join("")).toBe("[secret] Saved TUNNEL_TOKEN to .env (only you can read it). Added .env to .gitignore.\n");
  // From now on it is hidden wherever it turns up.
  expect(scrubPlainSecrets(`docker run cloudflare/cloudflared tunnel run ${VALUE}`).text).toBe("docker run cloudflare/cloudflared tunnel run <secret hidden>");
});

test("any other file holds just the value; a file git already ignores is left out of .gitignore", async () => {
  const w = await world({ ignored: ["secrets/tunnel.txt"] });
  const result = await w.tool.execute({ name: "TUNNEL_TOKEN", why: "for the tunnel", saveTo: "secrets/tunnel.txt" });
  expect(result.text).toBe(`Saved TUNNEL_TOKEN to secrets/tunnel.txt (${VALUE.length} characters, mode 600). Read it from the file; don't print it.`);
  expect(await readFile(path.join(w.project, "secrets/tunnel.txt"), "utf8")).toBe(VALUE);
  expect(await stat(path.join(w.project, ".gitignore")).then(() => true, () => false)).toBe(false);
});

test("a file git tracks, one outside the project, a link out of it or git's own is refused before the box opens", async () => {
  const w = await world({ tracked: ["config.yml"] });
  await symlink(w.home, path.join(w.project, "out"), "junction");
  const cases: Array<[string, string]> = [
    ["config.yml", "Not asked: git tracks config.yml, so the secret would be committed. Pick a file git doesn't track, such as .env."],
    ["../elsewhere.env", "Not asked: "],
    ["out/token.txt", "Not asked: "],
    [".git/config", "Not asked: .git/config belongs to git or holds settings Casper doesn't change."],
  ];
  for (const [saveTo, start] of cases) {
    const result = await w.tool.execute({ name: "TOKEN", why: "x", saveTo });
    expect([saveTo, result.isError, result.text.startsWith(start)]).toEqual([saveTo, true, true]);
  }
  expect(w.asked).toEqual([]);
});

test("no saveTo: $NAME reaches only the next command, and the value is hidden in its output", async () => {
  const w = await world();
  const result = await w.tool.execute({ name: "TUNNEL_TOKEN", why: "for docker run" });
  expect(result.text).toBe(`$TUNNEL_TOKEN is set for your next command only (${VALUE.length} characters). Use "$TUNNEL_TOKEN" in it; its value shows as <secret hidden>.`);
  expect(w.asked[0]!.to).toBe("the AI's next command only, as $TUNNEL_TOKEN");
  expect(nextCommandNames()).toEqual(["TUNNEL_TOKEN"]);
  expect(process.env.TUNNEL_TOKEN).toBeUndefined();
  expect(takeNextCommandEnv()).toEqual({ TUNNEL_TOKEN: VALUE });
  expect(takeNextCommandEnv()).toEqual({});
  expect(scrubPlainSecrets(`token=${VALUE}`).text).not.toContain(VALUE);
});

test("forgetting typed secrets (a cleared conversation, the end of the session) drops one still waiting for a command", async () => {
  const w = await world();
  await w.tool.execute({ name: "TUNNEL_TOKEN", why: "x" });
  forgetTypedSecrets();
  expect(takeNextCommandEnv()).toEqual({});
});

test("a run that can't show the hidden box refuses plainly and asks nothing", async () => {
  const w = await world({ canAsk: false });
  const result = await w.tool.execute({ name: "TUNNEL_TOKEN", why: "x", saveTo: ".env" });
  expect(result).toEqual({ isError: true, text: "Not asked: this run can't show Casper's hidden box (it needs Casper's full terminal). Don't ask for TUNNEL_TOKEN in chat; tell the user to put it in .env themselves." });
  expect(w.asked).toEqual([]);
  expect(w.told.join("")).toContain("this run can't show Casper's hidden box");
});

test("skipped in the box: nothing saved, and the AI is told not to ask in chat", async () => {
  const w = await world({ typed: undefined });
  const result = await w.tool.execute({ name: "TUNNEL_TOKEN", why: "x", saveTo: ".env" });
  expect(result).toEqual({ isError: true, text: "The user skipped it; nothing was saved. Don't ask for TUNNEL_TOKEN in chat." });
  expect(await stat(path.join(w.project, ".env")).then(() => true, () => false)).toBe(false);
});

test("bad names, names the shell needs, and a file save in plan mode are refused", async () => {
  const w = await world();
  expect((await w.tool.execute({ name: "my token", why: "x" })).text).toStartWith("Not asked: name must be");
  expect((await w.tool.execute({ name: "PATH", why: "x" })).text).toBe("Not asked: $PATH is one the shell or Casper uses. Pick another name.");
  expect((await w.tool.execute({ name: "LD_PRELOAD", why: "x" })).isError).toBe(true);
  expect((await w.tool.execute({ name: "TOKEN", why: " " })).isError).toBe(true);
  const plan = await world({ planning: true });
  expect((await plan.tool.execute({ name: "TOKEN", why: "x", saveTo: ".env" })).text).toBe("Not asked: plan mode changes no files. Ask for it when you build.");
  expect(w.asked).toEqual([]);
});

test("outside a git repository the file is still mode 600, and .gitignore is not made", async () => {
  const w = await world({ repo: false });
  const result = await w.tool.execute({ name: "API_KEY", why: "x", saveTo: "local.env" });
  expect(result.text).toBe(`Saved API_KEY to local.env (${VALUE.length} characters, mode 600, as API_KEY=…). Read it from the file; don't print it.`);
  expect(await stat(path.join(w.project, ".gitignore")).then(() => true, () => false)).toBe(false);
});

test(".env lines: replaced where they were, quoted when needed, added when new", () => {
  expect(withEnvLine("", "A", "plain-value_1")).toBe("A=plain-value_1\n");
  expect(withEnvLine("X=1\nexport A=old\nY=2\nA=dup\n", "A", "new")).toBe("X=1\nA=new\nY=2\n");
  expect(withEnvLine("X=1", "A", "has space")).toBe("X=1\nA='has space'\n");
  expect(withEnvLine("", "A", "it's $x")).toBe("A=\"it's \\$x\"\n");
});

test("the tool is offered for a request that names a password, token or key, not for ordinary work", () => {
  for (const request of ["set up the cloudflare tunnel, prompt me for token to hide", "add my OpenAI API key", "the db password is in 1password", "rotate the deploy key", "use my credentials"]) {
    expect([request, secretRequested(request)]).toEqual([request, true]);
  }
  for (const request of ["fix the login bug", "add a primary key to users", "press any key to continue", "count tokens in the parser"]) {
    expect([request, secretRequested(request)]).toEqual([request, request === "count tokens in the parser"]);
  }
});

test("offered only when asked for, it stays small: one short description and three fields", async () => {
  const w = await world();
  const sent = JSON.stringify({ type: "function", function: { name: w.tool.name, description: w.tool.description, parameters: w.tool.inputSchema } });
  expect(sent.length).toBeLessThan(750);
});
