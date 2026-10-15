/**
 * Splits the suite `bun run test` runs into two tiers, so a pull request can run the part that does not depend
 * on the OS everywhere and leave the rest to Linux, main and the nightly run:
 *
 * - heavy: a file that starts real processes or services (Bun or a shell child, git, a PTY or ConPTY, the
 *   browser, a language or MCP server, the sandbox), itself or through a tests/support helper it imports, or
 *   one whose time in tests/timings.json is above HEAVY_MS.
 * - fast: every other suite file.
 *
 * `decide` picks what a CI run on macOS or Windows runs: the whole suite ("full") for every push, schedule and
 * manual run, and for a pull request that changes a path where OS behaviour matters; otherwise only "fast".
 *
 *   bun tools/test-tier.ts fast|heavy              prints that tier's files, one per line
 *   bun tools/test-tier.ts sizes                   prints each tier's file count and summed time
 *   bun tools/test-tier.ts decide <event> < paths  prints "full" or "fast", then why (Markdown), for the
 *                                                  changed paths on stdin (one per line)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { suiteFiles } from "./test-shard";
import { terminalReason } from "./test-terminal";

/** Above 5 s in tests/timings.json: about 110 of the timed files, which hold 98% of the suite's time. */
export const HEAVY_MS = 5_000;

/** What starting a real process or service looks like in a test or helper. */
export const STARTS_PROCESSES: readonly RegExp[] = [
  /\bBun\.spawn(?:Sync)?\b/, /\bspawnSync\b/, /\bexecFile(?:Sync)?\b/, /\bexecSync\b/, /\bchild_process\b/,
  /\bnode-pty\b/, /\bConptySession\b/, /\bpuppeteer/, /\bpyright\b/i, /\btypescript-language-server\b/,
  /\bStdioClientTransport\b/, /\bsandbox-exec\b/, /\bbwrap\b/, /\bdebugpy\b/,
  // Through Casper's own code: Bun itself as the command of an MCP server, language server, service or check,
  // and a configured check run for real (src/verify/command, or a tests/support/check-command fixture).
  /\bprocess\.execPath\b/, /\brunCommandCheck\b/, /\bcheckCommand\b/,
  // A fake program written as a shell script and run for real, a host tool found to be run, the real browser.
  /#!\/bin\/(?:ba)?sh\b/, /\bBun\.which\b/, /\bCASPER_BROWSER_EXECUTABLE\b/,
];

/**
 * Helpers that start a process only to probe the host once when imported (can this host make symlinks, run the
 * sandbox, verify an SSH signature), not as the test's work. Importing one does not make a file heavy.
 */
export const PROBE_ONLY_HELPERS = new Set(["tests/support/platform.ts", "tests/support/release-signing.ts", "tests/support/preload.ts"]);

/**
 * Pull request paths where OS behaviour matters: a change here runs the heavy tier on macOS and Windows too.
 * Prefixes end in "/"; "*" matches within one path segment. Besides these, `decide` counts any changed src
 * file that starts processes or checks the OS, and any changed heavy test file.
 */
export const OS_PATHS: readonly string[] = [
  "src/platform/", "src/runtime/", "src/browser/", "src/sandbox/", "src/services/", "src/workspace/", "src/verify/",
  "src/crew/", "src/agents/", "src/tui/", "src/lsp/", "src/mcp/", "src/debug/", "src/update/", "src/app/*terminal*",
  "src/cli.ts", "src/cli-main.ts", "src/standalone.ts",
  "tools/", "scripts/", ".github/", "tests/support/", "tests/fixtures/",
  "package.json", "bun.lock", "bunfig.toml", "tsconfig.json",
];

/** A src file that starts processes or branches on the OS. */
const OS_SOURCE = [...STARTS_PROCESSES, /\bprocess\.platform\b/, /["']win32["']/, /["']darwin["']/];

const read = (file: string): string | undefined => { try { return readFileSync(file, "utf8"); } catch { return undefined; } };

/** The tests/support helpers a file imports (static, side-effect or dynamic import), as repo paths. */
export function importedHelpers(source: string, prefix = "./support/"): string[] {
  const found = new Set<string>();
  const escaped = prefix.replace(/[.]/g, "\\.");
  const pattern = new RegExp(`(?:\\bfrom\\s+|\\bimport\\s*\\(\\s*|\\bimport\\s+)["']${escaped}([\\w.-]+?)(?:\\.ts)?["']`, "g");
  for (const [, name] of source.matchAll(pattern)) found.add(`tests/support/${name}.ts`);
  return [...found].sort();
}

/** The helpers a test imports, and the helpers those import in turn. */
function helpersOf(source: string, helper: (file: string) => string | undefined): string[] {
  const seen = new Set<string>();
  const queue = importedHelpers(source);
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    // A probe-only helper is skipped along with what it imports.
    if (PROBE_ONLY_HELPERS.has(name)) continue;
    queue.push(...importedHelpers(helper(name) ?? "", "./"));
  }
  return [...seen].sort();
}

/** Why a file is heavy, or undefined when it is fast. */
export function heavyReason(file: string, source: string, timings: Readonly<Record<string, number>>, helper: (file: string) => string | undefined = read): string | undefined {
  const own = STARTS_PROCESSES.find((pattern) => pattern.test(source));
  if (own) return `starts processes (${own.source})`;
  for (const name of helpersOf(source, helper)) {
    if (PROBE_ONLY_HELPERS.has(name)) continue;
    const text = helper(name);
    if (text !== undefined && STARTS_PROCESSES.some((pattern) => pattern.test(text))) return `starts processes through ${name}`;
  }
  const terminal = terminalReason(file, source, helper);
  if (terminal) return `real terminal (${terminal})`;
  const time = timings[file];
  if (typeof time === "number" && time > HEAVY_MS) return `takes ${(time / 1000).toFixed(1)} s`;
  return undefined;
}

export function loadTimings(file = "tests/timings.json"): Record<string, number> {
  try { return (JSON.parse(readFileSync(file, "utf8")) as { files?: Record<string, number> }).files ?? {}; } catch { return {}; }
}

export interface Tiers { fast: string[]; heavy: string[]; reasons: Record<string, string> }

export async function tiers(root = "tests", timings = loadTimings(path.join(root, "timings.json"))): Promise<Tiers> {
  const result: Tiers = { fast: [], heavy: [], reasons: {} };
  for (const file of await suiteFiles(root)) {
    const reason = heavyReason(file, read(file) ?? "", timings);
    if (reason) { result.heavy.push(file); result.reasons[file] = reason; } else result.fast.push(file);
  }
  return result;
}

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);

/** Why a changed path makes OS behaviour matter, or undefined. */
export function osReason(changed: string, heavy: ReadonlySet<string>, source: (file: string) => string | undefined = read): string | undefined {
  for (const entry of OS_PATHS) {
    if (entry.endsWith("/") ? changed.startsWith(entry) : glob(entry).test(changed)) return `\`${changed}\` is under \`${entry}\``;
  }
  if (heavy.has(changed)) return `\`${changed}\` is a heavy test`;
  if (/^src\/.*\.tsx?$/.test(changed)) {
    const text = source(changed);
    // A deleted src file cannot be read: count it, to be safe.
    if (text === undefined) return `\`${changed}\` was removed`;
    if (OS_SOURCE.some((pattern) => pattern.test(text))) return `\`${changed}\` starts processes or checks the OS`;
  }
  return undefined;
}

export interface Decision { tier: "full" | "fast"; why: string[] }

export function decide(event: string, changed: readonly string[], heavy: ReadonlySet<string>, source?: (file: string) => string | undefined): Decision {
  if (event !== "pull_request") return { tier: "full", why: [`A \`${event || "unknown"}\` run tests everything on every OS.`] };
  const paths = changed.map((line) => line.trim()).filter(Boolean);
  if (paths.length === 0) return { tier: "full", why: ["No changed paths could be listed, so everything runs."] };
  const reasons = paths.map((file) => osReason(file, heavy, source)).filter((reason): reason is string => reason !== undefined);
  if (reasons.length) return { tier: "full", why: ["This pull request changes paths where OS behaviour matters:", ...reasons.slice(0, 20).map((reason) => `- ${reason}`), ...(reasons.length > 20 ? [`- and ${reasons.length - 20} more`] : [])] };
  return { tier: "fast", why: [`None of the ${paths.length} changed paths touches OS behaviour, so only the fast tier runs here. Linux runs everything; main and the nightly run test everything on every OS.`] };
}

if (import.meta.main) {
  const [command, event] = process.argv.slice(2);
  const timings = loadTimings();
  const split = await tiers("tests", timings);
  const seconds = (files: string[]) => (files.reduce((sum, file) => sum + (timings[file] ?? 0), 0) / 1000).toFixed(0);
  if (command === "fast" || command === "heavy") {
    for (const file of split[command]) console.log(file);
  } else if (command === "sizes") {
    console.log(`fast: ${split.fast.length} files, ${seconds(split.fast)} s summed`);
    console.log(`heavy: ${split.heavy.length} files, ${seconds(split.heavy)} s summed`);
  } else if (command === "decide") {
    const changed = event === "pull_request" ? (await Bun.stdin.text()).split("\n") : [];
    const { tier, why } = decide(event ?? "", changed, new Set(split.heavy));
    const ran = tier === "full" ? `the whole suite (${split.fast.length + split.heavy.length} files)` : `the fast tier (${split.fast.length} of ${split.fast.length + split.heavy.length} files)`;
    console.log(tier);
    console.log(`### Tests: ${ran}\n\n${why.join("\n")}`);
  } else {
    console.error("usage: bun tools/test-tier.ts fast|heavy|sizes|decide <event> < changed-paths");
    process.exit(2);
  }
}
