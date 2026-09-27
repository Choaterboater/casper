export class SemverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemverError";
  }
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
  build: string[];
}

type Op = "<" | "<=" | ">" | ">=" | "=" | "!=";

interface Comparator {
  op: Op;
  version: ParsedVersion;
}

type Branch = Comparator[];

/** A version token as written in a range: major is always concrete; minor/patch are null when
 * omitted or written as a wildcard (x, X, *), meaning the token is a partial (x-range) version. */
interface RangeVersion {
  major: number;
  minor: number | null;
  patch: number | null;
  prerelease: (string | number)[];
  build: string[];
}

const CORE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([^+]+))?(?:\+(.+))?$/;
const IDENTIFIER_RE = /^[0-9A-Za-z-]+$/;

function parsePrerelease(text: string): (string | number)[] | null {
  const out: (string | number)[] = [];
  for (const part of text.split(".")) {
    if (part.length === 0 || !IDENTIFIER_RE.test(part)) return null;
    if (/^[0-9]+$/.test(part)) {
      if (part.length > 1 && part.startsWith("0")) return null;
      out.push(Number(part));
    } else {
      out.push(part);
    }
  }
  return out;
}

function parseBuild(text: string): string[] | null {
  const parts = text.split(".");
  for (const part of parts) if (part.length === 0 || !IDENTIFIER_RE.test(part)) return null;
  return parts;
}

function stripLeadingMarker(text: string): string {
  return text.startsWith("v") || text.startsWith("=") ? text.slice(1) : text;
}

/** Parses a strict, fully-specified version core (no wildcards), or returns null. */
function tryParseFull(text: string): ParsedVersion | null {
  const match = CORE_RE.exec(text);
  if (!match) return null;
  const [, majorS, minorS, patchS, preText, buildText] = match;
  let prerelease: (string | number)[] = [];
  if (preText !== undefined) {
    const parsed = parsePrerelease(preText);
    if (parsed === null) return null;
    prerelease = parsed;
  }
  let build: string[] = [];
  if (buildText !== undefined) {
    const parsed = parseBuild(buildText);
    if (parsed === null) return null;
    build = parsed;
  }
  return { major: Number(majorS), minor: Number(minorS), patch: Number(patchS), prerelease, build };
}

export function parse(version: string): ParsedVersion {
  const normalized = stripLeadingMarker(version.trim());
  const result = tryParseFull(normalized);
  if (!result) throw new SemverError(`invalid version "${version}"`);
  return result;
}

function compareIdentifier(a: string | number, b: string | number): number {
  const aNum = typeof a === "number";
  const bNum = typeof b === "number";
  if (aNum && bNum) return a === b ? 0 : a < b ? -1 : 1;
  if (aNum && !bNum) return -1;
  if (!aNum && bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: (string | number)[], b: (string | number)[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const c = compareIdentifier(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const c = comparePrerelease(a.prerelease, b.prerelease);
  return c < 0 ? -1 : c > 0 ? 1 : 0;
}

export function compare(a: string, b: string): -1 | 0 | 1 {
  return compareParsed(parse(a), parse(b));
}

function parseIntStrict(text: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(text)) return null;
  return Number(text);
}

/** Parses a version token as it may appear inside a range: a full version (optionally with
 * prerelease/build), or a partial/wildcard form (1, 1.2, 1.x, 1.2.*, ...). Returns null on failure. */
function parseRangeVersionToken(rawToken: string): RangeVersion | null {
  const text = stripLeadingMarker(rawToken);
  const full = tryParseFull(text);
  if (full) return { major: full.major, minor: full.minor, patch: full.patch, prerelease: full.prerelease, build: full.build };
  const segments = text.split(".");
  if (segments.length === 0 || segments.length > 3) return null;
  const values: (number | null)[] = [];
  for (const segment of segments) {
    if (segment === "x" || segment === "X" || segment === "*") {
      values.push(null);
      continue;
    }
    const n = parseIntStrict(segment);
    if (n === null) return null;
    values.push(n);
  }
  const major = values[0];
  if (major === null || major === undefined) return null;
  const minor = values[1] ?? null;
  const patch = values[2] ?? null;
  return { major, minor, patch, prerelease: [], build: [] };
}

function floorVersion(rv: RangeVersion): ParsedVersion {
  return { major: rv.major, minor: rv.minor ?? 0, patch: rv.patch ?? 0, prerelease: rv.prerelease, build: [] };
}

/** The exclusive upper bound implied by treating `rv` as an x-range: bumps the first omitted/wildcard part. */
function nextAfterPartial(rv: RangeVersion): ParsedVersion {
  if (rv.minor === null) return { major: rv.major + 1, minor: 0, patch: 0, prerelease: [], build: [] };
  return { major: rv.major, minor: rv.minor + 1, patch: 0, prerelease: [], build: [] };
}

function expandComparator(op: Op, rv: RangeVersion): Comparator[] {
  if (rv.patch !== null) {
    return [{ op, version: { major: rv.major, minor: rv.minor!, patch: rv.patch, prerelease: rv.prerelease, build: rv.build } }];
  }
  const lower = floorVersion(rv);
  const upper = nextAfterPartial(rv);
  switch (op) {
    case "=":
      return [{ op: ">=", version: lower }, { op: "<", version: upper }];
    case ">":
      return [{ op: ">=", version: upper }];
    case ">=":
      return [{ op: ">=", version: lower }];
    case "<":
      return [{ op: "<", version: lower }];
    case "<=":
      return [{ op: "<", version: upper }];
    case "!=":
      return [{ op: "!=", version: lower }];
  }
}

function expandTilde(rv: RangeVersion): Comparator[] {
  const lower = floorVersion(rv);
  const upper: ParsedVersion = rv.minor !== null
    ? { major: rv.major, minor: rv.minor + 1, patch: 0, prerelease: [], build: [] }
    : { major: rv.major + 1, minor: 0, patch: 0, prerelease: [], build: [] };
  return [{ op: ">=", version: lower }, { op: "<", version: upper }];
}

function expandCaret(rv: RangeVersion): Comparator[] {
  const lower = floorVersion(rv);
  const capMajor = rv.major === 0 ? 1 : rv.major + 1;
  const upper: ParsedVersion = { major: capMajor, minor: 0, patch: 0, prerelease: [], build: [] };
  return [{ op: ">=", version: lower }, { op: "<", version: upper }];
}

function expandHyphen(left: RangeVersion, right: RangeVersion): Comparator[] {
  const lower = floorVersion(left);
  const upperComparator: Comparator = right.patch !== null
    ? { op: "<=", version: { major: right.major, minor: right.minor!, patch: right.patch, prerelease: right.prerelease, build: right.build } }
    : { op: "<", version: nextAfterPartial(right) };
  return [{ op: ">=", version: lower }, upperComparator];
}

const BARE_OPS = new Set(["<=", ">=", "!=", "<", ">", "="]);

function splitBranchTokens(branch: string): string[] | null {
  const raw = branch.split(/\s+/).filter((t) => t.length > 0);
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!;
    if (BARE_OPS.has(t)) {
      const next = raw[i + 1];
      if (next === undefined) return null;
      tokens.push(t + next);
      i++;
    } else {
      tokens.push(t);
    }
  }
  return tokens.length > 0 ? tokens : null;
}

const TOKEN_RE = /^(<=|>=|!=|~|\^|<|>|=)?(.+)$/;

function parseToken(token: string): Comparator[] | null {
  if (token === "*" || token === "x" || token === "X") return [];
  const match = TOKEN_RE.exec(token);
  if (!match) return null;
  const opSym = match[1];
  const rest = match[2]!;
  const rv = parseRangeVersionToken(rest);
  if (!rv) return null;
  if (opSym === "~") return expandTilde(rv);
  if (opSym === "^") return expandCaret(rv);
  const op = (opSym as Op | undefined) ?? "=";
  return expandComparator(op, rv);
}

function parseBranch(branchText: string, original: string): Branch {
  if (branchText === "*" || branchText === "x" || branchText === "X") return [];
  const hyphenMatch = /^(\S+)\s+-\s+(\S+)$/.exec(branchText);
  if (hyphenMatch) {
    const left = parseRangeVersionToken(hyphenMatch[1]!);
    const right = parseRangeVersionToken(hyphenMatch[2]!);
    if (!left || !right) throw new SemverError(`invalid range "${original}"`);
    return expandHyphen(left, right);
  }
  const tokens = splitBranchTokens(branchText);
  if (!tokens) throw new SemverError(`invalid range "${original}"`);
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const parsed = parseToken(token);
    if (!parsed) throw new SemverError(`invalid range "${original}"`);
    comparators.push(...parsed);
  }
  return comparators;
}

function parseRange(range: string): Branch[] {
  const trimmedWhole = range.trim();
  if (trimmedWhole.length === 0) return [[]];
  const branches: Branch[] = [];
  for (const side of trimmedWhole.split("||")) {
    const trimmedSide = side.trim();
    if (trimmedSide.length === 0) throw new SemverError(`invalid range "${range}"`);
    branches.push(parseBranch(trimmedSide, range));
  }
  return branches;
}

function comparatorHolds(version: ParsedVersion, comparator: Comparator): boolean {
  const cmp = compareParsed(version, comparator.version);
  switch (comparator.op) {
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "=":
      return cmp === 0;
    case "!=":
      return cmp !== 0;
  }
}

function branchAllows(version: ParsedVersion, branch: Branch, includePrerelease: boolean): boolean {
  if (!branch.every((c) => comparatorHolds(version, c))) return false;
  if (includePrerelease || version.prerelease.length === 0) return true;
  return branch.some((c) => c.op !== "!=" && c.version.prerelease.length > 0
    && c.version.major === version.major && c.version.minor === version.minor && c.version.patch === version.patch);
}

export function satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean {
  const branches = parseRange(range);
  let parsedVersion: ParsedVersion;
  try {
    parsedVersion = parse(version);
  } catch (error) {
    if (error instanceof SemverError) return false;
    throw error;
  }
  const includePrerelease = options?.includePrerelease ?? false;
  return branches.some((branch) => branchAllows(parsedVersion, branch, includePrerelease));
}

function bestSatisfying(versions: string[], range: string, pickHigher: boolean): string | null {
  const branches = parseRange(range);
  let best: { text: string; parsed: ParsedVersion } | null = null;
  for (const text of versions) {
    let parsed: ParsedVersion;
    try {
      parsed = parse(text);
    } catch {
      continue;
    }
    if (!branches.some((branch) => branchAllows(parsed, branch, false))) continue;
    if (best === null) {
      best = { text, parsed };
      continue;
    }
    const cmp = compareParsed(parsed, best.parsed);
    if (pickHigher ? cmp > 0 : cmp < 0) best = { text, parsed };
  }
  return best ? best.text : null;
}

export function maxSatisfying(versions: string[], range: string): string | null {
  return bestSatisfying(versions, range, true);
}

export function minSatisfying(versions: string[], range: string): string | null {
  return bestSatisfying(versions, range, false);
}

export function sort(versions: string[]): string[] {
  const withIndex = versions.map((text, index) => {
    let parsed: ParsedVersion | null;
    try {
      parsed = parse(text);
    } catch {
      parsed = null;
    }
    return { text, index, parsed };
  });
  const valid = withIndex.filter((v): v is { text: string; index: number; parsed: ParsedVersion } => v.parsed !== null);
  const invalid = withIndex.filter((v) => v.parsed === null);
  valid.sort((a, b) => {
    const c = compareParsed(a.parsed, b.parsed);
    return c !== 0 ? c : a.index - b.index;
  });
  invalid.sort((a, b) => a.index - b.index);
  return [...valid.map((v) => v.text), ...invalid.map((v) => v.text)];
}
