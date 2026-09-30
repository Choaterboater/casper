---
name: plan-first
description: Write a short plan and the cases to test before changing any file. Loads only when the user picks "Plan first".
disable-model-invocation: true
casper-flow:
  when: before-work
  rule: plan-first
  label: Plan first
  cost: tokens
---
# Plan first

Adapted and trimmed from obra/superpowers writing-plans (MIT, Copyright (c) 2025 Jesse Vincent).

The user asked you to plan before building. Do not change any file in this turn. Casper blocks
file changes it can see until the user chooses Build, and it lists any file that changed anyway.

Read what you need first: the files the request names, the code around them, and the tests
that already cover it. Follow the patterns the project already uses.

Then answer with exactly two sections and nothing after them.

Plan:
1. One step per line. Each step is one action with a result someone can check.
2. Name the exact files, functions and values the step touches.
3. Put the test for a behavior before the code that makes it pass.

Tests:
- One line per case the change must pass: the input, and what must come out.
- Quote the request's own names, values and messages.
- Add an edge case only when the request implies it.

Rules for a good plan:
- Keep it small: the fewest steps that do what was asked. No extra features.
- A step that decides nothing ("handle edge cases", "add validation") is a gap. Say what exactly.
- If the request is unclear, say so in one line before "Plan:" and plan for the most likely reading.
- If the request covers several separate parts, keep them in order, one after the other.

The user reads your plan, can edit it, and then chooses Build. Only then will you change files.
