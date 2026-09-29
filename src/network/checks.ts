import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import hierConfigScript from "./assets/hier_config_diff.py" with { type: "text" };
import junosCommitPlaybook from "./assets/junos_commit_check.yml" with { type: "text" };
import { formatDuration } from "../verify/evidence";
import { scrubText } from "../secrets/scrub";
import { readProjectPlaybook } from "./ansible";
import { ansibleWorkspace, plainWorkspace, pythonWorkspace, type ToolWorkspace } from "./environment";
import { expandFiles, resolveInside } from "./files";
import {
  checkInventoryFile, guardLab, labApprovalKey, labHosts, labModelRefusal, labRefusalText, LAB_LIMIT_NOTE, NO_LAB_REASON,
  reachRefusalText, scanPlaybookReach, type LabHost,
} from "./lab";
import { runArgv, type ArgvRunResult } from "./run";
import type { HierConfigReport, LabSettings, NetworkCheckResult, NetworkCheckSpec, NetworkPreset } from "./spec";

/**
 * Running named network checks. Each preset builds its own argument list and
 * runs without a shell, in a clean environment. A missing tool, Ansible
 * collection or input reads "not run" and is never handed to the model as a
 * failure to fix. All output is scrubbed of secrets before anyone sees it.
 */

export const DRY_RUN_LABEL = "dry run not guaranteed";
export const COMMIT_CHECK_LABEL = "commit check only; not committed";
export const WINDOWS_REASON = "Ansible does not run on Windows; use WSL";
const OFFLINE_TIMEOUT_MS = 120_000;
const LAB_TIMEOUT_MS = 600_000;

export interface NetworkCheckContext {
  /** The project root. */
  root: string;
  /** The owner's lab list (from ~/.casper/config.yaml or a profile only). */
  lab?: LabSettings;
  signal?: AbortSignal;
  /** Defaults to process.platform; tests set "win32". */
  platform?: NodeJS.Platform;
  /** Defaults to Casper's PATH. */
  path?: string;
  /** Parent for private temp folders. */
  tmpRoot?: string;
  /** Your home folder (Ansible collections, SSH keys for lab checks). */
  realHome?: string;
}

const INSTALL_HINTS: Record<string, string> = {
  "ansible-playbook": "pipx install ansible-core",
  "ansible-inventory": "pipx install ansible-core",
  junoser: "gem install junoser",
  yanglint: "it comes with libyang: apt install yang-tools or brew install libyang",
};

function which(tool: string, context: NetworkCheckContext): string | undefined {
  return Bun.which(tool, { PATH: context.path ?? process.env.PATH ?? "" }) ?? undefined;
}

type Base = Pick<NetworkCheckResult, "name" | "kind" | "preset" | "cwd"> & Partial<NetworkCheckResult>;

function notRun(base: Base, reason: string, notRunKind: NonNullable<NetworkCheckResult["notRun"]>): NetworkCheckResult {
  return {
    command: undefined, exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0,
    ...base, status: "skip", reason, notRun: notRunKind,
  };
}

const scrub = (text: string): string => scrubText(text).text;

function fromRun(base: Base, command: string, run: ArgvRunResult, extra: Partial<NetworkCheckResult> = {}): NetworkCheckResult {
  return {
    ...base, command, status: !run.reason && run.exitCode === 0 ? "pass" : "fail",
    exitCode: run.exitCode, signal: run.signal, stdout: scrub(run.stdout), stderr: scrub(run.stderr), truncated: run.truncated,
    durationMs: run.durationMs, ...(run.reason ? { reason: run.reason } : {}), ...(run.ended ? { ended: run.ended } : {}), ...extra,
  };
}

/**
 * Ansible messages (ansible-core 2.16 to 2.19) that mean a collection is not
 * installed, as opposed to a mistake in the playbook. When unsure, the result
 * stays a failure: that is the honest reading.
 */
export function missingCollection(output: string): string | undefined {
  const patterns = [
    /couldn't resolve module\/action '([a-z0-9_]+\.[a-z0-9_]+)\.[a-z0-9_]+'/i,
    /\bcollection '?([a-z0-9_]+\.[a-z0-9_]+)'? (?:was )?not found/i,
    /unable to (?:find|locate) (?:the )?collection '?([a-z0-9_]+\.[a-z0-9_]+)/i,
    /the role '([a-z0-9_]+\.[a-z0-9_]+)\.[a-z0-9_]+' was not found/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match) return match[1]!.toLowerCase();
  }
  return undefined;
}

export const collectionReason = (collection: string): string =>
  `the Ansible collection ${collection} is not installed (ansible-galaxy collection install ${collection})`;
export const VAULT_REASON = "it needs an Ansible vault password, and Casper never runs vault password scripts or reads vault files; run it yourself";

function needsVault(output: string): boolean {
  return /no vault secrets (were )?found|attempting to decrypt but no vault secrets|a vault password (must|is required)/i.test(output);
}

/** Turn an Ansible run into a result, reading "collection missing" and "vault needed" as not run. */
function ansibleResult(base: Base, command: string, run: ArgvRunResult, extra: Partial<NetworkCheckResult> = {}): NetworkCheckResult {
  const output = `${run.stdout}\n${run.stderr}`;
  if (run.exitCode !== 0 && !run.ended) {
    const collection = missingCollection(output);
    if (collection) return { ...notRun({ ...base, ...extra }, collectionReason(collection), "collection"), command, durationMs: run.durationMs };
    if (needsVault(output)) return { ...notRun({ ...base, ...extra }, VAULT_REASON, "vault"), command, durationMs: run.durationMs };
  }
  if (run.exitCode === 0 && /no hosts matched|skipping: no hosts matched/i.test(output) && base.preset === "ansible-render") {
    return { ...notRun({ ...base, ...extra }, "no play matched localhost, so nothing was rendered", "input"), command, durationMs: run.durationMs };
  }
  return fromRun(base, command, run, extra);
}

async function withWorkspace<T>(make: () => Promise<ToolWorkspace>, use: (workspace: ToolWorkspace) => Promise<T>): Promise<T> {
  const workspace = await make();
  try { return await use(workspace); } finally { await workspace.cleanup(); }
}

/** Run playbooks one by one; the first failure or not-run ends the check. Durations add up. */
async function eachPlaybook(base: Base, playbooks: string[], step: (playbook: string) => Promise<NetworkCheckResult>): Promise<NetworkCheckResult> {
  let total = 0;
  let last: NetworkCheckResult | undefined;
  const commands: string[] = [];
  for (const playbook of playbooks) {
    const result = await step(playbook);
    total += result.durationMs;
    if (result.command) commands.push(result.command);
    if (result.status !== "pass") return { ...result, durationMs: total };
    last = result;
  }
  return { ...last!, durationMs: total, command: commands.join(" && ") };
}

function display(tool: string, args: string[]): string {
  return [tool, ...args].map((part) => /^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)).join(" ");
}

async function ansibleSyntax(base: Base, spec: NetworkCheckSpec, context: NetworkCheckContext, render: boolean): Promise<NetworkCheckResult> {
  const tool = which("ansible-playbook", context);
  if (!tool) return notRun(base, `ansible-playbook is not installed (${INSTALL_HINTS["ansible-playbook"]})`, "tool");
  const playbooks = spec.playbooks ?? [];
  for (const playbook of playbooks) {
    try {
      if (render) {
        const info = await readProjectPlaybook(context.root, playbook);
        if (!info.renderOnly) {
          return notRun(base, `${playbook} is not render-only: ${info.renderProblem}. Casper only runs playbooks where every device task has state: rendered`, "input");
        }
      } else await resolveInside(context.root, playbook);
    } catch (error) {
      return notRun(base, error instanceof Error ? error.message : String(error), "input");
    }
  }
  return withWorkspace(() => ansibleWorkspace({ tmpRoot: context.tmpRoot, realHome: context.realHome, path: context.path }), (workspace) =>
    eachPlaybook(base, playbooks, async (playbook) => {
      const absolute = await resolveInside(context.root, playbook);
      // -i localhost, : the explicit inventory stops ansible.cfg or ANSIBLE_INVENTORY from naming a dynamic one.
      const args = render ? ["-i", "localhost,", absolute] : ["--syntax-check", "-i", "localhost,", absolute];
      const shown = render ? ["-i", "localhost,", playbook] : ["--syntax-check", "-i", "localhost,", playbook];
      const run = await runArgv(tool, args, { cwd: context.root, env: workspace.env, timeoutMs: (spec.timeout ?? 0) * 1000 || OFFLINE_TIMEOUT_MS, signal: context.signal });
      return ansibleResult(base, display("ansible-playbook", shown), run);
    }));
}

/** Junoser's grammar lags new Junos releases, so its complaint is "could not read", not "invalid". */
export const JUNOSER_NOTE = "Junoser could not read this line; it may be newer syntax than Junoser knows. Do not rewrite valid config just to please Junoser.";

async function junoser(base: Base, spec: NetworkCheckSpec, context: NetworkCheckContext): Promise<NetworkCheckResult> {
  const tool = which("junoser", context);
  if (!tool) return notRun(base, `junoser is not installed (${INSTALL_HINTS.junoser})`, "tool");
  let files;
  try { files = await expandFiles(context.root, spec.files ?? []); } catch (error) { return notRun(base, error instanceof Error ? error.message : String(error), "input"); }
  if (!files.length) return notRun(base, "no config files to check", "input");
  return withWorkspace(() => plainWorkspace({ tmpRoot: context.tmpRoot, realHome: context.realHome, path: context.path }), async (workspace) => {
    let total = 0;
    for (const file of files) {
      const run = await runArgv(tool, ["-c", file.absolute], { cwd: context.root, env: workspace.env, timeoutMs: (spec.timeout ?? 0) * 1000 || OFFLINE_TIMEOUT_MS, signal: context.signal });
      total += run.durationMs;
      if (run.reason || run.exitCode !== 0) {
        const result = fromRun(base, display("junoser", ["-c", file.relative]), { ...run, durationMs: total });
        const first = /Invalid syntax:\s*(.*)/.exec(result.stderr) ?? /Invalid syntax:\s*(.*)/.exec(result.stdout);
        return { ...result, reason: result.reason ?? (first ? `Junoser could not read ${file.relative}: ${first[1]!.trim().slice(0, 200)} (it may be newer syntax)` : undefined) };
      }
    }
    return {
      ...base, status: "pass", exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: total,
      command: display("junoser", ["-c", ...(files.length === 1 ? [files[0]!.relative] : [`${files.length} files`])]),
    };
  });
}

async function yanglint(base: Base, spec: NetworkCheckSpec, context: NetworkCheckContext): Promise<NetworkCheckResult> {
  const tool = which("yanglint", context);
  if (!tool) return notRun(base, `yanglint is not installed (${INSTALL_HINTS.yanglint})`, "tool");
  const models: string[] = [];
  for (const folder of spec.models ?? []) {
    try {
      const absolute = await resolveInside(context.root, folder);
      if (!(await lstat(absolute)).isDirectory()) throw new Error(`${folder} is not a folder`);
      models.push(absolute);
    } catch {
      return notRun(base, `the YANG models folder ${folder} is not there (for AOS-CX, the models for your release come from github.com/aruba/aoscx-yang)`, "input");
    }
  }
  let modules; let data;
  try {
    modules = await expandFiles(context.root, spec.modules ?? []);
    data = await expandFiles(context.root, spec.files ?? []);
  } catch (error) { return notRun(base, error instanceof Error ? error.message : String(error), "input"); }
  if (!data.length) return notRun(base, "no data files to check", "input");
  const args = ["-t", "config", ...models.flatMap((folder) => ["-p", folder]), ...modules.map((file) => file.absolute), ...data.map((file) => file.absolute)];
  const shown = ["-t", "config", ...(spec.models ?? []).flatMap((folder) => ["-p", folder]), ...modules.map((file) => file.relative), ...data.map((file) => file.relative)];
  return withWorkspace(() => plainWorkspace({ tmpRoot: context.tmpRoot, realHome: context.realHome, path: context.path }), async (workspace) =>
    fromRun(base, display("yanglint", shown), await runArgv(tool, args, { cwd: context.root, env: workspace.env, timeoutMs: (spec.timeout ?? 0) * 1000 || OFFLINE_TIMEOUT_MS, signal: context.signal })));
}

/** The project's Python as an argument list: uv, poetry, a project virtualenv, else the system Python. */
export async function pythonArgv(root: string, platform: NodeJS.Platform = process.platform): Promise<{ argv: string[]; install: string }> {
  const has = async (name: string, kind: "file" | "dir" = "file") => {
    try { const info = await lstat(path.join(root, name)); return kind === "file" ? info.isFile() : info.isDirectory(); } catch { return false; }
  };
  if (await has("uv.lock")) return { argv: ["uv", "run", "--no-sync", "python"], install: "uv add --dev hier-config" };
  if (await has("poetry.lock")) return { argv: ["poetry", "run", "python"], install: "poetry add --group dev hier-config" };
  for (const venv of [".venv", "venv"]) {
    if (await has(venv, "dir")) {
      return { argv: [platform === "win32" ? path.join(root, venv, "Scripts", "python.exe") : path.join(root, venv, "bin", "python")], install: `${venv} pip install hier-config` };
    }
  }
  return { argv: [platform === "win32" ? "python" : "python3"], install: "pip install hier-config" };
}

function readReport(stdout: string): HierConfigReport | undefined {
  try {
    const value = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
    if (typeof value.change_lines !== "number" || typeof value.undo_lines !== "number") return undefined;
    return {
      changeLines: value.change_lines, undoLines: value.undo_lines,
      remediation: scrub(String(value.remediation ?? "")).slice(0, 16_384), rollback: scrub(String(value.rollback ?? "")).slice(0, 16_384),
    };
  } catch { return undefined; }
}

async function hierConfig(base: Base, spec: NetworkCheckSpec, context: NetworkCheckContext): Promise<NetworkCheckResult> {
  let running: string; let intended: string;
  try {
    running = await resolveInside(context.root, spec.running!);
    intended = await resolveInside(context.root, spec.intended!);
  } catch (error) { return notRun(base, error instanceof Error ? error.message : String(error), "input"); }
  const python = await pythonArgv(context.root, context.platform ?? process.platform);
  const program = path.isAbsolute(python.argv[0]!) ? python.argv[0]! : which(python.argv[0]!, context);
  if (!program) return notRun(base, `${python.argv[0]} is not installed`, "tool");
  return withWorkspace(() => pythonWorkspace({ tmpRoot: context.tmpRoot, realHome: context.realHome, path: context.path }), async (workspace) => {
    const script = path.join(workspace.dir, "hier_config_diff.py");
    await writeFile(script, hierConfigScript, { mode: 0o600, flag: "wx" });
    const args = [...python.argv.slice(1), script, spec.platform!, running, intended];
    const run = await runArgv(program, args, { cwd: context.root, env: workspace.env, timeoutMs: (spec.timeout ?? 0) * 1000 || OFFLINE_TIMEOUT_MS, signal: context.signal, outputBytes: 65_536 });
    const command = `hier_config diff ${spec.running} -> ${spec.intended}`;
    if (run.exitCode === 3) return { ...notRun(base, `hier_config is not installed (${python.install})`, "tool"), command, durationMs: run.durationMs };
    if (run.exitCode === 0) {
      const report = readReport(run.stdout);
      if (report) return { ...fromRun(base, command, run), stdout: "", report };
    }
    return { ...fromRun(base, command, run), status: "fail", reason: run.reason ?? "hier_config did not give a diff" };
  });
}

/** Offline and report checks. Lab checks go through prepareLabCheck; asking this for one is refused. */
export async function runNetworkCheck(name: string, spec: NetworkCheckSpec, context: NetworkCheckContext): Promise<NetworkCheckResult> {
  const base: Base = { name, kind: spec.kind, preset: spec.preset, cwd: context.root };
  if (spec.kind === "lab") return { ...notRun(base, labModelRefusal(name), "lab"), status: "skip" };
  if (!spec.preset) throw new Error(`${name} is a run command, not a ready-made network check`);
  const platform = context.platform ?? process.platform;
  if (platform === "win32" && (spec.preset === "ansible-syntax" || spec.preset === "ansible-render")) return notRun(base, WINDOWS_REASON, "platform");
  switch (spec.preset) {
    case "ansible-syntax": return ansibleSyntax(base, spec, context, false);
    case "ansible-render": return ansibleSyntax(base, spec, context, true);
    case "junoser": return junoser(base, spec, context);
    case "yanglint": return yanglint(base, spec, context);
    case "hier-config": return hierConfig(base, spec, context);
    default: throw new Error(`${name}: ${spec.preset} is a lab check`);
  }
}

export interface LabAsk {
  /** The question, then the hosts. */
  text: string;
  /** Numbered choices, in order: "Skip" (so Enter never reaches a device), "Run on the lab", then "Always for this project" (junos-commit only). */
  choices: string[];
  /** Always the limit of what Casper checked. */
  note: string;
}

export type LabPlan =
  | { state: "not-run"; result: NetworkCheckResult }
  | { state: "refused"; message: string; result: NetworkCheckResult }
  | { state: "ready"; hosts: LabHost[]; ask: LabAsk; approvalKey: string; allowAlways: boolean; run(): Promise<NetworkCheckResult> };

function formatHosts(hosts: readonly LabHost[]): string {
  const names = hosts.slice(0, 12).map((host) => host.name);
  return names.join(", ") + (hosts.length > 12 ? ` and ${hosts.length - 12} more` : "");
}

export function labAskFor(name: string, preset: NetworkPreset, hosts: readonly LabHost[]): LabAsk {
  const count = hosts.length;
  if (preset === "junos-commit") {
    return {
      text: `Run ${name} on your lab? It loads the change on ${count} lab ${count === 1 ? "router" : "routers"}, runs commit check, then rolls back. ${formatHosts(hosts)}`,
      choices: ["Skip", "Run on the lab", "Always for this project"], note: LAB_LIMIT_NOTE,
    };
  }
  return {
    text: `Run ${name} on your lab? It uses ansible --check, and a dry run is not guaranteed: some modules can still change the switches. ${formatHosts(hosts)}`,
    choices: ["Skip", "Run on the lab"], note: LAB_LIMIT_NOTE,
  };
}

/** "1 Skip · 2 Run on the lab" */
export function numberedChoices(choices: readonly string[]): string {
  return choices.map((choice, index) => `${index + 1} ${choice}`).join(" · ");
}

function junosFormat(file: string): string {
  if (/\.set$/i.test(file)) return "set";
  if (/\.xml$/i.test(file)) return "xml";
  if (/\.json$/i.test(file)) return "json";
  return "text";
}

/**
 * Check everything a lab check needs before anything reaches a device: the
 * platform, the lab list, the tools, a plain inventory whose hosts are all on
 * the lab list, and (for ansible --check) playbooks that name no other
 * targets. Only a "ready" plan can run, and only after the user picks 1 (or 2
 * "Always" for junos-commit). Nothing here asks the model anything.
 */
export async function prepareLabCheck(name: string, spec: NetworkCheckSpec, context: NetworkCheckContext): Promise<LabPlan> {
  const label = spec.preset === "ansible-check" ? DRY_RUN_LABEL : COMMIT_CHECK_LABEL;
  const base: Base = { name, kind: "lab", preset: spec.preset, cwd: context.root, label };
  const skip = (reason: string, kind: NonNullable<NetworkCheckResult["notRun"]>): LabPlan => ({ state: "not-run", result: notRun(base, reason, kind) });
  const refuse = (message: string): LabPlan => ({ state: "refused", message, result: notRun(base, message, "lab") });
  if (spec.kind !== "lab" || (spec.preset !== "junos-commit" && spec.preset !== "ansible-check")) throw new Error(`${name} is not a lab check`);
  if ((context.platform ?? process.platform) === "win32") return skip(WINDOWS_REASON, "platform");
  if (!context.lab || !context.lab.hosts.length) return skip(NO_LAB_REASON, "lab");
  const playbookTool = which("ansible-playbook", context);
  const inventoryTool = which("ansible-inventory", context);
  if (!playbookTool) return skip(`ansible-playbook is not installed (${INSTALL_HINTS["ansible-playbook"]})`, "tool");
  if (!inventoryTool) return skip(`ansible-inventory is not installed (${INSTALL_HINTS["ansible-inventory"]})`, "tool");

  let inventory: string;
  try { inventory = await checkInventoryFile(context.root, spec.inventory!); } catch (error) {
    return refuse(`Refused: ${name}: ${error instanceof Error ? error.message : String(error)}. Nothing was sent.`);
  }
  let files: { relative: string; absolute: string }[] = [];
  if (spec.preset === "junos-commit") {
    try {
      files = await expandFiles(context.root, spec.files ?? []);
      if (files.length !== 1) throw new Error("junos-commit needs exactly one change file");
    } catch (error) { return skip(error instanceof Error ? error.message : String(error), "input"); }
  } else {
    for (const playbook of spec.playbooks ?? []) {
      try { await resolveInside(context.root, playbook); } catch (error) { return skip(error instanceof Error ? error.message : String(error), "input"); }
      const finding = await scanPlaybookReach(context.root, playbook);
      if (finding) return refuse(reachRefusalText(finding));
    }
  }

  const listed = await withWorkspace(() => ansibleWorkspace({ tmpRoot: context.tmpRoot, realHome: context.realHome, path: context.path }),
    (workspace) => labHosts(inventory, { cwd: context.root, env: workspace.env, ansibleInventory: inventoryTool, signal: context.signal }));
  if (listed.vault) return skip(VAULT_REASON, "vault");
  if (listed.problem) return refuse(`Refused: ${name}: ${listed.problem}. Nothing was sent.`);
  const guard = guardLab(listed.hosts, context.lab);
  if (!guard.ok) return guard.reason === NO_LAB_REASON ? skip(NO_LAB_REASON, "lab") : refuse(labRefusalText(name, guard));

  const hosts = listed.hosts;
  const approvalKey = labApprovalKey(name, { inventory, hosts, files: files.map((file) => file.absolute) });
  const timeoutMs = (spec.timeout ?? 0) * 1000 || LAB_TIMEOUT_MS;
  const labBase: Base = { ...base, hosts: hosts.map((host) => host.name) };
  const run = async (): Promise<NetworkCheckResult> => withWorkspace(
    () => ansibleWorkspace({ tmpRoot: context.tmpRoot, realHome: context.realHome, path: context.path, keepHome: true }),
    async (workspace) => {
      if (spec.preset === "junos-commit") {
        const playbook = path.join(workspace.dir, "junos_commit_check.yml");
        const vars = path.join(workspace.dir, "vars.json");
        await writeFile(playbook, junosCommitPlaybook, { mode: 0o600, flag: "wx" });
        await writeFile(vars, JSON.stringify({ casper_src: files[0]!.absolute, casper_format: junosFormat(files[0]!.absolute) }), { mode: 0o600, flag: "wx" });
        const execution = await runArgv(playbookTool, ["-i", inventory, playbook, "-e", `@${vars}`], { cwd: context.root, env: workspace.env, timeoutMs, signal: context.signal });
        return ansibleResult(labBase, `juniper.device.config check on ${hosts.length} lab ${hosts.length === 1 ? "router" : "routers"}`, execution);
      }
      return eachPlaybook(labBase, spec.playbooks ?? [], async (playbook) => {
        const absolute = await resolveInside(context.root, playbook);
        const execution = await runArgv(playbookTool, ["--check", "--diff", "-i", inventory, absolute], { cwd: context.root, env: workspace.env, timeoutMs, signal: context.signal });
        return ansibleResult(labBase, `ansible --check on ${hosts.length} lab ${hosts.length === 1 ? "switch" : "switches"}`, execution);
      });
    });
  return {
    state: "ready", hosts, approvalKey, allowAlways: spec.preset === "junos-commit",
    ask: labAskFor(name, spec.preset, hosts), run,
  };
}

/** How a result may be repaired: never for not-run skips or reports, only after asking for lab checks. */
export function repairClass(result: NetworkCheckResult): "repairable" | "ask" | "never" {
  if (result.status !== "fail" || result.kind === "report") return "never";
  if (result.kind === "lab") return "ask";
  if (result.ended) return "never";
  return "repairable";
}

/** Extra words for the repair prompt. */
export function repairNote(result: NetworkCheckResult): string | undefined {
  return result.preset === "junoser" ? JUNOSER_NOTE : undefined;
}

export function labFailureAsk(name: string): { text: string; choices: string[]; defaultChoice: number } {
  return {
    text: `${name} failed on the lab. Casper did not ask the model to fix it, because each try touches lab devices.`,
    // Stop first: Enter (or a stray key) never starts a paid repair that touches the lab again.
    choices: ["Stop", "Ask the model to fix it"], defaultChoice: 1,
  };
}
export const labStoppedReason = (name: string): string => `${name} failed on the lab; stopped without asking the model to fix it`;

/** Reports never make a run pass or fail; lab passes with "dry run not guaranteed" are not grounds for Verified. */
export function countsTowardVerified(result: NetworkCheckResult): boolean {
  if (result.kind === "report") return false;
  if (result.label === DRY_RUN_LABEL) return false;
  return true;
}

/** The status over checks that count: reports are left out entirely. */
export function networkStatus(results: readonly NetworkCheckResult[]): "pass" | "fail" | "incomplete" {
  const counted = results.filter((result) => result.kind !== "report");
  if (counted.some((result) => result.status === "fail")) return "fail";
  if (!counted.length || counted.some((result) => result.status === "skip")) return "incomplete";
  return "pass";
}

function plain(text: string): string { return text.replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, " "); }

/** One check line for the terminal and the receipt. Never says "offline": that is not enforced yet. */
export function formatNetworkCheckLine(result: NetworkCheckResult): string {
  if (result.status === "skip") return `– ${result.name}  not run: ${plain(result.reason ?? "skipped")}`;
  if (result.kind === "report") {
    if (result.report) return `• ${result.name}  ${result.report.changeLines} lines to change · ${result.report.undoLines} to undo (a diff, not a pass/fail check)`;
    return `• ${result.name}  no diff: ${plain(result.reason ?? "hier_config failed")} (a diff, not a pass/fail check)`;
  }
  const mark = result.status === "pass" ? "✓" : "✗";
  const parts = [result.label, result.status === "fail" ? (result.reason ?? (result.exitCode === null ? result.signal : `exit ${result.exitCode}`)) : undefined, formatDuration(result.durationMs)]
    .filter((part): part is string => !!part).map(plain);
  return `${mark} ${result.name}${result.command ? `  ${plain(result.command)}` : ""}  (${parts.join(" · ")})`;
}

/** Additive JSON event and receipt fields. */
export function networkEventFields(result: NetworkCheckResult): { kind: NetworkCheckResult["kind"]; label?: string; hosts?: string[] } {
  return { kind: result.kind, ...(result.label ? { label: result.label } : {}), ...(result.hosts ? { hosts: [...result.hosts] } : {}) };
}

/** What casper_check hands the model: bounded and already scrubbed. */
export function networkResultForModel(result: NetworkCheckResult): Record<string, unknown> {
  return {
    name: result.name, status: result.status, kind: result.kind, ...(result.label ? { label: result.label } : {}),
    command: result.command, exitCode: result.exitCode, reason: result.reason, truncated: result.truncated,
    stdout: scrub(result.stdout), stderr: scrub(result.stderr),
    ...(result.report ? { report: { ...result.report, remediation: scrub(result.report.remediation), rollback: scrub(result.report.rollback) } } : {}),
    ...(repairNote(result) && result.status === "fail" ? { note: repairNote(result) } : {}),
  };
}
