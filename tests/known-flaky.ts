/** Observations, not permission to retry assertion failures. The repository owner triages each entry. */
export interface Flake {
  file: string;
  title?: string;
  platforms: NodeJS.Platform[];
  owner: string;
  reason: string;
  observed: string;
}

const observed = (file: string, platform: NodeJS.Platform, reason: string, title?: string): Flake => ({
  file: `tests/${file}.test.ts`, title, platforms: [platform], owner: "repository owner", reason, observed: "2026-10-15",
});

/** File-level observations are deliberate where the incident did not identify one test title. Narrow after deflaking. */
export const OBSERVED_FLAKY: Flake[] = [
  observed("project-folder-recent", "win32", "CLI spawn timed out on the Windows runner."),
  observed("effort-cycle", "win32", "The interactive fixture saw prompts 0 instead of the next prompt; deflake before classifying as startup latency."),
  observed("security-suppressions", "win32", "The fixture launcher build exceeded its setup deadline."),
  observed("phase9-learn", "win32", "Learning integration failed in the Windows CI run; isolate the file before attributing it to host timing."),
  observed("claude-subscription-runtime", "win32", "Subscription registration failed on the Windows runner; retain the failing assertion when investigating.", "subscription registration and session-only selection preserve existing saved defaults"),
  ...["auto-builders", "crew-builder", "crew-builder-pi.integration", "crew-review", "crew-worktrees", "review-command", "phase6-review", "phase7-app-review"].map(file =>
    observed(file, "win32", "Crew/review integration failures were observed on Windows; run this file alone to establish the failing case.")),
  observed("clipboard-files", "darwin", "The fixed-program child did not finish reliably on macOS.", "a clipboard tool runs without a shell: its arguments reach it as they are"),
  observed("phase10-browser", "darwin", "Multiline textarea replacement failed on macOS; investigate the browser result, never retry a wrong value.", "fill replaces an entire multiline textarea rather than only the clicked paragraph"),
  observed("stall-guard", "darwin", "The stalled-file recovery fixture failed on macOS under load.", "after a stall, the files Bun was still running run once more, and that run's exit code is the step's"),
  observed("mcp-network-setup", "win32", "Main's Windows network-MCP setup tests failed during fixture setup; reproduce with the pinned launcher and server."),
  observed("mcp-access", "win32", "PR #337, Windows suite (3), run 38762130296 attempt 1: the fake MCP server missed its 5 s connection budget, leaving an empty catalog at line 24. Investigate startup readiness, not the access assertion."),
  observed("mcp-check-probe", "win32", "PR #337, Windows suite (3), run 38762130296 attempt 1: the fake MCP probe missed its 10 s connection budget at line 17.", "a server that starts lists every tool and is stopped afterwards"),
  observed("phase4-mcp", "win32", "PR #337, Windows suite (3), run 38762130296 attempt 2: the fake MCP reload fixture missed its 2 s connection budget; line 122 saw failed instead of ready.", "a reload diffs definitions in place and revokes consent only for changed programs"),
  observed("review-config", "win32", "PR #337, Windows suite (3), run 38762130296 attempt 1: the real CLI startup exceeded Bun's 30 s test deadline before configuration warnings could be asserted.", "Casper shows configuration warnings at startup"),
  observed("mcp-check-cli", "win32", "Main run 38809613113, suite (3): Bun killed the CLI at the 30 s test limit (31833.37 ms), leaving exit 143. Explicit child/readiness investigation and native Windows proof remain queued; no limits or assertions are changed.", "a clean repo exits 0 and prints the offline notice and the report"),
  observed("services-tool", "darwin", "PR run 38812460918 attempt 1: HTTP readiness preceded the listening log; a one-shot read returned empty at 285.19 ms. A gated fixture reproduces it; poll the actual line within the existing deadline. The green second attempt is not fix evidence.", "start, status, logs, restart and stop a declared service through the tool"),
  observed("phase9-learn", "win32", "Run 38716274534: the guarded provider-failure CLI returned exit 143 rather than 1. This assertion failure remains unresolved; timeout-only retries cannot fix or hide it.", "provider failure does not expose raw provider text or record an outcome as a learning draft"),
  observed("crew-review", "win32", "Run 38724710031 exceeded 30 s while producing the combined full-check receipt; not reproduced on macOS. Retain the receipt assertions and obtain native Windows proof before adding retries.", "the receipt shows the full-check run on the combined result, and its failure cannot report done"),
  observed("crew-review", "win32", "Run 38719265633 exceeded 30 s during real worktree creation/landing; the completed-result assertion also failed. Native Windows investigation is still required, not an assertion retry.", "a second fix for the same part is refused and not counted; a fix with no review on file is allowed"),
  ...(["linux", "win32"] as const).map(platform => observed("browser-start", platform, "PR #393, Linux suite run 39334791761 attempt 1 (and earlier on PRs #387 and #388, Linux and Windows): 90 s, then \"a beforeEach/afterEach hook timed out\", only inside the full suite. Deflake runs went 20/20 on Linux and Windows, and 20/20 on macOS with every core busy; the failed job passed on re-run. Find which close step waits (the browser's, the page server's or the temp folder's) before changing a limit.", "the installed browser starts, opens a local page and closes")),
  observed("eval-packs", "win32", "PR #397, Windows suite (1), run 39365286587 attempt 1: tsc in the candidate exited 1 with no output after 20 s at line 183. Deflake run 39370056076 on windows-2025: 20/20 pass; the failed job passed on re-run. Seen only inside the full suite.", "a task that needs TypeScript gets a working `bun run typecheck` in the candidate, for every harness"),
  observed("network-update-swap", "win32", "PR #398, Windows suite (4), run 39367435759 attempt 1: line 141 saw the server still running after the swap (21.5 s). Deflake run 39370058785 on windows-2025: 20/20 pass; the failed job passed on re-run. Seen only inside the full suite.", "through the MCP manager: the running server is stopped before the swap, and starts again after it"),
  observed("browser-signin", "linux", "PR #407, Linux suite run 39469009782: the No case ran 60 s inside the full suite (a cold Chrome start for the open after it, like browser-start). Deflake run 39470434644 on ubuntu-24.04: 20/20 pass.", "No opens no window and the AI's pages stay signed out"),
  observed("folder-trust-app", "linux", "PR #562, Linux preview source suite, run 41324388229: start() threw \"Casper is closing\" (src/app.ts start) as the test's own close() arrived while the folder question's start was still running; only inside the full suite. Deflake runs 41325435091 (the PR branch) and 41325437148 (main) on ubuntu-24.04: 30/30 pass each.", "a repository inside a trusted folder is its own project: it asks for itself"),
  observed("windows-screen", "win32", "Main run 38986825404 (v0.2.38 release commit), standalone job against the built exe: the idle footer did not appear within 32 s after Esc. Deflake run 38988280500 on windows-2025 from source: 20/20 pass, none skipped; the failed job passed on re-run. Not yet reproduced against the built binary.", "ConPTY: a line typed during work is queued, and Esc stops the task and gives it back"),
];
