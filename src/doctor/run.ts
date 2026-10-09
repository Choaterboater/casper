import os from "node:os";
import path from "node:path";
import { DOCTOR_INSTALL_CHOICES, DOCTOR_UPDATE_CHOICES, numberedLines } from "../app/safe-choices";
import { hasProjectSignals } from "../project/inspect";
import { casperAgentDir } from "../runtime/agent-store";
import { installQuestion, type InstallResult } from "../security/install";
import { SECURITY_TOOLS } from "../security/tools";
import type { SecurityToolId } from "../security/types";
import { terminalText } from "../tui/format";
import type { Install } from "../update/command";
import { runningFromBinary } from "../update/mode";
import { CASPER_VERSION } from "../version";
import {
  checkConfig, checkDisk, checkLanguageServers, checkMcp, checkNetworkServer, checkPathLink, checkSandbox, checkSecurityTools, checkSignIn,
  checkVersion, type DoctorContext, type DoctorFix, type DoctorLine,
} from "./checks";

export type { DoctorContext, DoctorLine } from "./checks";

/** The Casper that is running: a release binary, or the checkout this file is in (<root>/src/doctor). */
export function runningInstall(): Install {
  return runningFromBinary(import.meta.path) ? { kind: "binary", executable: process.execPath } : { kind: "checkout", root: path.resolve(import.meta.dir, "..", "..") };
}

/** The doctor's view of this machine, looking at `folder`'s project when it is one. */
export async function doctorContext(folder: string, extra: Partial<DoctorContext> = {}): Promise<DoctorContext> {
  const homeDir = extra.homeDir ?? os.homedir();
  const inProject = path.resolve(folder) !== path.resolve(homeDir) && await hasProjectSignals(folder).catch(() => false);
  return {
    homeDir, env: process.env, platform: process.platform, currentVersion: CASPER_VERSION, install: runningInstall(), agentDir: casperAgentDir(),
    ...(inProject ? { projectRoot: path.resolve(folder) } : {}), ...extra,
  };
}

/** Every check, in the order they are shown. Independent checks run side by side. */
export async function collectDoctorLines(ctx: DoctorContext): Promise<DoctorLine[]> {
  const config = await checkConfig(ctx);
  const profile = config.loaded?.profileName ?? (ctx.env.CASPER_PROFILE || "default");
  // A check that breaks says so on its own line; the others still run.
  const settle = <T>(work: Promise<T>, what: string, wrap: (lines: DoctorLine[]) => T): Promise<T> =>
    work.catch((error: unknown) => wrap([{ status: "note", text: `${what}: not checked (${error instanceof Error ? error.message : String(error)})` }]));
  const mcp = await settle(checkMcp(ctx, profile), "MCP", (lines) => ({ lines, servers: [] }));
  const one = (work: Promise<DoctorLine[]>, what: string) => settle(work, what, (lines) => lines);
  const [version, link, signIn, network, languages, security, sandbox, disk] = await Promise.all([
    one(checkVersion(ctx), "Version"), one(checkPathLink(ctx), "casper on PATH"), one(checkSignIn(ctx, config.loaded?.localModels !== false), "Sign-in"),
    one(checkNetworkServer(ctx, mcp.servers), "Network server"), one(checkLanguageServers(ctx, profile), "Language servers"),
    one(checkSecurityTools(ctx), "Security tools"), one(checkSandbox(ctx, config.loaded), "Sandbox"), one(checkDisk(ctx), "Disk"),
  ]);
  return [...version, ...link, ...config.lines, ...signIn, ...mcp.lines, ...network, ...languages, ...security, ...sandbox, ...disk];
}

const MARK: Record<DoctorLine["status"], string> = { ok: "✓", note: "!", fail: "✗" };

export function formatDoctorLines(lines: readonly DoctorLine[]): string {
  return lines.map((line) => `${MARK[line.status]} ${terminalText(line.text)}${line.next ? `\n    → ${terminalText(line.next)}` : ""}\n`).join("");
}

export function doctorSummary(lines: readonly DoctorLine[]): string {
  const fails = lines.filter((line) => line.status === "fail").length;
  const notes = lines.filter((line) => line.status === "note").length;
  if (!fails) return notes ? `Nothing to fix. ${notes} thing${notes === 1 ? "" : "s"} worth knowing (!).` : "All good.";
  return `${fails} thing${fails === 1 ? "" : "s"} to fix (✗)${notes ? `, ${notes} worth knowing (!)` : ""}.`;
}

/** What the doctor needs from where it runs: the terminal, and the three fixes it can make. */
export interface DoctorIO {
  write(text: string): void;
  /** One numbered answer from the person ("1", "2"), or undefined when nobody can answer (a script, a pipe). */
  choose?(preview: string, choices: readonly string[]): Promise<string | undefined>;
  /** casper update. */
  update?(): Promise<{ exitCode: number }>;
  /** Installs the pinned security tools, hash-checked (as /security-review does). */
  installTools?(ids: readonly SecurityToolId[]): Promise<InstallResult[]>;
  /** The network setup, which asks its own numbered question; true when it changed something. Undefined where it
   * can't run (then it is only named). */
  networkSetup?(): Promise<boolean>;
  /** Where nobody can answer now: what to do for the fixes, in place of running casper doctor in a terminal. */
  fixesLater?: string;
}

/**
 * Checks, prints the report and offers the fixes it can make, each behind its own numbered question with 1 = Not now.
 * Exit 0 when nothing is left to fix, 1 when something is (✗). Worth-knowing lines (!) never fail it.
 */
export async function runDoctor(ctx: DoctorContext, io: DoctorIO): Promise<{ exitCode: number; lines: DoctorLine[] }> {
  io.write("Casper doctor · no model, no tokens\n");
  let lines = await collectDoctorLines(ctx);
  io.write(formatDoctorLines(lines));
  io.write(`${doctorSummary(lines)}\n`);
  const fixes = new Set<DoctorFix>(lines.flatMap((line) => line.fix ? [line.fix] : []));
  let fixed = false;
  if (fixes.size && io.choose) {
    if (fixes.has("update") && io.update) {
      const line = lines.find((entry) => entry.fix === "update")!;
      const answer = await io.choose(`${line.text}.\n${numberedLines(DOCTOR_UPDATE_CHOICES)}`, ["1", "2"]);
      if (answer === "2") { fixed = true; await io.update(); }
    }
    const missing = ctx.missingTools ?? [];
    if (fixes.has("security") && missing.length && io.installTools) {
      const question = installQuestion(missing.map((id) => SECURITY_TOOLS[id]));
      const answer = await io.choose(`${question.text}\n${numberedLines(DOCTOR_INSTALL_CHOICES)}`, ["1", "2"]);
      if (answer === "2") {
        fixed = true;
        for (const result of await io.installTools(missing)) io.write(`${terminalText(result.message)}\n`);
      }
    }
    if (fixes.has("network") && io.networkSetup && await io.networkSetup()) fixed = true;
  } else if (fixes.size) {
    io.write(io.fixesLater ?? "Run casper doctor in a terminal to have Casper make the fixes it can (it asks first).\n");
  }
  if (fixed) {
    lines = await collectDoctorLines(ctx);
    const left = lines.filter((line) => line.status === "fail");
    io.write(`\nAfter the fixes: ${doctorSummary(lines)}\n${formatDoctorLines(left)}`);
  }
  return { exitCode: lines.some((line) => line.status === "fail") ? 1 : 0, lines };
}
