import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { gitFiles, type GitState } from "./git";
import type { SecurityToolId } from "./types";

/**
 * Which tools this project needs, from its own files: `git ls-files` (tracked plus untracked, ignored
 * files left out), or a bounded walk outside git. Reads only the first part of Python files, to spot
 * MCP and FastAPI imports.
 */

export interface ProjectFacts {
  files: string[];
  /** The file list stopped early (very large folder outside git). */
  truncated: boolean;
  python: string[];
  workflows: string[];
  lockfiles: string[];
  mcpServer: boolean;
  fastapi: boolean;
  ansible: string[];
}

export interface ToolNeed { needed: boolean; reason: string; /** An opt-in tool the user has not turned on. */ off?: boolean }

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".nox", ".mypy_cache", ".ruff_cache", ".pytest_cache", "dist", "build", ".next", ".cache"]);
const WALK_LIMIT = 20_000;
const WALK_DEPTH = 12;
const HEAD_BYTES = 64 * 1024;
const LOCKFILE = /(^|\/)(uv\.lock|poetry\.lock|Pipfile\.lock|pdm\.lock|requirements[\w.-]*\.txt|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/;
const WORKFLOW = /^(\.github\/workflows\/[^/]+\.ya?ml|(.*\/)?action\.ya?ml)$/;
const ANSIBLE_HINT = /(^|\/)(ansible\.cfg|galaxy\.yml|requirements\.ya?ml)$|(^|\/)(roles|playbooks|group_vars|host_vars)\//;
const PLAY_TOP = /^-\s+(hosts|import_playbook|ansible\.builtin\.import_playbook)\s*:/m;
const MCP_IMPORT = /^\s*(from\s+(fastmcp|mcp\.server)[\w.]*\s+import|import\s+(fastmcp|mcp\.server))/m;
const FASTAPI_IMPORT = /^\s*(from\s+fastapi[\w.]*\s+import|import\s+fastapi)\b/m;

async function walk(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (files.length >= WALK_LIMIT) { truncated = true; return; }
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      // Links are not followed: a link out of the project is not the project.
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < WALK_DEPTH) await visit(child, depth + 1);
        else if (depth >= WALK_DEPTH) truncated = true;
      } else if (entry.isFile()) {
        files.push(child);
        if (files.length >= WALK_LIMIT) { truncated = true; return; }
      }
    }
  };
  await visit("", 0);
  return { files, truncated };
}

/** The first part of a regular file (never a link or a device). */
export async function readHead(root: string, relative: string, bytes = HEAD_BYTES): Promise<string> {
  const full = path.join(root, relative);
  try {
    const details = await lstat(full);
    if (!details.isFile()) return "";
    const handle = await open(full, "r");
    try {
      const buffer = Buffer.alloc(Math.min(bytes, details.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
  } catch { return ""; }
}

export async function detectProject(root: string, git: GitState): Promise<ProjectFacts> {
  const listed = git.inRepo ? await gitFiles(root) : undefined;
  const { files, truncated } = listed ? { files: listed, truncated: false } : await walk(root);
  const python = files.filter((file) => /\.pyi?$/.test(file) && !file.split("/").some((part) => SKIP_DIRS.has(part)));
  const workflows = files.filter((file) => WORKFLOW.test(file));
  const lockfiles = files.filter((file) => LOCKFILE.test(file) && !file.split("/").some((part) => SKIP_DIRS.has(part)));
  let mcpServer = false;
  let fastapi = false;
  for (const file of python.slice(0, 2000)) {
    if (mcpServer && fastapi) break;
    const head = await readHead(root, file);
    mcpServer ||= MCP_IMPORT.test(head);
    fastapi ||= FASTAPI_IMPORT.test(head);
  }
  const ansible: string[] = [];
  const yamlFiles = files.filter((file) => /\.ya?ml$/.test(file) && !WORKFLOW.test(file) && !file.startsWith(".github/"));
  const hinted = files.some((file) => ANSIBLE_HINT.test(file));
  for (const file of yamlFiles.slice(0, 2000)) {
    if (ansible.length >= 200) break;
    if (/(^|\/)(roles|group_vars|host_vars)\//.test(file)) continue;
    if (PLAY_TOP.test(await readHead(root, file, 16 * 1024))) ansible.push(file);
  }
  if (!ansible.length && hinted && files.some((file) => /(^|\/)roles\/[^/]+\/tasks\/main\.ya?ml$/.test(file))) ansible.push(".");
  return { files, truncated, python, workflows, lockfiles, mcpServer, fastapi, ansible };
}

export interface NeedOptions {
  /** mcp-scanner is opt-in: a large install that must be turned on. */
  mcpScanner?: boolean;
  /** The server's tools/list JSON (from `casper mcp check`). */
  mcpToolsJson?: string;
}

/** Which tools apply to this project, each with a plain reason for the report. */
export function toolNeeds(facts: ProjectFacts, options: NeedOptions = {}): Record<SecurityToolId, ToolNeed> {
  return {
    gitleaks: { needed: true, reason: "always runs" },
    ruff: facts.python.length ? { needed: true, reason: `${facts.python.length} Python file${facts.python.length === 1 ? "" : "s"}` } : { needed: false, reason: "no Python files" },
    semgrep: facts.mcpServer || facts.fastapi
      ? { needed: true, reason: [facts.mcpServer ? "MCP server code" : "", facts.fastapi ? "FastAPI code" : ""].filter(Boolean).join(" and ") }
      : { needed: false, reason: "no MCP server or FastAPI code" },
    zizmor: facts.workflows.length ? { needed: true, reason: "GitHub workflows" } : { needed: false, reason: "no GitHub workflows" },
    "osv-scanner": facts.lockfiles.length ? { needed: true, reason: "dependency lock files" } : { needed: false, reason: "no dependency lock files" },
    "ansible-lint": facts.ansible.length ? { needed: true, reason: "Ansible playbooks" } : { needed: false, reason: "no Ansible files" },
    "mcp-scanner": !facts.mcpServer && !options.mcpToolsJson ? { needed: false, reason: "no MCP server" }
      : !options.mcpScanner ? { needed: false, reason: "off; casper security --mcp-tools <file> checks the tool descriptions (large install)", off: true }
      : { needed: true, reason: "MCP server tool descriptions" },
  };
}
