import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration, type AskQuestions, type Autonomy, type CasperPolicy, type GitActionPolicy, type LoadedConfiguration } from "../config/load";
import type { VisualizationSettings } from "../visualize/router";
import type { ProjectInfo } from "./inspect";
import { loadProjectModel, projectStateDirectory, type ProjectModel } from "./model";
import { detectMigrations } from "../verify/migrations";
import { detectE2e } from "../verify/e2e";
import { detectAnsible } from "../network/ansible";
import type { LabSettings } from "../network/spec";
import type { NamedCheckSpec } from "../verify/named";

export interface ProjectContext {
  info: ProjectInfo;
  stateDirectory: string;
  model: ProjectModel;
  profileName: string;
  policy: CasperPolicy;
  skills: LoadedConfiguration["skills"];
  verification: LoadedConfiguration["verification"];
  repair: LoadedConfiguration["repair"];
  /** `suggestions: false` in the user's config: no suggestions anywhere. */
  suggestions?: boolean;
  /** `updates: false` in the user's config: no new-version line at the start of a session. */
  updates?: boolean;
  /** `sideQuestions: false` in the user's config: a line starting with `?` is an ordinary request. */
  sideQuestions?: boolean;
  /** `localModels: false` in the user's config: no model servers on this computer are looked for. */
  localModels?: boolean;
  /** `cache:` in the user's config (auto, long, short or off). Unset: auto. */
  cache?: LoadedConfiguration["cache"];
  /** `display:` in the user's config (quiet, normal or detailed). Unset: normal. */
  display?: LoadedConfiguration["display"];
  /** `theme:` in the user's config: the screen's colours, by name. Unset: default. */
  theme?: string;
  /** `showPages:` in the user's config (ask, on or off). Unset: ask once a session. */
  showPages?: LoadedConfiguration["showPages"];
  /** `delegate.build: false`: the AI starts no builders. Unset: on. */
  delegate?: LoadedConfiguration["delegate"];
  /** Per-task spend limits (a note, then a pause); see src/task/spend.ts. */
  spend?: LoadedConfiguration["spend"];
  visualize: VisualizationSettings;
  /** `browser: off` in the user's config: the AI's browser tool is never offered. Unset: on. */
  browser?: boolean;
  /** `templates: off` in the user's config: a first request that fits a template is never built for you. Unset: on. */
  templates?: boolean;
  /** `packs: off` in the user's config: the packs you added are not used and /pack add adds none. Unset: on. */
  packs?: boolean;
  /** `github: off` in the user's config: the AI is never offered the github tool. Unset: on. */
  github?: boolean;
  /** `visualize: off` in the user's config: the AI's diagram tool is never offered. Unset: on. */
  diagrams?: boolean;
  /** Managed services declared in .casper/project.yaml (see docs/SERVICES.md). */
  services?: LoadedConfiguration["services"];
  /** Configured smoke checks, run after every change (see docs/VERIFICATION.md). */
  smoke?: LoadedConfiguration["smoke"];
  /** The pages: setting: pages the page check always opens, or off (see docs/VERIFICATION.md). */
  pages?: LoadedConfiguration["pages"];
  /** `pages: off` in the user's config: no page checks in any project. Unset: on. */
  pageChecks?: boolean;
  /** `tools: { downloads: off }` in the user's config: Casper fetches no programs (ripgrep). Unset: on. */
  toolDownloads?: boolean;
  /** `ssh_login: off` in the user's config: no private password box for ssh. Unset: on. */
  sshLogin?: boolean;
  /** `telemetry: off` in the user's config: no OpenRouter app-name headers. Unset: on. */
  telemetry?: boolean;
  rules: {
    profile: string | null;
    project: string | null;
  };
  /** Configuration keys that were ignored, by file (see LoadedConfiguration.warnings). */
  warnings?: string[];
  /** A digest of .casper/project.yaml as it was read for this context (undefined when there is none): a task that
   * rewrites it does not change the checks it runs (see projectAfterSetup in app.ts). */
  projectFile?: string;
  /** The user's lab list (lab.hosts), from ~/.casper/config.yaml or the profile only. */
  lab?: LabSettings;
  /** The profile whose own lab list is in force, when it has one (/lab import adds there). */
  labProfile?: string;
  /** The shell sandbox settings: yours, and the project's extra denies (see src/sandbox/policy.ts). */
  sandbox?: LoadedConfiguration["sandbox"];
  /** Web lookups: yours only (web: in ~/.casper/config.yaml). Unset: on, with DuckDuckGo. */
  web?: LoadedConfiguration["web"];
  /** The untrusted-text reader: on/off yours only; untrusted paths from you or the project. Unset: on, no paths. */
  reader?: LoadedConfiguration["reader"];
}

export interface LoadProjectContextOptions {
  homeDir?: string;
  profileName?: string;
}

/** A digest of the project's .casper/project.yaml as it is now; undefined when there is none. */
export function projectFileDigest(root: string): Promise<string | undefined> {
  return readFile(path.join(root, ".casper", "project.yaml"))
    .then((bytes) => createHash("sha256").update(bytes).digest("hex"), () => undefined);
}

export async function loadProjectContext(
  info: ProjectInfo,
  options: LoadProjectContextOptions = {},
): Promise<ProjectContext> {
  const homeDir = options.homeDir ?? os.homedir();
  const projectFile = await projectFileDigest(info.root);
  const configuration = await loadConfiguration({
    projectRoot: info.root,
    homeDir,
    profileName: options.profileName,
  });
  const detected = await loadProjectModel(info, {
    homeDir,
    overrides: configuration.projectOverrides,
  });
  // The migrations check is found from the project's own files each time it is opened.
  const migrations = await detectMigrations(info.root).catch(() => undefined);
  // So are Ansible playbooks: the language and platforms, and ready-made checks to offer (never saved or run on their own).
  const ansible = await detectAnsible(info.root).catch(() => undefined);
  // And Playwright tests the project already has, unless verification.e2e is false (/settings).
  const e2e = configuration.verification.e2e === false ? undefined : await detectE2e(info.root, detected.packageManager).catch(() => undefined);
  let model = migrations ? { ...detected, migrations } : detected;
  if (e2e && !model.namedChecks?.e2e) model = { ...model, e2e };
  if (ansible) {
    const found: Record<string, NamedCheckSpec> = {};
    for (const [name, spec] of Object.entries(ansible.checks)) if (!model.namedChecks?.[name]) found[name] = spec;
    const overrides = configuration.projectOverrides;
    model = {
      ...model,
      languages: overrides.languages ? model.languages : [...new Set([...model.languages, "ansible"])].sort(),
      frameworks: overrides.frameworks ? model.frameworks : [...new Set([...model.frameworks, ...ansible.frameworks])].sort(),
      ...(Object.keys(found).length ? { foundChecks: found } : {}),
    };
  }

  return {
    info,
    stateDirectory: projectStateDirectory(info.root, homeDir),
    model,
    profileName: configuration.profileName,
    policy: configuration.policy,
    skills: configuration.skills,
    verification: configuration.verification,
    repair: configuration.repair,
    ...(configuration.suggestions !== undefined ? { suggestions: configuration.suggestions } : {}),
    ...(configuration.updates !== undefined ? { updates: configuration.updates } : {}),
    ...(configuration.sideQuestions !== undefined ? { sideQuestions: configuration.sideQuestions } : {}),
    ...(configuration.localModels !== undefined ? { localModels: configuration.localModels } : {}),
    ...(configuration.cache ? { cache: configuration.cache } : {}),
    ...(configuration.display ? { display: configuration.display } : {}),
    ...(configuration.theme ? { theme: configuration.theme } : {}),
    ...(configuration.showPages ? { showPages: configuration.showPages } : {}),
    ...(configuration.delegate ? { delegate: configuration.delegate } : {}),
    spend: configuration.spend,
    visualize: configuration.visualize,
    ...(configuration.browser !== undefined ? { browser: configuration.browser } : {}),
    ...(configuration.templates !== undefined ? { templates: configuration.templates } : {}),
    ...(configuration.packs !== undefined ? { packs: configuration.packs } : {}),
    ...(configuration.github !== undefined ? { github: configuration.github } : {}),
    ...(configuration.diagrams !== undefined ? { diagrams: configuration.diagrams } : {}),
    services: configuration.services,
    smoke: configuration.smoke,
    ...(configuration.pages ? { pages: configuration.pages } : {}),
    ...(configuration.pageChecks !== undefined ? { pageChecks: configuration.pageChecks } : {}),
    ...(configuration.telemetry !== undefined ? { telemetry: configuration.telemetry } : {}),
    ...(configuration.sshLogin !== undefined ? { sshLogin: configuration.sshLogin } : {}),
    ...(configuration.toolDownloads !== undefined ? { toolDownloads: configuration.toolDownloads } : {}),
    rules: {
      profile: configuration.profileRules,
      project: configuration.projectRules,
    },
    warnings: configuration.warnings,
    ...(configuration.lab ? { lab: configuration.lab } : {}),
    ...(configuration.labProfile ? { labProfile: configuration.labProfile } : {}),
    sandbox: configuration.sandbox,
    web: configuration.web,
    reader: configuration.reader,
    ...(projectFile ? { projectFile } : {}),
  };
}

function list(values: string[]): string {
  return values.length ? values.join(", ") : "not detected";
}

function commands(model: ProjectModel): string {
  const entries = Object.entries(model.commands);
  return entries.length
    ? entries.map(([name, command]) => `${name}=${command}`).join("; ")
    : "not detected";
}

// Plain meanings, so the model reads an instruction rather than a bare word.
const AUTONOMY: Record<Autonomy, string> = {
  high: "high: do the next step yourself when it is inside this project (edit files, including ignored ones such as *.local.json, run the tests, change settings the user asked for). Never tell the user to open or hand-edit a file you can edit. Never hand the user a script to run outside Casper. If something outside the project is needed, say what in one line and ask one numbered question.",
  medium: "medium: do small steps inside this project yourself; ask one numbered question before large or wide changes.",
  low: "low: ask one numbered question before changing files.",
};

const ASK_QUESTIONS: Record<AskQuestions, string> = {
  onlyWhenBlocked: "only when blocked",
  beforeChanges: "before changing files",
};

function gitRule(policy: GitActionPolicy): string {
  return policy === "never" ? "never" : "only when the user asks";
}

/** "- label: a, b" with the flags that are on; nothing when none is. */
function line(label: string, flags: Array<[boolean, string]>): string[] {
  const on = flags.filter(([value]) => value).map(([, name]) => name);
  return on.length ? [`- ${label}: ${on.join(", ")}`] : [];
}

export function formatProjectContext(context: ProjectContext): string {
  const { model, policy, rules } = context;
  const sections = [
    "Casper project context (deterministically detected and cached):",
    `- project: ${model.project.name}`,
    `- root: ${model.project.root}`,
    `- languages: ${list(model.languages)}`,
    `- frameworks: ${list(model.frameworks)}`,
    `- package manager: ${model.packageManager ?? "not detected"}`,
    `- commands: ${commands(model)}`,
    `- selected profile: ${context.profileName}`,
    "Casper policy:",
    `- autonomy: ${AUTONOMY[policy.behavior.autonomy]}`,
    `- ask questions: ${ASK_QUESTIONS[policy.behavior.askQuestions]}`,
    // On/off flags as one plain line each; a flag that is off is left out.
    ...line("work style", [[policy.behavior.inspectBeforeEditing, "inspect before editing"], [policy.code.preferSmallChanges, "prefer small changes"],
      [policy.code.preserveArchitecture, "preserve architecture"], [policy.code.avoidUnnecessaryDependencies, "avoid unnecessary dependencies"]]),
    // Instructions to the model, not rules Casper enforces: bash can still run git or rm.
    ...(gitRule(policy.git.commit) === gitRule(policy.git.push) ? [`- git commit and push: ${gitRule(policy.git.commit)}`]
      : [`- git commit: ${gitRule(policy.git.commit)}`, `- git push: ${gitRule(policy.git.push)}`]),
    "- ask the user first before deleting files they didn't ask to delete, git reset, or force-push. Creating and editing files in this project needs no ask.",
    "- never set aside or discard uncommitted work: git stash, reset --hard, checkout --, restore and clean are blocked",
    ...line("isolate", [[policy.workspace.isolateWhen.parallelAgents, "parallel agents"], [policy.workspace.isolateWhen.riskyRefactor, "risky refactors"],
      [policy.workspace.isolateWhen.experimentalBranch, "experimental branches"]]),
  ];

  if (rules.profile) {
    sections.push("Profile rules:", rules.profile);
  }
  if (rules.project) {
    sections.push("Project rules (higher precedence than profile rules):", rules.project);
  }
  const structure = Object.entries(model.architecture);
  if (structure.length || model.conventions.length) {
    sections.push("Repository structure (from the tree, not a skill):");
    for (const [name, value] of structure) sections.push(`- ${name}: ${value}`);
    for (const convention of model.conventions) sections.push(`- ${convention}`);
  }

  return sections.join("\n");
}
