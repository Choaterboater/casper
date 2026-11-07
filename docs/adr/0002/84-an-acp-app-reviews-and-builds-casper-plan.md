# 84. An ACP app reviews and builds Casper's plan

Date: 2026-11-07. Status: proposed. Extends 76 (Casper speaks ACP), 81, 82 and 83. Over `casper acp`, `/plan` showed
the plan only on Casper's own transcript and stopped: "This run can't ask you to build". The model's planning words
reached the app as its message, the build's checklist was invisible there, and `/plan on` had no switch in the app.

## Decision

- **The Build box.** After a plan, the app gets `session/request_permission` for "Build this plan?" with Stop
  (`reject_once`), Build (`allow_once`) and Change the plan (`reject_once`). Only Build builds. The box's text is the
  plan as Markdown: `# <title>` (the request when it has none), then the screen's sections as `## <heading>`, with
  Steps and Done means numbered and Open questions last. Details stay in the saved file. Past 64 KiB the text is cut
  at a line and names the saved file. `_meta.casper.plan` (`approve`, `change`) on the box's `tool_call` and on the
  request names the two labels, so an app can show its own plan review.
- **Change the plan in the same prompt.** It asks "What should change?" as a form (decision 83). The model rewrites
  the plan and the box comes back in the same prompt. A change that ends in `?` is a question: the model answers in
  words, a message, and the box comes back with the plan unchanged. Open questions are answered the same way: the
  app's box has no Answer rows.
- **No answer means Stop.** A cancel, an error, a cancelled prompt, a closed connection or no answer in 30 minutes
  builds nothing, as every box. So does Change the plan in an app that does not show forms. The plan is saved, and
  after a Stop the app is told so: `[plan] The plan is saved: /plan reopens it.` Bare `/plan` offers the recent plans as a box with
  Stop first (`reject_once`); a picked plan comes back to the Build box.
- **The question round** before a plan asks through a form, as decision 83 set out.
- **Planning words are thoughts.** While the model writes a plan, its text goes out as `agent_thought_chunk`, a
  line at a time, hidden as every update is: the box carries the plan. An answer that holds no plan, or a plan turn
  that failed or was cancelled, is printed on the terminal; then the app gets those words as a message too.
- **Plan entries.** During the build, ACP's `plan` update lists the accepted plan's steps, all of them each time, at
  the start, after each step the model reports and at the end. They take the place of the "Do the task" stage, and
  Casper's checks follow them. active is `in_progress`, done is `completed`, and pending and not-done stay `pending`;
  not-done says `<title> (not done: <reason>)`. They are the model's report, labelled so on the receipt as before.
- **The `plan` option.** A `select` config option, `plan` ("Plan first"), `off` or `on`, before `mode`, which stays
  last (decision 82). It has no category. It is `/plan on`'s switch: on, every request gets a plan first, until it is
  set off or `/plan off` is typed. It is taken during a prompt too and applies from the next request. A typed
  `/plan on` or `/plan off` reaches the app as `config_option_update`. A set the app made is not sent back.
- **Why an option, not a mode.** Session modes are the access chip's (decision 82). Planning first is no access level,
  and a mode list with plan in it would make a chip that changes two things at once.
- No unstable `plan_update` and no Casper method of its own: stable `plan` entries and a permission request say it.

## Guard rails

- Nothing in Casper answers the Build box. Only the app's Build is a yes; any other answer, or none, is Stop.
- The plan's words, its labels and the step entries are hidden as every update is (the `--json` redaction and your
  own secrets' values).
- The planning gate is unchanged: the plan turn still refuses every change Casper can see until Build.
- A switch to Read only (decision 82) closes the open Build box as Stop, as it closes every open box.
- An older app that shows neither forms nor `_meta` sees a plain permission card with the plan as its text, and Change
  the plan stops.
