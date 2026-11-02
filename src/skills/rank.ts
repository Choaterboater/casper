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

  const named = overlap(words([skill.name, ...skill.tags].join(" ")), taskWords);
  const described = overlap(words(skill.description), taskWords);
  // One word of the request in a long description is chance ("test" is in a TDD skill, a test-migration skill and
  // "stress-test"): the description counts with two of the request's words, or with the skill's name or tags.
  const topicScore = named * 4 + (named || described >= 2 ? described : 0);
  // A long request: the skill counts when the request names it, or when they share a fair part of its words.
  const nameWords = words(skill.name);
  const calledByName = nameWords.size > 0 && [...nameWords].every((word) => taskWords.has(word));
  const shared = overlap(words([skill.name, ...skill.tags, skill.description].join(" ")), taskWords);
  if (!calledByName && shared < Math.max(1, Math.ceil(taskWords.size * TOPIC_SHARE))) return 0;
  const intentScore = skill.intents.includes(classification.intent) ? 3 : 0;
  // Broad intent/stack matches only boost a topical match; otherwise every
  // implementation skill for this language would load for an unrelated task.
  if (!topicScore) return 0;
  return topicScore + intentScore + stackMatch * 2;
}
