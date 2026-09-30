import { spawn } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { isRecord } from "../mcp/config";
import { addReferenceSource, ReferenceExistsError, type NewReferenceSource } from "./config";
import { readReferenceFile, referenceText } from "./files";

/**
 * Vendor spec repos that "/references add <name>" can download. Nothing is
 * downloaded without the user typing yes; missing sources never trigger a clone.
 *
 * Layouts of pycentral, pyaoscx, pyclearpass, mistapi and junos-pyez were checked on 2026-09-30
 * ("git clone --filter=blob:none --no-checkout" plus "git ls-tree -r -l"),
 * including the largest file, so maxFileBytes covers every file. The other
 * layouts were written without that check; check them before relying on them.
 */
export interface SpecRepo {
  id: string;
  title: string;
  license: string;
  url: string;
  /** junos-yang needs a release such as 23.4. */
  needsRelease: boolean;
  useFor: string[];
  maxFileBytes?: number;
  /** Extra line printed after adding. */
  tip?: string;
}

export const SPEC_REPOS: readonly SpecRepo[] = [
  {
    id: "mist-openapi", title: "Mist API spec", license: "MIT", url: "https://github.com/mistsys/mist_openapi.git", needsRelease: false,
    useFor: ["Mist API endpoints and fields"],
    tip: "Tip: for exact Mist endpoints and fields, lookup_api in hpe-networking-mcp is faster and complete.",
  },
  {
    id: "junos-yang", title: "Junos YANG models, one release", license: "see repo", url: "https://github.com/Juniper/yang.git",
    needsRelease: true, useFor: ["Junos configuration YANG models"], maxFileBytes: 4 * 1024 * 1024,
  },
  {
    // MIT (LICENSE on the v2 default branch). v2 holds new Central, GreenLake and pycentral/classic.
    // Largest file: pycentral/troubleshooting/troubleshooting.py, about 190 KB.
    id: "pycentral", title: "Aruba Central Python SDK", license: "MIT", url: "https://github.com/aruba/pycentral.git",
    needsRelease: false, useFor: ["Aruba Central API through the Python SDK"], maxFileBytes: 256 * 1024,
  },
  {
    // Apache-2.0 (License.md). REST code for v1, v10.04, v10.08, v10.09 under pyaoscx/rest. Largest file about 85 KB.
    id: "pyaoscx", title: "AOS-CX Python SDK, REST API", license: "Apache-2.0", url: "https://github.com/aruba/pyaoscx.git",
    needsRelease: false, useFor: ["AOS-CX switch REST API through the Python SDK"],
    tip: "Tip: the SDK covers some firmware versions only. Your switch's own REST API reference is the final word for its firmware.",
  },
  {
    // MIT (LICENSE.md). One module per ClearPass API group; largest file about 245 KB.
    id: "pyclearpass", title: "ClearPass Python SDK, REST API", license: "MIT", url: "https://github.com/aruba/pyclearpass.git",
    needsRelease: false, useFor: ["ClearPass REST API through the Python SDK"], maxFileBytes: 512 * 1024,
    tip: "Tip: your ClearPass server's API Explorer is the final word for its version.",
  },
  {
    // MIT (LICENSE). Community Python SDK for the Mist API (PyPI mistapi points here); one module per
    // API group under src/mistapi/api/v1. Largest file: src/mistapi/api/v1/sites/devices.py, about 111 KB.
    id: "mistapi", title: "Mist API Python SDK (community)", license: "MIT", url: "https://github.com/tmunzer/mistapi_python.git",
    needsRelease: false, useFor: ["Mist API calls and parameters through the Python SDK"],
    tip: "Tip: mistapi is a community SDK. For exact Mist endpoints and fields, lookup_api in hpe-networking-mcp is complete.",
  },
  {
    // Apache-2.0 (LICENSE). PyEZ: lib/jnpr/junos holds Device, Config (load, commit_check, commit confirm), tables.
    // Largest file: lib/jnpr/junos/utils/sw.py, about 72 KB.
    id: "junos-pyez", title: "Junos PyEZ Python library", license: "Apache-2.0", url: "https://github.com/Juniper/py-junos-eznc.git",
    needsRelease: false, useFor: ["Junos automation with PyEZ: RPCs, config load and commit, tables"],
  },
];

export const RELEASE_PATTERN = /^\d{2}\.\d$/;

/** "/references add" with no name. */
export function catalogListText(): string {
  const width = Math.max(...SPEC_REPOS.map((entry) => entry.id.length)) + 2;
  return SPEC_REPOS.map((entry) => {
    const detail = entry.needsRelease ? `${entry.title} (needs a release, e.g. 23.4)` : `${entry.title} (${entry.license})`;
    return `${entry.id.padEnd(width)}${detail}`;
  }).join("\n");
}

export interface ReferenceAddPlan {
  entry: SpecRepo;
  /** ID written to references.yaml (junos-yang-23.4 for a release). */
  id: string;
  destination: string;
  /** Each command is argv only; run without a shell. */
  commands: string[][];
  /** What the user sees before saying yes. */
  shown: string[];
  source: NewReferenceSource;
}

export type ReferenceAddRequest = { plan: ReferenceAddPlan } | { error: string };

/** Paths searched inside the clone, and the sparse-checkout patterns that fetch them. */
function layout(entry: SpecRepo, release?: string): { sparse: string[]; cone: boolean; search: string[] } {
  switch (entry.id) {
    case "mist-openapi":
      // mist.openapi.json at the root is one 3.5 MB line: useless for line search, so it is left out.
      return { sparse: ["src"], cone: true, search: ["src"] };
    case "junos-yang":
      // Only the Junos config models and the shared ones for one release, not every platform.
      return { sparse: [`/${release}/*/junos/conf/`, `/${release}/*/common/`], cone: false, search: [release!] };
    case "pyaoscx":
      return { sparse: ["pyaoscx", "docs"], cone: true, search: ["pyaoscx", "docs", "README.md"] };
    case "mistapi":
      return { sparse: ["src/mistapi"], cone: true, search: ["src/mistapi", "README.md"] };
    case "junos-pyez":
      return { sparse: ["lib/jnpr/junos", "docs"], cone: true, search: ["lib/jnpr/junos", "docs", "README.md"] };
    case "pyclearpass":
      // No docs folder; the README has the login and usage examples.
      return { sparse: ["pyclearpass"], cone: true, search: ["pyclearpass", "README.md"] };
    default:
      return { sparse: ["pycentral", "docs"], cone: true, search: ["pycentral", "docs", "README.md"] };
  }
}

/** git with hooks off; the clone never runs repo code. */
const GIT = ["git", "-c", "core.hooksPath=/dev/null"];

export function cloneCommands(entry: SpecRepo, destination: string, release?: string): string[][] {
  const { sparse, cone } = layout(entry, release);
  return [
    [...GIT, "clone", "--depth", "1", "--filter=blob:none", "--sparse", entry.url, destination],
    [...GIT, "-C", destination, "sparse-checkout", "set", ...(cone ? [] : ["--no-cone"]), ...sparse],
  ];
}

function shownCommand(argv: string[], home: string): string {
  // The exact argv that runs, so what the user approves is what happens.
  return argv.map((part) => {
    const tilde = part === home || part.startsWith(home + path.sep) ? `~${part.slice(home.length)}` : part;
    return /[\s"'$`\\*]/.test(tilde) && !tilde.startsWith("~") ? `'${tilde.replaceAll("'", "'\\''")}'` : tilde;
  }).join(" ");
}

/** Plan "/references add <name> [release]". Returns plain usage text when the request is wrong. */
export function planReferenceAdd(name: string, release: string | undefined, home: string): ReferenceAddRequest {
  const entry = SPEC_REPOS.find((candidate) => candidate.id === name);
  if (!entry) return { error: `Unknown name: ${name}. Choose one of:\n${catalogListText()}` };
  if (entry.needsRelease && (!release || !RELEASE_PATTERN.test(release))) {
    return { error: `Usage: /references add ${entry.id} <release>, for example 23.4` };
  }
  if (!entry.needsRelease && release) return { error: `Usage: /references add ${entry.id}` };
  const id = entry.needsRelease ? `${entry.id}-${release}` : entry.id;
  const destination = path.join(home, ".casper", "reference-repos", id);
  const commands = cloneCommands(entry, destination, release);
  const { search } = layout(entry, release);
  const source: NewReferenceSource = {
    path: `~/.casper/reference-repos/${id}`, paths: search, useFor: [...entry.useFor],
    ...(entry.maxFileBytes ? { maxFileBytes: entry.maxFileBytes } : {}),
  };
  return { plan: { entry, id, destination, commands, shown: commands.map((argv) => `Will run: ${shownCommand(argv, home)}`), source } };
}

export const REFERENCE_ADD_PROMPT = "Download now? Type yes: ";
export const referenceAddedText = (id: string) => `Added ${id} to ~/.casper/references.yaml. Restart Casper to search it.`;
export const REFERENCE_DOWNLOADING_TEXT = "Downloading (up to 5 minutes; Ctrl+C stops it)...";

export const referenceDownloadFailedText = (code: number | null) =>
  `Download failed (git exit ${code ?? "unknown"}). Nothing was added.`;

export interface ReferenceAddHost {
  print(line: string): void;
  confirmExact(prompt: string): Promise<boolean>;
  /** argv only, never a shell. */
  runGit(argv: string[]): Promise<{ code: number | null }>;
}

async function alreadyListed(home: string, id: string): Promise<boolean> {
  try {
    const document: unknown = parse(referenceText(await readReferenceFile(path.join(home, ".casper", "references.yaml"), 65_536)), { maxAliasCount: 0 });
    return isRecord(document) && isRecord(document.references) && Object.hasOwn(document.references, id);
  } catch { return false; }
}

/**
 * "/references add <name> [release]": show the exact commands, download only
 * after the user types yes, then add the entry to ~/.casper/references.yaml.
 */
export async function runReferenceAdd(name: string | undefined, release: string | undefined, home: string, host: ReferenceAddHost): Promise<boolean> {
  if (!name) { host.print(catalogListText()); return false; }
  const request = planReferenceAdd(name, release, home);
  if ("error" in request) { host.print(request.error); return false; }
  const { plan } = request;
  if (await alreadyListed(home, plan.id)) { host.print(new ReferenceExistsError(plan.id).message); return false; }
  if (await lstat(plan.destination).then(() => true, () => false)) {
    host.print(`~/.casper/reference-repos/${plan.id} already exists. Remove it first or add it to ~/.casper/references.yaml yourself. Nothing changed.`);
    return false;
  }
  for (const line of plan.shown) host.print(line);
  if (!(await host.confirmExact(REFERENCE_ADD_PROMPT))) { host.print("Nothing downloaded."); return false; }
  // git prints nothing here and may take minutes: say it started and how to stop it.
  host.print(REFERENCE_DOWNLOADING_TEXT);
  for (const argv of plan.commands) {
    const { code } = await host.runGit(argv).catch(() => ({ code: null }));
    if (code !== 0) {
      await rm(plan.destination, { recursive: true, force: true }).catch(() => {});
      host.print(referenceDownloadFailedText(code));
      return false;
    }
  }
  try { await addReferenceSource(home, plan.id, plan.source); }
  catch (error) {
    host.print(error instanceof Error ? error.message : "Could not update ~/.casper/references.yaml. Nothing was added.");
    return false;
  }
  host.print(referenceAddedText(plan.id));
  if (plan.entry.tip) host.print(plan.entry.tip);
  return true;
}

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Runs the download commands by argv (no shell) with prompts off and a 5 minute limit. */
export function defaultRunGit(argv: string[], signal?: AbortSignal): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    if (command !== "git") { resolve({ code: null }); return; }
    const child = spawn(command, args, { shell: false, stdio: "ignore", windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } });
    const timer = setTimeout(() => child.kill("SIGKILL"), DOWNLOAD_TIMEOUT_MS);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve({ code }); };
    child.once("error", () => done(null));
    child.once("close", (code) => done(code));
  });
}
