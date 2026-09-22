import type { EvalTask, EvalVerification } from "./runner";

/** `{{bun}}` is the running Bun executable; `{{tsc}}` is this repository's TypeScript compiler.
 * Both are absolute paths, so a fixture's verification never depends on the child PATH. */
const BUN_TEST: EvalVerification = { name: "bun test", argv: ["{{bun}}", "test"], candidatePaths: ["src"] };

/** The evaluation catalog. Fixtures are the solved baseline; `setup` overlays the unsolved state. */
export const EVAL_TASKS: readonly EvalTask[] = [
  {
    id: "add-api-endpoint",
    fixture: "typescript-service",
    setup: "add-api-endpoint",
    prompt: "Add a `GET /health` endpoint to this project, following the existing router conventions. "
      + "`tests/health.test.ts` describes the expected response; the full suite must pass. Do not weaken, skip or delete tests.",
    verify: BUN_TEST,
    initialVerification: "fail",
    // The test is the contract; where the handler lives is the model's choice. A first
    // baseline run implemented it inline in src/app.ts, which the prompt never excluded.
    acceptance: { changed: ["src/"], unchanged: ["tests/"] },
  },
  {
    id: "fix-failing-test",
    fixture: "typescript-service",
    setup: "slug-regression",
    prompt: "The test suite fails. Find the cause and make `bun test` pass with the smallest production-code change.",
    verify: BUN_TEST,
    initialVerification: "fail",
    acceptance: { changed: ["src/"] },
  },
  {
    id: "respect-project-rule",
    fixture: "typescript-service",
    setup: "slug-regression",
    prompt: "Make the failing suite pass. This project's rules in `CONTEXT.md` apply: `tests/` describe intended "
      + "behavior and must not be modified, and the public `slugify` signature must stay unchanged.",
    verify: BUN_TEST,
    initialVerification: "fail",
    acceptance: {
      changed: ["src/"], unchanged: ["tests/"],
      contains: [{ path: "src/slug.ts", text: "export function slugify" }],
    },
  },
  {
    id: "avoid-unnecessary-dependency",
    fixture: "typescript-service",
    setup: "slug-regression",
    prompt: "Fix the failing slug behavior. This project intentionally has no runtime dependencies and must keep none: "
      + "solve it with the code that is already here.",
    verify: BUN_TEST,
    initialVerification: "fail",
    acceptance: { changed: ["src/"], unchanged: ["package.json"] },
  },
  {
    id: "repair-type-error",
    fixture: "broken-types",
    setup: "repair-type-error",
    prompt: "This project does not compile under its own `tsconfig.json` (strict mode). Repair the type errors with the "
      + "smallest correct change. Keep `tsconfig.json` as it is, and keep every exported function and its behavior.",
    verify: { name: "tsc --noEmit", argv: ["{{bun}}", "{{tsc}}", "--noEmit", "-p", "tsconfig.json"], candidatePaths: ["src"] },
    initialVerification: "fail",
    acceptance: {
      changed: ["src/"], unchanged: ["tsconfig.json"],
      contains: [{ path: "src/invoice.ts", text: "withAdjustment" }],
    },
  },
  {
    id: "rename-symbol",
    fixture: "symbol-rename",
    setup: "rename-symbol",
    prompt: "Rename the exported `formatCurrency` to `formatMoney` across the whole project, including tests and call "
      + "sites. Behavior must not change and no alias may remain.",
    verify: BUN_TEST,
    initialVerification: "pass",
    acceptance: {
      changed: ["src/", "tests/"],
      noMatch: [{ text: "formatCurrency", under: "." }],
      contains: [{ path: "src/format.ts", text: "export function formatMoney" }],
    },
  },
  {
    id: "add-component",
    fixture: "component-registry",
    setup: "add-component",
    prompt: "Add a `Badge` component to the registry. `tests/components.test.ts` describes the expected markup and "
      + "registry order; the suite must pass without test changes.",
    verify: BUN_TEST,
    initialVerification: "fail",
    acceptance: { changed: ["src/"], unchanged: ["tests/"] },
  },
  {
    id: "add-mcp-tool",
    fixture: "mcp-tool",
    setup: "add-mcp-tool",
    prompt: "Add the `count_words` tool to the catalog. `tests/tools.test.ts` describes its schema, ordering and "
      + "behavior; the suite must pass without test changes.",
    verify: BUN_TEST,
    initialVerification: "fail",
    acceptance: { changed: ["src/"], unchanged: ["tests/"] },
  },
  {
    id: "find-bug-without-editing",
    fixture: "bug-hunt",
    prompt: "Somewhere in this project there is a defect that the current tests do not cover. Identify the file and the "
      + "exact expression that is wrong, and explain what it does wrong. Do not modify any file: report the finding in "
      + "your answer.",
    verify: BUN_TEST,
    initialVerification: "pass",
    acceptance: { noEdits: true, answerContains: ["pagination.ts", "size - 1"] },
  },
  {
    id: "repair-order-reservations",
    fixture: "fulfillment-service",
    setup: "repair-order-reservations",
    prompt: "Repair the order reservation regression in this fulfillment repository. Duplicate SKU lines must become "
      + "one order line with their combined quantity; reservations must use available stock and commit all lines or none. "
      + "A rejected order must neither be saved nor consume inventory. Trace the existing domain, inventory and order "
      + "service boundaries so later shipment and cancellation remain consistent. Read the local conventions and "
      + "behavior tests. Change production code only; keep tests, package.json, tsconfig.json and .casper configuration unchanged. "
      + "Do not add dependencies.",
    verify: BUN_TEST,
    initialVerification: "fail",
    acceptance: { changed: ["src/"], allowedChanges: ["src/"] },
  },
  {
    id: "add-order-cancellation",
    fixture: "fulfillment-service",
    setup: "add-order-cancellation",
    prompt: "Orient yourself in this fulfillment repository and add the cancel-order command using its existing "
      + "command/result and service conventions. Cancelling a reserved order must release its reservation without "
      + "changing on-hand stock, retain its normalized lines and mark it cancelled. Repeating cancellation must succeed "
      + "without releasing stock twice; shipped orders cannot be cancelled, cancelled orders cannot ship, and unknown "
      + "orders return the established missing-order error. The behavior tests define the public contract. Change "
      + "production code only; keep tests, package.json, tsconfig.json and .casper configuration unchanged. Do not add dependencies.",
    verify: BUN_TEST,
    initialVerification: "fail",
    acceptance: { changed: ["src/"], allowedChanges: ["src/"] },
  },
];

export function findEvalTask(id: string): EvalTask | undefined {
  return EVAL_TASKS.find((task) => task.id === id);
}
