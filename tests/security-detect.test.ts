import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectProject, toolNeeds } from "../src/security/detect";
import { gitState } from "../src/security/git";
import { fixtureRepo, gitIn } from "./fixtures/security-tools/setup";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

test("python -> ruff S, workflows -> zizmor, lockfiles -> osv, FastMCP import -> MCP rules, playbook -> ansible-lint; gitleaks always", async () => {
  const root = await fixtureRepo("casper-security-detect-");
  temps.push(root);
  const facts = await detectProject(root, await gitState(root));
  expect(facts).toMatchObject({ python: ["app/server.py"], workflows: [".github/workflows/ci.yml"], lockfiles: ["requirements.txt"], mcpServer: true, fastapi: false, ansible: ["site.yml"] });
  const needs = toolNeeds(facts);
  expect(Object.fromEntries(Object.entries(needs).map(([id, need]) => [id, need.needed]))).toEqual({
    gitleaks: true, ruff: true, semgrep: true, zizmor: true, "osv-scanner": true, "ansible-lint": true, "mcp-scanner": false,
  });
  expect(needs["mcp-scanner"]).toMatchObject({ off: true });
  expect(toolNeeds(facts, { mcpScanner: true })["mcp-scanner"].needed).toBe(true);
});

test("an empty project needs only gitleaks, and says why each other tool is not needed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-security-detect-empty-"));
  temps.push(root);
  await writeFile(path.join(root, "README.md"), "hello\n");
  gitIn(root, "init", "-q");
  const needs = toolNeeds(await detectProject(root, await gitState(root)));
  expect(needs.gitleaks.needed).toBe(true);
  expect(needs["ansible-lint"]).toEqual({ needed: false, reason: "no Ansible files" });
  expect(needs.ruff).toEqual({ needed: false, reason: "no Python files" });
  expect(needs["osv-scanner"].needed).toBe(false);
  expect(needs.zizmor.needed).toBe(false);
});

test("fastapi imports turn on the FastAPI rules; git-ignored and linked-out files are not the project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-security-detect-fastapi-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "casper-security-detect-outside-"));
  temps.push(root, outside);
  await writeFile(path.join(root, "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
  await mkdir(path.join(root, "build"));
  await writeFile(path.join(root, "build", "gen.py"), "import fastmcp\n");
  await writeFile(path.join(root, ".gitignore"), "build/\n");
  await writeFile(path.join(outside, "x.py"), "import fastmcp\n");
  await symlink(outside, path.join(root, "linked"));
  gitIn(root, "init", "-q");
  const facts = await detectProject(root, await gitState(root));
  expect(facts.fastapi).toBe(true);
  expect(facts.mcpServer).toBe(false);
  expect(facts.python).toEqual(["main.py"]);
  expect(toolNeeds(facts).semgrep).toEqual({ needed: true, reason: "FastAPI code" });
  // Outside git: a bounded walk that does not follow the link either.
  const plain = await detectProject(root, { inRepo: false, hasHead: false });
  expect(plain.python).toEqual(["main.py"]);
});
