import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { loadConfiguration } from "../src/config/load";
import { findExampleConfigs, reviewExampleConfigs } from "../src/mcp/check/examples";
import { findRepoCommands, SAFETY_TEST_NAME } from "../src/mcp/check/repo";
import { allTemplates, getTemplate, renderFiles, renderValues, type RenderedFile } from "../src/new/templates";

/** What each template's files promise, checked offline without running uv or bun. */

let scratch: string | undefined;
afterEach(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = undefined; });

function render(id: string, name = "demo-proj"): RenderedFile[] {
  return renderFiles(getTemplate(id)!, renderValues(name));
}

async function writeOut(files: RenderedFile[]): Promise<string> {
  scratch = await mkdtemp(path.join(os.tmpdir(), "casper-template-"));
  const root = path.join(scratch, "demo-proj");
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.text);
  }
  return root;
}

const text = (files: RenderedFile[], file: string) => files.find((entry) => entry.path === file)?.text ?? "";

test("every template renders with no placeholder left and no secret-looking value", () => {
  for (const template of allTemplates()) {
    for (const file of render(template.id)) {
      expect(`${template.id}/${file.path}: ${/\{\{(name|module|env|year)\}\}/.test(file.text)}`).toBe(`${template.id}/${file.path}: false`);
      expect(file.text).not.toMatch(/\b(sk-[\w-]{12,}|gh[pousr]_\w{12,}|AKIA[A-Z0-9]{16})\b/);
      expect(file.text).not.toMatch(/(TOKEN|PASSWORD)"\s*:\s*"(?!\$\{)[^"]{6,}"/);
    }
    expect(render(template.id).some((file) => file.path === "README.md")).toBe(true);
  }
});

test("network-mcp: the example configs pass Casper's own MCP example check", async () => {
  const root = await writeOut(render("network-mcp"));
  const examples = await findExampleConfigs(root);
  expect(examples.map((example) => example.file).sort()).toEqual([".mcp.json.example", "examples/mcp.json"]);
  const findings = reviewExampleConfigs(examples);
  expect(findings.map((finding) => `${finding.status} ${finding.label}: ${finding.text}`)).toEqual([
    "ok .mcp.json.example: keeps writes off",
    "ok examples/mcp.json: keeps writes off",
  ]);
});

test("network-mcp: Casper finds the safety test, and it fails a tool without readOnlyHint or destructiveHint", async () => {
  const files = render("network-mcp");
  const root = await writeOut(files);
  const repo = await findRepoCommands(root);
  expect(repo.testFiles).toContain("tests/test_read_only_labels.py");
  expect(SAFETY_TEST_NAME.test("test_read_only_labels.py")).toBe(true);
  const labels = text(files, "tests/test_read_only_labels.py");
  expect(labels).toContain("tool.annotations.read_only_hint is None and tool.annotations.destructive_hint is None");
  // Every tool in the server is registered with labels.
  const server = text(files, "src/demo_proj/server.py");
  const tools = server.match(/@server\.tool\([^)]*\)/g) ?? [];
  expect(tools.length).toBeGreaterThan(0);
  for (const tool of tools) expect(tool).toContain("annotations=");
  expect(server).toContain("from mcp.server.mcpserver import MCPServer");
  expect(server).toContain('"contract": ACCESS_CONTRACT');
});

test("mist-python: recorded answers are sample data, replay-only, and never keep the token", () => {
  const files = render("mist-python");
  const cassettes = files.filter((file) => file.path.startsWith("tests/cassettes/"));
  expect(cassettes.length).toBeGreaterThan(0);
  for (const cassette of cassettes) {
    expect(cassette.text).toStartWith("# Sample data, not from your org. Record your own with:\n#   uv run pytest --record-mode=once   (uses a read-only token)");
    expect(cassette.text).not.toMatch(/^\s*authorization:/im);
  }
  expect(text(files, "pyproject.toml")).toContain('addopts = "--record-mode=none"');
  expect(text(files, "tests/conftest.py")).toContain('"filter_headers": ["authorization"]');
  expect(text(files, "README.md")).toContain("sample data, not from your org");
});

test("web-app and noc-dashboard: .casper/project.yaml declares a service Casper accepts", async () => {
  for (const [id, service] of [["web-app", "web"], ["noc-dashboard", "dashboard"]] as const) {
    const root = await writeOut(render(id));
    const home = path.join(scratch!, "home");
    await mkdir(home);
    const loaded = await loadConfiguration({ projectRoot: root, homeDir: home });
    expect(Object.keys(loaded.services)).toEqual([service]);
    expect(loaded.services[service]!.port).toBe("auto");
    await rm(scratch!, { recursive: true, force: true });
  }
});

test("ansible templates: lab inventory only, show-only command lists, and render-only checks", () => {
  for (const id of ["aoscx-ansible", "junos-ansible"]) {
    const files = render(id);
    expect(files.filter((file) => file.path.startsWith("inventory/")).map((file) => file.path)).toEqual(["inventory/lab.yml"]);
    expect(text(files, "ansible.cfg")).toContain("inventory = inventory/lab.yml");
    for (const playbook of files.filter((file) => file.path.startsWith("playbooks/"))) {
      for (const play of parse(playbook.text) as Array<{ tasks: Array<Record<string, { commands?: string[] }>> }>) {
        for (const task of play.tasks) {
          for (const [module, args] of Object.entries(task)) {
            if (!module.endsWith("_command")) continue;
            for (const command of args.commands ?? []) expect(`${id} ${command}`).toStartWith(`${id} show `);
          }
        }
      }
    }
  }
  const render_ = text(render("junos-ansible"), "checks/render.yml");
  expect(render_).toContain("state: rendered");
  expect(render_).not.toMatch(/state: (merged|replaced|overridden|deleted)/);
});

test("the templates never say verified or secure", () => {
  for (const template of allTemplates()) {
    for (const file of render(template.id)) {
      expect(`${template.id}/${file.path}: ${/\bverified\b|\bsecure\b/i.test(file.text)}`).toBe(`${template.id}/${file.path}: false`);
    }
  }
});
