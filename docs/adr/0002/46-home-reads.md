# 46. Plain reads in your own folders run without the "Run this command?" box

Date: 2026-10-29. Status: accepted (merged 2026-10-30 in #549). Widens decision 1's "plain
read" from the project to your own folders under home; decision 1 is otherwise unchanged.

**What:** with no sandbox, the AI's shell asks `Run this command?` before a command that is neither a plain read nor
routine work. A plain read now counts in your own folders too, not only in the project: `cd ~/Documents/lab && grep -rn
token src | cut -c1-80 | head` or `cat ~/Documents/notes.txt` run without the box and leave one line,
`[read] outside this project, no box (a plain read in your own folders): …`. An unquoted `~/` at the start of a word is
checked as your home folder, as bash expands it.

Your own folders are those below your home folder whose first folder is neither hidden (`~/.ssh`, `~/.config`) nor app
data (`~/Library`, `AppData`). It applies only to the shell's box; the reader, checks and routine work still count only
the project.

**Why:** the owner was asked about a read-only `cd ~/Documents/… && grep … | cut … | head` because it read outside the
project, and chose to let plain reads in his own folders run. The AI's `read` tool already reads there without asking (and
names the folder under the turn's steps); the box made the shell stricter than the tool for the same bytes.

**Guard rails:**

- Only plain reads, checked as before: the same short list of programs and options, no redirects but the harmless ones,
  no substitutions, no other `$`, a `*` or `?` expanded and each file checked.
- The private list stays refused (`~/.ssh`, `~/.aws`, `~/.casper`, logins, your `sandbox.denyRead`), and so do `.env` and
  key files anywhere, a folder that holds one, and a link that leads to one or out of your folders.
- Home itself, hidden folders, app data, other places on the machine (`/etc`, another user), a quoted `"~/x"`, `~user` and
  a home path with a character the check doesn't take still ask.
- A run that can't ask is unchanged for anything else; the sandbox, where it runs, is unchanged.

**A finding:** a command that is not a plain read running without the box; a read of a private place, a key or `.env`
file, a hidden folder or app data running without the box; or the reader, checks or routine work counting home reads.
