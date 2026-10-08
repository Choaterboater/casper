# How Casper is built

One page for a new contributor: the main pieces, how one request runs, the promises Casper makes and
where they are kept, and where to start a change. Read [DEVELOPING.md](DEVELOPING.md) first for
how to run the checks. Words such as *Verified* and *verification evidence* are defined in
[CONTEXT.md](../CONTEXT.md); the design decision behind them is [ADR 0001](adr/0001-casper-own-product.md).

Casper is TypeScript on Bun. The model loop, the provider sign-ins and the terminal widgets come from
Pi (`@earendil-works/pi-*` in `package.json`). Casper owns everything around that loop: what the AI may
touch, what it sees, how its work is checked, and what the receipt says.

## The main pieces

| Piece | Folder | What it does |
| --- | --- | --- |
| Start-up | `src/cli.ts`, `src/cli-main.ts`, `src/cli-args.ts` | Reads flags, builds one `CasperApp`, runs one request (`runOnce`) or the prompt loop (`runInteractive`). |
| The app | `src/app.ts` | `CasperApp`: the session's state and the owner of every subsystem. The work itself lives in `src/app/`. |
| Session modules | `src/app/` | One file per job. `command-loop.ts` reads a line; `commands.ts` runs slash commands; `task-run.ts` runs one request from prompt to receipt; `wiring.ts` opens a workspace; `runtime-start.ts` starts the model; `verification.ts` runs checks and repairs; `undo.ts` is `/undo`, `/diff`, `/receipt`; `approvals.ts`, `session-yes.ts` and `safe-choices.ts` are the approval boxes; `sandbox.ts` is the sandbox's questions and receipt lines; `events.ts` and `footer.ts` are what shows while work runs. |
| Model runtime | `src/runtime/` | `pi.ts` is the adapter over Pi: it registers Casper's tools, gates every tool call before it runs and scrubs every tool result before the model reads it. `types.ts` is the seam (`AgentRuntime`, `RuntimeTool`) tests fake. `git-guard.ts` refuses git commands that throw away your work. Model choice and routing are `model-routing.ts`, `pi-models.ts`. |
| Tools for a task | `src/app/capabilities.ts`, `src/app/task-tools.ts` | `assembleTaskTools` decides which tools one request is offered: MCP, helpers, `ask`, `casper_session` (Casper's own state, read-only), `casper_check`, LSP, references, web, browser, services and diagrams. |
| Capabilities broker | `src/capabilities/` | MCP tools reach the model through two tools, `find_capability` and `call_capability` (`broker.ts`). `labels.ts` and `kinds.ts` judge how risky a call is; `approval.ts` builds the box; `validate.ts` checks arguments against the schema. |
| MCP | `src/mcp/` | `manager.ts` connects servers and holds writes on or off; `config.ts` and `import.ts` find definitions; `consent.ts` remembers approval; `presets.ts` holds the rules for known network servers. `mcp/network/` sets up Casper's own network server and its logins. `mcp/check/` is `casper mcp check`. |
| Network checks | `src/network/` | Config checks that run with no device (`checks.ts`, `spec.ts`), the lab list (`lab.ts`) and the risky config lines on the receipt (`risky-lines.ts`). |
| Shell sandbox | `src/sandbox/` | `manager.ts` wraps every shell command Casper runs; `policy.ts` is the one policy; `runtime.ts` is the seam over `@anthropic-ai/sandbox-runtime`; `linux.ts` and `seccomp.ts` are Linux details; `read-only.ts` is the read-only allow-list for when no sandbox can run; `remote.ts` reads ssh and friends; `store.ts` keeps your per-project answers. |
| Private places | `src/platform/project-paths.ts` | One list of private paths (`PRIVATE_PATHS`) and git's own files, checked on the resolved path for every file tool and named in shell commands. |
| Secrets | `src/secrets/` | `scrub.ts` swaps a secret for `<secret hidden>`; `patterns.ts` (device configs), `files.ts` (.env and friends), `prose.ts` (notes) and `assignments.ts` hold the rules; `tool-output.ts` scrubs native tool output; `gate.ts` refuses an edit or command that would write the marker back; `netconan.ts` is the optional extra pass. |
| Checks and proof | `src/verify/` | `registry.ts` and `named.ts` know the checks; `command.ts` runs one in the sandbox; `repair-loop.ts` runs checks and bounded repairs; `proof.ts` runs the tests on a copy without the change; `acceptance.ts` is the optional independent test; `evidence.ts` holds the result types. |
| Task record | `src/task/` | `result.ts` is the receipt (`formatShortReceipt`, `formatTaskResult`); `receipts.ts` saves it; `undo.ts` keeps copies in `~/.casper/projects/<id>/undo.git`; `changes.ts` snapshots the tree; `spend.ts`, `checklist.ts`, `review.ts` and `classify.ts` support the run. |
| Terminal | `src/tui/` | `terminal.ts` owns input and numbered questions; `surface.ts` is the rich screen; `commands.ts` lists slash commands for completion; `help.ts` is `/help`; `ask.ts` is the AI's `ask` tool. |
| Services and pages | `src/services/`, `src/browser/` | Dev servers Casper starts and owns (`manager.ts`, `detect.ts`), smoke checks (`smoke.ts`), page checks after a UI change (`pages.ts`, `page-checks.ts`, `page-report.ts`), showing the AI the pages (`page-look.ts`) and `/preview`. `src/browser/` drives Chrome for the page check and the `browser` tool. |
| LSP and debugger | `src/lsp/`, `src/debug/` | Language servers (diagnostics after edits, rename) and a DAP step debugger. Both start only after you say yes. |
| Helpers | `src/agents/manager.ts` | The `delegate` tool: bounded, read-only child sessions. |
| Everything else | `src/sessions/`, `src/workspace/`, `src/skills/`, `src/packs/`, `src/memory/`, `src/references/`, `src/web/`, `src/visualize/`, `src/flows/`, `src/security/`, `src/doctor/`, `src/new/`, `src/update/`, `src/config/`, `src/project/`, `src/platform/` | Saved conversations and branches, skills, skill packs, memory, reference docs, web lookups, diagrams, suggested flows, `/security-review`, `casper doctor`, `casper new`, `casper update`, settings, project facts and OS helpers. Each folder's main file starts with a comment that says what it owns. |

## How one request runs

From the prompt to the receipt, in `src/app/task-run.ts` (`runModelTask`) unless named:

1. `command-loop.ts` reads the line. A slash command goes to `handleSlashCommand`; anything else is a request.
2. The request is classified (`src/task/classify.ts`) and `prepareCapabilities` (`task-tools.ts`) builds its tool list.
3. Casper snapshots the folder (`snapshotWorkspace`) and starts undo's first copy (`taskUndo.begin`).
4. At most one question before work: a checklist of the cases the request states, or the plan-first panel. Then, for
   a code change with a test command (in auto mode), `ChangeBaseline.capture` (`src/verify/proof.ts`) copies the
   folder as it is now.
5. The model turn: `session.prompt` in `src/runtime/pi.ts`. Every tool call passes the gates first (git guard, private
   places, git's own files, the plan turn's gate, writes outside the project). Every shell command goes through
   `casperBashOperations`, which asks first when no sandbox runs and wraps the command when one does. Every tool
   result is scrubbed before the model reads it. MCP calls go through the broker and its approval box.
6. Casper snapshots again and plans the checks from what changed (`planAutoChecks` in `src/verify/mode.ts`), plus smoke and page checks.
7. `runVerification` (`src/app/verification.ts`) runs them in the sandbox, with up to three repair turns by default (`repair.maxAttempts`)
   (`src/verify/repair-loop.ts`).
8. When the checks pass on a code change, `finishChange` and `proveChange` run the tests on the copy without the
   change: they must fail there and pass with it. The optional acceptance test runs after that.
9. The receipt: `app.lastTaskResult` is built, `taskUndo.finish` saves the second copy and the receipt
   (`src/task/receipts.ts`), and `formatShortReceipt` (`src/task/result.ts`) prints it.
10. `offerNextSteps` shows the numbered row under the receipt: 1 Show diff, 2 Undo, then suggestions.

## Promises Casper makes and where they live

Each row is a promise a user can rely on, the code that keeps it, and the tests that fail if it breaks.
[docs/SECURITY.md](SECURITY.md) has the full list of what the sandbox holds back, and
`tests/doc-claims.test.ts` checks that its table names real tests.

| Promise | Kept in | Guarded by |
| --- | --- | --- |
| Every shell command Casper runs is sandboxed: writes only in the project, temp and caches; git's own files read-only | `src/sandbox/manager.ts`, `src/sandbox/policy.ts`, `src/sandbox/runtime.ts`, `src/sandbox/linux.ts` | `tests/sandbox-policy.test.ts`, `tests/sandbox-wiring.test.ts`, `tests/sandbox-writes.test.ts`, `tests/sandbox-live.test.ts` |
| Private places (`~/.ssh`, cloud and git logins, Casper's own login files) are hidden from the AI's file tools and shell; your shell start-up files, git settings and `~/.casper` can't be changed | `src/platform/project-paths.ts`, `src/sandbox/policy.ts`, `src/runtime/pi.ts` | `tests/file-guard.test.ts`, `tests/sandbox-policy.test.ts` |
| With no sandbox, the AI's shell asks before each command, except a short list of commands that only read | `src/sandbox/read-only.ts`, `src/app/sandbox.ts`, `src/runtime/pi.ts` (`casperBashOperations`) | `tests/no-sandbox-commands.test.ts`, `tests/sandbox-asks.test.ts` |
| Approval boxes: only a person answers, choice 1 is always the safe one (No, Stop, Not now), Enter picks 1, and every yes uses the same wording (`YES_WORDS`) | `src/app/safe-choices.ts`, `src/app/approvals.ts`, `src/app/session-yes.ts`, `src/tui/terminal.ts` | `tests/safe-first-choice.test.ts`, `tests/yes-words.test.ts`, `tests/session-yes.test.ts` |
| MCP servers connect with writes off; risky kinds stay off until you allow them; the AI can't skip a box | `src/mcp/manager.ts`, `src/mcp/presets.ts`, `src/capabilities/broker.ts`, `src/capabilities/approval.ts`, `src/capabilities/labels.ts`, `src/capabilities/kinds.ts` | `tests/mcp-safety.test.ts`, `tests/capabilities-approval.test.ts`, `tests/capabilities-kinds.test.ts`, `tests/mcp-presets.test.ts`, `tests/mcp-setup-app.test.ts` |
| Secrets are swapped for `<secret hidden>` before the AI sees them, and the marker is never written back | `src/secrets/` (`scrub.ts`, `tool-output.ts`, `gate.ts`), `src/capabilities/broker.ts` | `tests/secrets-scrub.test.ts`, `tests/secrets-files.test.ts`, `tests/secrets-gate.test.ts`, `tests/secrets-broker.test.ts`, `tests/secrets-pi.integration.test.ts` |
| A project's `.casper/project.yaml` can't change your own settings or loosen the sandbox; it can only add denies | `src/config/load.ts`, `src/sandbox/policy.ts` | `tests/sandbox-policy.test.ts`, `tests/settings.test.ts`, `tests/spend.test.ts`, `tests/web-app.test.ts` |
| *Verified* means your configured checks passed fresh and your tests fail without the change and pass with it | `src/verify/proof.ts`, `src/verify/repair-loop.ts`, `src/task/result.ts` | `tests/change-proof.test.ts`, `tests/receipt.test.ts` |
| Undo puts a task's files back at no token cost, never touches the project's own `.git`, and names what it can't reach | `src/task/undo.ts`, `src/app/undo.ts`, `src/task/receipts.ts` | `tests/undo.test.ts`, `tests/undo-app.integration.test.ts`, `tests/receipt-store.test.ts` |

If you change one of these files, run its tests. If you change what a promise says, change the doc that
states it in the same commit.

## Rules for contributors

These follow from how the owner wants Casper to feel. A change that breaks one will be asked to change.

- **On by default, with an off switch.** A new feature works without setup. Turning it off is one
  numbered choice in `/settings` (`src/app/settings.ts`), written to `~/.casper/config.yaml` for you by
  `src/config/user-write.ts`. No one should have to edit a config file for normal use.
- **Numbered choices, 1 is safe.** Every question is a numbered list; Enter picks 1, and 1 never builds,
  spends tokens, writes, turns writes on or remembers anything. Yes is said with the same wording (No · Yes, this once · Yes, for this session · Yes, always for this
  project) from
  `src/app/safe-choices.ts`, never a typed `yes`. `tests/safe-first-choice.test.ts` and
  `tests/yes-words.test.ts` hold this.
- **Never gate harder than Claude Code.** Don't add a box, a refusal or a limit that Claude Code would
  not have for the same action. Safety comes from defaults the user can switch off, not from blocking
  what the user may do.
- **Do the in-project step yourself.** When the model can do a step inside the project, it does it,
  without telling the user to.
- **Plain short words.** In messages, help, receipts and docs. Say what happened and what to type next.
- **A project file is not you.** Settings that spend your money, change your screen or loosen the
  sandbox are user settings; `src/config/load.ts` refuses them in `.casper/project.yaml`.
- **Evidence, not claims.** Only what Casper ran makes a receipt say *Verified*. What the model says,
  what the AI saw on a page and the acceptance test are signals, never a pass.
- **Nothing personal.** No real hosts, names, paths or logins in code, tests or docs.

## Where to start

| Change | Start here | Then |
| --- | --- | --- |
| A slash command | Add it to `COMMANDS` in `src/tui/commands.ts` (completion), then handle it in `runSlashCommand` in `src/app/commands.ts`, or in `handleSlashCommand` in `src/app/command-loop.ts` when it needs the whole app | Add it to `/help` in `src/tui/help.ts` and to [TERMINAL_UX.md](TERMINAL_UX.md). Tests: `tests/help-text.test.ts`, `tests/help-search.test.ts` and a test for the command. |
| A tool for the model | Write a `RuntimeTool` (`src/runtime/types.ts`); `src/web/tools.ts` and `src/visualize/tools.ts` are small examples | Offer it in `assembleTaskTools` (`src/app/capabilities.ts`). A tool that changes state needs a box with 1 = No. |
| An MCP preset | `src/mcp/presets.ts`. A preset may only make Casper stricter: pin read-only settings, raise a label, hide tools while writes are off | Tests in `tests/mcp-presets.test.ts`; document it in [MCP.md](MCP.md#presets). |
| A check | A built-in or named check: `src/verify/registry.ts` and `src/verify/named.ts`. A network check: `src/network/spec.ts` and `src/network/checks.ts` | Tests: `tests/named-checks.test.ts`, `tests/network-spec.test.ts`; document it in [VERIFICATION.md](VERIFICATION.md) or [NETWORK-CHECKS.md](NETWORK-CHECKS.md). |
| A doc | A file in `docs/`, linked from the docs table in [README.md](../README.md) | Docs that state a safety rule are checked by `tests/doc-claims.test.ts` and `tests/terminal-ux-doc.test.ts`; keep them true. |

Tests use fakes for the model, the sandbox, servers and the terminal; see `tests/support/` (`app.ts` builds a
test app). Run only the test files you touched while you work, and `bun run check` before you send a change.
