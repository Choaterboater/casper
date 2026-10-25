# 36. Casper reads OpenRouter's own model list while you are signed in to OpenRouter

Date: 2026-10-25. Status: proposed (needs the owner's review before merge).

## Decision

With an OpenRouter sign-in, Casper reads OpenRouter's public model list (`https://openrouter.ai/api/v1/models`) as a
session starts, every 5 minutes and when `/model` opens, and lays it over the engine's OpenRouter catalog:

- A model the catalog already has keeps how Casper talks to it (its API and address, thinking levels, longest answer
  and price tiers) and takes OpenRouter's newer name, context window, prices and picture input.
- A model the catalog doesn't have yet is added when it can call tools, through OpenRouter's OpenAI-style endpoint
  with the settings most OpenRouter models have in the catalog. A thinking model isn't offered thinking off.
- The catalog's other models stay, including ones OpenRouter no longer lists, and its picture models.
- A start whose model only OpenRouter's list has waits for the first read; other missing cloud models still never
  wait. `/model openrouter/<id>` reads the list again before saying it doesn't know the id.

## Why

The engine's catalog is its copy of each provider's list, kept at pi.dev and fetched when `/model` opens, at most every
4 hours. OpenRouter adds models every day, and the copy can trail it by days (one machine's copy was a week old when it
was checked), so new models were missing from `/model`. OpenRouter's own list is the source.

A model the catalog has keeps its request settings because they are curated: some Anthropic models go through
OpenRouter's Anthropic-style endpoint for caching, and thinking levels and price tiers differ per model. OpenRouter's
list has none of that, so taking its entry whole would break requests. A new model without tool calls is left out
because Casper's work needs tools (the engine's catalog leaves those out too). OpenRouter's list doesn't say whether
thinking can be turned off, and about 4 in 10 thinking models in the catalog can't, so a new one isn't offered off.

## Guard rails

- No read without an OpenRouter sign-in, and none with `CASPER_OFFLINE=1` (or the engine's `PI_OFFLINE`).
- The request carries no key and no app-attribution headers: the list is public.
- A read that fails, or an answer that isn't the list, changes nothing: the models already listed stay. The list is
  never emptied.
- The list is laid on through the engine's own way to give a provider a model list (`registerProvider`). Casper takes
  off only the list it laid on; one another engine extension put on is left alone.
- Helpers take the list the main session read and never read it themselves.
