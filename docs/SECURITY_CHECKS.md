# Security checks for your projects

Casper can run a set of well-known security tools on your project. This uses no
model and costs no tokens. There are two ways to start it:

- `/security-review` in a Casper session, for the project you are in. After the tools
  it offers an [AI review](#the-ai-review), which uses tokens only if you pick it.
- `casper security [repo]` in a terminal or in CI. This never calls a model.

Casper reports what the tools found. It never calls the code "safe" or "secure":
a clean report means these tools found nothing, not that nothing is wrong.

## What runs

| Tool | When | Licence | Pinned |
| --- | --- | --- | --- |
| gitleaks | always: passwords and keys in files (the value is hidden) | MIT | 8.30.1, sha256 in Casper's source |
| ruff S | Python files: the bandit-style security rules | MIT | 0.16.9, hash-locked |
| semgrep | MCP server or FastAPI code, with Casper's own rules only (never `auto` or the registry) | LGPL-2.1 (engine); Casper's rules are MIT | 1.178.0, hash-locked |
| zizmor | GitHub workflows | MIT | 1.30.1, hash-locked |
| osv-scanner | dependency lock files, with advisory data downloaded earlier | Apache-2.0 | sha256 in Casper's source |
| ansible-lint | Ansible playbooks (it runs the repo's own Ansible plugins, with Casper's own ansible.cfg, never the repo's) | GPL-3.0, called, never copied | 26.9.0, hash-locked |
| mcp-scanner | only with `--mcp-tools <file>`: the tool descriptions in a saved `tools/list` reply | Apache-2.0 | 4.8.4, hash-locked |

A tool the project does not need reads "not needed". A tool that is missing, crashes
or takes too long reads "not run" with the reason, and the other tools still run.

Casper runs each tool with its own offline setting on, with a dead proxy, with an
allowlist of environment variables (no passwords or tokens) and with a stand-in home
folder, inside the shell sandbox. On Linux the sandbox gives the tools no network at all
and no writes outside the project, temp and package caches; on macOS they reach only listed hosts. Where
no sandbox runs (Windows, bubblewrap missing, `--no-sandbox`) a program can still open a
network connection itself, and the report's second line says so. See [SECURITY.md](SECURITY.md).

## Installing the tools

Casper looks for its own pinned copy in `~/.casper/tools`, then for your own copy on
`PATH`. Your own copy is shown with its version:

```
gitleaks: using your 8.18.0 (Casper pins 8.30.1)
```

Casper never downloads anything without asking:

```
Security checks need 2 tools that aren't installed: gitleaks, zizmor (about 50 MB from github.com and pypi.org).
1 Stop · 2 Run what's installed · 3 Install them
```

Enter picks 1 Stop: nothing is downloaded and no tool runs. Installing takes a deliberate 3.

Go programs are checked against the sha256 in Casper's source before they are
unpacked; a mismatch installs nothing. Python tools install with `uv` from lock files
that carry a hash for every package.

- `casper security` never installs. `casper security --install` installs what is missing first.
- A `/security-review` that cannot ask (a one-shot run, `--json`, a pipe) installs
  nothing, runs what is installed and says so.
- `/security-review update` downloads osv-scanner's advisory data, after asking
  (`1 Stop · 2 Download it`; Enter downloads nothing).
  The report shows how old it is.

## Ignores

Tools let a file say "ignore this" (`# nosec`, `# noqa: S608`, `nosemgrep`,
`gitleaks:allow`, `zizmor: ignore`, and files such as `.gitleaks.toml`). Casper turns
those off in the tools and decides itself. An ignore counts only when:

- you committed it (it is in the last commit), or
- you approved it with a numbered choice:

  ```
  New ignore you didn't approve: src/x.py:12  # nosec B608
  1 Leave it flagged · 2 Show the line · 3 Keep it (I approve)
  ```

Enter picks 1, so it never approves anything.

A changed ignore file is not used until you say so:

```
.gitleaks.toml changed since your last commit, so Casper used the default rules.
1 Keep the default · 2 Use my changed file
```

Approvals are kept in `~/.casper/projects/<project>/security-approved.json`, never in
the repo. `/security-review ignores` lists them and can remove one. Only your answer
writes that file: no model tool can, and with the shell sandbox on no shell command can
either. Where no sandbox runs, a shell command could still edit it, so treat it as best effort there.

## The report and exit codes

```
Security check: my-server (/home/me/my-server)
Casper runs these tools in the shell sandbox: no network, no passwords or tokens, and no writes outside the project, temp and package caches.
gitleaks      1 problem    config/.env.example:4  looks like an API key (value hidden)
ruff S        ok
zizmor        ok           its online checks off
osv-scanner   not run      no advisory data yet. /security-review update downloads it (asks first)
Result: 1 problem, 1 check not run. This is what these tools found. It does not prove the code has no problems.
```

`casper security` exits **0** with no problems, **1** with problems, and **64** on a
usage mistake. `--strict` also exits 1 when a check did not run or a new ignore was
added. `--json` prints one versioned document (`version: 1`) with the same facts.

## The AI review

After the tools, `/security-review` offers one more step: the AI reads the changed
code for security problems. It is the only part that costs tokens, so it asks first,
with the cost, and Enter stops:

```
Next: the AI can read the 3 files for security problems (changes since main).
It runs on openrouter/some-model (your review model): at least about 9k tokens, ≈ $0.03, up to 30 steps and 10 minutes.
It reads with look-only tools and can't run commands or change files. Key and .env files and files gitleaks flagged are kept from it, and secrets it reads elsewhere are hidden.
Its findings are its opinion, not checked by a tool.
1 Stop here · 2 Run the AI review
```

- **What it reads.** This branch's changes against the default branch (`origin/HEAD`,
  else `main` or `master`), else your changes since the last commit, else the files the
  tools flagged and the MCP server code. At most 40 files, none over 256 KB, no binary
  files. The price is a lower bound: it counts the files once, and each step the AI
  takes costs more.
- **How it reads.** One read-only child on your review model (`/model` sets the
  `review` role; without one, your usual model). It has `read`, `grep`, `find` and `ls`
  only: no shell, no edits, no network tools. It is not the shell sandbox; it simply
  has no tool that runs a command.
- **What it never sees.** Key files (`*.pem`, `id_rsa` and the like), `.env` files,
  credential files and files gitleaks flagged in this run are refused, and a `grep`
  leaves their lines out. Secrets in anything else it reads are hidden the same way as
  in a normal session, with device-config hiding on even when `/secrets files off`.
  If gitleaks did not run, the question says that flagged files could not be kept from it.
- **What it shows.** Each finding needs a real `file:line` in this project and a
  concrete example input; anything else is counted as "not shown". Findings are the
  AI's opinion and say so:

```
AI review (the AI's opinion, not checked by a tool):
  src/server.py:88  host goes into a shell command. Example input: 8.8.8.8; id  (the AI's opinion, not checked by a tool)
2 AI findings not shown: no real file:line here or no example input.
The AI review used about 23k tokens (≈ $0.07, the catalog's estimate).
This is the AI's opinion of the code it read. It does not prove the code has no problems.
```

- **Ignores stay yours.** Nothing the AI says can approve or hide an ignore. Only an
  ignore you committed, or one you approved with your own `3`, counts.
- **Scripts.** A one-shot or `--json` run never starts the AI review by itself: it says
  so and spends nothing. `casper "/security-review ai"` runs it without asking (the
  cost is printed first). `casper security` never calls a model.
