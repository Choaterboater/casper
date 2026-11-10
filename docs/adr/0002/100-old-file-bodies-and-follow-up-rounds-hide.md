# 100. Old file bodies are hidden too, and Casper's own rounds hide at once

Date: 2026-11-09. Status: proposed. Extends decision 12 (old tool output is hidden only in provider requests). Decision
12 hides old tool *results*. In a build, much of the conversation is the AI's own tool *calls*: every file it wrote,
in `write` content, `edit` text and `cat > file <<'EOF'` bodies. They stayed in every later request although the files
are on disk. And the rounds Casper starts itself after the build (check repairs, the requirements review and
self-review of decision 72, proof repair, finishing browser checks, keep going) re-read that whole conversation,
usually before decision 12's marks are reached.

## Decision

- **File bodies get stubs** in provider requests (`src/runtime/tool-history.ts`), by decision 12's rules: older than
  the latest four rounds, at the same checkpoints, outweighing what the rebuild re-reads, and saved as branch-local
  masks. Eligible: a successful `write` (its content), `edit` (its replacement text, the legacy `oldText`/`newText`
  form too) and a bash command that is one `cat > file <<DELIM` heredoc, optionally after a `&&` or `;` prefix,
  each from 2,000 characters. The stub names the tool, the file and its size, and says to read the file before judging
  or editing it, so a review never rates code it no longer sees. The call keeps its tool, its path and, for a heredoc, its command line and closing line.
- **A body stays** while the latest rounds or the latest request name its path or file name, quote one of its lines
  (tool arguments compared unescaped), name its call id or point back at an earlier write or version. Shared
  library words do not count, as they do for results, because the file on disk can always be read again.
- **Casper's own rounds hide at once.** `promptRound`, the check repair and keep going pass `followUp`; at that
  round's first request only, hiding skips the fifth-of-the-window and 60% marks if at least 5% of the window goes
  and it still outweighs the rebuild. Later requests in the round use the normal marks.
- **Same off switch:** **Hide old tool output** (`hide_tool_output: false`) stops new body stubs and follow-up
  checkpoints too. No new setting, and the fixed prompt does not change.

## Why

Smaller requests in every later round, on every model, for tokens the AI can get back with one read. A follow-up
round is where the build is longest and where several requests in a row re-read it, and its first request is a
stable point: one checkpoint there, then every request repeats the one before byte for byte. A recorded-style
build with two reviews (`tests/tool-history-bodies.test.ts`) sends about a third fewer tokens with one cache
rebuild; a real Pi run proves the first review request carries the stub and the next one repeats it.

## Guard rails

- The saved conversation, exports, `/output` and receipts keep every body; only provider requests change.
- Failed calls, other commands (a heredoc into a program, two heredocs in one command), MCP calls and small bodies
  are never stubbed. Errors, unfinished commands and verification results stay as decision 12 says.
- A stub is permanent: off stops new ones, never restores old ones, so the prefix is not invalidated again.
- A body still named or quoted in the latest rounds stays, so an edit in progress keeps the text it builds on.
- An edit made from a stub cannot apply old text: its old text is not in the file, so the edit tool refuses it and
  the model reads that it failed. A stub written back into a file gets the placeholder note of the elision check
  (`src/runtime/elision.ts`), as `// ... existing code ...` does. Both are tested on a real Pi run.

## A finding

A body stubbed within the latest four rounds, while its path or one of its lines is referenced, or after a failed
call; a stub with no file name; a checkpoint at a follow-up request that does not outweigh the rebuild; more than one
forced checkpoint per round; anything stubbed while hiding is off; the saved transcript changed.
