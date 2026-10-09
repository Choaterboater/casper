/**
 * `/security-review`: the pinned security tools on this project, with no model call and no token cost. Every
 * question is numbered and answered by a person: installing tools, using a changed ignore file, approving a new
 * ignore, downloading advisory data, and the AI review after the tools (the only part that spends tokens). A run
 * that cannot ask takes the choice that downloads nothing, approves nothing and spends nothing, and says so;
 * only `/security-review ai` runs the AI review there.
 */
import { formatQuestion, formatSecurityHeader, formatSecurityReport, IGNORE_APPROVE, IGNORE_CHOICES, IGNORE_FILE_CHOICES, IGNORE_FILE_USE, ignoreFileQuestion, ignoreQuestion } from "../security/format";
import { findTool, INSTALL_CHOICES, INSTALL_RUN, INSTALL_YES, installQuestion, installTools, OSV_UPDATE_QUESTION, updateOsvDb, type InstallOptions } from "../security/install";
import { ignoreState, missingSecurityTools, readRepoText, SecurityCheck, type SecurityCheckOptions, type SecurityReport } from "../security/run";
import { approveIgnore, approveIgnoreFile, removeApproval, removeFileApproval } from "../security/suppressions";
import { SECURITY_TOOLS } from "../security/tools";
import type { IgnoreEntry, SecurityFinding } from "../security/types";
import { formatCost, formatTokens, redactPreview, terminalText } from "../tui/format";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SubagentResult, SecurityReviewRunOptions } from "../agents/manager";
import type { RuntimeStartOptions } from "../runtime/types";
import { AI_REVIEW_HEADING, AI_REVIEW_TAIL, dropDeniedGrepLines, droppedLine, formatModelFinding, parseModelFindings, REVIEW_SYSTEM_APPEND,
  reviewCostWords, reviewPrompt, reviewReadGate, reviewScope, validateModelFindings, type ReviewScope } from "../security/review";
import { formatFindingText } from "../security/format";
import { AI_REVIEW_CHOICES } from "./safe-choices";

export const SECURITY_REVIEW_USAGE = "Usage: /security-review | /security-review ai | /security-review update | /security-review ignores";
export const CANT_ASK_AI = "The AI review did not run: it uses tokens, and Casper can't ask here. /security-review in the terminal offers it; casper \"/security-review ai\" runs it without asking.";
export const AI_REVIEW_STOPPED = "Stopped. The AI review did not run and no tokens were spent.";
export const CANT_ASK_INSTALL = "Casper can't ask here, so nothing was installed and it ran what is installed. Type /security-review in the terminal, or run casper security --install.";
export const CANT_ASK_IGNORES = "Casper can't ask here, so new ignores stay flagged. /security-review ignores in the terminal lets you approve them.";
export const CANT_ASK_UPDATE = "Casper can't ask here, so nothing was downloaded. Type /security-review update in the terminal.";
/** At most this many ignore questions in one go; the rest wait for the next run. */
const MAX_IGNORE_ASKS = 10;

export interface SecurityReviewHost {
  root: string;
  homeDir: string;
  write(text: string): void;
  /** A person can answer a numbered question now. */
  canAsk(): boolean;
  pick(question: string, options: { label: string; description?: string }[], signal?: AbortSignal): Promise<string | undefined>;
  signal?: AbortSignal;
  /** Test seams, passed to the engine and the installer. */
  check?: Pick<SecurityCheckOptions, "find" | "run" | "now" | "baseEnv" | "timeouts">;
  install?: Pick<InstallOptions, "fetchBytes" | "run" | "env">;
  /** The AI review after the tools; absent where no model can run. */
  ai?: SecurityAIReview;
}

/** What the AI review needs from the app. Nothing here is reachable from the model's own tools. */
export interface SecurityAIReview {
  /** The model the review runs on and its input price. Starts the session if needed (no model call); throws when no
   * model is signed in. */
  model(): Promise<{ name: string; inputCostPerMillion?: number }>;
  /** One read-only child with the review's own bounds (SubagentManager.reviewSecurity). */
  run(options: SecurityReviewRunOptions): Promise<SubagentResult>;
  /** The full secret scrubber: device configs, .env and credential files, and secret env values, whatever /secrets says. */
  scrub: NonNullable<RuntimeStartOptions["scrubToolOutput"]>;
}

const labels = (choices: readonly string[]) => choices.map((label) => ({ label }));

async function ask(host: SecurityReviewHost, text: string, choices: readonly string[]): Promise<string | undefined> {
  return host.pick(terminalText(text), labels(choices), host.signal);
}

export async function runSecurityReview(host: SecurityReviewHost, args: readonly string[]): Promise<SecurityReport | undefined> {
  if (args.length > 1 || (args[0] && !["update", "ignores", "ai"].includes(args[0]))) throw new Error(SECURITY_REVIEW_USAGE);
  if (args[0] === "update") { await updateAdvisories(host); return undefined; }
  if (args[0] === "ignores") { await reviewIgnores(host); return undefined; }
  const report = await review(host);
  if (report) await aiReview(host, report, args[0] === "ai");
  return report;
}

async function review(host: SecurityReviewHost): Promise<SecurityReport | undefined> {
  const options: SecurityCheckOptions = { root: host.root, homeDir: host.homeDir, ...host.check, ...(host.signal ? { signal: host.signal } : {}),
    write: (text) => host.write(text) };
  const state = await ignoreState(host.root, host.homeDir);
  const root = await realpath(path.resolve(host.root));
  host.write(formatSecurityHeader({ name: path.basename(root), path: root }));

  // A changed ignore file counts only once you say so; the choice is kept in ~/.casper, never in the repo.
  for (const file of state.files.filter((entry) => !entry.used && (entry.status === "changed" || entry.status === "unknown"))) {
    if (!host.canAsk()) break;
    const question = ignoreFileQuestion(file);
    const answer = await ask(host, question.text, IGNORE_FILE_CHOICES);
    if (answer === IGNORE_FILE_USE) {
      await approveIgnoreFile(host.root, host.homeDir, file.file, file.text);
      host.write(`Using ${terminalText(file.file)} as it is now. Casper keeps that choice in ~/.casper, not in the repo.\n`);
    }
  }

  // One question before any download.
  const missing = await missingSecurityTools(options);
  if (missing.length) {
    const question = installQuestion(missing.map((id) => SECURITY_TOOLS[id]));
    if (!host.canAsk()) host.write(`${question.text}\n${CANT_ASK_INSTALL}\n`);
    else {
      const answer = await ask(host, question.text, INSTALL_CHOICES);
      if (answer === INSTALL_YES) {
        const results = await installTools(missing, { homeDir: host.homeDir, write: (text) => host.write(text), ...host.install });
        for (const result of results) host.write(`${terminalText(result.message)}\n`);
      } else if (answer !== INSTALL_RUN) {
        host.write("Stopped. Nothing was installed and no tool ran.\n");
        return undefined;
      }
    }
  }
  if (host.signal?.aborted) return undefined;

  const result = await new SecurityCheck(options).run();
  host.write(formatSecurityReport(result, { header: false }));
  await askAboutIgnores(host, result.ignores.new);
  return result;
}

/** "1 Leave it flagged · 2 Show the line · 3 Keep it (I approve)" for each new ignore. Only a person's 3 approves; Enter never does. */
async function askAboutIgnores(host: SecurityReviewHost, fresh: readonly IgnoreEntry[]): Promise<void> {
  if (!fresh.length) return;
  if (!host.canAsk()) { host.write(`${CANT_ASK_IGNORES}\n`); return; }
  let approved = 0;
  for (const entry of fresh.slice(0, MAX_IGNORE_ASKS)) {
    if (host.signal?.aborted) return;
    const question = ignoreQuestion(entry);
    let answer = await ask(host, question.text, IGNORE_CHOICES);
    const lineText = (await readRepoText(host.root, entry.file))?.split(/\r?\n/)[entry.line - 1];
    if (answer === IGNORE_CHOICES[1]) {
      host.write(`${terminalText(entry.file)}:${entry.line}  ${lineText === undefined ? "(the line could not be read)" : redactPreview(terminalText(lineText.trim()))}\n`);
      answer = await ask(host, question.text, [IGNORE_CHOICES[0], IGNORE_APPROVE]);
    }
    if (answer === IGNORE_APPROVE && lineText !== undefined) {
      await approveIgnore(host.root, host.homeDir, entry, lineText);
      approved++;
    }
  }
  if (fresh.length > MAX_IGNORE_ASKS) host.write(`${fresh.length - MAX_IGNORE_ASKS} more new ignores stay flagged; /security-review ignores asks about them.\n`);
  if (approved) host.write(`Approved ${approved} ${approved === 1 ? "ignore" : "ignores"}. Casper keeps them in ~/.casper, not in the repo; they count from the next run.\n`);
}

/** `/security-review ignores`: what you approved, and the new ignores you have not. */
async function reviewIgnores(host: SecurityReviewHost): Promise<void> {
  const state = await ignoreState(host.root, host.homeDir);
  const { markers, files } = state.approvals;
  if (!markers.length && !files.length && !state.fresh.length) {
    host.write("No ignores you approved, and no new ones since the last commit. Ignores you committed always count.\n");
    return;
  }
  host.write(`Ignores you approved (kept in ~/.casper, not in the repo): ${markers.length + files.length}\n`);
  for (const item of markers) host.write(`  ${terminalText(item.file)}  ${terminalText(item.marker)}  (approved ${item.approvedAt.slice(0, 10)})\n`);
  for (const item of files) host.write(`  ${terminalText(item.file)}  whole file as it was (approved ${item.approvedAt.slice(0, 10)})\n`);
  if (state.fresh.length) host.write(`New ignores you didn't approve: ${state.fresh.length}\n`);
  await askAboutIgnores(host, state.fresh);
  if ((!markers.length && !files.length) || !host.canAsk()) return;
  const keep = "Keep them all";
  // Both kinds can be taken back: a marker you approved, and a changed ignore file you chose to use.
  const choices = [
    ...markers.map((item) => ({ label: `Remove ${terminalText(item.file)}  ${terminalText(item.marker)}`,
      remove: () => removeApproval(host.root, host.homeDir, item.file, item.lineHash), what: `${terminalText(item.file)}  ${terminalText(item.marker)}` })),
    ...files.map((item) => ({ label: `Remove ${terminalText(item.file)}  whole file`,
      remove: () => removeFileApproval(host.root, host.homeDir, item.file, item.contentHash), what: `${terminalText(item.file)} (whole file)` })),
  ].slice(0, 8);
  const answer = await ask(host, "Remove an approval? A removed ignore stops counting until you approve it again.", [keep, ...choices.map((choice) => choice.label)]);
  const chosen = choices.find((choice) => choice.label === answer);
  if (chosen) {
    await chosen.remove();
    host.write(`Removed the approval for ${chosen.what}.\n`);
  }
}

/** `/security-review update`: osv-scanner's advisory data, the only other download. Asks first. */
async function updateAdvisories(host: SecurityReviewHost): Promise<void> {
  const spec = SECURITY_TOOLS["osv-scanner"];
  const location = await (host.check?.find ?? ((toolSpec) => findTool(toolSpec, { homeDir: host.homeDir, run: host.check?.run })))(spec);
  if (location.kind === "missing") { host.write("osv-scanner is not installed. /security-review offers to install it.\n"); return; }
  if (!host.canAsk()) { host.write(`${formatQuestion(OSV_UPDATE_QUESTION)}${CANT_ASK_UPDATE}\n`); return; }
  const answer = await ask(host, OSV_UPDATE_QUESTION.text, OSV_UPDATE_QUESTION.choices);
  if (answer !== OSV_UPDATE_QUESTION.choices[1]) { host.write("Nothing was downloaded.\n"); return; }
  const result = await updateOsvDb(host.root, location, { homeDir: host.homeDir, ...host.install, ...(host.signal ? { signal: host.signal } : {}) });
  host.write(`${terminalText(result.message)}\n`);
}

/** "Next: the AI can read the 3 changed files for security problems (changes since main). …" */
export function aiReviewQuestion(scope: ReviewScope, model: string, cost: string, gitleaksRan: boolean): string {
  const files = `${scope.files.length} ${scope.files.length === 1 ? "file" : "files"}`;
  return [
    `Next: the AI can read the ${files} for security problems (${scope.basis}${scope.skipped ? `; ${scope.skipped} more left out` : ""}).`,
    `It runs on ${model}: ${cost}, up to 30 steps and 10 minutes.`,
    "It reads with look-only tools and can't run commands or change files. Key and .env files" +
      (gitleaksRan ? " and files gitleaks flagged" : "") + " are kept from it, and secrets it reads elsewhere are hidden." +
      (gitleaksRan ? "" : " gitleaks did not run, so files with secrets in the code are not kept from it."),
    "Its findings are its opinion, not checked by a tool.",
  ].join("\n");
}

/** The AI review after the tools: a numbered ask with Stop first and the cost shown, then one bounded read-only child. */
async function aiReview(host: SecurityReviewHost, report: SecurityReport, explicit: boolean): Promise<void> {
  const ai = host.ai;
  if (!ai || host.signal?.aborted) return;
  const root = await realpath(path.resolve(host.root));
  const canAsk = host.canAsk();
  if (!canAsk && !explicit) { host.write(`${CANT_ASK_AI}\n`); return; }
  // What the AI is kept from: files gitleaks flagged, also when an ignore hides that finding from the report.
  const keptFrom: SecurityFinding[] = [...report.findings, ...(report.secretFiles ?? []).map((file) =>
    ({ tool: "gitleaks" as const, file, line: 1, rule: "secret", severity: "high" as const, text: "flagged by gitleaks" }))];
  const scope = await reviewScope(root, keptFrom);
  if (!scope.files.length) {
    host.write(`The AI review has nothing to read: no changed files and nothing the tools flagged${scope.skipped ? ` (${scope.skipped} left out: keys, .env files, big or binary files)` : ""}. No tokens were spent.\n`);
    return;
  }
  let model: { name: string; inputCostPerMillion?: number };
  try { model = await ai.model(); } catch (error) {
    host.write(`The AI review can't start: ${terminalText(error instanceof Error ? error.message : String(error))}. /login signs in. No tokens were spent.\n`);
    return;
  }
  const gitleaksRan = report.tools.some((tool) => tool.id === "gitleaks" && (tool.status === "ok" || tool.status === "problems"));
  const question = aiReviewQuestion(scope, terminalText(model.name), reviewCostWords(scope, model.inputCostPerMillion), gitleaksRan);
  if (canAsk) {
    const answer = await host.pick(terminalText(question), AI_REVIEW_CHOICES.map((choice) => ({ ...choice })), host.signal);
    if (answer !== AI_REVIEW_CHOICES[1].label) { host.write(`${AI_REVIEW_STOPPED}\n`); return; }
  } else host.write(`${question}\nRunning it because you asked with /security-review ai.\n`);
  if (host.signal?.aborted) return;

  // The tools' findings and the diff reach the model too: the same scrub first.
  const hide = async (text: string): Promise<string> => {
    if (!text) return "";
    const checked = await ai.scrub("bash", {}, [text], host.signal).then((result) => ({ result }), () => undefined);
    if (!checked) return "(not shown: Casper could not check it for secrets)";
    return checked.result?.texts[0] ?? text;
  };
  const findingsText = await hide(report.findings.map((finding) => `- ${finding.tool}: ${formatFindingText(finding)}`).join("\n") || "(none)");
  const diff = await hide(scope.diff);
  const prompt = reviewPrompt({ root, scope, toolFindings: report.findings, diff, findingsText });
  const gate = reviewReadGate(root, keptFrom);
  host.write(`AI review: reading ${scope.files.length} ${scope.files.length === 1 ? "file" : "files"} on ${terminalText(model.name)}…\n`);
  let result: SubagentResult;
  try {
    result = await ai.run({
      cwd: root, prompt, systemPromptAppend: REVIEW_SYSTEM_APPEND, beforeToolGate: gate,
      scrubToolOutput: async (toolName, input, texts, signal) => {
        const kept = toolName === "grep" ? dropDeniedGrepLines(root, keptFrom, input, texts) : texts;
        const scrubbed = await ai.scrub(toolName, input, kept, signal);
        return scrubbed ?? (kept === texts ? undefined : { texts: kept });
      },
      ...(host.signal ? { signal: host.signal } : {}),
    });
  } catch (error) {
    host.write(`The AI review could not start: ${terminalText(error instanceof Error ? error.message : String(error))}.\n`);
    return;
  }
  const spent = result.usage
    ? `The AI review used about ${formatTokens(result.usage.tokens)} tokens${result.usage.estimatedCost > 0 ? ` (≈ ${formatCost(result.usage.estimatedCost)}, the catalog's estimate)` : ""}.`
    : "The AI review used tokens; the provider did not report how many.";
  if (result.status === "cancelled") { host.write(`AI review stopped before it finished. Nothing it found is shown. ${spent}\n`); return; }
  const raw = parseModelFindings(result.response);
  const { kept, dropped } = await validateModelFindings(root, raw ?? [], keptFrom);
  const lines = [AI_REVIEW_HEADING];
  if (result.status !== "completed") lines.push(`  It stopped early (${terminalText(result.reason ?? result.status)}), so it may have missed things.`);
  if (raw === undefined) lines.push("  Casper could not read findings in its answer, so nothing is shown.");
  else if (!kept.length && !dropped) lines.push("  It named no problems.");
  for (const finding of kept) lines.push(`  ${formatModelFinding(finding)}`);
  const droppedText = droppedLine(dropped);
  if (droppedText) lines.push(droppedText);
  lines.push(spent, AI_REVIEW_TAIL);
  host.write(`${lines.join("\n")}\n`);
}
