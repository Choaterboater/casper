import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type { AcceptanceResult } from "./acceptance";
import { runCommandCheck } from "./command";
import { isCodePath } from "./proof";
import type { TreeChanges } from "../task/changes";

/** Mutation check (experimental): small, deliberate bugs in the change's code must each make a test fail.
 * A mutant no test notices shows a requirement the tests assert less strictly than the code implements it.
 * Host-run only: no model call, so no model judgment in the verdict. JavaScript/TypeScript sources only. */

export interface Mutant { file: string; line: number; start: number; end: number; original: string; replacement: string }

/** Operator swaps: each is a common off-by-one, sign or logic slip. */
const BINARY: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.LessThanToken]: "<=", [ts.SyntaxKind.LessThanEqualsToken]: "<",
  [ts.SyntaxKind.GreaterThanToken]: ">=", [ts.SyntaxKind.GreaterThanEqualsToken]: ">",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "!==", [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "===",
  [ts.SyntaxKind.PlusToken]: "-", [ts.SyntaxKind.MinusToken]: "+",
  [ts.SyntaxKind.AsteriskToken]: "/", [ts.SyntaxKind.SlashToken]: "*",
  [ts.SyntaxKind.AmpersandAmpersandToken]: "||", [ts.SyntaxKind.BarBarToken]: "&&",
};
const ROUNDING: Record<string, string> = { floor: "ceil", ceil: "floor", round: "floor", trunc: "round", max: "min", min: "max" };

/** Every mutant of one source file, in source order. Only expressions are touched (never types or strings). */
export function mutantsOf(file: string, source: string): Mutant[] {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: Mutant[] = [];
  const add = (node: ts.Node, replacement: string) => {
    const start = node.getStart(tree);
    found.push({ file, line: tree.getLineAndCharacterOfPosition(start).line + 1, start, end: node.getEnd(), original: node.getText(tree), replacement });
  };
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node)) {
      const swap = BINARY[node.operatorToken.kind];
      // `a + b` on strings is concatenation; a sign swap there only makes a type error, not a behavior bug.
      const stringy = node.operatorToken.kind === ts.SyntaxKind.PlusToken && [node.left, node.right].some((side) => ts.isStringLiteral(side) || ts.isTemplateExpression(side) || ts.isNoSubstitutionTemplateLiteral(side));
      if (swap && !stringy) add(node.operatorToken, swap);
    } else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      add(node, node.operand.getText(tree));
    } else if (node.kind === ts.SyntaxKind.TrueKeyword) add(node, "false");
    else if (node.kind === ts.SyntaxKind.FalseKeyword) add(node, "true");
    else if (ts.isNumericLiteral(node) && (node.text === "0" || node.text === "1")) add(node, node.text === "0" ? "1" : "0");
    else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Math" && ROUNDING[node.name.text]) {
      add(node.name, ROUNDING[node.name.text]!);
    } else if (ts.isThrowStatement(node)) add(node, ";");
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** At most `limit` mutants, spread evenly over the list so every part of the change is sampled. */
export function sample<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  return Array.from({ length: limit }, (_, index) => items[Math.floor((index * items.length) / limit)]!);
}

const MUTANT_LIMIT = 40;
/** The check fails when more than this share of mutants survive (a mutation score under 80%), fixed before measuring. */
const SURVIVAL_LIMIT = 0.2;
const SURVIVOR_NAMES = 20;

/** Run the tests once per mutant of the change's JavaScript/TypeScript code, in `root` itself: each mutant is written,
 * tested and restored before the next, so `root` must be a disposable copy. */
export async function mutationCheck(input: {
  root: string; changes: TreeChanges; testCommand: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
}): Promise<AcceptanceResult & { mutants?: number; survived?: number }> {
  const none = { tokens: 0, estimatedCost: 0 };
  const files = [...input.changes.added, ...input.changes.modified].filter((file) => isCodePath(file) && /\.[cm]?[jt]sx?$/.test(file)).sort();
  const all: Mutant[] = [];
  const sources = new Map<string, string>();
  for (const file of files) {
    const source = await readFile(path.join(input.root, file), "utf8").catch(() => undefined);
    if (source === undefined) continue;
    sources.set(file, source);
    all.push(...mutantsOf(file, source));
  }
  if (!all.length) return { status: "error", reason: "the change has no JavaScript or TypeScript code to mutate", usage: none };
  const run = () => runCommandCheck({ name: "test", command: input.testCommand, cwd: input.root, timeoutMs: input.timeoutMs, signal: input.signal, ...(input.env ? { env: input.env } : {}) });
  const clean = await run();
  if (clean.status !== "pass") return { status: "error", reason: "the tests do not pass on the change itself", usage: none };
  const chosen = sample(all, MUTANT_LIMIT);
  const survivors: Mutant[] = [];
  for (const mutant of chosen) {
    input.signal?.throwIfAborted();
    const source = sources.get(mutant.file)!;
    const target = path.join(input.root, mutant.file);
    await writeFile(target, source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end));
    try {
      const result = await run();
      if (result.status === "pass") survivors.push(mutant);
    } finally { await writeFile(target, source); }
  }
  const described = survivors.slice(0, SURVIVOR_NAMES).map((mutant) => `${mutant.file}:${mutant.line} ${mutant.original.slice(0, 60)} → ${mutant.replacement.slice(0, 60)}`);
  const counts = { mutants: chosen.length, survived: survivors.length };
  return survivors.length / chosen.length > SURVIVAL_LIMIT
    ? { status: "fail", unconfirmed: described, output: `${survivors.length} of ${chosen.length} mutants survived`, usage: none, ...counts }
    : { status: "pass", ...(described.length ? { unconfirmed: described } : {}), output: `${survivors.length} of ${chosen.length} mutants survived`, usage: none, ...counts };
}
