# 25. Showing the work is worth a slightly larger request

Date: 2026-10-21. Status: accepted (owner's choice).

## Decision

Casper may add up to about 1,000 tokens (about 4,000 characters) to the fixed part of every request so that the AI
says what it is doing as it works. That covers one short line before each group of tool calls (what it will do and
why), one line after it changes config, a device or another machine, and a short title on a shell step. The screen
uses these lines. The status row leads with the latest one (`Fixing the port test · Running bun test · 4s · Esc stops`).

An earlier trim took such lines out to save tokens, and the work went quiet. The owner chose to put them back:
"for a 1000 tokens extra that was a bad decision to cut it out previously."

## Guard rails

- About 1,000 tokens is the whole allowance. Each use raises the caps in `tests/fixed-tokens.test.ts` by what it uses,
  with a comment naming this decision. Any other text added to the fixed request still has to be shortened first
  (AGENTS.md).
- The final answer keeps its rule: lead with the answer, result or next action, with no unasked checklist or recap.
- Lean guidance gets the same rules in fewer words and stays under half of the full text.
- These lines are for display. A step title never replaces the real command in an approval box or a permission check,
  and the status row drops the line first on a narrow screen, never `Esc stops`.

## A finding

A cap raised by more than the new text uses, or text added under this decision that is not about showing the work.
