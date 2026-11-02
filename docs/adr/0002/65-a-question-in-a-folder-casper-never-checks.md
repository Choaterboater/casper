# 65. A question in a folder Casper never checks gets no card

Date: 2026-11-02. Status: proposed. Amends 33 (no receipt card until the task is done): its "no card when the card
would only say that no files changed" now also covers a folder Casper can't compare.

## Decision

A question asked in the home folder ("what is pac mcp") ended in an amber card: `⚠ Not verified: Casper never trusts
your home folder; open a project folder to run its checks` and `Changes unknown: not a project folder`. The AI had only
read a file with `python3 -c`. Casper never runs checks in your home folder or at the top of a drive, and can't compare
their files, so any command it can't read as a look left the changes unknown and the card stood, after every question.

- **Only looked.** When the AI's commands were all looks (`ls`, `cat`), nothing follows the answer, as in a project
  folder (unchanged).
- **One grey line.** When the request asked something (not for a change), the folder is one Casper never checks and
  can't compare, and nothing Casper can see changed, the card is one grey line: `– Changes unknown: not a project
  folder (your home folder)`. "Nothing Casper can see changed": no edit, write or rename tool, no builder helper, no
  shell command with a change Casper knows (an install, a commit, a push, a deletion, a command to another machine that
  does more than look), no change sent through an MCP server, no write outside the folder, no check, and nothing else
  on the receipt (a stop, a secret, a job left running, a plan).

## Guard rails

- The receipt is saved as before: `/receipt` has every line, `--verbose` prints it in full, and one-shot runs and
  `--json` are unchanged.
- A request to change something, or any change Casper can see, keeps the card, with its `Not verified` line.
- A project folder is unchanged: its files are compared, so a pure answer there has no card at all.
- A shell command whose text Casper did not keep whole (over 512 characters), or more tool calls than it keeps, keeps
  the card.

A finding: the grey line after an edit, a known change, an MCP change or a change request; or a receipt not saved.
