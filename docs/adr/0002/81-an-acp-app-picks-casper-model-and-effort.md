# 81. An ACP app picks Casper's model and effort

Date: 2026-11-06. Status: proposed. Extends 76 (Casper speaks ACP), 77, 78, 79 and 80. Over `casper acp` the app's
model badge showed the app's own models, which Casper never used, and a pick there changed nothing in Casper.

## Decision

- **Config options.** The `session/new` and `session/load` replies carry ACP's `configOptions`: `model` first (the
  picker is used most, and the spec reads array order as priority), then `effort`. A load's reply had been `{}`.
- **The model list** is every model you are signed in to that can call tools, in `/model`'s order (the current one
  first, then your default), grouped by provider in order of first appearance. Each group is named as Casper says it
  (`Claude Code plan`, `Anthropic API`, `/login`'s `OpenAI Codex`), else by the catalog's name, never by its raw id.
  A model in use that can no longer be used (signed out, gone from its server) stays listed, its description saying
  why. With no model selected there is no `model` or `effort` option; the list comes once Casper has one.
- **Effort** is offered only when the current model has at least three of `/effort`'s choices (`auto` and its
  levels), as Shift+Tab cycles. Its value is the configured effort; one that is not among the choices goes first.
  Each model option carries `_meta.casper.efforts`: the effort values a set would take once that model is picked, so
  the app's picker can show them per model.
- **`session/set_config_option`** with `model` selects exactly that `provider/id` (a new `exact` selection: no words,
  roles or picker; an id with `:` or `/` works) and saves it as Casper's default, as `/model provider/id` without
  `--session` does. With `effort` it sets the level and saves it, as `/effort <level>`. Both write `/model`'s and
  `/effort`'s own lines to stderr. The reply is the whole list after the change.
- **Casper's own changes reach the app.** At the end of every prompt (after its text, before the receipt), Casper
  compares the list with the last one sent and sends `config_option_update` when it changed: a typed `/model`, a
  failover, a model server found later, or a new default's order. A change the client asked for is not echoed back.

## Guard rails

- Only a listed value is taken: an unknown option, a value that is not a string, a model that is not listed or an
  effort the model does not offer is refused (-32602) before the runtime is called, and changes nothing. The
  runtime's own checks (sign-in, tools, stale credentials) still run on a listed model, and its refusal is its words
  (-32603). When the runtime took the model but could not save it as the default, the new list is sent first
  (`config_option_update`), so the app shows the model the next prompt goes to.
- Refused while a prompt runs (-32600), since the runtime takes a change only between prompts; while a change is
  applied, a prompt is refused too. Each session is its own process, so a set reaches only the session it names.
- No key or sign-in is ever in an option: values are `provider/id`, names are the catalog's, and every name and
  description goes through the session's hiding. An option whose value hiding would change is left out. A model in use
  that can't be used says why in Casper's words, which may name its model server's address, as a prompt's error does.
- `--json`, the screen, `/model` and receipts are unchanged. An app that ignores `configOptions` works as before.
