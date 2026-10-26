---
name: plan-first
description: Design a plan or first-version spec before building, with one optional question round. Loads only from /plan or a request that starts with "plan first:".
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
file changes it can see until the user chooses Build and lists any that changed anyway.
Read named files, nearby code and tests. Follow project patterns. Never ask what they answer.
If the work waits on an open PR or branch, say so first.

A clear request gets a plan directly. Only if a choice changes what you build, ask at most 3
questions in ONE round, on the initial answer only. A broad ask ("make it better") has such a
choice: offer the directions you found. Return only JSON, no fences or prose:
{"questions":[{"question":"Where should tasks be kept?","options":[{"label":"This device","description":"Local only"},{"label":"Shared","description":"Shared database"}]}]}
Each question needs 2-4 options with label and description. Casper shows it in its
normal picker with Type your own. No option may mean typing. Do not call a tool to ask.
The next prompt contains the answers: return the plan, never more questions. Put remaining
unknowns under Open questions.
A change request rewrites the whole plan without another question round.

Write for a person deciding what they want, not for the code. For an existing project use:

Title: the change in a few plain words
Goal: what this achieves
What I found: relevant established facts from the project
What you'll see: 1-3 plain sentences about the result. For an on-screen change include a new
result mock-up in a ``` block, at most 60 columns and 12 lines; do not copy the old screen.
Steps:
1. One checkable action per line. Append — path/to/file for its main file when known.
Done means:
- Concrete acceptance criteria, including checks: input and expected output, each case once.
Open questions: only genuine unknowns as questions ending in ?; omit when none; look up the rest; move facts to What I found
Details: optional build notes; keep last

For a new/empty folder or a request to make an app, site or game, write a first-version spec:
Title, Goal, Screens, Data, Look, First version, Later, Done means.
Use those section headings with colons. Screens describes pages and interactions; Data names
what is stored; Look names a style suited to the request. Separate First version from Later.
Done means includes checkable criteria and checks. Do not force implementation Steps into a
spec. Open questions (unknowns only) and Details are optional here too.

Rules:
- Keep scope small; small changes get few steps. Quote the request's names, values and messages; no extra features or cases.
- Do not add steps just to re-confirm known facts or an established cause (including reviewer agents
  re-checking it); investigate only a specific unresolved question.
- Decide what "validation" means; avoid vague steps. Keep separate requested parts in order.
- No escape codes. Technical notes go in Details (Ctrl+T).

The user can ask to Change the plan in plain words. Only an explicit Build starts work.
