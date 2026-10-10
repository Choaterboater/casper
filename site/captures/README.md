# Terminal captures

Plain-text copies of real Casper 0.2.31 runs, for the site's `<pre>` blocks.
Nothing here used a model API key or the network.

## Rules used for every file

- Line 1 (and sometimes line 2) is a `# ` note saying what the capture shows. Lines that start
  with `# (` inside a capture are notes about a key we pressed; they are not Casper output.
  Everything else is output, copied as it was.
- No ANSI codes. No line is longer than 100 characters (terminal was 100 columns wide).
- Paths were shortened: the temporary home folder became `~`, the MCP test repo became
  `~/project/lab-mcp`.
- Interactive captures were cut to the part that matters. The prompt box and footer under the
  transcript were left out.
- The model in the interactive and `--json` captures is a **scripted stand-in**
  (`capture-app.ts`), not a real model. Its lines are the ones marked `[model] scripted/site-capture`
  and the short replies such as `(scripted model) No more changes.` Its file edits are real
  edits on disk. Everything Casper does after that is the real code of the checkout the scripts ran in: checks, the
  with/without-the-change proof, repairs, receipts, MCP connect, approvals, `Ctrl+O`.
- `$ casper ...` in `mcp-check.txt` and `json-receipt.txt` is what a user types. We ran the same
  code from source: `bun src/cli.ts ...` (for `mcp-check.txt`) and `bun site/captures/capture-app.ts --json ...`
  (for `json-receipt.txt`, because it needs the scripted model).

## Helper files (in this folder)

- `make-project.sh <dir>`: makes `<dir>/home` (with `~/.casper/mcp.json` pointing at
  `tests/fixtures/mcp-server.ts`, a local test MCP server that never contacts a device) and
  `<dir>/project` (a tiny git repo: `src/sum.js` with a bug, `a - b`; `tests/sum.test.js`;
  `.casper/project.yaml` with `commands.test: bun test`, `verification.mode: auto`,
  `repair.maxAttempts: 1`).
- `capture-app.ts`: runs the real `CasperApp` with a scripted runtime instead of a model.
  Interactive by default; `--json "<prompt>"` does a one-shot JSON Lines run like
  `casper --json`. The scripted model acts only on its first request:
  "fix the sum bug" (fixes `a - b`, adds a test), "numeric strings" (wraps inputs in `Number()`,
  no test), "speed up sum" (breaks it: `a * b`), "set the lab site" (calls the MCP write tool
  `fixture/set_site`). Any later prompt (such as a repair request) gets "No more changes."
- `secrets-demo.ts`: runs Casper's own `scrubToolOutput` (the function a native `read` goes
  through) on two made-up backups, with netconan off.

## How each capture was made

Common setup (paths are examples; `$CASPER` is this repo, `$W` any scratch folder):

```sh
BUN=$(command -v bun) sh $CASPER/site/captures/make-project.sh $W/capN
# interactive run, 100 columns:
tmux new-session -d -s cap -x 100 -y 60 -c $W/capN/project \
  "env -i HOME=$W/capN/home PATH=$HOME/.local/bin:/opt/node22/bin:/usr/bin:/bin TERM=xterm-256color \
   LANG=C.UTF-8 bun $CASPER/site/captures/capture-app.ts"
tmux send-keys -t cap "<text>" Enter      # then: tmux capture-pane -p -t cap -S -300
```

| File | What it shows | How |
|---|---|---|
| `banner.txt` | Start screen (ghost + wordmark, version, checks line) | Common setup, fresh project; screen before any input. |
| `help.txt` | `/help` at 100 columns | Common setup; typed `/help`. Same text as `bun src/cli.ts --help`, wrapped by Casper at 100 columns. |
| `status.txt` | `/status` before a model is picked | Same session; typed `/status`. |
| `receipt-verified.txt` | ✓ Verified: tests fail without the change, pass with it | Common setup, fresh project; typed `fix the sum bug in src/sum.js`, then `/receipt`. |
| `receipt-not-proven.txt` | ⚠ Not proven: tests pass without the change too; one repair round asks for a test | Fresh project, then `sed -i 's/a - b/a + b/' src/sum.js && git commit -qam "sum adds"`; typed `let sum take numeric strings too`. |
| `receipt-failed.txt` | ✗ Failed: a test fails, one repair try, still failing, with the check's output boxed | Fresh project, fix `sum` as above and append `test("two plus three", () => expect(sum(2, 3)).toBe(5));` to `tests/sum.test.js`, commit; typed `speed up sum in src/sum.js`. |
| `checks-live.txt` | `/verify`: one line per check as it finishes, then the receipt | Fresh project, with `.casper/project.yaml` set to `commands: {lint: node --check src/sum.js, test: bun test, build: bun build src/sum.js --outdir dist}` (plus the same verification/repair lines), `dist` in `.gitignore`, committed, then Casper restarted (the config is read at start); typed `/verify`. `node` must be on `PATH`. |
| `numbered-choices.txt` | A check that could not start, and Casper's numbered "What now?" choice; Esc skips | Same project, but started with a `PATH` that has `bun` but **not** `node` (a folder holding only a link to `bun`); typed `/verify`, captured, pressed Esc, captured again. |
| `mcp-status.txt` | `/mcp` (the server picker), Connect with "Remember fixture?" (answered `1`, No), `/mcp writes fixture` (answered `2`); each closed box leaves one line | Common setup (the `fixture` server comes from `~/.casper/mcp.json`); typed `/mcp`, pressed `1` (the server) and `2` (Connect) in the picker, answered `1` to "Remember fixture?", pressed Esc at the servers the picker came back to, then typed `/mcp writes fixture` and `2`. Pieces of one session, joined with `# (` notes. |
| `mcp-ask.txt` | A write tool on an MCP server asks first; `1` (No) denies; `Ctrl+O` turns writes off | Same session; typed `set the lab site on the fixture server`, then `1` at "Make this change?", then pressed Ctrl+O. |
| `mcp-allow.txt` | The same write, answered `2` (Yes, this once) | Same session; typed `set the lab site on the fixture server`, then `2`. |
| `mcp-setup-network.txt` | `/mcp setup network` asks once; `1` is Not now | Fresh project, `uv` on `PATH` (without it the question also shows uv's installer); typed the command, then `1`. Nothing is installed. |
| `mcp-check.txt` | `casper mcp check --quick` on a test server whose tool labels are wrong on purpose | Folder `lab-mcp` with `server.ts` = copy of `tests/fixtures/mcp-check-server.ts`, a `node_modules` symlink to this repo's, `Makefile` (`test:` / `true`), `git init`, and `.mcp.json.example` = `{"mcpServers":{"lab":{"command":"bun","args":["server.ts"],"env":{"FIXTURE_MODE":"lying","FIXTURE_READ_ONLY":"1"}}}}`. Ran `env -i HOME=<tmp> PATH=... TERM=dumb CASPER_PROFILE=default bun $CASPER/src/cli.ts mcp check . --quick` in it (exit 1). Output piped through `fold -s -w 100`. |
| `secrets-hidden.txt` | Two fake backups (AOS-CX `.cfg`, Junos `.set`) on disk and as the AI reads them, plus `/secrets` | `bun site/captures/secrets-demo.ts` from the repo root. The `/secrets` lines at the end were typed in the `mcp-status` session (netconan is not installed there). |
| `json-receipt.txt` | `--json` event types and the final receipt object | Fresh project; `env -i HOME=... PATH=... TERM=dumb bun $CASPER/site/captures/capture-app.ts --json "fix the sum bug in src/sum.js" > ../run.jsonl` (exit 0; the file goes outside the project so it is not counted as a changed file), then the two `jq` commands shown in the file. |

Times such as `0.2s` and `ms: 314` will differ a little on another run. So will the
bun version line inside the failed test's output box.
