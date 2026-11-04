import type { ProjectModel } from "../project/model";
import type { TaskClassification } from "../task/classify";
import type { SkillMetadata } from "./metadata";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is",
  "it", "of", "on", "or", "our", "that", "the", "their", "this", "to", "use", "using", "with",
  "you", "your", "skill", "skills", "task", "when", "guidance", "instructions",
  "add", "build", "create", "implement", "fix", "modify", "update", "change", "help",
  // Doing something again says nothing about what it is about: "re run test" is not research ("you're") or a rerun skill.
  "re", "run", "rerun", "again", "redo", "retry", "repeat", "please", "now",
  // Words of any English text, which say nothing about a topic.
  "any", "not", "no", "so", "one", "if", "its", "then", "only", "even", "also", "into", "own", "instead", "do", "does", "has", "have",
  "what", "will", "like", "them", "they", "up", "must", "where", "every", "out", "all", "can", "but", "than", "there", "these", "those",
  "which", "who", "was", "were", "been", "just", "more", "most", "some", "such", "each", "other", "about", "over", "after", "before",
  "while", "may", "would", "should", "could", "here", "via", "without", "says", "uses", "means",
  // Words of any request, which say nothing about its topic either: "can you check mist and see why my laptop is slow"
  // picked a UI review skill on "my" and "check" ("review my UI", "check accessibility") and a browser skill on "see".
  "my", "me", "we", "us", "why", "check", "see", "look", "want", "need", "know", "tell", "show", "get", "make", "doing",
  // "when were the last changes … which one he was working" picked docx ("tracked changes", "working with").
  "changes", "changed", "changing", "work", "works", "worked", "working",
]);

/** The share of a long request's words a skill's name, tags and description must share with it, unless the request names
 * the skill. A 5,000-character build spec shares words with any long description by chance ("file", "read", "edit"):
 * it picked xlsx, docx, docs and google-workspace, 41k characters of skill text in every turn. */
const TOPIC_SHARE = 0.08;

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word)));
}

/** The request without its links (https://…, www.…, host.tld/path): a word inside one, such as "mcp" in a repository
 * named casper-network-mcp, says where something is, not what the request is about. A project path has no dotted host. */
function withoutLinks(text: string): string {
  return text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ").replace(/\b[\w-]+(?:\.[\w-]+)+\/\S*/g, " ");
}

/** Every word of the text, in order, stop words kept: a skill's name is matched as a phrase in these. */
function rawWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** True when the skill's whole name is in the request as a phrase ("find skills", "mcp builder"): its words next to each
 * other, in order. "find-skills" is not named by "can find some … hpe skills". */
function namesSkill(name: string, request: string): boolean {
  const parts = rawWords(name);
  const words = rawWords(request);
  if (!parts.length) return false;
  for (let at = 0; at + parts.length <= words.length; at++) if (parts.every((part, index) => words[at + index] === part)) return true;
  return false;
}

/** A long request shares words with a long description by chance ("fixed" and "two" with "a fixed point … two axes"):
 * past this many of the request's words, the description needs three of them, not two. */
const SHORT_REQUEST_WORDS = 6;

function overlap(left: Set<string>, right: Set<string>): number {
  return [...left].filter((word) => right.has(word)).length;
}

export function scoreSkill(
  skill: SkillMetadata,
  request: string,
  project: ProjectModel,
  classification: TaskClassification,
): number {
  if (skill.disableModelInvocation) return 0;
  const taskWords = words(withoutLinks(request));
  const stackWords = words([...project.languages, ...project.frameworks].join(" "));
  const declaredStacks = words(skill.stacks.join(" "));
  const stackMatch = overlap(declaredStacks, stackWords);
  if (declaredStacks.size && stackWords.size && !stackMatch && !overlap(declaredStacks, taskWords)) {
    return 0;
  }

  const nameWords = words(skill.name);
  const calledByName = nameWords.size > 0 && namesSkill(skill.name, withoutLinks(request));
  // A tag, or the whole name, names the skill. One word of a longer name is like a word of the description: "add
  // another mcp central server to network mcp" and "what is pac mcp" are not about mcp-builder.
  const named = overlap(words([...(calledByName ? [skill.name] : []), ...skill.tags].join(" ")), taskWords);
  const described = overlap(words([skill.name, skill.description].join(" ")), taskWords);
  // One word of the request in a long description is chance ("test" is in a TDD skill, a test-migration skill and
  // "stress-test"): the description counts with two of the request's words, or with the skill's name or tags.
  const needed = taskWords.size > SHORT_REQUEST_WORDS ? 3 : 2;
  const topicScore = named * 4 + (named || described >= needed ? described : 0);
  // A long request: the skill counts when the request names it, or when they share a fair part of its words.
  const shared = overlap(words([skill.name, ...skill.tags, skill.description].join(" ")), taskWords);
  if (!calledByName && shared < Math.max(1, Math.ceil(taskWords.size * TOPIC_SHARE))) return 0;
  const intentScore = skill.intents.includes(classification.intent) ? 3 : 0;
  // Broad intent/stack matches only boost a topical match; otherwise every
  // implementation skill for this language would load for an unrelated task.
  if (!topicScore) return 0;
  return topicScore + intentScore + stackMatch * 2;
}
