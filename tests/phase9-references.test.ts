import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverReferenceConfiguration } from "../src/references/config";
import { ReferenceLibrary } from "../src/references/library";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-references-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const repo = path.join(root, "reference");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await mkdir(project);
  const config = path.join(home, ".casper/references.yaml");
  await writeFile(config, JSON.stringify({ references: {
    router: { path: repo, paths: ["docs"], useFor: ["MCP routing"] },
  } }));
  return { root, home, repo, project, config };
}

test("local reference search returns literal matches with inspectable source provenance", async () => {
  const { home, repo, config } = await fixture();
  const source = "# Router notes\nUse a small MCP router surface.\nCurrent projects remain authoritative.\n";
  await writeFile(path.join(repo, "docs/router.md"), source);
  await writeFile(path.join(repo, "outside.md"), "MCP router outside the configured paths");
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home }));
  cleanup.push(() => library.close());
  const result = await library.search({ query: "mcp ROUTER", source: "router" });
  expect(result.status).toBe("complete");
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]).toMatchObject({
    source: "router", configuration: config, file: "docs/router.md", line: 2,
    excerpt: "Use a small MCP router surface.", excerptTruncated: false,
    sha256: createHash("sha256").update(source).digest("hex"),
  });
  expect(result.guidance).toContain("Current repository");
  expect(result.guidance).toContain("untrusted");
  expect(await readFile(path.join(repo, "docs/router.md"), "utf8")).toBe(source);
});

for (const excluded of ["a.data", "package-lock.json"]) test(`an excluded ${excluded} hardlink cannot hide an eligible reference file`, async () => {
  const { home, repo, config } = await fixture();
  await writeFile(path.join(repo, "docs", excluded), "needle\n");
  await link(path.join(repo, "docs", excluded), path.join(repo, "docs/z.md"));
  await link(path.join(repo, "docs", excluded), path.join(repo, "docs/zz.md"));
  const paths = excluded === "a.data" ? ["docs"] : [`docs/${excluded}`, "docs/z.md", "docs/zz.md", "docs"];
  await writeFile(config, JSON.stringify({ references: { router: { path: repo, paths } } }));
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home }));
  cleanup.push(() => library.close());
  const result = await library.search({ query: "needle" });
  expect(result.status).toBe("complete");
  expect(result.issues).toEqual([]);
  expect(result.matches.map((entry) => entry.file)).toEqual(["docs/z.md"]);
  expect(result.filesSearched).toBe(1); // Eligible hardlinks and overlapping paths still deduplicate.
  expect(result.bytesRead).toBe(7);
});

test("configuration is user/profile metadata only, with null disables and no invalid-override fallback", async () => {
  const { home, repo, config } = await fixture();
  const profile = path.join(home, ".casper/profiles/work/references.yaml");
  await mkdir(path.dirname(profile), { recursive: true });
  await writeFile(profile, JSON.stringify({ references: {
    router: { path: "https://example.com/private", paths: ["docs"] },
    absent: { path: "~/not-present", paths: ["docs"], useFor: ["patterns"] },
  } }));
  const discovered = await discoverReferenceConfiguration({ homeDir: home, profileName: "work" });
  expect(discovered.sources.map((entry) => entry.id)).toEqual(["absent"]);
  expect(discovered.sources[0]).toMatchObject({ root: path.join(home, "not-present"), configuration: profile });
  expect(discovered.diagnostics.join("\n")).toContain("router");
  const library = new ReferenceLibrary(discovered);
  cleanup.push(() => library.close());
  expect((await library.search({ query: "patterns" })).status).toBe("partial");
  await writeFile(profile, JSON.stringify({ references: { router: null } }));
  expect((await discoverReferenceConfiguration({ homeDir: home, profileName: "work" })).sources).toEqual([]);
  expect((await discoverReferenceConfiguration({ homeDir: home, profileName: "../work" })).sources[0]?.root).toBe(repo);
  expect(await readFile(config, "utf8")).toContain("router");
});

test("malformed, remote, traversal and executable source definitions cannot authorize reads", async () => {
  const { home, repo, config } = await fixture();
  for (const source of [
    { path: repo, paths: ["../outside"] }, { path: repo, paths: ["/outside"] },
    { path: repo, paths: ["docs/*.md"] }, { path: repo, paths: [] },
    { path: "owner/repository", paths: ["."] }, { path: "file:///tmp/repository", paths: ["."] },
    { path: repo, paths: ["docs"], command: "do-not-execute" },
    { path: repo, paths: ["docs"], useFor: [12] },
  ]) {
    await writeFile(config, JSON.stringify({ references: { bad: source } }));
    const result = await discoverReferenceConfiguration({ homeDir: home });
    expect(result.sources).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  }
  for (const text of ["references: [", "x".repeat(65_537), "references: &a {x: *a}"]) {
    await writeFile(config, text);
    const result = await discoverReferenceConfiguration({ homeDir: home });
    expect(result.sources).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(await readFile(config, "utf8")).toBe(text);
  }
});

test("literal queries cannot supply paths, regex programs, or extra tool arguments", async () => {
  const { home, repo } = await fixture();
  await writeFile(path.join(repo, "docs/query.md"), "ordinary text\nA literal .* is not a regex program.\n");
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home }));
  cleanup.push(() => library.close());
  expect((await library.search({ query: ".*" })).matches.map((entry) => entry.line)).toEqual([2]);
  const tool = library.tools()[0]!;
  for (const args of [{ query: "" }, { query: "x".repeat(513) }, { query: 3 },
    { query: "text", source: "../outside" }, { query: "text", root: repo }, { query: "text", limit: 99999 }]) {
    expect((await tool.execute(args)).isError).toBe(true);
  }
});

test("content is read anew while configuration and returned metadata cannot widen the library", async () => {
  const { home, repo, config } = await fixture();
  const file = path.join(repo, "docs/current.md");
  await writeFile(file, "needle before\n");
  const configuration = await discoverReferenceConfiguration({ homeDir: home });
  const library = new ReferenceLibrary(configuration);
  cleanup.push(() => library.close());
  configuration.sources[0]!.paths = ["."];
  library.list().sources[0]!.root = "/";
  const before = await library.search({ query: "needle" });
  await writeFile(file, "needle after\n");
  await writeFile(config, "references: {}\n");
  const after = await library.search({ query: "needle" });
  expect(after.matches[0]?.excerpt).toBe("needle after");
  expect(after.matches[0]?.sha256).not.toBe(before.matches[0]?.sha256);
  expect(library.list().sources[0]?.paths).toEqual(["docs"]);
  expect((await discoverReferenceConfiguration({ homeDir: home })).sources).toEqual([]);
});

test("configured-path parents and traversed symlinks cannot expose outside content", async () => {
  const { home, repo, root, config } = await fixture();
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.md"), "needle OUTSIDE_REFERENCE\n");
  await writeFile(path.join(repo, "docs/safe.md"), "needle safe\n");
  await writeFile(path.join(repo, "docs/.env"), "needle HIDDEN_CONTENT");
  await mkdir(path.join(repo, "docs/node_modules"));
  await writeFile(path.join(repo, "docs/node_modules/dependency.ts"), "needle DEPENDENCY_CONTENT");
  await symlink(outside, path.join(repo, "docs/link"));
  await symlink(outside, path.join(repo, "alias"));
  await writeFile(config, JSON.stringify({ references: { router: { path: repo, paths: ["docs", "alias/secret.md"] } } }));
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home }));
  cleanup.push(() => library.close());
  const result = await library.search({ query: "needle" });
  expect(result.status).toBe("partial");
  expect(result.matches.map((entry) => entry.excerpt)).toEqual(["needle safe"]);
  expect(JSON.stringify(result)).not.toContain("OUTSIDE_REFERENCE");
  expect(JSON.stringify(result)).not.toContain("HIDDEN_CONTENT");
  expect(JSON.stringify(result)).not.toContain("DEPENDENCY_CONTENT");
  expect(result.issues.join("\n")).toContain("symlink");
});

test("unavailable, oversized and invalid text stay qualified; bytes read for rejected text still count", async () => {
  const { home, repo, config } = await fixture();
  const binary = Buffer.from([110, 101, 101, 100, 108, 101, 0]);
  const invalid = Buffer.from([0xff, 0xfe]);
  await writeFile(path.join(repo, "docs/binary.json"), binary);
  await writeFile(path.join(repo, "docs/invalid.txt"), invalid);
  await writeFile(path.join(repo, "docs/large.md"), "needle" + "x".repeat(131_072));
  await writeFile(config, JSON.stringify({ references: { router: { path: repo, paths: ["docs", "missing.md"] } } }));
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home }));
  cleanup.push(() => library.close());
  const result = await library.search({ query: "needle" });
  expect(result.matches).toEqual([]);
  expect(result.status).toBe("partial");
  expect(result.issueCount).toBe(4);
  expect(result.bytesRead).toBe(binary.length + invalid.length);
});

test("long Unicode lines retain the actual matching text and valid excerpts", async () => {
  const { home, repo } = await fixture();
  await writeFile(path.join(repo, "docs/unicode.md"), "İ".repeat(800) + "NEEDLE\nneedle " + "😀".repeat(800));
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home }));
  cleanup.push(() => library.close());
  const result = await library.search({ query: "needle" });
  expect(result.matches).toHaveLength(2);
  expect(result.matches[0]?.excerpt).toContain("NEEDLE");
  expect(result.matches[1]?.excerpt).toContain("needle");
  for (const match of result.matches) {
    expect(match.excerptTruncated).toBe(true);
    expect(match.excerpt).not.toContain("\ufffd");
    expect(Buffer.byteLength(match.excerpt)).toBeLessThanOrEqual(1030);
  }
});

test("tool results retain whole provenance records within the serialized result budget", async () => {
  const { home, repo } = await fixture();
  await writeFile(path.join(repo, "docs/many.md"), Array(12).fill("needle " + "\u0001".repeat(1000)).join("\n"));
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home }));
  cleanup.push(() => library.close());
  const output = await library.tools()[0]!.execute({ query: "needle" });
  expect(output.isError).not.toBe(true);
  expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(16_384);
  const result = JSON.parse(output.text);
  expect(result.status).toBe("partial");
  expect(result.matches.length).toBeGreaterThan(0);
  expect(result.matches.length).toBeLessThan(8);
  expect(result.issues.join("\n")).toContain("limit reached");
  expect(result.matches[0]).toMatchObject({ source: "router", file: "docs/many.md", line: 1 });
});

test("C1 escaping participates in the reference tool's serialized byte budget", async () => {
  const { home, repo } = await fixture();
  await writeFile(path.join(repo, "docs/controls.md"), Array(12).fill("needle " + "\u009b".repeat(500)).join("\n"));
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home }));
  cleanup.push(() => library.close());
  const output = await library.tools()[0]!.execute({ query: "needle" });
  expect(output.isError).not.toBe(true);
  expect(output.text.includes("\u009b")).toBe(false);
  expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(16_384);
  const result = JSON.parse(output.text);
  expect(result.status).toBe("partial");
  expect(result.matches.length).toBeGreaterThan(0);
  expect(result.matches.length).toBeLessThan(8);
  expect(result.matches[0].excerpt).toBe("needle " + "\u009b".repeat(500));
  expect(result.matches[0]).toMatchObject({ source: "router", file: "docs/controls.md", line: 1 });
});

test("cancellation and close stop pending searches and revoke captured tools", async () => {
  const { home, repo } = await fixture();
  await writeFile(path.join(repo, "docs/notes.md"), "needle\n");
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home }));
  cleanup.push(() => library.close());
  const tool = library.tools()[0]!;
  const controller = new AbortController();
  controller.abort();
  expect((await tool.execute({ query: "needle" }, controller.signal)).isError).toBe(true);
  const pending = library.search({ query: "needle" }).then(() => "completed", () => "cancelled");
  await library.close();
  expect(await pending).toBe("cancelled");
  expect((await tool.execute({ query: "needle" })).isError).toBe(true);
  expect(library.tools()).toEqual([]);
});

test("multiple sources respect valid profile overrides and explicit source selection", async () => {
  const { home, repo, root, config } = await fixture();
  const other = path.join(root, "other");
  await mkdir(other);
  await writeFile(path.join(other, "README.md"), "needle profile\n");
  await writeFile(path.join(repo, "docs/main.md"), "needle global\n");
  await writeFile(config, JSON.stringify({ references: {
    router: { path: repo, paths: ["docs"] }, global: { path: repo, paths: ["docs", "docs/main.md"] },
  } }));
  const profile = path.join(home, ".casper/profiles/work/references.yaml");
  await mkdir(path.dirname(profile), { recursive: true });
  await writeFile(profile, JSON.stringify({ references: { router: { path: other, paths: ["README.md"] } } }));
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home, profileName: "work" }));
  cleanup.push(() => library.close());
  expect((await library.search({ query: "needle" })).matches.map((match) => [match.source, match.excerpt]))
    .toEqual([["global", "needle global"], ["router", "needle profile"]]);
  const selected = await library.search({ source: "router", query: "needle" });
  expect(selected.matches).toHaveLength(1);
  expect(selected.matches[0]?.configuration).toBe(profile);
});

test("a partial read budget cannot be mistaken for a complete no-match search", async () => {
  const { home, repo } = await fixture();
  await Promise.all(Array.from({ length: 34 }, (_, index) => writeFile(path.join(repo, `docs/${String(index).padStart(2, "0")}.txt`), "x".repeat(131_072))));
  const library = new ReferenceLibrary(await discoverReferenceConfiguration({ homeDir: home }));
  cleanup.push(() => library.close());
  const result = await library.search({ query: "absent" });
  expect(result.matches).toEqual([]);
  expect(result.status).toBe("partial");
  expect(result.bytesRead).toBe(4_194_304);
  expect(result.filesSearched).toBe(32);
  expect(result.issues.join("\n")).toContain("Total read limit");
});

test.skipIf(process.platform === "win32")("FIFO configuration and reference entries cannot wait for a writer", async () => {
  const { home, repo, config } = await fixture();
  await rm(config);
  const fifo = Bun.spawn(["mkfifo", config, path.join(repo, "docs/pipe.txt")], { stdout: "ignore", stderr: "pipe" });
  expect(await fifo.exited).toBe(0);
  const child = Bun.spawn([process.execPath, "-e", `
    import { discoverReferenceConfiguration } from ${JSON.stringify(path.resolve("src/references/config.ts"))};
    import { ReferenceLibrary } from ${JSON.stringify(path.resolve("src/references/library.ts"))};
    const discovered = await discoverReferenceConfiguration({ homeDir: ${JSON.stringify(home)} });
    if (discovered.sources.length || !discovered.diagnostics.length) throw new Error("FIFO config accepted");
    const library = new ReferenceLibrary({ sources: [{ id: "fifo", configuration: "fixture", root: ${JSON.stringify(repo)}, paths: ["docs"], useFor: [] }], diagnostics: [] });
    const result = await library.search({ query: "needle" });
    if (result.status !== "partial" || result.matches.length) throw new Error("FIFO reference accepted");
    await library.close();
    console.log("nonblocking rejection");
  `], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 1500);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stdout, stderr, exit, timedOut }).toEqual({ stdout: "nonblocking rejection\n", stderr: "", exit: 0, timedOut: false });
  } finally { clearTimeout(timer); child.kill(); }
});
