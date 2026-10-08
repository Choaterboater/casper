# MCP capability broker

**What this is.** MCP (Model Context Protocol) is a standard way for an AI tool to
talk to other programs, called MCP servers. A network MCP server gives the AI tools
such as "list the APs at a site" or "run a Junos show command". Casper connects to
those servers for you and decides which tools the AI sees, which ones need your
yes, and how much of each answer the AI reads.

**When you'd use it.** When you want Casper to look things up in Aruba Central,
Mist, ClearPass, NetBox, a Junos router and so on, through a server you trust.
Every server starts with writes off. Every change asks you first, in plain words:
`1 No · 2 Yes, this once · 3 Yes, for this session`, and last
`Yes to everything on <product> this session`. Firmware changes, deletes and admin
changes are off until you allow them ([Change kinds](#change-kinds-and-mcp-allow)).

Casper uses the pinned official MCP SDK (the library that speaks the protocol). No
server and no credentials come with Casper. For Mist, Central and ClearPass, Casper can
set up its own network server for you after one question
([Casper's network server](#caspers-network-server)).

**Read-only comes from the product.** Casper calls a login read-only only when the
product itself says so, through the server's `access_check` tool (see
[Access check](#access-check)). A tool the server marks `readOnlyHint: true` gets the
label `read` and runs without asking, as in Casper 0.2.14. That is the server's
word, not a check. Casper's own labels, word lists, presets and guesses can only
make things stricter (ask more, hide more). They never skip an approval and never
claim read-only. No answer from the product means `access not checked`, not
read-only. Only you can approve a call or turn writes on; the AI can't. See
[SECRETS.md](SECRETS.md) for the device secrets Casper hides from the AI.

## Quick start

1. Put your server in `~/.casper/mcp.json`. For example, a local junos-mcp-server
   checkout (the path and file names are yours to change):

   ```json
   {
     "mcpServers": {
       "junos": {
         "command": "uv",
         "args": ["run", "python", "jmcp.py", "-f", "devices.json", "-t", "stdio"],
         "cwd": "~/src/junos-mcp-server"
       }
     }
   }
   ```

2. Start Casper and type `/mcp` to see it. It shows `not connected` until you connect it.
   `/mcp` prints one line for each server (name, state, tools, writes, sandbox, where it
   was found). On a normal terminal an arrow-key list sits right under it: pick a server,
   then pick what to do (details, connect or reconnect, disconnect, forget, writes on or
   off, sandbox on or off). Nothing to remember. `/mcp detail [name]` prints the full
   status, with limits, the preset and its pins. Plain terminals and scripts get the same
   one-line list with the typed commands shown.
3. Pick Connect (or type `/mcp connect junos`). Casper asks if it should remember the server.
   It then prints one line, such as `[mcp] junos connected · 4 tools · writes off`.
4. Ask your question, for example "show the BGP summary on my lab router". Each
   command still asks you first. For a plain `show` command the box offers
   `3 Yes, show commands on junos for this session`: later show commands run without a
   box; anything else still asks.

Already set up servers in Claude Code or VS Code? Casper finds them; see the next
section.

### Casper's network server

For Mist, Central and ClearPass, Casper sets up its own server
([casper-network-mcp](https://github.com/Choaterboater/casper-network-mcp)). You edit no
file and set no variable.

1. Ask about Mist, Marvis, Central, GreenLake, ClearPass, an SSID, a WLAN, a switch port
   or an access point, or type `/mcp setup network`. Everyday words such as "central",
   "mist", "aruba" or "Wi-Fi" count only next to a network word (site, AP, switch,
   device, VLAN …), so "central logging" or "a wifi icon" in a web app never brings it up.
   Casper asks once:

   ```text
   Casper can set up its network server (casper-network-mcp 0.1.2, about 60 MB from pypi.org, installed with uv into ~/.casper/tools).
   It starts read-only. Logins are asked per product the first time you use it.
   → 1 Not now
     2 Set it up
   Press 1-2 or Up/Down + Enter · Esc is No
   ```

   `2` installs that exact version, every package checked against a hash lock that
   ships inside Casper (the same way as `/security-review`'s tools; it needs
   [uv](https://docs.astral.sh/uv/)). When uv isn't installed, the question says so and
   shows uv's official installer (`curl -LsSf https://astral.sh/uv/install.sh | sh`, or
   the PowerShell one on Windows); then the choices are `1 Not now · 2 Install uv, then
   set it up`, and `2` runs that installer first. It adds `network` to `~/.casper/mcp.json` (never
   over an entry you already have), remembers it, and connects it with writes off.
   `1` is kept: Casper doesn't offer again, and `/mcp` shows
   `network: not set up — /mcp setup network`. Casper doesn't offer it when you
   already have hpe-networking-mcp, casper-network-mcp or a server named `network`;
   `/mcp setup network` still works.
2. The first time the AI uses a product with no login, Casper asks you (never the AI):

   ```text
   Mist isn't set up yet. Casper will ask for a Mist API token. Use one that can reach only the sites you want, not an admin token.
   → 1 Not now
     2 Add a login
   Press 1-2 or Up/Down + Enter · Esc is No
   ```

   `2` asks for the Mist cloud (a numbered list) and the token, typed hidden. Central
   asks for its region, API client ID and secret; ClearPass for its address and API
   token. Central means new Central (through GreenLake) only for now: classic Central
   logins don't work yet, and the question says so. Casper restarts the server with the
   login and checks what it can do with `access_check`, for example
   `Mist login: can change Branch-12 (checked)`. Mist and ClearPass logins are checked;
   casper-network-mcp can't check a Central login yet, so it shows
   `Central login: saved (not checked)`. The last Mist cloud and Central region choice is
   `Other — type the address`, for a cluster that isn't listed (Central also lists its internal cluster).
   `/mcp login mist` adds or replaces it any time; `/mcp login mist forget` removes it.
   `/mcp login` on its own shows each login and asks which to add or replace
   (`1 Not now · 2 Mist · 3 Central · 4 ClearPass`).

   When the product turns a saved login down (an expired ClearPass token, a revoked Mist
   token: the server answers `login_expired`, or, in casper-network-mcp 0.1.0, passes the
   product's own answer through with `"status": 401`),
   Casper asks the same way: `The ClearPass login didn't work (ClearPass turned it down; it
   may have expired). Replace it?` with `1 Not now · 2 Replace the login`.
3. Every change asks you in the change box, like any server
   ([Turning writes on](#turning-writes-on)). The box names the product
   (`Change in Mist: ...`), and a disruptive, firmware, delete or admin change asks every
   time, unless you picked `Yes to everything` on that product (then nothing asks until
   Ctrl+O or the session ends). The real tool's kind comes from the server's `find_tool` and can only make a
   call stricter. A tool `find_tool` never named asks every time, with no
   "Yes, for this session".
   If the AI calls `access_check` first, it is told that a product with no login is
   asked for when it calls that product's tool, so it never asks you in chat.

When Casper ships a newer pinned version, it asks before your first request in a session:
`Casper's network server has an update (0.1.0 → 0.2.0 …)` with `1 Not now · 2 Update it`
(`1` is kept for that version). A newer version that another, newer Casper on the same
computer installed is kept as it is: Casper never offers to go back.
The new version is built beside the old one while it runs; then, once its running calls
finish, the server stops, the folders are swapped and it starts again. A failed update
keeps the old version running. Your `network` entry and what you remembered stay as they are.

One-shot runs never install, never ask for a login and never turn writes on. They print
one line instead, such as `Mist has no login yet. Run casper and type /mcp login mist.`

#### It runs in the sandbox

On macOS and Linux the network server runs inside the same sandbox as the AI's shell
(sandbox-exec, or bubblewrap), held to what it needs:

- **Network.** It reaches only the product hosts of your saved logins: the Mist cloud you
  picked, your Central region and `sso.common.cloud.hpe.com` (where Central logins get their
  token), and your ClearPass address. It goes through a small proxy of its own; any other host
  is refused and Casper says so once: `[mcp] The sandbox kept network from reaching example.com
  (it may reach only api.mist.com).` A login you add or change applies when it restarts, as it
  does after `/mcp login`.
- **Files.** It reads only its own install (`~/.casper/tools/casper-network-mcp`) and the
  Python it was built with, and writes only its spec cache (`~/.cache/casper-network-mcp`) and
  its own temp folder. The rest of your home folder (`~/.ssh`, `~/.casper`, your projects), the
  temp folders and the open project are hidden from it. On Linux it may also run Casper's seccomp
  helper and `socat`, read-only, even when they sit in your home folder.

`/mcp` lists it as `sandboxed` or `not sandboxed` on each connected server's line, and adds one
"Heads up" line if a connected server runs outside the sandbox or any writes are on.
`/mcp detail` shows the full lines, and one summary under them:

```text
  sandbox: on · reaches only api.mist.com · writes only its cache · can't read your keys, ~/.casper or projects (/mcp sandbox network off)
Sandboxed: network. Run as they are: local-docs (Casper doesn't know what it needs).
```

It is on by default. `/mcp sandbox network off` turns it off for that server (kept in
`~/.casper/mcp-sandbox.json`; `/settings` has the same switch), and `/mcp sandbox network on`
puts it back; a running server restarts once its calls finish. Other servers run as they
always did: Casper doesn't know what an unknown server needs, so it never guesses and breaks it.
A server that runs through a package runner (`uvx casper-network-mcp`) or sets its own proxy
runs as it is too. With no sandbox here (Windows, `--no-sandbox`, `sandbox: off`), or when the
sandbox can't start, the server starts as before and `/mcp detail` says why.

### A server on another machine (ssh)

Some MCP servers run on another machine and talk over ssh (stdio). `/mcp setup ssh`
adds one for you. You edit no file.

1. Type `/mcp setup ssh`. Casper lists the hosts in `~/.ssh/config` (not the
   patterns) and asks:

   ```text
   Which ssh host?
     1 Not now
     2 lab-box
     3 Type a host
   ```

   `/mcp setup ssh lab-box` skips this. A host is a name, an address or `user@`
   either; one that starts with `-` is refused.
2. Casper has no plain text box, so the command that starts the server goes on the
   same line: `/mcp setup ssh lab-box python3 -m my_server mcp`. Everything after the
   host is the command, as typed. After a pick or Type a host, Casper says the line.
3. Casper shows what it will write and asks for a name (the host by default):

   ```text
   Casper adds this to ~/.casper/mcp.json and connects it with writes off:
     ssh lab-box python3 -m my_server mcp
   Name it?
     1 Not now
     2 lab-box
     3 Type a name
   ```

   `/mcp setup ssh --name lab lab-box python3 -m my_server mcp` skips this.
4. Casper adds the entry to `~/.casper/mcp.json` (never over a name you already
   have), remembers it, and connects it with writes off. If the server has an
   `access_check`, Casper runs it, as for any server ([Access check](#access-check)).

   ```json
   {"command": "ssh", "args": ["-T", "-o", "BatchMode=yes", "--", "lab-box", "python3 -m my_server mcp"],
    "env": {"SSH_AUTH_SOCK": "${SSH_AUTH_SOCK:-}"}}
   ```

   ssh must log in with no prompt (a key or your ssh agent). If the server doesn't
   start, Casper says what to check, and `/mcp connect <name>` tries again.
   `/mcp writes <name>` lets changes through; each one still asks.

One-shot runs don't ask; they say to run casper and type `/mcp setup ssh`.

## Configure and connect

Casper reads optional JSON files, in this order. A later file replaces a server with
the same name from an earlier file:

1. VS Code user settings: `mcp.json` (`"servers"`) and `settings.json`
   (`"mcp"."servers"`), stable and Insiders. The folder is `~/.config/Code/User` on
   Linux, `~/Library/Application Support/Code/User` on macOS and `%APPDATA%\Code\User`
   on Windows.
2. `~/.mcp.json` (skipped when the opened project is your home folder, where it is item 8)
3. `~/.claude.json`: its top-level `mcpServers`, then the entry for this project
   (`projects["<project>"].mcpServers`)
4. `~/.casper/mcp.json`
5. `~/.casper/profiles/<selected-profile>/mcp.json`
6. `<project>/.vscode/mcp.json` (`"servers"`)
7. `<project>/mcp.json`
8. `<project>/.mcp.json`
9. `<project>/.casper/mcp.json`

Items 4 and 5 are "your own" files. Items 1-3 are "imported". Items 6-9 are
"project files": they come with the repository you opened, so Casper treats them
with more care (see "Discovery is not permission" below).

### Servers you already set up elsewhere

Items 1-3 are the files Claude Code and VS Code use, so you don't have to copy
anything.

- **Only the server entries are read.** `~/.claude.json` also holds history and
  account data. Casper never keeps or prints it. That file may be up to 32 MB;
  the VS Code files and `~/.mcp.json` up to 4 MB each. At most 64 servers are read
  from one file.
- **Where they start.** Imported servers start in your home folder, never in the
  opened project (in `~/.casper` when the project is your home folder).
- **`/mcp` shows where each came from:**

  ```text
  junos  not connected · from ~/.claude.json · /mcp connect junos
  ```

  (The `/mcp connect` hint is left out on a normal terminal, where you pick the server instead.
  `/mcp detail junos` says `Found in ~/.claude.json. Not approved yet`.)

- **Once per new set of names**, an interactive session says:
  `[mcp] Found 3 servers in ~/.claude.json and VS Code. Run /mcp to see them.`
- **VS Code variables are translated.** `${env:X}` becomes `${X}` and `${userHome}`
  becomes your home folder.
- **Entries Casper can't fill in are skipped by name**, and the others still load:
  `Skipped "netbox" from VS Code: it asks VS Code for a value (${input:token}). Put it in ~/.casper/mcp.json instead.`
  The same goes for `${workspaceFolder}` in a user file, `envFile` and SSE (an old
  MCP transport).
- **A half-written `~/.claude.json`** gives
  `Cannot read ~/.claude.json (it may be in use). Try /mcp reload.`
- **A name found in several files is reported**, and your own files win:
  `"junos" is in VS Code and ~/.claude.json; using ~/.casper/mcp.json`
- **A server from the project entry of `~/.claude.json`** whose arguments look like
  paths inside the project gets a note: it starts in your home folder, so copy it to
  `~/.casper/mcp.json` with `"cwd": "${PROJECT_ROOT}"` if it needs the project.
- `<project>/.vscode/mcp.json` is project content (`${workspaceFolder}` is the
  project) and gets the same review as the other project files.

### The file format

Common `mcpServers` maps work:

```json
{
  "mcpServers": {
    "local-docs": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": { "DOCS_TOKEN": "${DOCS_TOKEN}" }
    },
    "remote-docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
      "disabled": true
    }
  }
}
```

The example URL is a placeholder, not a server to connect to.

- **Two kinds of server.** A "stdio" server is a program Casper starts on your
  machine (`command` plus `args`); `type: "stdio"` is optional. An "HTTP" server is a
  URL (`type` `http` or `streamable-http`).
- **URLs.** Only HTTPS, or plain HTTP to `localhost`, `127.0.0.1` or `[::1]`. A user
  name or password inside the URL, a `#fragment`, the old SSE transport, and an
  entry with both `command` and `url` are refused.
- **No shell.** Stdio commands run directly, not through a shell. They get the SDK's
  small default environment plus your `env` map. A shell you name as the command
  (for example `bash -c ...`) can still run shell code.
- **Start folder (`cwd`).** Your own servers (`~/.casper/mcp.json` and profile
  files) start in your home folder, so an opened repository can't change what they
  load. Set `"cwd"` to an absolute folder, `~/...`, or `${PROJECT_ROOT}` to choose
  another. Project-file servers start at the project root, or at a relative `"cwd"`
  inside it.
- **Server names** use letters, numbers, dot, dash and underscore, up to 64
  characters.
- **Time limits** go in the same entry: see "Time limits" under
  [Lifecycle and results](#lifecycle-and-results).

**Variables.** `${ENV_NAME}` (or `${ENV_NAME:-default}`, which uses the default
when the variable is unset or empty) works in the command, arguments, `env` values
and header values. It is filled in only when the server connects. A missing
variable fails the connection, and `/mcp` names it, never a value. Use variables
instead of writing secrets into these files.

**What Casper never does.** It does not run commands to fetch secrets, set up OAuth
logins, install servers or write credentials. It writes MCP configuration in one
case only: `/mcp docs` adds a docs-only server to `~/.casper/mcp.json` after you
pick `2 Add it` (see [Secrets and docs servers](#secrets-and-docs-servers)).

### Commands

```text
/mcp                           # status only; no connection, no model
/mcp setup network             # set up Casper's network server (asks first)
/mcp setup ssh [host] [command]  # add a server that runs on another machine over ssh
/mcp login [mist|central|clearpass] [forget]  # add, replace or forget a network login
/mcp connect local-docs        # allow and connect this server for this run of Casper
/mcp disconnect local-docs     # disconnect and take back that permission
/mcp reload                    # re-read the files without restarting
/mcp writes <name>             # turn writes on for one server (you pick 2 in the box)
/mcp writes off                # writes off for every server (Ctrl+O does the same)
/mcp forget <name>             # forget a remembered server
/mcp junos-show <name> on|off  # let plain Junos show commands run without asking
/mcp sandbox <name> on|off     # run Casper's network server in the sandbox (on by default) or not
/mcp docs                      # docs servers; add a docs-only copy
```

For one-shot tasks, or to connect before an interactive session starts, put
`--mcp` before the prompt. You can repeat it:

```bash
casper --mcp local-docs "Find the documentation for pagination"
casper --mcp local-docs --mcp another-server
```

**Discovery is not permission.** Every server starts disconnected, including your
own. A `trusted` flag in a project file or a skill can't connect one. Only your
`/mcp connect` or `--mcp` does.

- `--mcp` and one-shot runs connect your own and imported servers only. A project
  server (including one that replaces your server of the same name) connects only
  through an interactive `/mcp connect <name>`. First Casper shows its file, the
  file it replaces, its command and arguments or URL origin, and the names of its
  env values and headers (never the values). It also names every `${NAME}` it
  would send and where, for example
  `sends $NETBOX_TOKEN to https://collector.example (header X-Key)`, then asks
  `1 No · 2 Yes, this once`.
- Permission lasts for this run of Casper unless you remember the server (see
  [Remembered servers](#remembered-servers)). It is separate from skill trust.
- `/mcp` on a normal terminal is an arrow-key picker of the servers: each row says its state and
  where it came from (`from ~/.claude.json`, `from VS Code`), and Casper's own network server says
  which products it covers (`network  not connected · Casper's (Mist, Central, ClearPass)`). No list
  is printed before it, and each closed box leaves one line (`Pick a server → lab`, `lab → Connect`,
  `Remember lab? → No`); after a connect the servers come back. Elsewhere (a plain terminal, or
  during a task) `/mcp` lists one line per server: name, state (a failed one with a short reason),
  tool count, writes on/off, sandboxed or not, login access and where it came from.
  `/mcp detail [name]` adds the transport (stdio or http), preset, source file, time
  limits and the whole plain error message. Neither shows command arguments, URLs,
  header values or env values. When a server fails, `/mcp detail` shows what it said
  (see [Lifecycle and results](#lifecycle-and-results)).

**Mistakes in the files.** A broken entry gives a message and takes nothing else
down. A broken entry that would replace an earlier one removes that name; Casper
does not fall back to the earlier program. Casper's own and project files may be up
to 1 MiB, and at most 64 servers are loaded in total. Unknown keys in an entry are
ignored.

**`/mcp reload`** re-reads the same files in place:

- New servers appear disconnected. Removed servers disappear.
- A server whose command, arguments, env, URL, headers or start folder changed
  counts as a different program. Its connection closes, its writes go off, and you
  must `/mcp connect <name>` again. One exception: a definition that matches one
  you remembered is approved again, with writes off.
- A server that moves from your own or an imported file into a project file counts
  as changed too: it needs the project review before it connects again.
- Unchanged approved servers keep their connection.

### Remembered servers

After an interactive `/mcp connect` of your own or an imported server, Casper asks:

```text
Next time it connects on its own, with writes off. Every change still asks you.
Remember lab?
  1 No
  2 Yes
```

`1` (or Enter, or Esc) connects it for this session only. (Before v0.2.16, `1` was
Remember; the order changed so Enter is always the safe choice.)

- **What is stored.** `2` stores a keyed hash (a fingerprint that can't be turned
  back into the values) of the definition: name, start folder, command, arguments,
  env, URL and headers. It goes in `~/.casper/mcp-consent.json`. The key is 32
  random bytes in `~/.casper/mcp-consent.key`. Both files are private (0600). No
  definition value is stored.
- **Next time** the server connects on its own when a task needs it, always with
  writes off. `/mcp detail` shows `Remembered: connects on its own, with writes off.`
- **Any change asks again.** `/mcp` then lists it as
  `not connected (changed since you approved it)`, and `/mcp detail` shows
  `Changed since you approved it. Run /mcp connect <name>.` Time limits and which
  file the entry lives in are not part of the hash. A secret written straight into
  the definition is part of it, so changing that secret asks again; `${VAR}`
  references avoid that.
- **Never remembered:** project servers; netmiko_mcp servers; and servers started
  through a package runner that can download new code later (`npx`, `bunx`,
  `pnpm dlx`, `yarn dlx`, `npm exec`, `uvx`, `uv tool run`, `uv run --with`, `pipx run`,
  `deno run` of an address, `nix run` of a flake without a commit, `docker run` or
  `podman run` with `:latest` or no tag) unless they are pinned to a version:
  `Not remembered: central-mcp-server is not pinned to a version. An update could add write tools. Pin it (for example ==1.4.2 or a commit) and connect again.`
- `/mcp forget <name>` drops a remembered server. A damaged store counts as empty
  and says so. At most 256 servers can be remembered.

### Presets

Casper recognises some network servers by what they run (never by their name) and
adds restrictions. A preset can pin read-only settings (send the server's own
read-only switch), raise a tool's label, hide tools for a read-only login, refuse
arguments and add notes to the approval box. It never lowers a label, never skips
an approval and never calls a server read-only.

| Server | Recognised by | Pinned while writes are off | Hidden for a read-only login (with writes off they stay listed and every change asks in the box) |
| --- | --- | --- | --- |
| casper-network-mcp (Casper's network server) | `casper-network-mcp` or `casper_network_mcp` in the command, or its router tools | `--read-only` (added once); your saved logins are added to its environment when it starts | nothing: `invoke_tool` stays visible so a change can reach the box. Casper judges each `invoke_tool` call by the real tool it runs |
| hpe-networking-mcp | `tool_router.py`, `hpe-mcp-router`, `hpe_networking_mcp`, `HPE_MCP_*` env, or its router tools | `HPE_MCP_ACCESS_PROFILE=safe-read-only`, `HPE_MCP_READONLY=1`, `HPE_MCP_PRODUCT_ACCESS=read-only`, every `HPE_MCP_*_WRITES=0` | `invoke_tool`, `invoke_tools_batch`, write and delete tools |
| centralmcp (`aruba-*`) | `centralmcp` in the command or `CENTRALMCP_*` env | `CENTRALMCP_READONLY=1` | write and delete tools |
| central-mcp-server | `central-mcp-server` in the command | nothing (no setting exists); must be pinned to a version (or be a local checkout) to be remembered | tools not marked read-only |
| junos-mcp-server | `jmcp.py`, `junos-mcp-server`, or its tool names | nothing (no setting exists) | `load_and_commit_config`, `render_and_apply_j2_template` |
| greencli-mcp (GreenCLI) | the program `greencli-mcp` (or `greencli-mcp.exe`), from any folder; GreenCLI's MCP export (a `.mcp.json`) works as saved | nothing: no setting exists (GreenCLI ships no write tools) | write and delete tools; when its `access_check` says read-only, everything above diagnostic |
| mist-mcp (local Mist API server) | `mist_mcp` or `mist-mcp` in the command, or `MIST_READ_ONLY` env | `MIST_READ_ONLY=1` (the server then sends only GET) | write and delete tools |
| Mist hosted | a `mist.com` URL | nothing: `Access not checked. Use a read-only (Observer) org token for this server.` | write and delete tools |
| NetBox | `netbox` in the command, `NETBOX_*` env or URL | nothing: `Use a read-only NetBox API token for this server.` | write and delete tools |
| netmiko_mcp | `netmiko` in the command | nothing; never remembered | tools not marked read-only |
| Oxidized / LibreNMS | the name in the command, env or URL | nothing | tools not marked read-only |
| Grafana | `mcp-grafana` | `--disable-write` (added once) | write and delete tools |
| ClearPass MCP | `clearpass` in the command or `CLEARPASS_*` env | `CLEARPASS_READ_ONLY=true` | write and delete tools |

How pins work:

- A pin is an env value that beats your own, or an argument added once. For
  `docker run` and `podman run` the env pins go in as `-e NAME=VALUE` just before
  the image.
- `/mcp detail` shows `preset: hpe-networking-mcp (read-only pins sent, not confirmed: ...)`
  until the server itself reports its write switches off through `access_check`.
  Then it reads `read-only pinned`.
- When Casper can't place a pin, it says so. For an HTTP server:
  `Can't pin read-only for this server (it runs elsewhere). Every change asks you in Casper.`
  The same line, with another reason, appears when Casper can't find the image in
  a docker command, or has to add an argument to a shell wrapper or a command with
  `--`.
- A server recognised only by its tool list is started once more, with the pins.
- A definition that matches a preset but whose tools don't:
  `Looks different from the hpe-networking-mcp preset. Pins kept, and its extra checks still apply.`

**Junos.** `execute_*` tools are labelled `exec`, and the two commit tools
`destructive`.

- With writes off only plain show commands run. Anything else gives
  `Not executed (Junos writes are off; only show commands run.)`.
- A plain show command starts with the literal word `show` (no short forms), has
  no `;`, line break or redirection, and uses only the pipes `match`, `except`,
  `count`, `display`, `no-more`, `last`, `find` and `trim` (`| save` is refused).
- Show commands still ask, with `1 No · 2 Yes, this once · 3 Yes, show commands on
  <name> for this session`. 3, like typing `/mcp junos-show <name> on`, lets plain show
  commands on that server run without a box until the session ends
  (`/mcp junos-show <name> off` ends it sooner). Commits and other commands still ask.
  PFE commands always ask.
- The approval box for `load_and_commit_config` says
  `Note: load_and_commit_config commits right away. No preview and no auto-rollback.`
  and never offers `p` (preview).
- A Junos call may go 400 s without an answer (the server allows 360 s for a
  commit) unless you set `callTimeout`.

### Access check

A server may offer a read-only tool named `access_check` (contract
`casper/access-check v1`; see
[docs/patches/hpe-networking-mcp-access-check.patch](patches/hpe-networking-mcp-access-check.patch)
for a proposal for hpe-networking-mcp). It asks each product what the current login
may do.

- **When Casper calls it.** Once per connection, and only when the server marks it
  read-only and not destructive, Casper labels it `read`, and it needs no
  arguments. It runs under the call limit, never longer than the start limit.
- **Read-only login.** Only the product's own answer can make a login read-only,
  and only when every product says so. Then:
  - `/mcp` shows `login: read-only`, and `/mcp detail` shows `login: read-only (checked)`;
  - every tool that is not `read` or `diagnostic` is hidden and refused with
    `Not executed (<server> login is read-only.)`;
  - writes can't be turned on:
    `This login is read-only (access_check). Writes can't be turned on here.`;
  - the AI's `find_capability` description says
    `<server>: login is read-only. Write tools are hidden. Don't plan changes on it.`
- **Anything else** (another answer, an error, a slow answer, or no `access_check`
  at all) is `access not checked`. A server that says its login can make changes
  (`login: can make changes (checked)`) unlocks nothing.
- **Where the login can change things (v2).** A `casper/access-check v2` answer may add, per
  product, `"can_change"` and `"read_only"` lists of `{"kind": "org" | "site" | "sitegroup",
  "id", "name"}`. Casper shows them; the server enforces them. `/mcp` then shows
  `login: can change Lab site` (or `2 sites and 1 org`; an org shows as `the org`, never by name;
  `/mcp detail` adds `(checked)`), and the change box adds
  `Your login can change: Lab site` under its first line. A name that isn't plain text, an
  unknown kind, or more than 64 entries drops the whole list, and a product that can make
  changes without saying where hides the line: Casper never shows a shorter reach than
  the real one. v1 answers still work.
- **v2 also says** `"login": "missing"` for a product with no login yet (that product
  doesn't count toward the overall state), and may name a flag instead of an env var:
  `"server_gate": {"flag": "--read-only", "state": "off"}`. Casper's network server
  answers in v2.
- Only the parsed state is used. The server's text never reaches the AI.

### Turning writes on

Every server starts with writes off, including remembered ones. Writes off: the server runs with its read-only settings, and every change asks you first. In detail:

- the server runs with its preset's read-only pins, where it has one;
- every change asks you first, in the change box (see [Safety](#safety)); nothing changes without your answer;
- the AI's `find_capability` description says
  `<server>: every change asks the user first, in Casper's box; they can allow it once or for this session. Don't ask them again in chat.`

**From the change box (the usual way).** The first change on a server shows the box. Answer `2`
(**Yes, this once**) or `3` (**Yes, for this session**) and Casper turns writes on for that server
before the change runs: it waits for running calls and restarts the server without its pins.
`Yes, this once` turns writes off again (pins back) after that change. `Yes, for this session`
leaves them on, and later changes on that server that are not destructive run without a box until
the session ends or you turn writes off (the transcript says `[approval] allowed (this session)`).

**Ahead of time.** `/mcp writes <server>`, then `2` in the box, turns writes on before any change:

```text
Central writes are off.
→ 1 Keep writes off
  2 Enable for this server
Press 1-2 or Up/Down + Enter · Esc is No
```

`1` (or anything other than `2`) keeps writes off. Each change still asks you.

- The box title uses the product name from the preset, else the server name.
- When your own settings still keep writes off, Casper says so:
  `Casper removed its read-only pins, but your own settings still keep writes off (HPE_MCP_ACCESS_PROFILE=safe-read-only in ~/.claude.json).`
- While any server has writes on, the footer starts with `WRITES: <servers> · Ctrl+O`
  (`ALLOW ALL: <servers>` first for servers under "Yes to everything").
  It is never cut off.
- Ctrl+O (or `/mcp writes off`) turns writes off for every server at once, even
  while Casper is working, ends every "for this session" answer, every change kind
  allowed for this session and every "Yes to everything", and denies an open
  box: `[mcp] Writes off for <server>. Every change asks you again.` (With writes
  already off it says `[mcp] Allowed change kinds ended. Every change asks you again.`)
  A yes given in a
  box that was open when writes went off does not count. A server that was running
  without pins is restarted with them once its calls finish.
- A read-only login (see [Access check](#access-check)) never gets writes: changes
  stay hidden and the box is never offered.
- Only you can do any of this. The AI's ask tool can't answer the change box or this
  box, and one-shot runs never turn writes on
  (`Writes can only be turned on in an interactive session.`; a change in a one-shot
  run is `Not executed (needs your approval, and this run cannot ask)`).

### Change kinds and /mcp allow

Each change also has a kind: configuration, troubleshooting, disruptive (reboot,
bounce, disconnect), firmware, delete or admin (users, roles assigned, SSO, tokens).
Casper reads it from the server's `_meta["casper/change-kind"]`, else from the tool's
name; a router call uses the real tool. A server can name a kind stricter, never make
a disruptive, firmware, delete or admin name into a safer one. A preset can raise a
kind too (a teardown that isn't tagged counts as a delete), never lower one. Vendor developer-site categories
are a reference only.

**Firmware changes, deletes and admin changes are off by default on every server.**
The first such call asks about the kind before the change box:

```text
Firmware changes are off by default on Mist.
  Runs: trigger device upgrade
Allow firmware changes on Mist?
  1 No
  2 Yes, this once
  3 Yes, for this session
Type 1, 2 or 3:
```

`2` allows that kind for this one change. `3` allows it on that server until the session
ends, Ctrl+O, `/mcp writes off` or a disconnect; the change box still asks about each call, with no "for this session"
answer (risky and disruptive kinds ask every time). `1` runs nothing.
One-shot runs refuse: `Not executed (Firmware changes are off by default on <server>,
and this run cannot ask)`.

**`/mcp allow <server>`** picks them ahead of time, from a numbered list (never a
config file):

```text
Mist change kinds. Firmware changes, deletes and admin changes are off by default; every change still asks you.
  Allowed now: none
Which change kinds may Mist make?
  1 Keep the defaults
  2 Allow firmware changes
  3 Allow deletes
  4 Allow admin and account changes
  5 Allow all change kinds
  6 Allow everything (no asking) this session
Type 1, 2, 3, 4, 5 or 6:
```

- For 2 to 5, then `1 This session · 2 Remember`. Remembered kinds are kept in
  `~/.casper/mcp-consent.json` as a keyed hash of the server's definition, like a
  remembered server: change its command, arguments or environment and they are gone.
  Project servers and unpinned runners are this session only. Ctrl+O does not forget
  them; `/mcp allow <server> off` does.
- 6 is "Yes to everything" for this session, as in the change box. It is never
  remembered.
- `/mcp allow <server> off` goes back to the defaults on that server; `/mcp forget <server>`
  forgets its remembered kinds too.
- A read-only login can't be widened. Only you can type `/mcp allow`; the AI has no way
  to run it.

## Small model-facing surface

A server may have hundreds of tools. Casper does not hand them all to the AI. For
the connected servers the AI gets:

- at most **six** direct MCP tools, picked for the task at hand;
- `find_capability`: search by words, list every tool (`query: "*"`), or read one
  tool's full input schema (the JSON description of its arguments);
- `call_capability`: call any tool by its exact ID and arguments.

That is at most **eight extra tools**. Casper's normal tools (read, edit, bash and
so on) stay as they are.

- **How direct tools are picked.** By matching words in the task, the same way
  every time, before each prompt. Router tools (`find_tool`, `invoke_read_tool`,
  `invoke_tool`) come first, then docs tools (see
  [Secrets and docs servers](#secrets-and-docs-servers)).
- **Size limits.** One tool's schema may be up to 12,000 bytes, and all direct
  schemas together 32,000 bytes (measured as an escaped JSON string). A tool with a
  bigger schema can't be called through `call_capability` either.

Example AI workflow:

```text
find_capability({ query: "*" })
find_capability({ query: "*", cursor: "<next_cursor from the last page>" })
find_capability({ query: "rare site counter" })
find_capability({ id: "mcp:docs:read_site_counter" })
call_capability({ id: "mcp:docs:read_site_counter", arguments: { site: "lab" } })
```

The unused `query`/`id` field can be left out or be an empty string. Search returns
up to five short summaries, not schemas. When nothing matches it returns
`{ "matches": [], "hint": "Nothing matched. Try one plain word (like site or vlan), or query \"*\" to list every tool." }`.
Search never calls a server.

**How search matches words.** A word matches its plural and singular forms, so
`site` finds `mist_list_sites`, `policy` finds `clearpass_list_enforcement_policies`,
and `routers` finds `get_router_list`. In `find_capability` only, a word of 5 or more
letters also matches the start of a longer name word (`config` finds
`compare_configuration_versions`). The choice of direct tools does not use that
rule, so it stays stable.

**Listing every tool.** `find_capability({ query: "*" })` lists every connected
tool, sorted by server then tool name, 50 at a time:
`{ "total": 340, "shown": "1-50", "items": [{ "id", "safety", "about" }], "next_cursor": "7.50" }`.

- `about` is the first line of the description, cut to 80 characters. Each page
  stays under 12 KB.
- Pass `next_cursor` back as `cursor` for the next page; the last page has none. A
  cursor only works with `query: "*"`.
- When the tool list changes (a server reconnects or sends a list change), old
  cursors are refused with
  `The tool list changed since that page. Start again with query "*".`
- A server with its own router (`find_tool` + `invoke_read_tool`, for example
  hpe-networking-mcp in router mode) can't be listed in full. Casper only knows its
  router tools, so the page adds `routers: [{ server, hint }]` telling the AI to
  use that server's `find_tool`.

**Bad arguments name the field.** A call whose arguments don't fit the tool's
schema is refused before any approval question, for example:
`Not executed (bad arguments: missing field "router_name"; unknown field "router" (did you mean "router_name"?)). Check the schema: find_capability({ id: "mcp:junos:execute_junos_command" }).`

- Other forms: `field "site" must be a string`, `field "filter.vlan" must be an integer`,
  `field "hosts[1]" must be a string`, `field "site" must be one of: "site-0", ... (+75 more)`,
  `field "mode" does not match any allowed form`.
- At most five problems are shown, then `(and N more)`.
- These messages never repeat the values the AI sent. Allowed values and rules
  quoted from the server's schema are shortened and have secrets hidden.
- `call_capability` shape errors say `field "id" is missing` or
  `field "arguments" must be an object`.

**Direct tools are checked by Pi first.** Pi is the agent engine Casper runs on. It
checks a direct MCP tool's arguments against the same schema before Casper sees the
call. When they don't fit, the AI gets Pi's own error, which can repeat the
arguments it sent. Casper keeps the real schema on direct tools on purpose: a loose
schema would hide the fields from the AI. Casper still checks the final arguments
again, so nothing that fails the schema is sent. Calls through `call_capability`
get only Casper's field-named errors.

**Schema lookup.** Asking for one ID returns `{ id, inputSchemaJson }`. The AI
parses `inputSchemaJson` to get the full schema. Sending it as a string keeps
lists such as `enum` and `required` whole. Direct and `call_capability` calls check
against the same schema and go through the same safety checks.

**Names.** Tool names sent to the AI provider are cleaned and get a short hash
(8 hex characters, 24 if two tools would share one), and Casper keeps the exact
server/tool mapping. Two servers that both have a `status` tool don't clash.
A direct tool's description loses the shared indent of a Python docstring, and its
schema loses the `title` notes pydantic adds to each field (a field named `title`
stays). Neither changes what is checked; both are sent with every request. When a server has its own router (`find_tool` +
`invoke_read_tool`), Casper uses it rather than flattening the router's whole
catalog. `invoke_tool` can also be picked but still counts as `destructive`.

## Safety

Every tool gets a label. From least to most strict: `read`, `diagnostic`,
`external-action` (no label from the server), `write`, `exec` (runs commands),
`destructive`. Anything above `read` asks you before it runs.

- **Only the server's own label lets a tool run without asking, and names only make
  it stricter.** A tool runs without asking only when the server marks it
  `readOnlyHint: true` and nothing else tightens it. Tools with no label are
  `external-action`. A description that claims to be safe changes nothing.
- **Network action words always ask.** A tool whose name contains a destructive or
  run word anywhere (bounce, reload, restart, reboot, halt, shutdown, disconnect,
  deauth, rollback, erase, wipe, delete, reset, upgrade, exec, shell, command, and
  similar) is `destructive` or `exec`, even when the server says it is read-only:
  `bounce_interface`, `rebootDevice` and `clearpass-disconnect-session` all ask.
  - A change word (commit, apply, push, enable, configure, and similar) tightens to
    `write` unless the name starts with a read word (`show_commit_history` stays a
    read) or the change word only describes what is read (`glp_write_status`).
  - A few exact names of known read tools, such as `get_config_rollback_status`,
    keep words like rollback as nouns.
  - No label is ever looser than Casper 0.2.14's, so the words it used (create,
    update, set, write, deploy, delete, run, and similar) still tighten anywhere in
    a name.
  - `destructiveHint` and the generic `invoke_tool`/`invoke_tools_batch`
    dispatchers are `destructive`.
  - `_meta["casper/safety"]` can only tighten, except that it may mark a tool with
    no label `diagnostic`.
  - The word list builds on actlint (Apache-2.0; see THIRD_PARTY_NOTICES.txt).
- **Routers are judged by the real tool.** `invoke_read_tool({ name: "port_bounce" })`
  asks, because `port_bounce` is not a read. A router call whose real tool Casper
  can't read also asks.
- **The AI can't approve for you.** Casper asks, even for a read tool and even
  inside a router's arguments, when the arguments:
  - set `confirm`, `confirmed`, `confirmation` or `force` (in any spelling:
    `Confirm`, `CONFIRMED`) to `true`, or to text a server may read as true, such as
    `"true"`, `"yes"` or `1`; or
  - set a preview switch (`dry_run`, `dryRun`, `preview`, `check_only`,
    `validate_only`, in any spelling such as `dry-run` or `DryRun`) to `false`, or to
    anything other than plain true or false. Such a switch shows as
    `May make the change`.
- **The change box.** It says what changes in plain words, then asks:

  ```text
  Change in Mist: set ssid
    ssid             Guest-Test
    vlan             30
    wpa_passphrase   ••• 13 chars
  Hidden: wpa_passphrase. The server still gets the real value.
  This makes the change.
  MCP · mist · set_ssid  [write]
  Make this change?
  → 1 No
    2 Yes, this once
    3 Yes, for this session
    4 Yes to everything on Mist this session (no more asking, even reboots, deletes or an AI-set confirm)
  Press 1-4 or Up/Down + Enter · Esc is No
  ```

  - The first line names the product (from the preset, else the server) and the real
    tool in words; behind a router it adds `Runs: port_bounce (through invoke_tool)`
    and shows that tool's own values.
  - One value per line. Passwords, PSKs, tokens and similar values show as
    `••• 13 chars` with a `Hidden:` line, and secrets inside config text as
    `<secret hidden>`. This hides them on screen and in the transcript only: the server
    still gets the real value, and the AI already had it.
  - Whether it changes anything: `This makes the change.`,
    `Preview only: nothing changes (dry_run=true).`, or
    `May make the change (dry_run is not set).` for a router. When the switch is left
    out, the tool's schema default decides.
  - For an AI-set confirm:
    `⚠ The AI set confirm=true. That skips the server's own check. Only your answer here lets it run.`
  - The last preview of the same call on the same connection, masked and cut to about
    1.5 KB. The technical line (`MCP · <server> · <tool>  [label]`) closes the box.
- **The answers.** `1` (or Enter, Esc, Ctrl+C, or anything else) is **No**.
  - `Yes, this once` runs this change.
  - `Yes, for this session` runs it and lets later changes on the same server run without
    a box until the session ends or writes go off (Ctrl+O, `/mcp writes off`, a
    disconnect). A **destructive** change (reboot, delete, bounce, upgrade…) never gets
    this answer and always asks, and so does any change where the AI set `confirm` or
    turned a preview off.
  - `Yes to everything on <product> this session` (always last) runs it, and no later
    call on that server asks at all: not reboots, not deletes or other risky kinds, not
    a call where the AI set `confirm`. It asks once more (`1 No · 2 Yes to everything`),
    so a key pressed from habit never grants it. Only you can pick it; the AI can't. It is never
    remembered, the footer shows `ALLOW ALL: <servers> · Ctrl+O`, and Ctrl+O,
    `/mcp writes off`, a disconnect or the end of the session ends it. Each call it
    covers is logged as `[approval] allowed (allow all): <server> · <tool>`. A read-only
    login, a hidden tool or a preset's rule still refuses.
  - `Preview first` (listed after the yes answers when the tool's own schema has a preview switch, so 2 and 3 mean
    the same in every change box) runs
    the same call with the switch on (and confirm off), then shows the box again with
    `Last preview (just now)`. It is never offered through a router: Casper can't see
    the real tool's schema, and a server that ignores an unknown `dry_run` would make
    the change. After three previews the box comes once more without it.
  - One key answers it, like every Casper box. Only a key pressed after the box appeared
    counts: a draft is set aside, keys in the first moment after it opens are ignored,
    lines typed ahead on the plain terminal are discarded (`[input] Discarded 1 line(s)
    entered before this question appeared.`), and a terminal that can't show the box
    (TERM=dumb, or output redirected while input is a terminal) is refused.
  - A closed box leaves one line on both terminals: `Make this change? → Yes, this once`, or
    `Make this change? — skipped (No)` after Esc. Only where no box could be shown does Casper print
    `[approval] denied` instead. A later change a session answer covers prints
    `[approval] allowed (this session)`.
- **Server questions reach only you.** Some servers ask before a risky action (MCP
  "elicitation"), for example `Confirm PORT BOUNCE on SG1 ports [1/1/1]?`.
  - It is shown as `<server> asks about the <tool> call you approved:`, numbered like
    the change box: `1 No · 2 Yes`, or `1 No` then the server's own options.
  - The AI never sees the question and has no tool to answer it; its ask tool can't
    answer an approval either.
  - MCP does not say which call a question belongs to, so Casper answers only while
    exactly one call you approved is running on that server. It pauses that call's
    clock while you read.
  - Everything else is declined without asking: questions outside an approved call
    (`[mcp] <server> asked a question outside a call you approved; declined.`),
    forms that are not one yes/no or pick-one field
    (`[mcp] <server> asked a question Casper can only answer yes/no; declined.`),
    links (URL mode), and more than three questions in one call. One-shot runs
    decline every question.
- **When Casper can't ask you.**
  - Without an interactive terminal (including one-shot runs), calls that need
    approval fail with `Not executed (needs your approval, and this run cannot ask)`.
  - Arguments over 4 KiB are not run: you see
    `Too long to show in full (over 4 KB); not run.` and the AI reads
    `Not executed (arguments too long to show you for approval)`.
  - When Casper is closing or the task was stopped, a pending approval gives
    `Not executed (cancelled)`, never `you said no`.
- **No shortcuts for the AI.** There is no write flag and no approval token the AI can
  set. "Yes, for this session" and "Yes to everything" are yours to give, per server,
  and end with the session or Ctrl+O; under "Yes, for this session" destructive changes
  still ask. A remembered server only connects on its
  own, with writes off. Calls that may ask run one at a time, and approvals and server
  questions are shown one at a time. The approval can't change the arguments, and a
  changed tool or a reconnect cancels a pending approval.

**Limits.** These are practical checks, **not a sandbox and not proof of what a
server does**.

- A server can lie in its labels, or change something from a tool that looks like a
  read.
- The name checks are word lists. They read tool names, not what a tool does. A tool
  that changes things under a read name, marked `readOnlyHint: true`, runs without
  asking. The Junos show check reads the command text the same way.
- Stdio servers run with your user's permissions, except Casper's own network server,
  which runs in the sandbox on macOS and Linux
  ([It runs in the sandbox](#it-runs-in-the-sandbox)). Every other server is outside the
  sandbox: Casper doesn't know what it needs.
- The AI's shell is in the sandbox, where the sandbox can run, and it can't read
  `~/.claude.json`, `~/.mcp.json`, `~/.casper/mcp.json` or a profile's `mcp.json` there
  (the AI's file tools can't open them either). Without the sandbox (Windows, Linux
  without bubblewrap, `--no-sandbox`), the AI's shell could read MCP configuration or go
  around this interface. See [SECURITY.md](SECURITY.md).
- Only connect servers you trust, and give them logins with only the rights they
  need. Tool descriptions and results are outside content, not instructions.

## Secrets and docs servers

- **Network logins.** Logins for Casper's network server live only in
  `~/.casper/network-logins.json`: written by Casper alone (mode 0600, never through a
  link), added to that server's environment when it starts, never put in `mcp.json` or the
  server's definition. The AI can't read the file, and the tokens and Central secret are
  hidden in tool output and in the server's error output. Only you type them, in the
  hidden prompt.
- **Device secrets are hidden from the AI.** Every MCP result is scrubbed before it
  is cut to size. Passwords, RADIUS/TACACS keys, Wi-Fi PSKs, SNMP communities and
  similar values in config text or under secret-looking JSON keys become
  `<secret hidden>`. The result gets `secretsHidden: N` and the summary adds
  `N secrets hidden before the AI saw this (...)`. This hides known formats only;
  see [SECRETS.md](SECRETS.md) for the list and for netconan.
- **A hidden secret can't be sent back.** A call whose arguments contain
  `<secret hidden>` is refused before any approval question:
  `Not executed (this change still has <secret hidden> in it). Casper hid that secret from the AI, so the AI can't send it back. Type the real value yourself or leave that line out.`
  hpe-networking-mcp's own `hpe_mcp_secret_<32 hex>` tokens are not hidden and not
  refused: that server swaps them back itself.
- **Docs servers.** hpe-networking-mcp's docs tools (`lookup_api`, `search_docs`,
  `ask_docs`; "aruba-rag" is the old name of the same rag-core) are always offered
  to the AI, right after the routers, whatever the task words, within the same tool
  and schema budget.
  - Their descriptions start with
    `[docs; read; <id>] Check docs here before guessing Aruba, HPE, Mist or Junos API and config details. Say when the docs had no answer.`
  - This only happens for a stdio server Casper recognised as hpe-networking-mcp by
    what it runs (its preset). Another server with the same tool names gets no
    special place.
  - An unbuilt `lookup_api` index answers `{degraded: true, hint}`. Casper passes
    that on and does not build indexes.
- **`/mcp docs`** lists the docs servers:
  `Docs servers: hpe-networking-mcp (lookup_api, search_docs, ask_docs). No docs-only server yet.`
  - When one of your servers runs hpe-networking-mcp's `mcp_servers/tool_router.py`,
    it offers a docs-only copy: the same command and folder running
    `mcp_servers/rag.py`, with only `PYTHONPATH` (and `HPE_MCP_RAG_BACKEND` if set)
    in its environment.
  - `CREDS_PATH`, vendor tokens and every other `HPE_MCP_*` setting are left out. A
    router started with extra settings on its command line (for example
    `--env-file`) is not copied. rag.py may still read the repo's own `.env` file;
    it has no device tools either way.
  - It shows what it will add and asks
    `Add a docs-only copy (no passwords, no device access)?` with `1 No · 2 Add it`.
  - On 2 it adds `<name>-docs` to `~/.casper/mcp.json`. It only adds: other
    entries are kept, and an existing name is refused with
    `<name>-docs is already in ~/.casper/mcp.json. Nothing changed.`
  - Then run `/mcp reload` and `/mcp connect <name>-docs`. It needs your approval
    like any server.

## Lifecycle and results

**Start-up cost.** `/mcp`, `/status`, help and other local commands connect
nothing and load neither the MCP library nor the schema checker (Ajv). The MCP
client and transport load only when you approve a connection; Ajv loads on the
first tool call.

**Reconnects.** An approved server that failed can reconnect on the next task: at
most two failed tries per server in any 30 seconds. Successful reconnects don't
count, and `/mcp connect` resets the count. There is no endless restart loop in
the background.

- **Time limits.** A server gets 20 s to start (handshake and tool list) and 90 s
  per call. Change them per server in whole seconds: `"connectTimeout": 60` (1-120)
  and `"callTimeout": 400` (1-1800). Any other value makes the entry invalid.
  `/mcp detail` shows them as `limits: start 20s · call 90s`. Changing only a limit and
  running `/mcp reload` keeps the connection and your approval.
- **Progress restarts the call clock.** Each progress message from the server
  starts the 90 s again, so a long job that reports progress keeps going. No call
  runs longer than 10 minutes (or its `callTimeout`, if that is longer), progress or
  not. The clock pauses while you answer a question about the call.
- **When a call fails**, the AI reads plain text and is told not to retry on its
  own: `No answer from <server> in 90s. It may have run. …` (plus the last
  progress message, if any), `<server> was still working after 10m and was
  stopped. …`, or `<server> returned an error: <message>. It may or may not have
  run.` Server text in these lines is shortened and has secrets hidden.
  - A timeout, a cancel or a lost connection closes that server's connection. This
    can stop other calls to the same server, not to other servers. The next task
    reconnects, under the same retry limit.
  - **An ordinary error answer from the server keeps the connection.**
  - A failed call is **never repeated automatically**: a lost answer does not prove
    the action did not happen.
- **What the server said.** Casper keeps the last 40 lines (8 KiB) a stdio server
  wrote to stderr. When a server fails, `/mcp` lists it as `failed` with a plain reason cut
  to 60 characters, and `/mcp detail` shows the whole reason, such as
  `No answer in 20s while starting.`, `The server stopped while starting (exit code 1).`,
  `Missing environment variable NAME`, `Command not found: uvx. It comes with uv: <install page>`
  (uv, Node.js, Bun, Docker and Python launchers name their install page) or
  `The server said HTTP 401: <body>`, then `Last lines from the server:` with up to
  8 lines. `/mcp connect` gives that reason once, as its last line:
  `[error] <server> did not start: Command not found: uvx. …`.
  - Every env and header value of that server (4 or more characters) becomes `•••`,
    and common token shapes are hidden too. This is best effort: Casper doesn't
    know a secret the server reads on its own (for example from its `.env`).
  - Server output is shown only to you, never to the AI, and is not saved.
- **Imported servers** always start in your home folder, never in the opened
  project. A `cwd` inside the project (also through a link) is replaced and reported
  as `<name>: starts in your home folder, not in this project.` When the opened
  project is your home folder, they start in `~/.casper`.
- **Tool lists.** At most 5,000 tools, 100 pages and 8 MiB of tool definitions per
  server. A repeated page cursor or duplicate tool name fails with a message.
  When a server says its tool list changed, Casper reloads it in one step. If that
  fails, the old tools are removed and the connection closes. Every call is checked
  against the current list, so a removed tool can't be called.
- **Failures stay local.** One server's failure doesn't remove another server's
  tools. A stdio server that exits is noticed at once. There is no background health
  check. A failed interactive command prints an error and the session goes on; a
  failed one-shot command exits non-zero.
- **Closing.** Casper cancels running work and stops stdio servers (a short wait,
  then TERM, then KILL on Linux and macOS). On Windows it waits for child processes
  it can verify. The CLI's one-second exit deadline can cut cleanup short, and a
  server's processes that detach themselves may keep running. For HTTP servers
  Casper only closes the connection; it can't stop the remote process. Windows host
  testing is still pending.
- **Size caps.** Each message or HTTP response from a server is capped at 8 MiB.

**What the AI reads back.**

- Every result the AI gets fits **16 KiB** of JSON, and **each list is cut to 50
  items on its own** (`lists: [{ path, shown, total }]` says which). When that is
  still too big, the per-list limit halves (25, 12, 6, 3, 1) before Casper falls
  back to a preview. A result that is one long text block previews its own text
  with real line breaks. Text blocks that hold JSON are decoded first; binary
  content (such as images) is left out.
- **Duplicate copies are dropped.** Many servers send the same data twice, as
  `structuredContent` and as text. Text blocks that only repeat `structuredContent`
  (or its `result`, or a list split into one block per item) are left out and
  `duplicateTextDropped: true` is set. Different text is kept.
- **The next-page cursor is always kept.** Casper looks for `next_cursor`,
  `nextCursor`, `next_page_token`, `nextPageToken`, `next` or `cursor`, at the top or
  under `_pagination`/`pagination`/`meta`/`links`, before cutting anything. It
  returns it as `nextCursor: { path, value }`, even in a preview. Casper does not
  fetch more pages itself or keep the raw result.
- **Summaries say what happened.** `Complete result.`;
  `Partial result: <path> shows 50 of 2000. More: call again with next_cursor.` (or
  `The server gave no next page; narrow the request.`);
  `Partial result: too big to show, first part only.`;
  `The server said the call failed.` when the server marked the result as an error.
- **Refused or stopped calls** read `Not executed (<reason>).`, for example
  `you said no`, `needs your approval, and this run cannot ask` (a one-shot run),
  `cancelled`, `arguments too long to show you for approval`,
  `<server> writes are off. Only the user can turn them on with /mcp writes <server>.`,
  `<server> login is read-only.`, `Junos writes are off; only show commands run.`,
  `this change still has <secret hidden> in it`, `bad arguments`,
  `tool changed; search again`, `server not connected`, `arguments over 16 KB`,
  `schema not supported`, or `unknown capability; use find_capability`.
- `executed` is `true` when the server answered, `false` when nothing was sent, and
  `"unknown"` when the call may have run. Never repeat a change just to get more
  output.

Configured credentials never appear in status or errors. But **server results and
arguments may themselves contain secrets**, and they can stay in the saved
conversation. Known device secret formats in results are hidden (see
[Secrets and docs servers](#secrets-and-docs-servers)); there is no general secret
detector.

## Check a server you built

`casper mcp check [repo]` checks an MCP server repo before you connect it. It is a
command-line command, not a slash command, and the AI has no tool for it (it can
still run it through its shell tool, like any other command). It runs code from the
repo (its doctor and its tests), so **only run it on repos you trust**.

```
casper mcp check [repo] [--server <name>] [--live] [--quick] [--strict] [--json] [--env NAME=VALUE]... [-- <start command>...]
```

For example, from inside your server's repo:

```bash
casper mcp check .
casper mcp check . --quick --json > report.json
casper mcp check . -- uv run python jmcp.py -f devices-template.json -t stdio
```

What it does, in order (one failing step never stops the others):

1. **Repo checks.**
   - The repo's own doctor: a `[project.scripts]` entry named doctor or selfcheck,
     `scripts/doctor.py`, `make doctor`, or a `doctor` script in package.json.
   - Its safety tests: pytest `-m safety` when that marker exists, else test files
     named for write gates, read-only, guards, redaction, confirm or dry_run.
   - The full tests: pytest (for example `uv run pytest`), `make test`, or the
     package.json `test` script. `--quick` skips them.
   - Missing packages show `Not set up: … Run \`uv sync\` in the repo, then check again.`
     This also shows when the server itself can't start for that reason.
2. **Server.** It starts the server once and lists its tools. It never calls a tool
   here. It checks:
   - that it starts in time (20 s, or the preset's limit), and shows the last lines
     it printed, secrets hidden, when it does not;
   - that stdout carries only MCP messages
     (`Server wrote plain text to stdout: "…" In stdio mode stdout is only for MCP messages. Print to stderr.`);
   - that every tool has `readOnlyHint` or `destructiveHint`, and that the label
     fits the name. A problem is: a tool labelled read-only whose name changes
     things; a write tool whose name can cut service (bounce, reboot, delete …) or
     runs any command (execute, cli …); or read-only plus destructive. The name check
     uses Casper's own word rules, so status readers pass: `glp_write_status`,
     `get_config_rollback_status` and `junos_config_diff` read something. Tools with
     no label get a hint (`get_router_list looks read-only: add readOnlyHint: true.`);
   - confirm, dry_run and commit fields: a read-only tool with one warns; a preview
     or apply switch without a default gets a note; a description that tells the AI
     to "retry with confirm=true" is a problem (only the user may confirm); and a
     change tool with a confirm field warns when the repo never asks the user
     through MCP elicitation;
   - that each schema is valid JSON Schema (checked with the same checker Casper
     uses for calls), has `"type": "object"`, declares every required field, and
     stays under Casper's 12 KB schema limit;
   - for routers (`find_tool` + `invoke_read_tool`): the finder and read dispatcher
     are read-only, `invoke_tool` and non-read `*_batch` dispatchers are
     destructive, and a repo test shows `invoke_read_tool` refuses write tools. The
     refusal is found by searching the test files, never by calling the router;
   - more than 5,000 tools (Casper's own limit per server), and whether an
     `access_check` tool exists.
3. **Example configs.** `.mcp.json*`, `mcp.json*`, `.vscode/mcp.json*`,
   `.cursor/mcp*.json` and `examples/**` (files only).
   - A plain-text secret is a problem, shown by length only.
   - A setting that turns writes on is a problem in a default example, and a note in
     a file whose name says full, write, rw, admin or unsafe.
   - For a server Casper has a preset for, an example that does not set its
     read-only setting (for example `HPE_MCP_ACCESS_PROFILE=safe-read-only`) warns:
     Casper sets it itself, other clients don't.
4. **Live** (only with `--live`): see below.

**How it starts the server**, in this order: `--server <name>` (a server from your
MCP settings, including imported ones), the command after `--`, `start` in
`.casper/mcp-check.json`, then the first stdio entry of `.mcp.json.example`,
`.vscode/mcp.json.example`, `.mcp.json` or `examples/**` (minimal or read-only names
first). `${workspaceFolder}` and `/path/to/<repo folder or project name>` become the
repo path (the project name comes from pyproject.toml or package.json). Casper
never guesses from README text or package scripts. Without a source it says
`Can't tell how to start this server. Add .mcp.json.example, or pass the command: casper mcp check . -- <command>`.

**Offline is the default, and it is best effort.**

- Everything the check starts gets an environment without credential-looking names
  (TOKEN, SECRET, PASSWORD, API_KEY …, also from the example's own env).
- Web proxies point at a dead local port, and `UV_OFFLINE=1`, `PIP_NO_INDEX=1` and
  `npm_config_offline=true` are set.
- An HTTP server is contacted only on localhost; a remote one gives
  `Remote server: needs --live`.
- A program that reads its own `.env` file or opens SSH itself can still reach the
  network, and the report says so.
- An example config can't change the proxy or offline settings. Use
  `--env NAME=VALUE` to pass a setting on purpose; `--env` also wins over the
  example's own env.

**`--live`** keeps your real environment and makes a few read calls:

- `access_check`, only when Casper itself would call it (labelled read-only and
  needing no fields);
- then at most 3 tools that are labelled read-only, pass Casper's label and the name
  check, need no fields and have no confirm, dry_run or commit field.
- Write, destructive, run-command, unlabelled and router tools are never called.
- The header says
  `Live: up to 3 tools the server labels read-only are called on your real systems. Write tools are never called.`
  A label is the server's own word, not a check of the login.
- The report shows the time and an item count, never what came back. A failure
  shows the server's words with its credentials and device secrets hidden.

`.casper/mcp-check.json` (optional):

```json
{ "start": ["uv", "run", "python", "jmcp.py", "-f", "devices-template.json", "-t", "stdio"],
  "doctor": "uv run hpe-mcp-doctor", "safetyTests": "uv run pytest -m safety", "tests": "make test" }
```

`start` may also be a server entry like in `.mcp.json`.

**Exit codes:** 0 no problems; 1 problems (or warnings with `--strict`); 64 usage
mistake (for example a repo folder that does not exist). `--json` prints one
`{version: 1, …}` report on stdout and progress on stderr.

Not in this build: a cross-check with the MCP Inspector CLI as a second client. It
is a planned follow-up; Casper will never download it with npx.
