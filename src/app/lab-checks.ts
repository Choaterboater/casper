/**
 * The app's side of device (lab) checks. Casper reads the inventory and the playbook text first
 * (src/network/checks.ts prepareLabCheck), then asks one numbered question naming every device, and only a person's
 * answer starts anything: for your own /verify <name>, or when the AI asks through casper_check. A run that cannot
 * ask (one-shot, --json, a pipe) sends nothing and says so. Auto mode never selects device checks.
 */
import { COMMIT_CHECK_LABEL, DRY_RUN_LABEL, labFailureAsk, prepareLabCheck, type NetworkCheckContext } from "../network/checks";
import { labAlwaysAllowed, rememberLabAlways } from "../network/lab";
import type { LabSettings } from "../network/spec";
import type { VerificationResult } from "../verify/evidence";
import { fromNetworkResult, type NamedCheckRunner, type NetworkToolContext } from "../verify/registry";
import { terminalText } from "../tui/format";
import { YES_ALWAYS, YES_ONCE } from "./safe-choices";

export const LAB_NEEDS_ANSWER = "lab checks need your answer at the terminal, and this run cannot ask; nothing was sent";
export const LAB_SKIPPED = "you chose No; nothing was sent";

export interface LabCheckHost {
  /** A person can answer a numbered question now. */
  canAsk(): boolean;
  /** One numbered question from Casper; the chosen label, or undefined (Esc, closed, cancelled). */
  pick(question: string, options: { label: string; description?: string }[], signal?: AbortSignal): Promise<string | undefined>;
  write(text: string): void;
  /** Where "Yes, always for this project" is kept (~/.casper/projects/<id>). */
  stateDirectory: string;
  /** From ~/.casper/config.yaml or the profile only. */
  lab?: LabSettings;
  network?: NetworkToolContext;
}

/**
 * The runner the registry calls for a device (lab) check. `origin` "user" is your own /verify <name>: a saved
 * "Yes, always for this project" answer runs it without the box. "ai" is the AI asking through casper_check: the box
 * shows every time, never offers Always, and a run that can't ask sends nothing.
 */
export function labCheckRunner(host: LabCheckHost, origin: "user" | "ai" = "user"): NamedCheckRunner {
  return async (name, spec, context) => {
    const networkContext: NetworkCheckContext = { ...host.network, root: context.cwd, ...(host.lab ? { lab: host.lab } : {}),
      ...(context.signal ? { signal: context.signal } : {}) };
    const plan = await prepareLabCheck(name, spec, networkContext);
    if (plan.state !== "ready") return fromNetworkResult(plan.result);
    // A lab check that did not run keeps its label ("dry run not guaranteed") in the JSON check event too.
    const label = spec.preset === "ansible-check" ? DRY_RUN_LABEL : COMMIT_CHECK_LABEL;
    const skipped = (reason: string): VerificationResult => ({ name, cwd: context.cwd, status: "skip", kind: "lab", label, exitCode: null, signal: null,
      stdout: "", stderr: "", truncated: false, durationMs: 0, reason, repair: "never", hosts: plan.hosts.map((host) => host.name) });
    const always = plan.allowAlways && origin === "user";
    if (always && await labAlwaysAllowed(host.stateDirectory, name, plan.approvalKey)) {
      host.write(`Running ${name} on your lab (you chose Yes, always for this project).\n`);
    } else {
      if (!host.canAsk()) return skipped(LAB_NEEDS_ANSWER);
      const warnings = plan.ask.warnings.map((line) => `${terminalText(line)}\n`).join("");
      const choices = always ? plan.ask.choices : plan.ask.choices.filter((label) => label !== YES_ALWAYS);
      const answer = await host.pick(`${terminalText(plan.ask.text)}\n${warnings}${plan.ask.note}`, choices.map((label) => ({ label })), context.signal);
      if (answer === YES_ALWAYS && always) {
        await rememberLabAlways(host.stateDirectory, name, plan.approvalKey);
      } else if (answer !== YES_ONCE) return skipped(LAB_SKIPPED);
    }
    return fromNetworkResult(await plan.run());
  };
}

/** What each choice after a lab failure does; the repair costs tokens, and it says so before it is chosen. */
export const LAB_FAILURE_WHY: Record<string, string> = {
  "Stop": "keep the files as they are; nothing more runs on the lab",
  "Ask the model to fix it": "the model changes the files, then the check runs on the lab again",
};

/**
 * A lab check failed: "junos-commit failed on the lab. Casper did not ask the model to fix it, because each try
 * touches lab devices." Stop comes first, so a stray Enter never starts a paid repair that touches the lab.
 */
export async function askLabFailure(host: Pick<LabCheckHost, "pick">, failures: readonly VerificationResult[], signal?: AbortSignal): Promise<"repair" | "stop"> {
  const names = [...new Set(failures.map((failure) => failure.name))].join(", ");
  const ask = labFailureAsk(names);
  const answer = await host.pick(ask.text, ask.choices.map((label) => ({ label, description: LAB_FAILURE_WHY[label] })), signal);
  return answer === "Ask the model to fix it" ? "repair" : "stop";
}
