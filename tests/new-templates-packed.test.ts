import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GENERATED_FILE, readTemplate, readTemplates, renderGenerated } from "../scripts/pack-templates";
import { getTemplate, renderFiles, renderValues, targetPath } from "../src/new/templates";
import { needsSymlinks } from "./support/platform";

let scratch: string | undefined;
afterEach(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = undefined; });

const manifest = (id: string) => JSON.stringify({
  id, version: 1, kind: "thing", title: "Thing", description: "A thing.", defaultName: "my-thing",
  tool: "uv", init: ["uv", "init"], add: [], addDev: [], replace: [], ready: true,
});

async function fixture(id: string, files: Record<string, string>): Promise<string> {
  scratch = await mkdtemp(path.join(os.tmpdir(), "casper-pack-"));
  const root = path.join(scratch, id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "template.json"), manifest(id));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return scratch;
}

test("src/new/templates.generated.ts matches templates/ (run bun run scripts/pack-templates.ts)", async () => {
  expect(await readFile(GENERATED_FILE, "utf8")).toBe(renderGenerated(await readTemplates()));
});

test("packing is deterministic", async () => {
  const templates = await readTemplates();
  expect(renderGenerated([...templates].reverse())).toBe(renderGenerated(templates));
});

test("a template file that is a dotfile is refused: it would act as this repo's own", async () => {
  const dir = await fixture("dots", { ".gitignore": "x\n" });
  await expect(readTemplate(dir, "dots")).rejects.toThrow("name it dot.gitignore");
});

needsSymlinks("a symlinked template file is refused", async () => {
  const dir = await fixture("links", {});
  await symlink("/etc/hostname", path.join(dir, "links", "stolen.txt"));
  await expect(readTemplate(dir, "links")).rejects.toThrow("is a symlink");
});

test("replace must name a real template file, and the id must match the folder", async () => {
  const dir = await fixture("wrong", {});
  await writeFile(path.join(dir, "wrong", "template.json"), manifest("other"));
  await expect(readTemplate(dir, "wrong")).rejects.toThrow('id must be "wrong"');
});

test("path rules: __module__, dot. and .append", () => {
  const values = renderValues("mist-aps", new Date("2026-01-01"));
  expect(targetPath("src/__module__/cli.py", values)).toEqual({ path: "src/mist_aps/cli.py", append: false });
  expect(targetPath("dot.gitignore", values)).toEqual({ path: ".gitignore", append: false });
  expect(targetPath("dot.casper/project.yaml", values)).toEqual({ path: ".casper/project.yaml", append: false });
  expect(targetPath("pyproject.toml.append", values)).toEqual({ path: "pyproject.toml", append: true });
});

test("rendering fills Casper's placeholders and leaves Jinja alone", () => {
  const values = renderValues("junos-lab");
  const files = renderFiles(getTemplate("junos-ansible")!, values);
  const inventory = files.find((file) => file.path === "inventory/lab.yml")!.text;
  expect(inventory).toContain("{{ lookup('env', 'JUNOS_PASSWORD') }}");
  const readme = files.find((file) => file.path === "README.md")!.text;
  expect(readme.startsWith("# junos-lab\n")).toBe(true);
});
