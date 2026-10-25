# 38. A task that hits a model's limit goes on with another model

Date: 2026-10-25. Status: proposed (the user asked for it; the coordinator's defaults below wait for the user's and the
owner's review before merge, since this changes which provider receives the conversation).

## Decision

When the model a task runs on hits a limit, the task goes on with the next model instead of stopping:

- **What switches:** a rate limit, once the engine's own tries on the same model run out; a usage or quota limit, or a
  model that can't run right now, at once. A rejected key (401), a refusal (403), a bad request (400) or a full window
  never switches.
- **To what:** the models you list with `/model failover`, in your order, then, only when the task was on a free
  OpenRouter model, the newest free OpenRouter models that call tools, have a window of at least 64k tokens and aren't
  retired within a week. A model must be signed in, call tools and be able to take the conversation.
- **How:** the failed request goes again on the new model. When the conversation doesn't fit its window, that model
  compacts it first. One line says what switched, why, and whether it compacted.
- **Back:** the rest of the task stays on the new model. The next request goes back to your model; your default and
  the conversation's model don't change.

Only the main conversation fails over; helpers keep their model.

## Why

The user asked for it: "fail over options in case u hit limits one free one or model then go to the next model", and
before switching, to compact the conversation to the next model's window. Free OpenRouter models hit rate limits
often, and a task that stops there loses its momentum.

The engine compacts once, keeping the newest part of the conversation and summarizing the rest in one request to the
model it switched to, and it won't compact twice in a row. So a model whose window can't take that request is passed
over rather than tried: switching to it would fail twice, once summarizing and once answering.

## Guard rails

- Never a paid model Casper picks by itself: a paid model is used only when you listed it.
- Never a free model from anything else: from a Claude plan, Copilot, Codex or any paid model, only the models you
  listed are tried. Most free models' hosts may keep prompts (decision 37), so a customer conversation never moves to
  one unless you listed it.
- Every switch is said, with the reason. Nothing switches silently, and nothing is saved: your next request goes back.
- A key, refusal or request problem never switches, so failover can't hide a problem only you can fix.
- Failover works through the engine's own retry steps. When an engine update renames them, failover turns off and a
  test fails, rather than the run breaking.
