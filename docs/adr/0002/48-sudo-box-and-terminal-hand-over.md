# 48. sudo asks in Casper's box, and a command that needs you gets the terminal

Date: 2026-10-30. Status: accepted (merged 2026-10-30 in #552).

**What:** three things, so nobody has to leave Casper to finish a task.

- **sudo on this computer.** When the AI's command uses `sudo` (no sandbox; not on Windows) and sudo really asks for
  the password, Casper asks the way it does for an ssh password: `sudo on this computer asks for your password.
  Type it in Casper's hidden box? The AI never sees it.` with `1 No · 2 Yes, this once · 3 Yes, for this session`, then
  its own hidden box, `Enter sudo password`. For that one command a two-line `sudo` in the askpass's private folder
  (`~/.casper/run/ask-…`, 0700) comes first on `PATH`; it runs the real sudo with `-A`, and `SUDO_ASKPASS` is Casper
  itself, over the private socket ssh's box uses. A command that chose `-S`, `-n` or `-A` itself is left alone.
- **A command that needs you.** An editor, a pager or REPL on its own, a database shell with no command, `docker`,
  `podman` or `kubectl` with `-it`, `gh auth login`, `npm login`, `docker login`, `aws configure`, `gcloud init`,
  `passwd`, `su`, `crontab -e`, `git rebase -i`, `git add -p`, `apt`/`dnf`/`yum` installs without `-y`, `ssh -t`, and
  a command the AI sends again after it failed for want of a terminal (`a terminal is required`, `not a tty`, …) get
  Casper's terminal: right after the command's usual box, with no question of its own. One line says what starts
  (`[terminal] vim notes.txt has the terminal now; Casper comes back when it exits.`), the screen pauses, the command
  has the keyboard and the screen, and Casper comes back when it exits. It runs inside `script` where there is one
  (macOS, Linux), so the AI reads its exit code and the last 40 lines the screen showed, scrubbed like any command's
  output. `ssh host sudo …` (a plain ssh) gets the terminal with `-t`; sudo over there asks at its own prompt.
- **Your own commands.** A line you type that starts with `!` (`!sudo apt update`), or plain words naming a program
  (`let me run sudo apt update`, `I'll run make deploy`), runs at once in Casper's terminal with no box, as in Claude
  Code and Copilot CLI. The AI reads its exit code and scrubbed tail with your next request.

**Why:** the owner, after a real session on his NAS: "i shouldnt have to exit casper to do sometnhing vs it opening a
sepearte cli inside or something or prompting me a password instead of a receipt". The AI's shell ran with no
keyboard, so `sudo` failed with "a terminal is required" and the AI ended with a receipt telling him to leave Casper.
Then: "as long as i dont get more and more prompts and its doing it" — so nothing here adds a box a task didn't have.

**Guard rails:**

- No new boxes. The sudo question shows only when sudo itself runs its askpass (a sudo still signed in, or a
  `NOPASSWD` rule, shows nothing); "Yes, for this session" means sudo doesn't ask again until you quit. A hand-over
  adds no question beyond the command's usual box, and a command you typed has none. A task with no sudo and nothing
  interactive asks exactly as before.
- The usual box still comes first: sudo is on the always-asks list (decision 47), and `/permissions all` answers that
  box, never the password question.
- The sudo password goes to sudo alone, through sudo's own askpass call: never a command, an argument, an environment
  variable or a file. From the moment you type it, it is hidden everywhere the AI reads; it is never in the screen,
  `--json` events, logs, the session file or `/export`; it is never saved; a "this once" value is forgotten when the next
  command starts. `DISPLAY` is not set.
- The hand-over never records keystrokes: `script` runs without `-k`, `-r`, `-I` or `-B`, its file is in
  `~/.casper/run` (a private place) and is removed once read. What the AI reads is what the screen showed (a password
  that isn't echoed isn't there), cut to 40 lines and scrubbed.
- Only the person's typing runs a command without a box: a `!` or "let me run" that came from a paste is an ordinary
  request, and "let me run" counts only when its first word is a program on the PATH or a file (so "let me run the
  tests" is a request).
- With no person at a terminal (one-shot, `-p`, `--json`, piped input, a builder or helper), a command that needs one
  is refused before any box, and a sudo that asks is refused, each with a plain line that says an interactive Casper
  session does it — never "run it yourself" or "open another terminal". Windows has no `script` and no sudo here: the
  hand-over still works, without the tail.

**A finding:** a box a task didn't have before (other than the sudo question when sudo really asks); a sudo password in
a tool result, the model's context, the screen, events, logs, the session file or an export; a password question
answered by `/permissions all`; keystrokes recorded; a hand-over without the command's usual box; a pasted line run as
the person's own; or a refusal that tells the person to leave Casper.
