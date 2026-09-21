import type { ProjectModel } from "../project/model";
import type { TaskClassification } from "../task/classify";
import type { SkillMetadata } from "./metadata";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is",
  "it", "of", "on", "or", "our", "that", "the", "their", "this", "to", "use", "using", "with",
  "you", "your", "skill", "skills", "task", "when", "guidance", "instructions",
  "add", "build", "create", "implement", "fix", "modify", "update", "change", "help",
]);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word)));
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
  const taskWords = words(request);
  const stackWords = words([...project.languages, ...project.frameworks].join(" "));
  const declaredStacks = words(skill.stacks.join(" "));
  const stackMatch = overlap(declaredStacks, stackWords);
  if (declaredStacks.size && stackWords.size && !stackMatch && !overlap(declaredStacks, taskWords)) {
    return 0;
  }

  const topicScore = overlap(words([skill.name, ...skill.tags].join(" ")), taskWords) * 4
    + overlap(words(skill.description), taskWords);
  const intentScore = skill.intents.includes(classification.intent) ? 3 : 0;
  // Broad intent/stack matches only boost a topical match; otherwise every
  // implementation skill for this language would load for an unrelated task.
  if (!topicScore) return 0;
  return topicScore + intentScore + stackMatch * 2;
}
