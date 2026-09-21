# Daily-use terminal interface

**Status:** implemented and validated. Current user contract: `TERMINAL_UX.md`.
Final gate and scoped review: `DAILY_TERMINAL_REVIEW.md`.

## Authorization and scope

The user approved global remembered model/effort, normal scrollback with anchored
input/status, and an interactive mockup, then requested completion without more
approval rounds. This is a usability slice, not DAP or a permissions redesign.
Existing unrelated changes stay intact; no commits, installations, personal auth
operations or live model trials. Local tickets continue the existing tracker
convention under `.scratch/terminal-ux/issues/`.

## Problem

A user reopening Casper unexpectedly has no selected model. Common controls are
hard to find, reasoning effort is inaccessible, and there is no persistent view
of project/model/context/activity. Repeated errors obscure simple recovery.

## User stories

1. Select a model once and use it in later new conversations across projects.
2. Explicitly select a session-only model without changing that default.
3. Change effort using only levels supported by the selected model.
4. See project/branch, provider/model, effort, context and activity while typing.
5. See unknown telemetry as unknown, never a fabricated percentage or charge.
6. Type slash and discover supported commands without memorizing them.
7. Edit multiline drafts, recall history, and cancel work without exiting.
8. Keep drafts across streamed output, exclusive pickers and confirmations.
9. Inspect context/usage, compact explicitly, and start a fresh conversation.
10. Discover/resume named conversations and inspect workspace diffs.
11. Keep normal terminal scrollback and usable plain redirected output.
12. Try the UI using a synthetic offline demo without credentials or model calls.

## Contract

Normal model selection saves the Casper global startup default. An explicit
session-only option preserves it. Conversation restoration still takes precedence;
there is no silent provider fallback. Effort is persisted with the selected model
when requested; unsupported levels fail rather than pretending to apply.

The footer displays observable state, not approval/verification promises. Context
usage follows Pi's reported estimate and may be unavailable after compaction.
Usage distinguishes catalog estimates from actual billing; subscription costs are
not inferred. Status and usage do not send model requests. Explicit compaction
may send a model request and is cancellable. Clear starts a new conversation, not
a workspace rollback. Resume reuses Casper's named-session/workspace lifecycle.

Use the existing Pi renderer/editor where appropriate, retaining Casper's single
input owner and fresh exact approvals. Palette entries insert commands rather
than silently executing them. File completion is a reference convenience, not
proof a file was read. No background queue of pasted commands.

## Test seams

Existing public CasperApp/RuntimeSession boundaries, real isolated Pi fixture
catalogs, InteractiveTerminal streams and POSIX PTYs. These follow the established
terminal/model/session test seams. Red-green changes are vertical; no live provider.
Test restart persistence, unsupported effort, session-only selection, truthful
telemetry, cancellation, resize/narrow display, palette/history/multiline, fresh
consent, picker ownership, plain output and existing regressions.

## Out of scope

New ASK/PLAN/BUILD enforcement, permission presets, undo/checkpoints, automatic
shell execution, external editor integration, queued prompts, animation/themes,
DAP and new clients. Existing tool/approval rules remain unchanged and must be
explained, not relabeled SAFE or YOLO. More commands can be added independently.

## Implementation sequence

1. Remember model/effort end-to-end.
2. Add the scrollback terminal surface, palette and offline demo.
3. Expose telemetry and session/context convenience commands.
4. PTY/public-interface review, isolated full gate and user documentation.

The approved terminal layout is used rather than web-page variants. The offline
demo is retained uncommitted; no prototype branch/commit overrides the no-commit
constraint. Automated exercise is not a claim of human visual sign-off.
