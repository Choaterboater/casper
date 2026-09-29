/**
 * Which test commands Casper may offer to remember as a project's test command.
 *
 * A command the model ran is not trusted just because it ran: a prompt could steer the model into
 * `python -c ...`, `uv run --with evil pytest` or `pytest -p plugin`, and a remembered command runs on
 * every later task. So a command is offered only when it is one of a few known test-runner shapes,
 * followed by plain test paths and a handful of harmless output flags. Anything else is not offered.
 */

/** Known runners, as exact word sequences. Nothing may come between these words. */
const RUNNERS: readonly (readonly string[])[] = [
  ["pytest"],
  ["python", "-m", "pytest"],
  ["python3", "-m", "pytest"],
  ["uv", "run", "pytest"],
  ["uv", "run", "python", "-m", "pytest"],
  ["poetry", "run", "pytest"],
  ["bun", "test"],
  ["bun", "run", "test"],
  ["npm", "test"],
  ["npm", "run", "test"],
  ["pnpm", "test"],
  ["pnpm", "run", "test"],
  ["yarn", "test"],
  ["go", "test"],
  ["cargo", "test"],
];

/** Output-only flags that load no code and write no files. */
const PLAIN_FLAGS = new Set(["-q", "-qq", "-v", "-vv", "-x", "--quiet", "--verbose"]);

/** A relative test path or test name: letters, digits and `_ . / -`, never starting with `-`,
 * never absolute and never climbing out with `..`. `./...` (Go's package pattern) counts. */
const PLAIN_PATH = /^(?!-)[A-Za-z0-9_./-]+$/;

function plainArgument(word: string): boolean {
  if (PLAIN_FLAGS.has(word)) return true;
  if (!PLAIN_PATH.test(word) || word.startsWith("/")) return false;
  return !word.split("/").includes("..");
}

/** The command in the exact form Casper would save, or undefined when it is not a known test-runner
 * shape. Words are separated by single spaces; the result is what the user sees before saving. */
export function rememberableTestCommand(command: string): string | undefined {
  if (command.length > 200 || /[^\x20-\x7e]/.test(command.trim())) return undefined;
  const words = command.trim().split(/ +/).filter(Boolean);
  const runner = RUNNERS.find((shape) => shape.length <= words.length && shape.every((word, index) => words[index] === word));
  if (!runner) return undefined;
  const rest = words.slice(runner.length);
  if (rest.length > 8 || !rest.every(plainArgument)) return undefined;
  return words.join(" ");
}
