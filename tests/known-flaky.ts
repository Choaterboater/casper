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
];
