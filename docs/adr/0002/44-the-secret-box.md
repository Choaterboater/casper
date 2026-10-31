# 44. The AI asks for a secret through Casper's hidden box

Date: 2026-10-29. Status: accepted (merged 2026-10-30 in #545).

**What:** `casper_secret` lets the AI ask the person for a password, token or key. Casper shows its own hidden box (the
one the ssh password uses: nothing typed is echoed, only a count). The box names what is asked, the AI's one-line reason
and where the value goes. Esc skips. The value goes to one of two places:

- A file in the project (`saveTo`). The file is mode 600, set before anything is written to it. A `.env`-style file
  gets one `NAME=value` line, replacing that name's line if it has one. Any other file holds the value only. A file git
  tracks is refused before the box opens. A file git would otherwise pick up is added to `.gitignore`, and both the
  person and the AI are told.
- `$NAME` in the AI's next shell command only. The value is in that command's environment, never in its text, and is
  gone when the command starts. A value not used by the end of the task is dropped.

The AI gets back where the value went and its length, never the value. The tool is offered from the first request that
names a password, token, key, secret or credential, and then stays for the session. Requests that don't name one never
carry it, so the fixed prompt does not grow.

Separately, a request whose *pasted* text holds something token-like asks `1 Remove it · 2 Send anyway` before it goes
to the AI. Enter and Esc remove it. A run that can't ask, and a line typed while a task runs, have it removed, and one
line says so. What the person typed is never changed.

**Why:** the owner asked the AI to set up a Cloudflare tunnel on his NAS and to "prompt me for token to hide". Casper
had no way to do that: `ask` puts its answer in the conversation, and the hidden box existed only for ssh. The AI then
spent a long time building a one-use HTTPS form on the NAS, which died once and then turned down his token. In his
words: "took forever to build something to just type a key or password in" and "not sure why it did browser vs a
prompt". Earlier the same day he had pasted a whole terminal screen with the tunnel token in it. A token he had garbled
by hand got past the scrubber and reached the AI.

**Guard rails:**

- The value is never in a tool result, an event, `--json` output, the screen, a log, the saved conversation or
  `/export`. It joins the session's typed secrets (as the ssh password does), so an exact copy is hidden in everything
  the AI reads from then on. `tests/secret-box-pi.integration.test.ts` checks every file Casper and Pi wrote.
- The box needs Casper's full terminal. A run that can't show it refuses: one-shot, `--json`, piped, a helper. Nothing
  is ever asked in chat.
- A file save stays in the project: no path outside it, no link that leads out, nothing git tracks, nothing of git's
  own. Plan mode saves no file.
- `$NAME` can't be a name the shell or Casper relies on (`PATH`, `HOME`, `LD_*`, `DYLD_*`, `GIT_*`, `SSH_*`,
  `CASPER_*` and the like), and it reaches one command only.
- The paste box's first row, and Enter, remove the secret. Sending it takes a deliberate 2.

**A finding:** the value in anything the AI, a record or an export can read. A box shown without the full terminal. A
file save that is outside the project, tracked by git, or more readable than 600. `$NAME` reaching a second command or a
reserved name. A pasted secret sent on Enter or Esc.
