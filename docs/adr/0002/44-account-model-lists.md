# 44. Casper reads your ChatGPT and Copilot plans' own model lists, and says when a list is out of date

Date: 2026-10-29. Status: accepted (merged 2026-10-30 in #547).

## Decision

- With a ChatGPT plan (`openai-codex`) or GitHub Copilot sign-in, Casper reads the account's own model list as a
  session starts and when `/model` opens (if the last read is over 10 minutes old): `GET
  https://chatgpt.com/backend-api/codex/models?client_version=<engine version>` with `originator: pi`, and Copilot's
  `GET <account API>/models` with the headers the engine already sends to Copilot.
- The account decides which models show. A ChatGPT-plan model the engine's catalog lists but the account doesn't
  offer is taken off, unless the account names none of the catalog's models. Copilot's list is already cut to the
  account by the engine (`availableModelIds`), so nothing is taken off there.
- A model the account offers that the catalog doesn't have is not added: `/model` names it and says to update Casper.
- `/model` shows where each signed-in provider's list comes from (your account, pi.dev, or built in) and its date.
  After a refresh it says `Model catalogs refreshed.` only when no list is out of date.
- When a signed-in provider's pi.dev copy is over 7 days old, two `HEAD` requests (at most every 4 hours per provider)
  read the date of the copy pi.dev gives this engine (asked with the engine's own `User-Agent`) and of its current
  copy (asked as `casper/<version>`). If the engine's copy is more than a day older, `/model` says the engine is given
  an older list, with both dates, and asks you to update Casper. An old saved copy the engine's next refresh replaces
  says nothing.

## Why

pi.dev gives each engine version the copy of a provider's list made for it (the engine's `User-Agent` is redirected
to `?pi-version=<version>`) and stops moving an older version's copy when the list changes in a way that engine
can't read. Pi 1.1.0's copies stopped on Oct 15, 2026. The engine asked every 4 hours, heard 304, and called the list
fresh, so `/model` said "refreshed" while `openai-codex` still offered `gpt-5.5` and `gpt-5.3-codex-spark` (which
always fail for ChatGPT accounts) and missed `gpt-6.1-terra`. Upgrading the engine (to Pi 1.4.0 in the same change)
fixes the list until the next such break; the account lists and the date check keep it from going silent again.

oh-my-pi asks the account's own endpoint and treats it as the truth, with the shared catalog only adding detail; that
is the model followed here. Asking pi.dev for a newer engine's copy instead was rejected: the copies differ in shape
(OpenRouter's `~anthropic/*-latest` change API and address, OpenAI models lose request flags), so an older engine
would call models wrongly. Adding a model only the account lists was rejected for the same reason: the account's list
has no thinking-level map, prices or request settings, and guessing them breaks requests.

The Codex endpoint answers 400 without `client_version` and hides models newer than it. The engine's own version is
sent (it is above every Codex CLI version), not a Codex CLI version: Casper doesn't claim to be another client.

## Guard rails

- No read without that plan sign-in, and none with `CASPER_OFFLINE=1` (or the engine's `PI_OFFLINE`).
- The token comes from the engine (`getAuth`, which renews it) and goes only to that provider. Errors are fixed words
  (`OpenAI answered HTTP 500`); no body, address or token reaches a message.
- A read that fails, or an answer that isn't a list, changes nothing: the list read before stays, marked as not read.
- An account list that names none of the catalog's models takes nothing off. The list is laid on through the engine's
  `registerProvider`, and Casper takes off only the list it laid on.
- Helpers take the list the main session read and never read it themselves.
- The pi.dev date checks send no key and no sign-in, only the engine's name (as the engine's own catalog requests do)
  or Casper's; pi.dev not answering makes no claim.
