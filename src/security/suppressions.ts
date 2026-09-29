import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { projectStateDirectory } from "../project/model";
import { headText, inHead, linesChangedSinceHead, type GitState } from "./git";
import type { IgnoreEntry, IgnoreFile, IgnoreMarker, IgnoreStatus, SecurityFinding, SecurityToolId } from "./types";

/**
 * Only the user can add a suppression. Every tool runs with its own inline ignores turned off, then
 * Casper hides a finding only when an ignore marker on the same statement was committed (the line reads
 * the same in HEAD) or the user approved it through a numbered choice. Approvals live outside the repo,
 * in ~/.casper/projects/<project>/security-approved.json, and are written only from the user's answer.
 * Until the shell sandbox ships this is best effort: a program with shell access can still edit that file.
 */

// ---------------------------------------------------------------------------------------------------------
// Markers

const PYTHON_FILE = /\.pyi?$/i;
const YAML_FILE = /\.ya?ml$/i;

/** Every marker on one line. A line can carry more than one (`# noqa: S608  # nosec B608`). */
export function markersOnLine(file: string, line: number, text: string): IgnoreMarker[] {
  const found: IgnoreMarker[] = [];
  const add = (tool: SecurityToolId, marker: string, codes: string[]) => found.push({ tool, file, line, marker: marker.trim(), codes });
  if (/gitleaks:allow\b/i.test(text)) add("gitleaks", "gitleaks:allow", []);
  if (PYTHON_FILE.test(file)) {
    // Bandit's `# nosec`, `# nosec B608`, `# nosec: B608, B105`. Ruff S uses bandit's numbers (B608 -> S608).
    const nosec = /#\s*nosec\b((?:[\s:,]*B\d{3})*)/i.exec(text);
    if (nosec) add("ruff", nosec[0], [...nosec[1]!.matchAll(/B(\d{3})/gi)].map((match) => `S${match[1]}`));
    // `# noqa` (every rule) or `# noqa: S608, E501` (only the S codes matter here).
    const noqa = /#\s*noqa\b(?::\s*([A-Z]+\d+(?:[\s,]+[A-Z]+\d+)*))?/i.exec(text);
    if (noqa) {
      const codes = noqa[1] ? noqa[1].split(/[\s,]+/).filter(Boolean).map((code) => code.toUpperCase()) : [];
      if (!codes.length || codes.some((code) => /^S\d{3}$/.test(code))) add("ruff", noqa[0], codes.filter((code) => /^S\d{3}$/.test(code)));
    }
  }
  // Semgrep: `# nosemgrep`, `# nosem`, `// nosemgrep: rule.id, other`.
  const nosem = /\bnosem(?:grep)?\b(?::\s*([\w.-]+(?:\s*,\s*[\w.-]+)*))?/i.exec(text);
  if (nosem && /(#|\/\/|--|\/\*)\s*nosem/i.test(text)) add("semgrep", nosem[0], nosem[1] ? nosem[1].split(/\s*,\s*/).filter(Boolean) : []);
  if (YAML_FILE.test(file)) {
    const zizmor = /#\s*zizmor:\s*ignore\[([^\]]*)\]/i.exec(text);
    if (zizmor) add("zizmor", zizmor[0], zizmor[1]!.split(/\s*,\s*/).filter(Boolean));
    // ansible-lint: `# noqa: rule` or `# noqa rule1 rule2` in YAML.
    const noqa = /#\s*noqa\b:?\s*([\w\[\]-]+(?:[\s,]+[\w\[\]-]+)*)?/i.exec(text);
    if (noqa) add("ansible-lint", noqa[0], noqa[1] ? noqa[1].split(/[\s,]+/).filter(Boolean) : []);
  }
  return found;
}

export function markersInText(file: string, text: string): IgnoreMarker[] {
  const lines = text.split(/\r?\n/);
  return lines.flatMap((line, index) => (line.length > 4000 ? [] : markersOnLine(file, index + 1, line)));
}

/** Whether a marker speaks to this finding: same tool and a matching rule (or no rule named). */
export function markerCovers(marker: IgnoreMarker, finding: SecurityFinding): boolean {
  if (marker.tool !== finding.tool) return false;
  if (!marker.codes.length) return true;
  const rule = finding.rule.toLowerCase();
  return marker.codes.some((code) => {
    const wanted = code.toLowerCase();
    return rule === wanted || rule.endsWith(`.${wanted}`) || (finding.tool === "ansible-lint" && rule.replace(/\[.*$/, "") === wanted);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Statement ranges

/**
 * For each 1-based line of a Python file, the first and last line of the logical statement it belongs
 * to. Ruff reports a multi-line call on its first line while bandit's `# nosec` often sits on the
 * last one (e.g. ruff at :725, nosec at :727), so an ignore counts anywhere on the statement.
 */
export function pythonStatementRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let line = 1;
  let statementStart = 1;
  let quote: string | undefined;
  let continued = false;
  const close = (end: number) => { for (let at = statementStart; at <= end; at++) ranges[at] = [statementStart, end]; statementStart = end + 1; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") { if (text[index + 1] === "\n") line++; index++; continue; }
      if (char === "\n") {
        line++;
        // An unterminated one-line string ends at the newline (a syntax error; do not swallow the file).
        if (quote.length === 1) { quote = undefined; if (depth === 0) close(line - 1); }
        continue;
      }
      if (text.startsWith(quote, index)) { index += quote.length - 1; quote = undefined; }
      continue;
    }
    if (char === "#") {
      const end = text.indexOf("\n", index);
      index = (end === -1 ? text.length : end) - 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = text.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      index += quote.length - 1;
      continue;
    }
    if (char === "\\" && text[index + 1] === "\n") { continued = true; continue; }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === "\n") {
      if (depth === 0 && !continued) close(line);
      continued = false;
      line++;
    }
  }
  close(line);
  return ranges;
}

/** The lines on which an ignore for this finding may sit. */
export function findingLines(finding: SecurityFinding, text: string | undefined, ranges?: Array<[number, number]>): [number, number] {
  let start = finding.line;
  let end = Math.max(finding.endLine ?? start, start);
  if (text !== undefined && PYTHON_FILE.test(finding.file)) {
    const table = ranges ?? pythonStatementRanges(text);
    start = Math.min(start, table[start]?.[0] ?? start);
    end = Math.max(end, table[end]?.[1] ?? end);
  }
  // Semgrep also honours a `# nosemgrep` on the line just above.
  if (finding.tool === "semgrep") start = Math.max(1, start - 1);
  return [start, end];
}

// ---------------------------------------------------------------------------------------------------------
// Approvals (outside the repo)

export interface ApprovalStore {
  version: 1;
  /** Approved inline markers, keyed by file and a hash of the line's text. */
  markers: Array<{ file: string; lineHash: string; marker: string; approvedAt: string }>;
  /** Approved ignore files, keyed by file and a hash of its content. */
  files: Array<{ file: string; contentHash: string; approvedAt: string }>;
}

export function approvalsPath(root: string, homeDir: string): string {
  return path.join(projectStateDirectory(root, homeDir), "security-approved.json");
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const lineHash = (file: string, lineText: string): string => sha256(`${file}\0${lineText.trim()}`);

export async function loadApprovals(root: string, homeDir: string): Promise<ApprovalStore> {
  try {
    const value = JSON.parse(await readFile(approvalsPath(root, homeDir), "utf8")) as Partial<ApprovalStore>;
    if (value.version === 1) {
      return {
        version: 1,
        markers: Array.isArray(value.markers) ? value.markers.filter((item) => typeof item?.file === "string" && typeof item.lineHash === "string") : [],
        files: Array.isArray(value.files) ? value.files.filter((item) => typeof item?.file === "string" && typeof item.contentHash === "string") : [],
      };
    }
  } catch { /* none yet, or unreadable: nothing is approved */ }
  return { version: 1, markers: [], files: [] };
}

async function saveApprovals(root: string, homeDir: string, store: ApprovalStore): Promise<string> {
  const target = approvalsPath(root, homeDir);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return target;
}

/**
 * Records the user's "1 Keep it (I approve)" for one marker. The host calls this only with the user's
 * own answer to a numbered question; no model tool reaches it. Returns the file it wrote.
 */
export async function approveIgnore(root: string, homeDir: string, marker: IgnoreMarker, lineText: string, now = new Date()): Promise<string> {
  const store = await loadApprovals(root, homeDir);
  const hash = lineHash(marker.file, lineText);
  if (!store.markers.some((item) => item.file === marker.file && item.lineHash === hash)) {
    store.markers.push({ file: marker.file, lineHash: hash, marker: marker.marker.slice(0, 200), approvedAt: now.toISOString() });
  }
  return saveApprovals(root, homeDir, store);
}

/** Records the user's approval of a changed ignore file's current content. */
export async function approveIgnoreFile(root: string, homeDir: string, file: string, content: string, now = new Date()): Promise<string> {
  const store = await loadApprovals(root, homeDir);
  const contentHash = sha256(content);
  if (!store.files.some((item) => item.file === file && item.contentHash === contentHash)) store.files.push({ file, contentHash, approvedAt: now.toISOString() });
  return saveApprovals(root, homeDir, store);
}

/** Removes an approval ("/security-review ignores" → remove). */
export async function removeApproval(root: string, homeDir: string, file: string, lineHashValue: string): Promise<string> {
  const store = await loadApprovals(root, homeDir);
  store.markers = store.markers.filter((item) => !(item.file === file && item.lineHash === lineHashValue));
  return saveApprovals(root, homeDir, store);
}

// ---------------------------------------------------------------------------------------------------------
// Which ignores count

export interface IgnoreContext {
  root: string;
  git: GitState;
  /** Files that differ from HEAD, plus untracked ones; undefined outside git. */
  changed: Set<string> | undefined;
  /** Untracked files: every marker in them is new. */
  untracked?: Set<string>;
  approvals: ApprovalStore;
  readText: (file: string) => Promise<string | undefined>;
}

export class IgnoreJudge {
  private readonly changedLines = new Map<string, Promise<Set<number> | undefined>>();
  private readonly inHead = new Map<string, Promise<boolean>>();
  constructor(private readonly context: IgnoreContext) {}

  /** committed, approved, new (added since HEAD, not approved) or unknown (outside git, not approved). */
  async status(marker: IgnoreMarker, lineText: string): Promise<IgnoreStatus> {
    const { approvals, git, changed } = this.context;
    const hash = lineHash(marker.file, lineText);
    if (approvals.markers.some((item) => item.file === marker.file && item.lineHash === hash)) return "approved";
    if (!git.inRepo || !changed) return "unknown";
    if (!git.hasHead) return "new";
    if (this.context.untracked?.has(marker.file)) return "new";
    if (!changed.has(marker.file)) {
      // Unchanged and in HEAD: committed. Not in HEAD at all (a git-ignored file): nobody committed it.
      let present = this.inHead.get(marker.file);
      if (!present) { present = inHead(this.context.root, marker.file); this.inHead.set(marker.file, present); }
      return await present ? "committed" : "new";
    }
    let lines = this.changedLines.get(marker.file);
    if (!lines) { lines = linesChangedSinceHead(this.context.root, marker.file); this.changedLines.set(marker.file, lines); }
    const changedLines = await lines;
    if (!changedLines) return "new";
    return changedLines.has(marker.line) ? "new" : "committed";
  }
}

export interface IgnoreOutcome {
  visible: SecurityFinding[];
  /** How many findings a committed or approved ignore hid. */
  hidden: { committed: number; approved: number; config: number };
  /** Markers that tried to hide a finding but do not count (new or unknown). The findings stay visible. */
  flagged: IgnoreEntry[];
}

/** Hides findings only behind committed or approved markers, and committed config-file ignores. */
export async function applyIgnores(findings: readonly SecurityFinding[], context: IgnoreContext, configIgnores: ConfigIgnore[] = []): Promise<IgnoreOutcome> {
  const judge = new IgnoreJudge(context);
  const texts = new Map<string, Promise<string | undefined>>();
  const ranges = new Map<string, Array<[number, number]>>();
  const outcome: IgnoreOutcome = { visible: [], hidden: { committed: 0, approved: 0, config: 0 }, flagged: [] };
  const flaggedKeys = new Set<string>();
  for (const finding of findings) {
    if (configIgnores.some((ignore) => ignore.covers(finding))) { outcome.hidden.config++; continue; }
    if (!finding.file || finding.line < 1 || finding.tool === "osv-scanner" || finding.tool === "mcp-scanner") { outcome.visible.push(finding); continue; }
    let pending = texts.get(finding.file);
    if (!pending) { pending = context.readText(finding.file); texts.set(finding.file, pending); }
    const text = await pending;
    if (text === undefined) { outcome.visible.push(finding); continue; }
    let table = ranges.get(finding.file);
    if (!table && PYTHON_FILE.test(finding.file)) { table = pythonStatementRanges(text); ranges.set(finding.file, table); }
    const [start, end] = findingLines(finding, text, table);
    const lines = text.split(/\r?\n/);
    let hiddenBy: IgnoreStatus | undefined;
    const notCounted: IgnoreEntry[] = [];
    for (let line = start; line <= end && line <= lines.length; line++) {
      for (const marker of markersOnLine(finding.file, line, lines[line - 1]!)) {
        if (!markerCovers(marker, finding)) continue;
        const status = await judge.status(marker, lines[line - 1]!);
        if (status === "committed" || status === "approved") { hiddenBy = hiddenBy === "committed" ? hiddenBy : status; }
        else notCounted.push({ ...marker, status });
      }
    }
    if (hiddenBy) { outcome.hidden[hiddenBy === "committed" ? "committed" : "approved"]++; continue; }
    outcome.visible.push(finding);
    for (const entry of notCounted) {
      const key = `${entry.file}:${entry.line}:${entry.tool}`;
      if (!flaggedKeys.has(key)) { flaggedKeys.add(key); outcome.flagged.push(entry); }
    }
  }
  return outcome;
}

/**
 * Every ignore marker added since the last commit (changed lines of tracked files, all of untracked
 * ones), whether or not a finding sits under it. A receipt can say "a security ignore was added".
 */
export async function newIgnores(context: IgnoreContext, limitFiles = 2000): Promise<IgnoreEntry[]> {
  if (!context.git.inRepo || !context.changed) return [];
  const judge = new IgnoreJudge(context);
  const entries: IgnoreEntry[] = [];
  for (const file of [...context.changed].sort().slice(0, limitFiles)) {
    const text = await context.readText(file);
    if (text === undefined) continue;
    for (const marker of markersInText(file, text)) {
      const lineText = text.split(/\r?\n/)[marker.line - 1] ?? "";
      const status = await judge.status(marker, lineText);
      if (status === "new") entries.push({ ...marker, status });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------
// Tool ignore files

/** The ignore and config files each tool reads by itself. Casper decides whether each one is used. */
export const IGNORE_FILES: ReadonlyArray<{ file: string; tool: SecurityToolId }> = [
  { file: ".gitleaks.toml", tool: "gitleaks" },
  { file: ".gitleaksignore", tool: "gitleaks" },
  { file: ".semgrepignore", tool: "semgrep" },
  { file: "osv-scanner.toml", tool: "osv-scanner" },
  { file: "zizmor.yml", tool: "zizmor" },
  { file: "zizmor.yaml", tool: "zizmor" },
  { file: ".github/zizmor.yml", tool: "zizmor" },
  { file: ".github/zizmor.yaml", tool: "zizmor" },
  { file: ".ansible-lint", tool: "ansible-lint" },
  { file: ".ansible-lint.yml", tool: "ansible-lint" },
  { file: ".ansible-lint.yaml", tool: "ansible-lint" },
  { file: ".config/ansible-lint.yml", tool: "ansible-lint" },
  { file: ".config/ansible-lint.yaml", tool: "ansible-lint" },
  { file: ".ansible-lint-ignore", tool: "ansible-lint" },
  { file: ".config/ansible-lint-ignore.txt", tool: "ansible-lint" },
  { file: "pyproject.toml", tool: "ruff" },
  { file: "ruff.toml", tool: "ruff" },
  { file: ".ruff.toml", tool: "ruff" },
];

/** The parts of a Python config file that ignore ruff S or bandit rules; other edits don't matter. */
export function pythonIgnoreTables(file: string, text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let parsed: Record<string, unknown>;
  try { parsed = Bun.TOML.parse(text) as Record<string, unknown>; } catch { return "unreadable"; }
  const pick = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value);
  const base = file === "pyproject.toml" ? pick(parsed, "tool", "ruff") : parsed;
  const tables = {
    bandit: file === "pyproject.toml" ? pick(parsed, "tool", "bandit") ?? null : null,
    ignore: pick(base, "lint", "ignore") ?? pick(base, "ignore") ?? null,
    extendIgnore: pick(base, "lint", "extend-ignore") ?? pick(base, "extend-ignore") ?? null,
    perFile: pick(base, "lint", "per-file-ignores") ?? pick(base, "per-file-ignores") ?? null,
    extendPerFile: pick(base, "lint", "extend-per-file-ignores") ?? pick(base, "extend-per-file-ignores") ?? null,
  };
  if (Object.values(tables).every((value) => value === null)) return undefined;
  return JSON.stringify(tables);
}

export interface IgnoreFileOptions {
  /** Changed files the user chose to use for this run ("1 Use my changed file"). */
  useChanged?: readonly string[];
}

/** Which of the tool's own ignore files exist, and whether each is used this run. */
export async function judgeIgnoreFiles(context: IgnoreContext, options: IgnoreFileOptions = {}): Promise<Array<IgnoreFile & { text: string }>> {
  const result: Array<IgnoreFile & { text: string }> = [];
  for (const { file, tool } of IGNORE_FILES) {
    const text = await context.readText(file);
    if (text === undefined) continue;
    const pythonConfig = tool === "ruff";
    const inRepo = context.git.inRepo && context.changed !== undefined;
    // HEAD's copy decides "committed": a git-ignored file is never in HEAD, however unchanged it looks.
    const committedText = inRepo && context.git.hasHead ? await headText(context.root, file) : undefined;
    if (pythonConfig && pythonIgnoreTables(file, text) === undefined && pythonIgnoreTables(file, committedText) === undefined) continue;
    let status: IgnoreFile["status"];
    const approved = context.approvals.files.some((item) => item.file === file && item.contentHash === sha256(text));
    if (!inRepo) status = "unknown";
    else if (committedText !== undefined && committedText === text) status = "committed";
    // Only the ignore tables of a Python config matter: a dependency edit does not change them.
    else if (pythonConfig && committedText !== undefined && pythonIgnoreTables(file, text) === pythonIgnoreTables(file, committedText)) status = "committed";
    else status = "changed";
    if (status !== "committed" && approved) status = "approved";
    if ((status === "changed" || status === "unknown") && options.useChanged?.includes(file)) status = "chosen";
    result.push({ file, tool, status, used: status === "committed" || status === "approved" || status === "chosen", text });
  }
  return result;
}

/** A committed ignore that a config file declares (zizmor.yml rules, bandit skips, ruff ignores). */
export interface ConfigIgnore { file: string; covers(finding: SecurityFinding): boolean }

function globMatch(pattern: string, file: string): boolean {
  try { return new Bun.Glob(pattern).match(file) || new Bun.Glob(`**/${pattern}`).match(file); } catch { return false; }
}

/** The ignores a used config file declares. Ruff runs --isolated, so Casper applies these itself. */
export function configIgnores(files: ReadonlyArray<IgnoreFile & { text: string }>): ConfigIgnore[] {
  const ignores: ConfigIgnore[] = [];
  for (const entry of files) {
    if (!entry.used) continue;
    if (entry.tool === "zizmor") {
      let parsed: unknown;
      try { parsed = YAML.parse(entry.text); } catch { continue; }
      const rules = parsed && typeof parsed === "object" ? (parsed as { rules?: unknown }).rules : undefined;
      if (!rules || typeof rules !== "object") continue;
      for (const [rule, settings] of Object.entries(rules as Record<string, unknown>)) {
        if (!settings || typeof settings !== "object") continue;
        const { ignore, disable } = settings as { ignore?: unknown; disable?: unknown };
        if (disable === true) ignores.push({ file: entry.file, covers: (finding) => finding.tool === "zizmor" && finding.rule === rule });
        for (const item of Array.isArray(ignore) ? ignore : []) {
          if (typeof item !== "string") continue;
          const [name, line] = item.split(":");
          ignores.push({ file: entry.file, covers: (finding) => finding.tool === "zizmor" && finding.rule === rule
            && path.posix.basename(finding.file) === name && (line === undefined || Number(line) === finding.line) });
        }
      }
    }
    if (entry.tool === "ruff") {
      const tables = pythonIgnoreTables(entry.file, entry.text);
      if (!tables || tables === "unreadable") continue;
      const parsed = JSON.parse(tables) as { bandit: { skips?: unknown } | null; ignore: unknown; extendIgnore: unknown; perFile: unknown; extendPerFile: unknown };
      const codes = new Set<string>();
      for (const code of Array.isArray(parsed.bandit?.skips) ? parsed.bandit!.skips as unknown[] : []) if (typeof code === "string" && /^B\d{3}$/i.test(code)) codes.add(`S${code.slice(1)}`);
      for (const list of [parsed.ignore, parsed.extendIgnore]) for (const code of Array.isArray(list) ? list : []) if (typeof code === "string") codes.add(code.toUpperCase());
      const covered = (rule: string, list: Iterable<string>) => [...list].some((code) => code === "S" || code === "ALL" || rule === code || (code.length < rule.length && rule.startsWith(code) && /^S\d*$/.test(code)));
      if (codes.size) ignores.push({ file: entry.file, covers: (finding) => finding.tool === "ruff" && covered(finding.rule, codes) });
      for (const table of [parsed.perFile, parsed.extendPerFile]) {
        if (!table || typeof table !== "object") continue;
        for (const [pattern, list] of Object.entries(table as Record<string, unknown>)) {
          const perCodes = (Array.isArray(list) ? list : []).filter((code): code is string => typeof code === "string").map((code) => code.toUpperCase());
          if (perCodes.length) ignores.push({ file: entry.file, covers: (finding) => finding.tool === "ruff" && globMatch(pattern, finding.file) && covered(finding.rule, perCodes) });
        }
      }
    }
  }
  return ignores;
}
