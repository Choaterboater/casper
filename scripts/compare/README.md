# Blind A/B/C compare

Three tools build the same app from the same prompt. Then you pick the best one without knowing
which tool made it.

| Side | What runs |
|---|---|
| A | Casper v0.2.32, as released (a copy kept in `~/casper-compare`, checked by commit) |
| B | The Casper in this checkout: the experiment |
| C | SkyN3t, from your SkyN3t folder |

Each side starts in its own fresh folder. On the judge page the three apps are called X, Y and Z
in a new random order each time. Only after you save a pick does the page show who was who.

**It costs money.** Each run makes model calls on all three sides, and the `big` set runs for up
to an hour.

## Before the first run

- Run it on the computer where you are signed in to your model (your Mac). Casper needs its own
  sign-in. SkyN3t reaches the same model through the matching command-line tool (`claude`, `codex`
  or `copilot`) or OpenRouter, so that tool must be signed in too.
- In this folder: `bun install --frozen-lockfile`.
- Have a working SkyN3t checkout (`uv sync` in it, so it has a `.venv`). The first run asks where
  it is and remembers the answer.
- The first run also downloads Casper v0.2.32 for side A and installs its packages. That happens
  once.

## Running it

```sh
bun run compare run web        # one prompt from the "web" set on all three sides, then judge it
bun run compare tally          # the scoreboard
bun run compare prompts        # every prompt, and how many times each was judged
bun run compare judge          # judge a run you didn't finish judging
```

A run goes like this:

1. It picks the prompt in the set that has been judged the fewest times (or the one you name with
   `--prompt <id>`).
2. It shows the model Casper is set to and asks once: press Enter to use it on all three sides, or
   type another one (`provider/model`). `--model <provider/model>` or `--yes` skips the question.
3. All three sides work at the same time, each with a time limit (`--minutes` to change it). The
   terminal only says how many sides are done, not which ones, so it can't hint at who is who.
4. It starts each app: it installs packages if needed, then runs the `dev`, `start`, `serve` or
   `preview` script, a FastAPI or Flask app, or serves a plain `index.html`. Every side's app is
   started the same way.
5. It opens the judge page. Look at X, Y and Z one at a time, all three side by side, or at phone
   width. Click around in them. Then pick the best one (or a tie) and add a note if you want.
6. Click **Finish** to stop the apps.

If a side fails in its first minute (not signed in, a wrong model name, SkyN3t not installed), the
script says why and skips the judge page, since that run says nothing about quality.

Ctrl-C stops everything. What the sides made so far stays in the run's folder.

## The prompt sets

| Set | What it is | Time limit per side |
|---|---|---|
| `web` | Small web apps from scratch (timer, budget, recipes, habits) | 30 min |
| `improve` | Change an existing app. Every side starts from the same starter app: a plain HTML bourbon shelf or a small React card binder (`starters/`) | 25 min |
| `hobby` | Bourbon tasting log, Pokémon and BoBA card tracker, fishing log, 3D print tracker | 30 min |
| `big` | Bigger whole apps (club site, card shop, stock and crypto watchlist) | 60 min |

The prompts are in `prompts.ts`. To add one, add a line there with a new `id`.

## The scoreboard

```sh
bun run compare tally                       # everything
bun run compare tally --since 2026-10-15    # only picks from that day on
bun run compare tally --experiment 1a2b3c4  # only picks where side B was that commit
```

Each pick saves which commit side B was. When you try a new idea on the experiment branch, use
`--since` or `--experiment` to see only the picks for that idea.

## Where things are kept

Everything lives in `~/casper-compare` (set `CASPER_COMPARE_HOME` to use another folder), not in
the repo:

- `runs/<date>-<prompt>/`: one folder per run, with `A/`, `B/` and `C/` (each app, its logs, and
  for Casper its JSON events) and `run.json`.
- `results.jsonl`: one line per pick.
- `config.json`: where SkyN3t is.
- `casper-v0.2.32/`: side A's copy of Casper.

## What it doesn't do

- SkyN3t may still use a second model for a few side jobs (for example picture checks). The script
  sets the model for its main build and repair work.
- Casper runs as it does from a script: its checks run, and a command that would need your OK is
  refused (it can't ask). npm, PyPI and the other package sites are allowed.
- An app that needs something extra to start (a database, a second server, an API key) may not
  start. The judge page then shows what went wrong, and that counts against that app.
- Starting an app runs its own install and dev scripts on your computer, outside Casper's sandbox,
  the same as opening any project you downloaded. They get your normal environment minus anything
  named like a key, token or password.
