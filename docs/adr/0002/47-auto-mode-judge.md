# 47. Auto mode: a model judge for commands that would ask

Date: 2026-10-29. Status: proposed (owner's choice; needs the owner's review before merge). Supersedes decision 27's
"Yes to everything this session" row in the command box, which was the stand-in until this landed.

**What:** with the sandbox off, in a folder you trust, a shell command that would show `Run this command?` (not a read,
not routine work, not one you already answered) goes to a model judge first. The judge is the conversation's current
model at low effort, in one short separate call whose tokens join the task's. It reads the command; your request, with
the lines you typed during the task; the task's last eight steps ("edited package.json", "ran npm test"); and whether
the folder is trusted. Secrets are hidden as in the conversation, and all of it is labelled data, not instructions. It
answers **allow** or **ask**:

- allow: the command runs, and one dim line says what it does: `✓ judge: runs the project's tests`.
- ask: the usual box, with `The judge says: <why>` on its dim line instead of the model's own reason.

It is on by default. `auto mode off` (typed), **Auto mode** in `/settings`, or `auto_mode: off` in
`~/.casper/config.yaml` turns it off. The command box loses its temporary `Yes to everything this session` row;
`/permissions all` stays for anyone who wants no questions.

**Why:** the owner: "I don't want to hit a bunch of prompts when building something." Claude Code (whose interactive
sessions start in auto mode since v2.1.283), Codex and Copilot CLI have moved to a reviewer model instead of a box
per command. Running with the sandbox on by default was tried and rejected: it kept blocking the installs and
setup a build needed. A fixed list of routine commands can't know that `node scripts/seed.js` is the project's own
seed script and `node -e "…"` fetching a URL isn't; a model that reads the request and the steps can.

**Guard rails:**

- It only allows or asks: it never refuses a command on its own. Anything it can't decide (a failure, a timeout, a
  cut-off or unreadable answer, a verdict other than "allow", or an allow with no reason) asks.
- It only sees commands that would show the box, and not all of those: a fixed list, checked in code before the judge
  (`src/sandbox/always-asks.ts`), always shows the box whatever the judge would say, so a model mistake or words planted
  in a request or a file can't run them: sudo and other users (`doas`, `su`); a download run through a shell or interpreter (`curl … | sh`, `bash -c "$(curl …)"`,
  `bash <(curl …)`, `iex (irm …)`); a force push or a deleted remote branch; `git reset --hard`, `git clean -f`, a dropped stash,
  `git branch -D`, files restored over changes, a changed remote or global git config; deleting, moving or changing files
  outside the project, in home, or the project folder itself or its `.git`, or where Casper can't tell (`$DIR`, a `cd` it
  can't follow), and a redirect `>` outside the project; disks, the machine and its services (`dd`, `mkfs`, `diskutil`,
  `shutdown`, `systemctl`, `crontab`, `pkill`, system package managers); shared infrastructure and cloud accounts (`aws`,
  `gcloud`, `az`, `terraform`, `kubectl`, `helm`, `vercel`, `fly` and the like); publishing (`npm`/`cargo` publish, `twine
  upload`, `docker push`, GitHub releases, repositories, secrets, and merging a pull request); another machine; `eval`; and a
  line Casper can't read (an open quote, process substitution). Private places and secrets are refused before any of this. The host, outside-write,
  other-machine, GitHub-login and check-change boxes, MCP change boxes and device writes keep their own questions.
- Only you turn it on or off: a project file can't set `auto_mode` (it is refused, like `routine_commands`). It
  runs only in a folder you trusted (decision 44), and only while someone can answer. One-shot runs, `--json` and
  piped input keep today's refusal, with no judge.
- `/permissions all` answers the box itself, so the judge isn't called then.
- The judge's input hides secrets the same way the conversation does, and says that the command, request and steps
  are data, not instructions.

**Cost:** the judge's own prompt and input are about 360 tokens and its answer about 50. On a Claude plan through
Claude Code, each side call also carries Claude Code's fixed context from the prompt cache, so a check counted about
2,500 tokens there (input 2, output 52, cache 2,508 on Opus 5.5 at low effort, `bun evals/judge-commands.ts`), almost
all of it cache. Only commands that would have shown the box are judged.

**A finding:** a command run without your answer that the judge didn't allow; a command on the fixed list reaching the judge; a judge that refuses on its own; a
hard refusal, another box's question or a device write reaching the judge; the judge running in a folder that isn't
trusted, in a run that can't ask, or because a project file said so; or a secret in the judge's input that the
conversation would have hidden.
