# 104. An ACP app lists models before the first message, and a pick is the session's

Date: 2026-11-12. Status: proposed. Extends 81 (an ACP app picks Casper's model and effort) and changes two of its
points. Under 81 every pick in the app's picker was saved as Casper's default, so a model tried in one conversation
became the model of every new one, in the terminal too. And with no model chosen yet there was no `model` option at
all: an app could show no list until a first message had been sent.

## Decision

- **A pick is that session's.** `session/set_config_option` with `model` or `effort` changes the conversation it
  names and nothing else: Casper's default, the other open sessions and the terminal keep theirs. The conversation
  keeps its pick when it is loaded again (decision 89).
- **Make default is its own request.** The same request with `_meta.casper.makeDefault: true` also saves the value
  as Casper's default for new conversations, as `/model provider/id` and `/effort <level>` do. An app's "make
  default" button sends the value the session is already on with it. Only `true` asks for it.
- **The list marks the default.** The model option that is Casper's default has `_meta.casper.default: true`.
- **The list comes with the session.** `session/new`, `session/load` and a fork reply with the `model` option
  whenever there is a model to list:
  - With no model chosen and a signed-in provider, Casper picks that provider's default as the session opens and
    saves it, and says so on stderr. This is what the first request did; it now happens before it.
  - With no model chosen and nothing Casper picks for you (your own model server), the option lists the models with
    `currentValue: ""` and no `effort` option. A pick is taken as usual.
  - With nothing to list (not signed in, no server), there is still no `model` option.
- A `/model` or `/effort` typed in the app is unchanged: without `--session` it saves the default.

## Limits

- A session that is already open lists the sign-ins it started with: a sign-in made afterwards shows in the next
  session.

## Guard rails

- Only a listed value is taken, with or without `makeDefault`; the refusals of decision 81 are unchanged.
- `tests/acp-models.integration.test.ts` checks, against a real `casper acp`: a pick leaves the settings file as it
  was, the other open session hears nothing and a new session starts on the default; `makeDefault` saves the model
  and the effort and the next session starts on them; anything but `true` saves nothing; the list comes with no
  message sent, both when a signed-in provider's default is picked and when no model is in use.
