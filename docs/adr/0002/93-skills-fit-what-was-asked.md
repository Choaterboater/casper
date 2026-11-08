# 93. Skills fit what was asked

Date: 2026-11-07. Status: proposed. Extends 90 (Embedded context is not the request) and 45 (other tools' skill
folders). In a live test through an app that runs Casper over ACP, with the skills from other tools' folders on a Mac,
` skills selected` listed skills that had nothing to do with the request: deep-research for a one-line bug fix,
google-workspace and prototype for "In one line: what did I answer to your question earlier?", google-workspace and
built-in-browser for "count the tests in sum.test.js without running them" sent with a mentioned chat, and six skills
for a one-line question about a mentioned chat. Each one is up to a few thousand tokens in that request.

## Decision

- **Only the person's words pick a skill.** A chat the app sends as context or a pasted transcript goes to the AI as
  before (90), but Casper picks skills from the request without it, as it already reads the checklist and the offers
  before the work. A request that is only context picks none. The mentioned chat's JSON had picked six skills.
- **Words about the exchange never count.** `ask`, `question`, `answer`, `reply`, `option`, `choice`, `yes`, `line`,
  `earlier`, `later`, `previous`, `chat`, `conversation`, `session`, `did`, `done`, and their plurals, say how to
  answer or what was said, not what a request is about. They join the words of any request (`my`, `check`) that
  never counted. "Options: Yes, No" had matched "comparing options", "one line … earlier" had matched "a one-line fix
  … earlier in the chat", and "this session" had matched "when the session runs".
- **A word said twice counts once.** A word and its plural ("tests" and the `test` of `sum.test.js`) are one shared
  word, so one idea said twice is not the two words a description needs.

Nothing else changes: the same thresholds (two of a description's words, three past six words, 8% of a long
request's), a tag or the whole name as a phrase still counts on its own, and the bundled network skills keep their own
rule. A request naming a Google Doc still gets google-workspace; one to research the web still gets deep-research.

## Others

Claude Code and Codex put every skill's name and description in the prompt and let the model choose and read one.
Casper picks locally with no model call and no tokens until a skill fits (SKILLS.md), so its word match has to leave
out words that say nothing about the topic.

## Guard rails

- Nothing the person typed is dropped from what the AI reads; only what picks a skill changes.
- No skill is named in the code: the words are kinds of words, not a list per skill.
- No new setting. `skills.maxActive: 0` still turns automatic loading off.
