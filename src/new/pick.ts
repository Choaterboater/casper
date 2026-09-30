import { listTemplates, NAME_RULE, projectSlug, validName, type TemplateManifest } from "./templates";

/**
 * Which template a build request looks like, from the words alone: local, zero tokens. Used only
 * outside a project, before any model call, to ask once: "Build this as a new … ? 1 Use this folder ·
 * 2 Yes · 3 Other kind". A wrong guess costs one key press, and Enter builds nothing.
 */

export interface NewProjectSuggestion {
  template: string;
  name: string;
  /** "Mist Python project", for the question. */
  kind: string;
}

const LEAD = /^(?:(?:please|pls|ok|okay|hey|so|now)[,\s]+)*(?:(?:can|could|would|will) you\s+|i (?:want|need|would like|'d like) (?:you )?to\s+|i'd like to\s+|let'?s\s+|help me\s+|go\s+)?/;
const VERB = /^(build|create|make|write|start|scaffold|set up|setup|new)\b\s*/;
const OBJECT = new Set(["tool", "tools", "script", "scripts", "app", "apps", "application", "server", "dashboard", "project", "cli",
  "bot", "playbook", "playbooks", "website", "webapp", "utility", "program"]);
const GENERIC = new Set(["project", "app", "apps", "application", "program"]);
/** Words that end the object phrase: after them comes what it does, not what it is. */
const CLAUSE = new Set(["that", "which", "who", "to", "for", "with", "so", "where", "using", "in", "on", "from", "and"]);
const MAX_MODIFIERS = 5;

type Kind = { template: string; test: (text: string) => boolean };

/** Keyword map, first match wins. Ansible without a vendor is ambiguous. */
const KINDS: Kind[] = [
  { template: "network-mcp", test: (t) => /\bmcp\b/.test(t) },
  { template: "noc-dashboard", test: (t) => /\b(dashboard|noc)\b/.test(t) },
  { template: "web-app", test: (t) => /\b(web ?app|website|web site|web page|react|frontend|front-end)\b/.test(t) },
  { template: "aoscx-ansible", test: (t) => /\b(ansible|playbooks?)\b/.test(t) && /\b(aruba|aos-?cx|cx switch(es)?|cx)\b/.test(t) },
  { template: "junos-ansible", test: (t) => /\b(ansible|playbooks?)\b/.test(t) && /\b(junos|juniper|srx|qfx|ex\d{4}|mx\d+)\b/.test(t) },
  { template: "ask", test: (t) => /\b(ansible|playbooks?)\b/.test(t) },
  { template: "mist-python", test: (t) => /\bmist\b/.test(t) },
];

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** A template and folder name for a build request, "ask" when it is one but the kind is unclear, else undefined. */
export function newProjectSuggestion(prompt: string, templates: readonly TemplateManifest[] = listTemplates()): NewProjectSuggestion | "ask" | undefined {
  const text = prompt.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  const rest = text.replace(LEAD, "");
  const verb = VERB.exec(rest);
  if (!verb) return undefined;
  const after = words(rest.slice(verb[0].length).replace(/[^a-z0-9' -]/g, " "));
  let noun = -1;
  for (let index = 0; index < Math.min(after.length, MAX_MODIFIERS + 1); index++) {
    const word = after[index]!;
    if (CLAUSE.has(word)) break;
    if (OBJECT.has(word)) { noun = index; break; }
  }
  if (noun < 0) return undefined;
  const nounWord = after[noun]!;
  const matched = KINDS.find((kind) => kind.test(text));
  if (matched?.template === "ask") return "ask";
  if (!matched && GENERIC.has(nounWord)) return "ask";
  const id = matched?.template ?? "python-cli";
  const template = templates.find((entry) => entry.id === id);
  if (!template || !template.ready) return "ask";

  let name = projectSlug(after.slice(noun + 1).join(" "));
  if (!name) name = projectSlug(after.slice(0, noun + 1).join(" "));
  if (id === "network-mcp" && name && !name.split("-").includes("mcp")) name = `${name}-mcp`.slice(0, 64);
  if (!validName(name)) name = template.defaultName;
  return { template: id, name, kind: template.kind };
}

/** "Build this as a new Mist Python project in ~/Projects/mist-aps?" Use this folder comes first, so Enter never
 * builds a project. */
export function newProjectQuestion(suggestion: NewProjectSuggestion, parentDisplay: string): { question: string; choices: string[] } {
  return {
    question: `Build this as a new ${suggestion.kind} in ${parentDisplay.replace(/\/$/, "")}/${suggestion.name}?`,
    choices: ["Use this folder", "Yes", "Other kind"],
  };
}

/** "What are you building?" with one numbered choice per ready template. */
export function templateMenu(templates: readonly TemplateManifest[] = listTemplates()): { question: string; choices: string[]; ids: string[] } {
  return { question: "What are you building?", choices: templates.map((t) => t.title), ids: templates.map((t) => t.id) };
}

/**
 * The answer to "Name it? (Enter for my-tool)": empty means the default; otherwise it must be a
 * valid name. Typed text in the Yes/No question is also read as a name.
 */
export function parseNameAnswer(answer: string, fallback: string): { name: string } | { error: string } {
  const name = answer.trim() || fallback;
  return validName(name) ? { name } : { error: NAME_RULE };
}
