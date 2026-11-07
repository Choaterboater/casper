# 83. An ACP app answers the AI's questions

Date: 2026-11-07. Status: proposed. Extends 76 (Casper speaks ACP), 82 and 51, and replaces 76's guard rail line "The
AI's own questions (the ask tool) stay off, as one-shot" (76 itself is not edited). Over `casper acp` the AI's ask
tool said "needs an interactive terminal", the plan's question round was "unanswered (cannot ask here)", and a
question that took typed words or several picks was skipped, because a permission request offers only fixed choices.

## Decision

- **Forms.** An app that says it shows forms (`initialize`'s `clientCapabilities.elicitation.form`) gets each
  question that takes typed words or several picks as ACP's `elicitation/create` in form mode. The router keeps the
  client's capabilities and passes them to each session it starts, and passes the form on as it passes a permission
  request.
- **What goes as a form:** the AI's ask tool, the plan's question round and its open-question and change lines, and
  any other pick of Casper's that takes typed words. The form's `answer` is the choices by number (`"1"`…`"n"`) with
  their labels as titles, an array of them for several picks, or a text line; `other` ("Or type your answer") is there
  when the question takes typed words. `_meta.casper.question` says who asks (`ai` or `casper`), `multi` and `typed`.
- **Steps.** The AI's question is asked on the ask tool's own step (`toolCallId`), which ends with the tool's result.
  Casper's own question is a step of its own, `casper-question-N`, pending while it waits and closed with
  `→ <answer>` or `— skipped`.
- **Answers.** Only an accepted form counts. A choice maps back to its label by its number; an unknown one is
  dropped. A single pick takes the typed words over the choice; several picks give the picks in the choices' order,
  then the typed words. A line's spaces are collapsed, and an empty line is no answer. A decline, a cancel, an error, a
  stopped task, a closed connection or no answer in 30 minutes is skipped, as in a run that can't ask.
- **Numbered boxes stay permission requests.** Approvals keep their labels' kinds. A pick of Casper's gets choice 1
  (its safe one) as `reject_once` and the rest as `allow_once`, whatever their labels say.
- **What follows from a person answering.** The ask tool is offered, the plan's question round asks, and
  `askQuestions: beforeChanges` holds edits until the AI has asked once, as in the terminal.
- **`acp_questions: on | off`** in `~/.casper/config.yaml` only (a profile or project is refused), on by default,
  shown in /settings as **Apps answer the AI's questions**. Off: the questions are skipped, as in a one-shot run. It is
  read when a session opens.

## Guard rails

- Nothing in Casper answers a form. An app that does not say it shows forms gets none, and its questions are skipped
  at once with no step.
- A secret never crosses: the `casper_secret` box, ssh and sudo passwords and a login's hidden prompt need Casper's
  own terminal, as before. A test lists every place that can ask in typed words.
- The question, its choices, their descriptions and the echoed answer are hidden as every update is (the `--json`
  redaction and your own secrets' values).
- A question is not a box: an app's switch to Read only closes the open boxes as No and leaves an open question,
  which asks for no change.
- An older app that does not show forms sees no change.
