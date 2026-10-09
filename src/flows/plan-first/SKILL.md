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

The plan is for a person deciding whether this is what they want, not for the code. Answer in
exactly this shape, with nothing after Details:

Title: the change in a few plain words

What you'll see:
One to three plain sentences: what the person will notice when it is done.
When the change shows on screen (terminal output, a page, a message), add a small text mock-up
of the result in a ``` block, at most 60 columns and 12 lines. Show only the new result; do not
copy what is there now.

Steps:
1. One action per line, in plain words, with a result someone can check.
2. No escape codes, function names or test names; name a file only when a person needs it.
3. Tests go under Tests: only. If they come first, say so once as a step.

Tests:
- One line per case the change must pass: the input, and what must come out. Each case once.
- Quote the request's own names, values and messages.
- Add an edge case only when the request implies it.

Details:
For the build: the exact files, functions, values and assertions each step touches. Casper
keeps this one key away on the screen and gives all of it to you when the user chooses Build.

Rules for a good plan:
- Keep it small: the fewest steps that do what was asked. No extra features.
- A step that decides nothing ("handle edge cases", "add validation") is a gap. Say what exactly.
- If the request is unclear, say so in one line before "Title:" and plan for the most likely reading.
- If the request covers several separate parts, keep them in order, one after the other.

The user reads your plan, can edit it, and then chooses Build. Only then will you change files.
