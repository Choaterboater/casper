# 87. An ACP app sees Casper's reasoning headlines

Date: 2026-11-07. Status: proposed. Extends 76 (Casper speaks ACP) and amends 24's "status row only" guard rail for
`casper acp` alone. In the terminal the status row shows a short headline of the model's reasoning, and a provider
retry is a dim line. Over `casper acp` an app saw neither: a long reasoning step or a retry's wait looked like a hang.

## Decision

- **A headline is a thought.** While the model reasons and its provider sends readable reasoning, the headline the
  status row would show (decision 24: the summary's latest title, or its latest finished sentence, at most 60
  characters) goes out as a standard `session/update` `agent_thought_chunk` with text content, the headline and a
  blank line. There is no extension.
- **Only a change is sent.** The same headline again sends nothing; a new one sends one more thought. A tool step, the
  end of a model response and a new prompt start afresh, so the same headline after them is sent again. Tool-call
  progress and reasoning with no readable headline send nothing.
- **A retry is a thought.** A provider retry sends one thought in the terminal line's words, without its glyph and
  without `Esc stops`: `openrouter is busy · trying again in 4s (1 of 3)`.
- A thought does not end the model's held text: its half-written line still goes out whole.
- The headline may be kept in the app's own saved session and export. It never goes to Casper's transcript, the
  steps pane, the receipt, a saved conversation's export, `--json` or the model.

## Guard rails

- The same off switch: `reasoning_headline: false` (**Reasoning headline** in `/settings`) sends no headline, and
  neither does `display: quiet`. Retries are sent either way, as the terminal's line is.
- The same 60-character limit and cut rule, then the session's hiding: the `--json` redaction, your own secrets'
  values and the client's server values. Each secret is also hidden as the headline may have changed it (marks taken
  off, spaces run together, a final `.`, `:` or `;` gone). A headline cut inside a secret also hides a run of 4 or more
  characters before the final `…` that starts one of those forms, since the whole value is not there to match.
- The headline is worked out by the runtime as before; the app gets a copy of the status row's words, nothing more of
  the reasoning.
- An older app drops `agent_thought_chunk` or shows it as reasoning; nothing it sends changes.
- This changes decision 24's guard rail, so it needs the owner's review.

## A finding

A headline at quiet or with the setting off, more than the status row's headline, a secret in one, or a headline in
Casper's own transcript, receipt, export, `--json` or the model.
