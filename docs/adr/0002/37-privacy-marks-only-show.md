# 37. /model shows what OpenRouter's hosts do with your prompts, and changes nothing

Date: 2026-10-25. Status: proposed (the user's choice; needs the owner's review before merge).

## Decision

`/model` marks each OpenRouter model from OpenRouter's public zero-data-retention list:

- 🔒 when at least one of its hosts keeps nothing of a request (zero data retention);
- ⚠ when no host promises that, so every host may keep your prompts;
- no mark when Casper doesn't know: another provider, or the list wasn't read.

The line under the list names the hosts that keep nothing. Casper reads the list at most every 30 minutes, beside the
model list (decision 36), with the same plain request: no key, no app name.

The marks only show this. Casper doesn't change where a request goes, and it blocks no model.

## Why

The user asked to see that different models do different things with what you send. They chose not to block anything:
"i dont want to block anything just show that the different models are doing different things". Free models are where
the difference shows most: on the day this was written, 1 of 16 free models that call tools had a host that keeps
nothing, and 219 of 399 models that call tools did.

A switch that sent requests only to such hosts was weighed and left out. It would block most free models. Pi's route
for Claude models through OpenRouter can't carry the setting. And OpenRouter's own account setting already does this
for anyone who wants it.

## Guard rails

- 🔒 never says your request goes to a private host. The legend says "a host keeps nothing (OpenRouter may pick
  another)", and the docs say Casper doesn't change where requests go.
- A model is marked only from a list that names at least one host. An empty, broken or unreadable list marks no model
  either way.
- Host names come from the network: they are shown with control characters taken out, at most 40 characters each.
- Nothing is read without an OpenRouter sign-in, or with `CASPER_OFFLINE=1`.
