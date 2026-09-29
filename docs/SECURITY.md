# What Casper keeps from the AI, and what it doesn't yet

Casper is **not a sandbox yet**. The shell sandbox is planned for v0.2.17. Until
then, these checks cut the most likely leaks. Each one is a check Casper makes
before a tool runs or before output reaches the AI. None of them is OS
isolation. Each row names the test that fails without it.

## What Casper does now

| What | How it shows | Test |
| --- | --- | --- |
| The AI's `read`, `grep`, `find`, `ls`, `edit` and `write` never open private places: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`, `~/.oci`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.pgpass`, `~/.claude.json`, `~/.mcp.json`, Casper's and Pi's login files (`auth.json`), `~/.casper/mcp-consent.key`, keychains and password stores. A link to one of them counts too. | `Not read: ~/.ssh is private (keys and logins). Casper keeps it from the AI.` | `tests/file-guard.test.ts`, `tests/secrets-pi.integration.test.ts` |
| `grep` on a folder that holds a private place (for example `~`) is refused, because grep reads hidden files. | `Not searched: ~ holds private files (~/.ssh). Search a narrower folder.` | `tests/file-guard.test.ts` |
| Those file tools never follow a link out of the project. | `Not read: notes.md is a link to a place outside this project. Casper doesn't follow links out.` | `tests/file-guard.test.ts`, `tests/secrets-pi.integration.test.ts` |
| `edit` and `write` can't change git's own files: anything in a `.git` folder or a `.git` file, a worktree's shared git folder, or the folder `core.hooksPath` points to. | `Not done: .git/hooks belongs to git itself. Casper doesn't let the AI change it.` | `tests/file-guard.test.ts`, `tests/secrets-pi.integration.test.ts` |
| `edit` and `write` can't change `~/.casper`, `~/.pi`, shell start-up files (`~/.bashrc`, `~/.zshrc`, `~/.profile` ...) or your git settings (`~/.gitconfig`, `~/.config/git`). | `Not done: ~/.bashrc holds your shell, git or Casper settings. Casper doesn't let the AI change it.` | `tests/file-guard.test.ts` |
| A shell command that writes to `.git/hooks`, `.git/config` or the `core.hooksPath` folder, or runs `git config` on a key that makes git run a program (`core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `alias.*`, `filter.*`, `credential.*`, `include.*` ...), or `git config --global`, is refused. | `Not run: this command changes .git/hooks, git's own files. ...` | `tests/file-guard.test.ts`, `tests/secrets-pi.integration.test.ts` |
| Values in `.env`, INI and credential files, values of secret-named keys and webhook or DSN addresses, passwords inside addresses (`postgres://app:PASSWORD@db`), exact copies of secret-named environment values and of the keys in Casper's login file are hidden from the AI in read, grep, shell and service output, in the main session and in read-only helpers. See [SECRETS.md](SECRETS.md). | `MIST_APITOKEN=<secret hidden>` | `tests/secrets-files.test.ts`, `tests/secrets-pi.integration.test.ts` |
| Repo checks (`/verify`, auto checks, proof and trace copies), services and dev servers run without AI provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and the rest Pi reads) or Casper's own secret variables. Network product tokens such as `MIST_API_TOKEN` stay, so your own tests still work. | nothing to see: the key is not there | `tests/shell-env.test.ts` |
| A question the AI asks with its `ask` tool starts with a muted `The AI asks:` line. Casper's own questions and approvals never do, so the AI can't pass off a question as a Casper approval. | `The AI asks:` | `tests/ask.test.ts` |

## What v0.2.16 adds, and how each part is held back

v0.2.16 adds new things that run code or reach devices. None of them is sandboxed yet.

| What | What Casper does | Test |
| --- | --- | --- |
| `casper new` runs `uv`, `bun` and `git` to build a project. | They run without AI provider keys. No model is called. The first commit uses your own git settings and hooks, and nothing is committed when the new folder is inside another repository. | `tests/new-scaffold.test.ts`, `tests/new-project-ask.test.ts` |
| Page checks start the project's dev server after edits. | The dev server runs the repository's own code, so Casper prints `Starting dev server … (it runs your project's code)` before the first start in a session, and `/status` names the command. It gets no provider keys. `pages: off` in `.casper/project.yaml` turns it off. It never runs when checks are off. | `tests/pages-app.test.ts`, `tests/checks-visibility.test.ts` |
| Ansible checks Casper finds are only offered. | They never run until you save one with `/verify add <name>`. When they run, Ansible gets Casper's own `ansible.cfg` (never the repo's, so no vault password script runs), a private home folder and no provider keys. | `tests/network-checks-app.test.ts`, `tests/ansible-syntax-preset.test.ts` |
| Lab checks (`junos-commit`, AOS-CX `ansible --check`) reach your lab devices. | Only you start them, with `/verify <name>`, and only after a numbered question. The lab list comes only from `~/.casper/config.yaml`. The inventory and playbook text are checked against it before every run. A run that can't ask sends nothing. The AI's `casper_check` can't run them. | `tests/lab-checks.test.ts`, `tests/network-checks-app.test.ts` |
| `/security-review` and `casper security` run pinned tools. | Downloads are checked against a sha256 or a hash-locked list before use, and only after you pick Install. Each tool runs with a dead proxy, no passwords or tokens and a stand-in home folder. ansible-lint gets Casper's own `ansible.cfg`. An ignore added since the last commit counts only after you approve it. | `tests/security-command.test.ts`, `tests/security-args.test.ts`, `tests/tool-pins.test.ts` |
| Plan first (`/plan`) lets the model look before it builds. | While planning, Casper asks its tool gate about every tool: only `read`, `grep`, `find`, `ls` and a short list of look-only shell commands run. Edits, MCP tools and Casper's own tools are refused. Files that change anyway are named on the receipt. | `tests/flows-plan.test.ts`, `tests/plan-first.test.ts` |
| Remember a test command. | Offered only for a known test-runner shape the model ran and passed, with the exact line it saves. Nothing is saved until you press its number. | `tests/flows-suggest.test.ts`, `tests/suggestions-app.test.ts` |
| Casper's release workflow. | Every action is pinned to a commit. The job that can publish runs no project code, and a release waits for the Linux and Windows previews to pass on the same commit. | `tests/release-workflows.test.ts` |

## What is still not blocked (until the v0.2.17 sandbox)

- **The AI's shell can still read private files.** `cat ~/.ssh/id_ed25519` in
  `bash` is not stopped. Exact copies of your secret environment values and of
  the keys in Casper's login file are hidden from what it prints, and so are key
  files it prints in PEM form, but a
  script can change the text first (base64, for example).
- **The AI's shell still has your environment**, provider keys included. Their
  values are hidden from the output the AI reads, but a command can send them
  somewhere over the network.
- **The shell checks are text checks.** A script, an alias or `sh -c` with a
  built string can still write `.git/hooks`. The file tools can't.
- **Repo checks, services and dev servers run the repository's own commands**
  with your permissions and network access. They no longer get provider keys,
  but they can read your files. Use `--no-verify` in a repo you don't trust.
- **A link can be swapped** between the check and the open (a race). The check
  uses the real path of the longest part that exists, which narrows this, and
  Windows has no no-follow open at all.
- **Private places are by name.** A key stored somewhere else (for example
  `~/work/deploy-key`) is not on the list. It is hidden only when it is in a
  key or credential file format.
- MCP servers, language servers, the debugger and the browser run as your user
  and are not covered by any of this.
- **Dev servers, found checks and lab checks can reach the network.** A page can call
  any address, and Casper checks a lab check's inventory and playbook text but can't
  block other traffic. The critique moved lab checks to v0.2.18, behind the sandbox's
  network allowlist; v0.2.16 ships them started by you only, and the question says so.
- **The plan turn's look-only list is not a sandbox.** For example `git diff` and
  `git log` follow a repository's own `diff.external` and `textconv` settings, which
  can run a program. A file that changes is still named on the receipt.
- **The AI's shell can write the files that hold your choices** in `~/.casper`:
  security approvals and lab "Always" answers. Only the sandbox can stop that.
- **ansible-lint loads the repository's own Ansible plugins** (`library/`,
  `filter_plugins/`). Only `ansible.cfg` is kept out.
