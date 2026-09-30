# Managed services

**What this is:** Casper can start and stop your project's long-running
programs, such as a development web server, for you. **When you'd use it:** when
you want Casper (or the model) to run your app, send it a test HTTP request, and
check it still answers after a change.

You declare each program in `.casper/project.yaml`. Casper then runs it as a
**managed service**: it picks a port, waits until the service is ready, keeps
recent log lines, restarts it when edits may have changed what it serves, and
stops it when the conversation that owns it ends. A running service is not proof
that anything works; it only gives Casper something to look at.

A service runs your project's own command in the project folder. It is trusted
project code. In 0.2.15 it runs with your permissions.

From v0.2.17 (not released yet) it runs in the shell sandbox where one can run: it
writes only the project and temp and can't read your private folders, but it keeps
the machine's network so you can reach it (on macOS it reaches only listed hosts). On
Linux it can't open a Unix socket, so a service that drives Docker
(`docker compose up`) needs `sandbox: off` in `~/.casper/config.yaml`. Where no
sandbox runs (Windows, bubblewrap missing, `--no-sandbox`) it runs with your
permissions. See [SECURITY.md](SECURITY.md).

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

A small working example, using Python's built-in web server to serve the
project folder:

```yaml
services:
  web:
    command: python3 -m http.server $PORT --bind $HOST
    port: auto
    ready: { http: / }
```

Then `/services start web` starts it and `/services` shows its address.

- **`command`** is run exactly as written through the shell (at most 4 KiB).
- **`port: auto`** gives the service a free loopback port, so two Casper runs of the same
  project never collide. Casper keeps the same port across restarts while it is free. A
  **fixed port** stays the same address. If it is already held by a process Casper did
  not start, the start is refused with guidance (stop that process, or use `port: auto`).
  Casper never stops or replaces a process it does not own. The port check and the
  service's own bind are not atomic: a foreign process that binds the port in between
  could answer an HTTP readiness probe, and Casper would take it for the service.
- **`ready`** is `{ http: <path> }`, a path probed on `http://127.0.0.1:<port>` until any
  HTTP answer arrives, or `{ log: <text> }`, a line the service prints. A service that
  misses its deadline, or exits first, is stopped and reported with its last log lines.
- **`scope`** has the same shape as `verification.scopes` (literal project-relative
  paths, no globs). An edit inside it marks the service stale. Paths are resolved as for
  verification scopes (symlinks, letter case), and an edit Casper cannot prove is outside
  the scope (for example a path that does not exist yet next to a scoped name) counts as
  inside. Without a scope, any edit in the project does. A shell command's files are
  unknown, so it marks every running service stale.
- **`env`** holds literal values, at most 32 of them. Nothing else comes from your shell: services start in
  Casper's isolated environment (a temporary `HOME`, the project's `node_modules/.bin` on
  `PATH`, package installs disabled). Casper sets `PORT` and `HOST` (`127.0.0.1`) itself,
  and owns `PATH`, `HOME`, `TMPDIR`, `BUN_INSTALL_AUTO` and `npm_config_offline`, so `env`
  may not set any of them (the last five in any letter case). The service should listen
  on `HOST:PORT`.
  From v0.2.17, AI provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and the rest)
  are dropped even when `env` sets them.

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

## The model's `service` tool

During a task the model uses one `service` tool, with these actions:

- **`start`** starts a declared service by name and waits for readiness. A stale or
  crashed one is restarted first. With `command` instead of a name, it starts an
  **ad-hoc service** named `adhoc-<n>`. It runs at the project root with `PORT`/`HOST`
  and nothing else in `env`, has no scope (any edit makes it stale), and is ready at
  `ready` (default `{ http: / }`) within `timeoutMs` (default 30000). Starting the same
  command again joins the running one (restarting it first when an edit made it stale or
  it no longer answers, reported as `restarted`), and relaunches it under the same name if it
  stopped, failed or crashed. At most 4 ad-hoc services run at once, and at most 4 are
  kept: starting a fifth drops the oldest one that is not running.
- **`status`**, **`logs`** (the most recent `lines`, default 40 and at most 200,
  optionally only lines containing `filter`), **`restart`** and **`stop`**.
- **`request`** sends one HTTP request (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`,
  `DELETE` or `OPTIONS`). It is sent either to `service` plus `path` (which
  starts with a single `/` and contains no `\`), or to a `url` on `localhost`, `127.0.0.1` or `[::1]` over `http:`. A URL at a service's
  address counts as that service. Anything else is refused. Before sending, Casper makes
  the service fresh: a service that is stale from edits, has crashed or no longer answers
  its readiness path is restarted, and the result says `restarted: true`. Redirects are
  shown, not followed. The request times out after 10 s. The result shows the status,
  selected headers (`content-type`, `content-length`, `location`, `allow`,
  `cache-control`, `etag`, `last-modified`, `retry-after`, `www-authenticate`) and the count of the rest. It also shows the timing and the
  body, with JSON pretty-printed. A body over 8 KiB is cut with a marker such as
  `[truncated: 20480 bytes, first 8192 shown]`; the size is that of the body as shown, so
  for pretty-printed JSON the marker says `bytes as pretty-printed JSON`, and a body over
  64 KiB is not read further (`more than 65536 bytes`). The whole result, an error included,
  stays within the usual 16 KiB capability-result bound.
- **`check`** records a smoke check (`name`, `service`, `request`, `expect`) and runs it
  once for its baseline; **`replay`** reruns one by `id`. Casper replays every recorded
  check after the change (see [VERIFICATION.md](VERIFICATION.md), "Smoke checks"). A check
  recorded after edits in the task, or during a repair round, is an observation, never evidence.

A crash after readiness is not pushed into the model's turn. The next `service` call or
smoke run reports it once, with the exit code and last log lines. A `service` call reports
it under `crashed`, before a request restarts the service, and a crash that `/services`
restarted or stopped first is still reported on that next call. A smoke run reports it in
the smoke report's `crashes` (the receipt says `api restarted after crash (exit 1)`), and a
repair prompt that follows it includes the crash.

The model's `edit` and `write` calls mark the services whose scope covers the file
stale. A `bash` call marks every running service stale.

The tool is offered only when the project declares services, a service is running, or
the task mentions a dev, HTTP or web server, `localhost`, an endpoint or `curl`. In other
tasks it is left out, so it costs no prompt tokens. Services the model starts belong to
the session like declared ones, and `/services` lists and controls them too.

## Dev servers for page checks

New in v0.2.16 (not released yet). In a web project Casper starts the dev server itself
to open changed pages after a change (see [page checks](VERIFICATION.md#page-checks)). A
declared `services.web` (or the only declared service of a web project) is used as it is.
Otherwise Casper runs the package.json `dev` script with its own port flags, or a
Streamlit app with the project's `.venv` Python, in a `web` slot of its own. Casper never
installs packages for it. That slot lives for the session like a declared service and
shows in `/services`. It is Casper's own: a running page-check server never adds the
service tool to the AI's later tasks.

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
