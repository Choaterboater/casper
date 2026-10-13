# Terminal checks

**What this is:** a managed check that starts a CLI in a real pseudoterminal, waits for screen text,
types sample input and presses keys. **When you'd use it:** to catch an invisible prompt, broken key,
erased output or a CLI that never exits. It uses the same `/verify` and `casper_check` surface and receipt
as the project's other checks; no new model tool or separate session is needed.

Built, not released. The first version runs on macOS and Linux with `python3` (standard library only).
Windows and missing Python report **not run**, never a pass. Casper installs nothing automatically.

## Declare a scenario

In `.casper/project.yaml`, next to the project's other checks:

```yaml
verify:
  checks:
    cli-greeting:
      preset: terminal
      argv: [python3, cli.py]
      columns: 80
      rows: 24
      timeout: 15
      scope:
        inputs: [cli.py, .casper/project.yaml]
      steps:
        - expect: "Name?"
        - send: "Ada"
        - key: enter
        - expect: "Hello Ada"
```

The matching local example `cli.py` is:

```python
name = input("Name? ")
print("Hello " + name)
```

`/verify cli-greeting` runs it. Once configured it also joins the checks after a change, and the AI can
run it through `casper_check`. Set `after: ask` on the named check to keep it manual instead. A failed
screen expectation or exit appears on the receipt, with the failing step and up to 6000 characters of
the current screen in the check output. Output is data, not instructions, and the existing check-output
secret filter still applies before the model sees it.

## Steps and bounds

- `argv`: 1–32 program/argument strings, run **without a shell** at the project root. Each is at most
  4096 characters. Shell syntax in an argument is literal, not executed.
- `steps`: 1–24 steps, each with exactly one of `expect`, `send` or `key`. At least one `expect` is required.
- `expect`: a nonempty, case-sensitive substring of the **current visible screen**, up to 4096 characters.
  It waits until present or the scenario deadline. It does not match erased text or scrollback, and it
  is not a regex; blank right-hand padding is stripped from each row. An expectation can match a transient frame; it is not a claim that the screen stayed
  unchanged afterward.
- `send`: printable sample text, at most 4096 characters. To submit a line, follow it with `key: enter`;
  control characters in `send` are refused.
- `key`: `enter`, `tab`, `shift-tab`, `escape`, `up`, `down`, `left`, `right`, `ctrl-c`, `ctrl-d`, or `backspace`.
  These are real terminal input sequences; Ctrl+C reaches the foreground program, not Casper.
- `columns`: 20–240 (default 80); `rows`: 5–100 (default 24).
- `timeout`: whole seconds, 1–3600; the ordinary check timeout applies when omitted. It bounds the whole
  scenario, not each individual step. An app still running after the last step must exit before it.
- `exitCode`: 0–255, default 0. All assertions **and** this exit condition must pass. A nonzero exit does
  not become a pass just because the screen looked right; expect it explicitly when testing error paths.
- `scope`: the existing declared-input format (`inputs`, optional `exclude`). With no scope the result
  still runs, but its freshness is unavailable and it is not reused as input-scoped evidence.

The screen tracks UTF-8, cursor movement, erase, scroll regions, colours (ignored for text assertions)
and alternate-screen mode. Unicode grapheme sequences this small screen cannot model (such as ZWJ emoji),
application-cursor mode and unsupported image commands remain unverified. Unsupported terminal operations or an incomplete escape at exit report
**not run / unverified**, not a guessed pass. At most 8 MiB of raw terminal output is read, and the
screen is bounded by the declared viewport. There is no colour, overlap or image assertion yet.

## Execution and evidence

Use these for local tests with sample data. As with `verify.test`, the scenario runs the project's own
program: review it first, and do not use a synthetic terminal check to operate a live account or device.
Device checks still use the lab-check approval path; a terminal preset cannot declare `kind: lab`.

The helper and program run through the ordinary managed-check wrapper and the session's sandbox
settings. AI provider keys are removed from the environment as for every repository check. Program
and descendants are stopped on completion, failure, timeout or cancellation; no background terminal
session is left open. Python's PTY implementation needs no downloaded package.

Scenarios are frozen when the task's checks are registered. Their screen expectations, keys, viewport
and exit condition are part of the check's command identity: changing any of them invalidates an old
pass even when `argv` and project files are identical. Edits to declared inputs use the same freshness
and final-check replay machinery as the other managed checks. Run repository tests too; a passing
terminal scenario proves only its declared assertions.

## Not built yet

Windows ConPTY, interactive terminal inspection outside a declared check, resizing during a scenario,
and visual/layout assertions are follow-up work. This first slice is a repeatable CLI test, not a
terminal remote-control service.
