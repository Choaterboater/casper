# Managed services

A project can declare its long-running processes, such as a development server, in
`.casper/project.yaml`. Casper starts each one as a **managed service**: it picks the
port, waits until the service is ready, keeps a bounded log, restarts it when edits may
have changed what it serves, and stops it when the conversation that owns it ends. A
service carries no verification evidence itself; it only gives Casper something to
observe.

A service runs the project's own command at the project root. It is trusted project
code, not a sandbox.

## Declaring services

```yaml
services:
  api:
    command: bun run dev          # shell string, run at the project root
    port: auto                    # or a fixed port, 1024..65535
    ready: { http: /health }      # or { log: "listening on" }
    timeoutMs: 30000              # readiness deadline, 1000..120000 (default 30000)
    scope: { inputs: [src], exclude: [src/ui] }   # optional
    env:                          # optional, literal strings only
      DATABASE_URL: postgres://localhost/dev
```

- **`command`** is run exactly as written through the shell.
- **`port: auto`** gives the service a free loopback port, so two Casper runs of the same
  project never collide. Casper keeps the same port across restarts while it is free. A
  **fixed port** stays the same address. If it is already held by a process Casper did
  not start, the start is refused with guidance (stop that process, or use `port: auto`).
  Casper never stops or replaces a process it does not own.
- **`ready`** is `{ http: <path> }`, a path probed on `http://127.0.0.1:<port>` until any
  HTTP answer arrives, or `{ log: <text> }`, a line the service prints. A service that
  misses its deadline, or exits first, is stopped and reported with its last log lines.
- **`scope`** has the same shape as `verification.scopes` (literal project-relative
  paths, no globs). An edit inside it marks the service stale. Paths are resolved as for
  verification scopes (symlinks, letter case), and an edit Casper cannot prove is outside
  the scope (for example a path that does not exist yet next to a scoped name) counts as
  inside. Without a scope, any edit in the project does. A shell command's files are
  unknown, so it marks every running service stale.
- **`env`** holds literal values. Nothing else comes from your shell: services start in
  Casper's isolated environment (a temporary `HOME`, the project's `node_modules/.bin` on
  `PATH`, package installs disabled). Casper sets `PORT` and `HOST` (`127.0.0.1`) itself,
  and owns `PATH`, `HOME`, `TMPDIR`, `BUN_INSTALL_AUTO` and `npm_config_offline`, so `env`
  may not set any of them (in any letter case). The service should listen on `HOST:PORT`.

A project declares at most 4 services. Names are a letter followed by up to 31 letters,
digits, `_` or `-`. `adhoc-<n>` is reserved for services started by command. Services
are a project setting: `~/.casper/config.yaml` and profile files cannot declare them.
Invalid values stop configuration loading with the dotted path, for example
`services.api.port must be auto or an integer between 1024 and 65535`.

## Running services

```text
/services                       state and address of each declared service
/services logs <name>           recent log lines
/services start <name>          start and wait for readiness (restarts a stale or crashed one)
/services restart <name>        stop, then start again
/services stop <name>           stop the service and its child processes
```

These are local commands: no model call and no model runtime startup.

A state is one of `idle` (declared, not started), `starting`, `ready`, `crashed`
(exited on its own after it was ready), `failed` (the last start did not reach
readiness) or `stopped`. A crash is recorded with its exit code and last log lines. It
is shown on the next `/services` and is not pushed into a running model turn. Casper
also stops any child processes the crashed service left behind. A `stale` service keeps
running until something needs it fresh, such as `/services start`; then it is restarted
first.

## Lifetime

Services belong to the session, not to one task. They keep running between prompts, so a
slow development server does not restart for every request. They stop on exit, `/clear`,
`/resume <id>`, `/branch`, `/switch` and `/services stop`. Ctrl+C cancels only a startup
in progress. A running service survives a cancelled task.

Stopping sends TERM, then KILL, to the service's own process group (on Windows, to its
verified descendants). This is Casper's process ownership: it is bounded and it checks
identity, but it is not atomic. When Casper cannot confirm that a service's processes
stopped, it says so (`process cleanup unconfirmed`). It then blocks further work until
you inspect those processes. It never claims the cleanup succeeded.
