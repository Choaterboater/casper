# MCP capability broker

Casper owns connections, capability selection, consent and result bounds. The
pinned official MCP SDK handles the protocol. No personal server or credentials
are bundled.

## Configure and connect

Casper reads optional JSON files, in this precedence order (later definitions replace earlier names):

1. VS Code user settings: `mcp.json` (`"servers"`) and `settings.json` (`"mcp"."servers"`), stable and Insiders (`~/.config/Code/User` on Linux, `~/Library/Application Support/Code/User` on macOS)
2. `~/.mcp.json` (skipped when the opened project is your home folder, where it is item 8)
3. `~/.claude.json`: its top-level `mcpServers`, then the entry for this project (`projects["<project>"].mcpServers`)
4. `~/.casper/mcp.json`
5. `~/.casper/profiles/<selected-profile>/mcp.json`
6. `<project>/.vscode/mcp.json` (`"servers"`)
7. `<project>/mcp.json`
8. `<project>/.mcp.json`
9. `<project>/.casper/mcp.json`

**Servers you already set up elsewhere.** Items 1-3 are Claude Code's and VS Code's files, so you don't have to copy anything. Only the server entries are read: `~/.claude.json` also holds history and account data, which Casper never keeps or prints (it may be up to 32 MB). Imported servers start in your home folder, never in the opened project (in `~/.casper` when the project is your home folder), and `/mcp` shows where each came from: `junos [stdio; disconnected] 0 tools · from ~/.claude.json · writes off` and `Found in ~/.claude.json. Not approved yet · /mcp connect junos`. An interactive session says once per new set of imported names: `[mcp] Found 3 servers in ~/.claude.json and VS Code. Run /mcp to see them.` VS Code variables are translated: `${env:X}` becomes `${X}` and `${userHome}` your home folder. Entries Casper can't fill in are skipped by name, and the others still load: `Skipped "netbox" from VS Code: it asks VS Code for a value (${input:token}). Put it in ~/.casper/mcp.json instead.`, and the same for `${workspaceFolder}` in a user file, `envFile` and SSE. A half-written `~/.claude.json` gives `Cannot read ~/.claude.json (it may be in use). Try /mcp reload.` A name found in several of these files is reported, and your own files win: `"junos" is in VS Code and ~/.claude.json; using ~/.casper/mcp.json`. `<project>/.vscode/mcp.json` is project content (`${workspaceFolder}` is the project) and gets the same review as the other project files.

Common `mcpServers` maps are supported:

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

The example URL is a placeholder, not a server to connect to. `type: "stdio"` is optional for command entries; URL entries accept `http` or `streamable-http`. Only HTTPS or loopback HTTP is accepted. URL userinfo, fragments, legacy SSE transport, and ambiguous command-plus-URL definitions are rejected. Stdio commands run directly (no implicit shell), with the SDK's minimal inherited environment plus the explicit `env` map. Your own servers (`~/.casper/mcp.json` and profile files) start in your home folder, so an opened repository cannot change what they load; set `"cwd"` to an absolute folder, `~/...`, or `${PROJECT_ROOT}` to choose another. Project-file servers start at the project root, or at a relative `"cwd"` inside it. Shell interpreters supplied as commands can still execute shell code.

`${ENV_NAME}` (or Claude Code's `${ENV_NAME:-default}`, which uses the default when the variable is unset or empty) references in command, arguments, environment values, and HTTP header values resolve only on connection. A missing variable fails the connection, and `/mcp` names it (never a value). Casper does not run secret-fetching commands, provision OAuth, install servers, or write MCP configuration/credentials. Use environment references instead of committing secrets. Review the resolved configuration source before connecting, especially when project definitions override user definitions. The review of a project-file server names every `${NAME}` it would send and where, for example `sends $ANTHROPIC_API_KEY to https://collector.example (header X-Key)`; literal values stay hidden.

```text
/mcp                          # local status; no connection or model
/mcp connect local-docs        # authorize this loaded definition for this process
/mcp disconnect local-docs     # disconnect and revoke process-local consent
/mcp reload                    # re-read the layered files without restarting
```

For one-shot tasks or preconnected interactive sessions, use repeatable **leading** CLI options:

```bash
casper --mcp local-docs "Find the documentation for pagination"
casper --mcp local-docs --mcp another-server
```

**Discovery is not permission.** All servers, including user/profile servers, start disconnected. Neither a `trusted` flag in project JSON nor a skill can authorize connection. Only the user's local connect command/CLI option does so. `--mcp` and non-interactive runs connect only user/profile definitions; a project definition (including one that replaces a same-named user server) connects only through an interactive `/mcp connect <name>` that first shows its source file, the file it replaces, its command and arguments or URL origin, and environment/header names (never values). Consent lasts for this process unless you remember it (see "Remembered servers"); it is separate from skill trust. `/mcp` lists name, source file, transport, state, tool count, time limits, and plain error messages, never command arguments, URLs, header values, or environment values. When a server fails, `/mcp` shows what it said (see "Lifecycle and results").

Malformed entries produce diagnostics without taking down other entries. An invalid overriding entry removes that name rather than falling back to the lower-precedence executable. Files are limited to 1 MiB and the merged configuration to 64 servers. Structurally invalid entries are rejected; unknown per-server keys are ignored. `/mcp reload` re-reads the same layered files in place: new servers appear disconnected, removed servers disappear, and a server whose command, URL, arguments, or environment changed counts as a different program, so its connection closes, its writes go off and its consent (also a remembered one) is revoked until `/mcp connect <name>` again. Unchanged approved servers keep their connection. Malformed reloaded entries produce diagnostics and take nothing else down.

### Remembered servers

After an interactive `/mcp connect` of your own or an imported server, Casper asks:

```text
Remember this server? Next time it connects on its own, with writes off. Every change still asks you.
  1 Remember
  2 Just this time
Type 1 or 2:
```

`1` stores a keyed hash of the definition (name, start folder, command, arguments, env, URL, headers) in `~/.casper/mcp-consent.json`. The key is 32 random bytes in `~/.casper/mcp-consent.key`; both files are private (0600), and no definition value is stored. Next time the server connects on its own when a task needs it, always with writes off. Any change to the definition means Casper asks again: `/mcp` shows `Changed since you approved it. Run /mcp connect <name>.` Time limits and where the entry lives are not part of the hash. A literal token in the definition is part of it, so rotating it asks again; `${VAR}` references avoid that. Project servers are never remembered. Servers started through a package runner that can fetch new code later (`npx`, `bunx`, `pnpm dlx`, `uvx`, `uv tool run`, `pipx run`, `docker run` with `:latest` or no tag) are remembered only when pinned to a version: `Not remembered: central-mcp-server is not pinned to a version. An update could add write tools. Pin it (for example ==1.4.2 or a commit) and connect again.` `/mcp forget <name>` drops a remembered server. A damaged store counts as empty and says so.

### Presets

Casper recognises some network servers by what they run (never by their name) and adds restrictions. A preset can pin read-only settings, raise a tool's label, hide tools while writes are off, refuse arguments and add notes to the approval box. It never lowers a label, never skips an approval and never calls a server read-only.

| Server | Recognised by | Pinned while writes are off | Hidden while writes are off |
| --- | --- | --- | --- |
| hpe-networking-mcp | `tool_router.py`, `hpe-mcp-router`, `hpe_networking_mcp`, `HPE_MCP_*` env, or its router tools | `HPE_MCP_ACCESS_PROFILE=safe-read-only`, `HPE_MCP_READONLY=1`, `HPE_MCP_PRODUCT_ACCESS=read-only`, every `HPE_MCP_*_WRITES=0` | `invoke_tool`, `invoke_tools_batch` |
| centralmcp (`aruba-*`) | `centralmcp` in the command or `CENTRALMCP_*` env | `CENTRALMCP_READONLY=1` | write and delete tools |
| central-mcp-server | `central-mcp-server` in the command | nothing (no setting exists); must be pinned to a version to be remembered | tools not marked read-only |
| junos-mcp-server | `jmcp.py`, `junos-mcp-server`, or its tool names | nothing (no setting exists) | `load_and_commit_config`, `render_and_apply_j2_template` |
| Mist hosted | a `mist.com` URL | nothing: `Access not checked. Use a read-only (Observer) org token for this server.` | write and delete tools |
| NetBox | `netbox` in the command, `NETBOX_*` env or URL | nothing; use a read-only token | write and delete tools |
| netmiko_mcp | `netmiko` in the command | nothing; never remembered | tools not marked read-only |
| Oxidized / LibreNMS | the name in the command, env or URL | nothing | tools not marked read-only |
| Grafana | `mcp-grafana` | `--disable-write` (added once) | write and delete tools |
| ClearPass MCP | `clearpass` in the command or `CLEARPASS_*` env | `CLEARPASS_READ_ONLY=true` | write and delete tools |

Pins are env values that beat your own (for docker and podman they go in as `-e NAME=VALUE` before the image) or arguments added once. `/mcp` shows `preset: hpe-networking-mcp (read-only pins sent, not confirmed: ...)` until the server itself reports its write gates off through `access_check`; then it reads `read-only pinned`. When Casper can't place a pin (an HTTP server, a shell wrapper, arguments after `--`), it says `Can't pin read-only for this server (it runs elsewhere). Write tools are hidden in Casper only.` A server recognised only by its tool list is started once more with the pins. A definition that matches but whose tools don't: `Looks different from the hpe-networking-mcp preset. Pins kept, and its extra checks still apply.`

**Junos.** `execute_*` tools are `exec` and the two commit tools `destructive`. With writes off only plain show commands run; anything else gives `Not executed (Junos writes are off; only show commands run.)`. A plain show command starts with the literal word `show`, has no `;`, line break or redirection, and uses only the pipes `match`, `except`, `count`, `display`, `no-more`, `last`, `find` and `trim` (`| save` is refused). Show commands still ask, unless you type `/mcp junos-show <name> on` for that server in this session (`[mcp] Plain show commands on <name> run without asking.`); PFE commands always ask. The approval box for `load_and_commit_config` says `Note: load_and_commit_config commits right away. No preview and no auto-rollback.` and never offers `p`. A Junos call may go 400 s without an answer (the server allows 360 s for a commit) unless you set `callTimeout`.

### Access check

A server may offer a read-only tool named `access_check` (contract `casper/access-check v1`, see `docs/patches/hpe-networking-mcp-access-check.patch` for a proposal for hpe-networking-mcp). Casper calls it once per connection, only when the server marks it read-only, Casper labels it `read` and it needs no arguments, under the call limit (never longer than the start limit). Only the product's own answer can make a login read-only, and only when every product says so. Then `/mcp` shows `login: read-only (checked)`, every tool that is not a read is hidden and refused with `Not executed (<server> login is read-only.)`, writes can't be turned on (`This login is read-only (access_check). Writes can't be turned on here.`), and the model's `find_capability` description says `<server>: login is read-only. Write tools are hidden. Don't plan changes on it.` Any other answer, an error, a slow answer or no `access_check` at all is `access not checked`. A server that says its login can make changes (`login: can make changes (checked)`) unlocks nothing. Only the parsed state is used; the server's text never reaches the model.

### Turning writes on

Every server starts with writes off, including remembered ones. Writes off means write and delete tools are hidden from search, the `"*"` list and the task tools, and are refused with `Not executed (<server> writes are off. Only the user can turn them on with /mcp writes <server>.)`; the preset's pins are sent; and every other change (unannotated or `exec` tools) is still shown and still asks you each time. The model's `find_capability` description says `<server>: writes are off. Only the user can turn them on.`

Turning writes on takes two steps that only you can do. Type `/mcp writes <server>`, then pick `1` in the box:

```text
Central writes are off.
  1 Enable for this server
  2 Keep writes off
Type 1 or 2:
```

The box title uses the product name from the preset, else the server name. `1` waits for running calls, restarts the server without the pins and prints `[mcp] Writes on for <server>. Each change still asks you. ctrl+o turns writes off.` When your own settings still keep writes off, Casper says so: `Casper removed its read-only pins, but your own settings still keep writes off (HPE_MCP_ACCESS_PROFILE=safe-read-only in ~/.claude.json).` While any server has writes on, the footer starts with `WRITES: <servers> · ctrl+o`, which is never cut off. ctrl+o (or `/mcp writes off`) turns writes off for every server at once, even while Casper is working, and denies an open approval box: `[mcp] Writes off for <server>. Write tools are hidden again.` A server that was running without pins is restarted with them once its calls finish. The model's ask tool can't answer this box, and `/mcp writes` in a one-shot run gives `Writes can only be turned on in an interactive session.`

## Small model-facing surface

For a connected generic catalog, Casper exposes:

- at most **six** task-selected direct MCP tools;
- `find_capability` for word search, a full list (`query: "*"`), or one schema inspection;
- `call_capability` for fallback invocation by exact ID and arguments.

This is at most **eight additional tools**, not hundreds of schemas. Pi's existing seven coding tools remain available. Selection is lexical, deterministic, and renewed before each ordinary/repair prompt. The schema budget is 12,000 bytes per tool and 32,000 bytes for selected direct schemas, measured using the escaped JSON-string representation (a conservative bound for direct schemas too). Oversized schemas cannot be called through the fallback either.

Example model workflow:

```text
find_capability({ query: "*" })
find_capability({ query: "*", cursor: "<next_cursor from the last page>" })
find_capability({ query: "rare site counter" })
find_capability({ id: "mcp:docs:read_site_counter" })
call_capability({ id: "mcp:docs:read_site_counter", arguments: { site: "lab" } })
```

The unused `query`/`id` field can be omitted or an empty string, accommodating providers that materialize optional string fields. Search returns up to five metadata summaries, not schemas. When nothing matches, it returns `{ "matches": [], "hint": "Nothing matched. Try one plain word (like site or vlan), or query \"*\" to list every tool." }`.

**How search matches words.** A word matches its plural and singular forms, so `site` finds `mist_list_sites`, `policy` finds `clearpass_list_enforcement_policies`, and `routers` finds `get_router_list`. In `find_capability` only, a word of 5 or more letters also matches the start of a longer name word (`config` finds `compare_configuration_versions`). The choice of direct tools does not use that rule, so it stays stable.

**Listing every tool.** `find_capability({ query: "*" })` lists every connected tool, sorted by server then tool name, 50 at a time: `{ "total": 340, "shown": "1-50", "items": [{ "id", "safety", "about" }], "next_cursor": "7.50" }`. `about` is the first line of the description, cut to 80 characters. Each page stays under 12 KB. Pass `next_cursor` back as `cursor` for the next page; the last page has none. A cursor only works with `query: "*"`. When the tool list changes (a server reconnects or sends a list change), old cursors are refused with `The tool list changed since that page. Start again with query "*".` A server with its own router (`find_tool` + `invoke_read_tool`, for example hpe-networking-mcp in router mode) cannot be listed in full: Casper only knows its router tools, so the page adds `routers: [{ server, hint }]` telling the model to use that server's `find_tool`.

**Bad arguments name the field.** A call whose arguments do not fit the tool's schema is refused before any approval question with, for example, `Not executed (bad arguments: missing field "router_name"; unknown field "router" (did you mean "router_name"?)). Check the schema: find_capability({ id: "mcp:junos:execute_junos_command" }).` Other forms: `field "site" must be a string`, `field "filter.vlan" must be an integer`, `field "hosts[1]" must be a string`, `field "site" must be one of: "site-0", ... (+75 more)`, `field "mode" does not match any allowed form`. At most five problems are shown, then `(and N more)`. These messages never repeat the values the model sent. Allowed values and quoted rules (such as a pattern) come from the server, so they are shortened and have secrets hidden. `call_capability` shape errors say `field "id" is missing` or `field "arguments" must be an object`.

**Direct tools are checked by Pi first.** Pi checks a direct MCP tool's arguments against the same schema before Casper sees the call. When they do not fit, the model gets Pi's own error, which can repeat the arguments it sent. Casper keeps the real schema on direct tools on purpose: a loose schema would hide the fields from the model. Casper still checks the final arguments again, so nothing that fails the schema is ever sent. Calls through `call_capability` get only Casper's field-named errors.

Exact-ID inspection returns `{ id, inputSchemaJson }`; parse `inputSchemaJson` to obtain the complete schema. Encoding it as a string preserves `enum`, `required`, and other schema arrays rather than truncating their semantics under the result-item budget. Descriptors carry stable server-qualified IDs, source, name, bounded description/tags, safety classification, and a schema reference. Both direct and fallback calls validate against the target input schema and share the same safety checks.

Provider-facing names are sanitized and hash-qualified; the broker retains exact server/tool mappings. Two servers exposing `status` do not overwrite each other. A native `find_tool` + `invoke_read_tool` surface is preferred when present; `invoke_tool` is also eligible but remains consequential. Casper does not recursively flatten a native router's backend catalog. With many connected routers, the same global direct-tool cap applies; the fallback can reach the rest.

## Safety

- **Read-only comes from the server, and names only make it stricter.** A tool runs without asking only when the server marks it `readOnlyHint: true` and nothing else tightens it. Unannotated tools are `external-action`; a description that claims to be safe changes nothing.
- **Network action words always ask.** A tool whose name contains a destructive or run word anywhere (bounce, reload, restart, reboot, halt, shutdown, disconnect, deauth, rollback, erase, wipe, delete, reset, upgrade, exec, shell, command, and similar) is `destructive` or `exec`, even when the server says it is read-only: `bounce_interface`, `rebootDevice` and `clearpass-disconnect-session` all ask. A change word (commit, apply, push, enable, configure, and similar) tightens to `write` unless the name starts with a read word (`show_commit_history` stays a read). A few exact names of known read tools, such as `get_config_rollback_status`, keep words like rollback as nouns. No label is ever looser than Casper 0.2.14's, so the words it used (create, update, set, write, deploy, delete, run, and similar) still tighten anywhere in a name. `destructiveHint` and the generic `invoke_tool`/`invoke_tools_batch` dispatchers are `destructive`. `_meta["casper/safety"]` can only tighten, except that it may mark an unannotated tool `diagnostic`. The word list builds on actlint (Apache-2.0; see THIRD_PARTY_NOTICES.txt).
- **Routers are judged by the real tool.** `invoke_read_tool({ name: "port_bounce" })` asks, because `port_bounce` is not a read. A router call whose real tool Casper can't read also asks.
- **The AI can't approve for you.** When the arguments set `confirm`, `confirmed` or `force` to `true` (or to text a server may read as true, such as `"true"`, `"yes"` or `1`), or set a preview switch (`dry_run`, `dryRun`, `preview`, `check_only`, `validate_only`) to `false` or to anything other than plain true or false, Casper asks even for a read tool, including inside a router's arguments. A switch that is not plain true or false shows as `Mode: may EXECUTE`.
- **The approval box.** It shows `MCP · <server> · <tool>  [label]`, the real tool behind a router (`Runs: port_bounce (through invoke_tool)`), and the mode: `Mode: EXECUTE (this makes the change)`, `Mode: preview (dry_run=true, nothing changes)`, or `Mode: may EXECUTE (dry_run is not set)` for a router. The mode uses the tool's schema default when the switch is left out. Passwords, PSKs, tokens and similar values show as `"wpa_passphrase":"••• 13 chars"` with a `Hidden:` line, and secrets inside config text show as `<secret hidden>`. This hides them on screen and in the transcript only: the server still gets the real value, and the model already had it. An AI-set confirm shows `⚠ The AI set confirm=true. That skips the server's own check. Only your yes here lets it run.` The last preview of the same call on the same connection is shown, masked and cut to about 1.5 KB.
- **Only a freshly typed `yes` runs it.** The question is `Run it? Type yes: `, or `Run it? Type yes, or p to preview first: ` when the tool's own schema declares a preview switch. `p` runs the same call with the switch on (and confirm off), then shows the box again with `Last preview (just now)`. `p` is never offered through a router, because Casper can't see the real tool's schema and a server that ignores an unknown `dry_run` would make the change. After three previews the box is shown once more with the last one, and only `yes` runs it; `p` is no longer offered. Any other answer, Esc or Ctrl+C is no. The transcript records `[approval] allowed`, `denied` or `preview first`.
- **Server questions reach only you.** Some servers ask before a risky action (MCP elicitation), for example `Confirm PORT BOUNCE on SG1 ports [1/1/1]?`. Casper tells servers it can answer when someone can. A question is shown as `<server> asks about the <tool> call you approved:` and answered only by your typed answer (`Answer? Type yes: `, or one of the server's options). The model never sees the question and has no tool to answer it; its ask tool can't answer an approval either. MCP does not say which call a question belongs to, so Casper answers only while exactly one call you approved is running on that server, and pauses that call's clock while you read. Everything else is declined without asking: questions outside an approved call (`[mcp] <server> asked a question outside a call you approved; declined.`), forms that are not one yes/no or pick-one field (`[mcp] <server> asked a question Casper can only answer yes/no; declined.`), links (URL mode), and more than three questions in one call. One-shot runs decline every question.
- Without an interactive terminal (including one-shot runs), calls that need approval fail closed with `Not executed (needs your approval, and this run cannot ask)`. Arguments too large to show in full (over 4 KiB) are not run: `Too long to show in full (over 4 KB); not run.` No blanket write flag or model-controlled approval token exists; a remembered server only connects on its own, with writes off, and each change still asks. Calls that may ask run one at a time, and approvals and server questions are shown one at a time. Arguments cannot be changed by the approval, and a changed tool or a reconnect cancels a pending approval.

These are operational checks, **not a sandbox or proof of server behavior**. A trusted server can lie in its annotations or perform side effects from a nominal read. Stdio servers execute with the user's permissions. Existing Pi shell/filesystem tools are unsandboxed and could access MCP configuration or bypass this interface. Only connect servers you trust; use credentials scoped appropriately. MCP descriptions/results are external content, not trusted instructions.

## Secrets and docs servers

- **Device secrets are hidden from the AI.** Every MCP result is scrubbed before it is cut to size: passwords, RADIUS/TACACS keys, Wi-Fi PSKs, SNMP communities and similar values in config text or under secret-looking JSON keys become `<secret hidden>`. The result gets `secretsHidden: N` and the summary adds `N secrets hidden before the AI saw this (...)`. This hides known formats only; see [SECRETS.md](SECRETS.md) for the list and for netconan.
- **A hidden secret can't be sent back.** A call whose arguments contain `<secret hidden>` is refused before any approval question: `Not executed (this change still has <secret hidden> in it). Casper hid that secret from the AI, so the AI can't send it back. Type the real value yourself or leave that line out.` hpe-networking-mcp's own `hpe_mcp_secret_<32 hex>` tokens are not hidden and not refused: that server swaps them back itself.
- **Docs servers.** hpe-networking-mcp's docs tools (`lookup_api`, `search_docs`, `ask_docs`; "aruba-rag" is the old name of the same rag-core) are always offered to the model, right after the routers, whatever the task words, within the same tool and schema budget. Their descriptions start with `[docs; read; <id>] Check docs here before guessing Aruba, HPE, Mist or Junos API and config details. Say when the docs had no answer.` This only happens for a stdio server Casper recognised as hpe-networking-mcp by what it runs (its preset). Another server with the same tool names gets no special place. An unbuilt `lookup_api` index answers `{degraded: true, hint}`; Casper passes that on and does not build indexes.
- **`/mcp docs`** lists the docs servers (`Docs servers: hpe-networking-mcp (lookup_api, search_docs, ask_docs). No docs-only server yet.`). When one of your servers runs hpe-networking-mcp's `mcp_servers/tool_router.py`, it offers a docs-only copy: the same command and folder running `mcp_servers/rag.py`, with only `PYTHONPATH` (and `HPE_MCP_RAG_BACKEND` if set) in its environment. `CREDS_PATH`, vendor tokens and every `HPE_MCP_*` setting are left out. A router started with extra settings on its command line (for example `--env-file`) is not copied. rag.py may still read the repo's own `.env` file; it has no device tools either way. It shows what it will add and asks `Add a docs-only copy (no passwords, no device access)? Type yes: `. On yes it adds `<name>-docs` to `~/.casper/mcp.json` (create-only: other entries are kept, an existing name is refused with `<name>-docs is already in ~/.casper/mcp.json. Nothing changed.`). Then run `/mcp reload` and `/mcp connect <name>-docs`; it gets the usual approval like any server.

## Lifecycle and results

- No connection work during startup/status. Pi's SDK is imported only when a model session is first needed. MCP's client and the required transport are imported only on an approved connection; the broker loads Ajv directly (its own `src/capabilities/validate.ts`, same options as the SDK's default validator) on its first invocation. (The pinned MCP client itself imports Ajv.) Local status/project/help commands load neither SDK nor Ajv. Consent/deadline checks after module-load awaits prevent late transport creation, but module loading/evaluation itself cannot be aborted or hard-preempted. Approved failed connections can reconnect on the next task; at most two failed attempts per server in a rolling 30-second window. Successful reconnects do not count, and an explicit `/mcp connect` resets the window. No infinite background restart loop.
- **Time limits.** A server gets 20 s to start (handshake and tool list) and 90 s per call. Change them per server with whole seconds: `"connectTimeout": 60` (1-120) and `"callTimeout": 400` (1-1800). Anything else makes the entry invalid. `/mcp` shows them as `limits: start 20 s · call 90 s`. Changing only a limit and running `/mcp reload` keeps the connection and your consent.
- **Progress restarts the call clock.** Each progress message from the server starts the 90 s again, so a long job that reports progress keeps going. No call runs longer than 10 minutes (or its `callTimeout`, if that is longer), progress or not. Casper's own clock stops the call; the SDK's request timeout is set far above it. The clock can be paused while you answer a question about the call.
- **When a call fails**, the model reads plain text and is told not to retry on its own: `No answer from <server> in 90 s. It may have run. …` (plus the last progress message, if any), `<server> was still working after 10 min and was stopped. …`, or `<server> returned an error: <message>. It may or may not have run.` Server text in these lines is shortened and has secrets hidden. A timeout, a cancel or a lost connection closes that server's connection to stop pending I/O (this can interrupt other calls to the same server, not other servers); the next task reconnects, under the same retry cap. **An ordinary error answer from the server keeps the connection.** A failed call is **never repeated automatically**: a lost answer does not prove an action did not happen.
- **What the server said.** Stdio server stderr is kept (the last 40 lines / 8 KiB, always drained so a chatty server never blocks). When a server fails, `/mcp` shows a plain reason — `No answer in 20 s while starting.`, `The server stopped while starting (exit code 1).`, `Missing environment variable NAME`, `Command not found: uvx`, `The server said HTTP 401: <body>` — then `Last lines from the server:` with up to 8 lines. Every configured env/header value of that server (4+ characters) becomes `•••`, and common token shapes are hidden too. This is best effort: a secret the server reads on its own (for example from its `.env`) is not known to Casper. Server output is shown only to you, never to the model, and is not saved.
- **Imported servers** (from other tools' files) always start in your home folder, never in the opened project; a `cwd` inside the project is replaced and reported as `<name>: starts in your home folder, not in this project.` When the opened project is your home folder, they start in `~/.casper`.
- Paginated discovery allows at most 5,000 tools, 100 continuation pages, and 8 MiB of combined serialized tool definitions per server. Repeated cursors and duplicate names fail visibly.
- `notifications/tools/list_changed` refreshes catalogs atomically; bursts coalesce. Failed refreshes remove stale tools and close the affected connection, including unanswered discovery HTTP requests. Direct exposure updates on the next prompt; every call resolves against the current catalog, so removed tools cannot be invoked through stale wrappers.
- The broker caches the validator module promise/resolved module across calls; normalized metadata, search terms, and compiled input validators are cached only for the current catalog revision. A first-use validator import rechecks cancellation and catalog identity before asking for confirmation. Refresh, failure, disconnect, reconnect, and close invalidate that capability cache, not the loaded module. Each connection has a separate identity, so a pending approval cannot transfer to a replacement connection.
- Interactive command failures are displayed without terminating the session; EOF ends the input loop. One-shot command failures still exit nonzero.
- One server's failure does not remove another server's tools. Stdio exit is detected immediately; HTTP call failures are reflected in status. There is no periodic health probe.
- Close cancels in-flight work, joins any teardown already started by another call, and prevents late connections from reappearing. POSIX stdio close retains a short grace period, then TERM/KILL. Windows awaits verified-descendant cleanup and refuses reconnect after an unknown result. The CLI's one-second signal-exit deadline can interrupt cleanup; Windows host validation is pending, and escaped/daemonized descendants are not certified. HTTP streams are aborted, not remote-server processes.
- Wire buffers/individual HTTP response streams are capped at 8 MiB. Very long notification streams can hit this cap and reconnect through the SDK's bounded stream retry policy.
- Every model-facing result envelope fits **16 KiB** serialized JSON, and **each list is cut to 50 items on its own** (`lists: [{ path, shown, total }]` says which). When that is still too big, the per-list limit halves (25, 12, 6, 3, 1) before Casper falls back to a preview; a result that is one long text block previews its own text with real line breaks. Top-level MCP text content blocks are JSON-decoded before bounding; binary protocol content is omitted. Content-block metadata is retained. Decoded application records are not reinterpreted as protocol blocks, even when they contain `type`, `text`, or image-like fields.
- **Duplicate copies are dropped.** Many servers send the same data twice, as `structuredContent` and as text. Text blocks that only repeat `structuredContent` (or its `result`, or a list split into one block per item) are left out and `duplicateTextDropped: true` is set. Different text is kept.
- **The next-page cursor is always kept.** Casper looks for `next_cursor`, `nextCursor`, `next_page_token`, `nextPageToken`, `next` or `cursor`, at the top or under `_pagination`/`pagination`/`meta`/`links`, before cutting anything, and returns it as `nextCursor: { path, value }` even in a preview. Casper does not fetch more pages itself or keep the raw result.
- **Summaries say what happened.** `Complete result.`; `Partial result: <path> shows 50 of 2000. More: call again with next_cursor.` (or `The server gave no next page; narrow the request.`); `Partial result: too big to show, first part only.`; `The server said the call failed.` when the server set `isError`. A call Casper refused or stopped before sending reads `Not executed (<reason>).`, for example `you said no`, `needs your approval, and this run cannot ask` (a one-shot run), `cancelled`, `bad arguments`, `tool changed; search again`, `server not connected`, `arguments over 16 KB`, `schema not supported`, or `unknown capability; use find_capability`. `executed` is `true` when the server answered, `false` when nothing was sent, and `"unknown"` when the call may have run. Never replay a consequential operation just to obtain more output.

Configured credentials are absent from status/errors, but **server results and arguments may themselves contain secrets** and can persist in the Pi conversation. Known device secret formats in results are hidden (see Secrets and docs servers); there is no general-purpose secret detector or output declassification mechanism.

## Check a server you built

`casper mcp check [repo]` checks an MCP server repo before you connect it. It is a command-line command, not a slash command, and the model has no tool for it (it can still run it through its shell tool, like any other command). It runs code from the repo (its doctor and its tests), so **only run it on repos you trust**.

```
casper mcp check [repo] [--server <name>] [--live] [--quick] [--strict] [--json] [--env NAME=VALUE]... [-- <start command>...]
```

What it does, in order (one failing step never stops the others):

1. **Repo checks.** The repo's own doctor (`[project.scripts]` named doctor/selfcheck, `scripts/doctor.py`, `make doctor` or `npm run doctor`), then its safety tests (pytest `-m safety` when that marker exists, else test files named for write gates, read-only, guards, redaction, confirm or dry_run), then the full tests (`uv run pytest`, `make test` or `npm test`; `--quick` skips them). Missing packages show `Not set up: … Run \`uv sync\` in the repo, then check again.` This also shows when the server itself can't start for that reason.
2. **Server.** It starts the server once and lists its tools. It never calls a tool here. It checks:
   - that it starts in time (20 s, or the preset's limit), and shows the last lines it printed, secrets hidden, when it does not;
   - that stdout carries only MCP messages (`Server wrote plain text to stdout: "…" In stdio mode stdout is only for MCP messages. Print to stderr.`);
   - that every tool has `readOnlyHint` or `destructiveHint`, and that the label fits the name. A tool labeled read-only whose name changes things, a write tool whose name can cut service (bounce, reboot, delete …) or runs any command (execute, cli …), or read-only plus destructive is a problem. The name check uses Casper's own word rules, so status readers pass: `glp_write_status`, `get_config_rollback_status` and `junos_config_diff` read something. Unlabeled tools get a hint (`get_router_list looks read-only: add readOnlyHint: true.`);
   - confirm, dry_run and commit fields: a read-only tool with one warns, a preview or apply switch without a default gets a note, a description that tells the AI to "retry with confirm=true" is a problem (only the user may confirm), and a change tool with a confirm field warns when the repo never asks the user through MCP elicitation;
   - that each schema is valid JSON Schema (compiled with the same validator Casper uses for calls), has `"type": "object"`, declares every required field, and stays under Casper's 12 KB schema limit;
   - for routers (`find_tool` + `invoke_read_tool`): the finder and read dispatcher are read-only, `invoke_tool` and non-read `*_batch` dispatchers are destructive, and a repo test shows `invoke_read_tool` refuses write tools. The refusal is found by searching the test files, never by calling the router;
   - more than 5,000 tools (Casper's own limit per server), and whether an `access_check` tool exists.
3. **Example configs.** `.mcp.json*`, `mcp.json*`, `.vscode/mcp.json*`, `.cursor/mcp*.json` and `examples/**` (files only). A plain-text secret is a problem, shown by length only. A setting that turns writes on is a problem in a default example and a note in a file whose name says full, write, rw, admin or unsafe. For a server Casper has a preset for, an example that does not set its read-only setting (for example `HPE_MCP_ACCESS_PROFILE=safe-read-only`) warns: Casper sets it itself, other clients don't.
4. **Live** (only with `--live`): see below.

The server is started from, in order: `--server <name>` (your MCP settings, including imported ones), the command after `--`, `start` in `.casper/mcp-check.json`, then the first stdio entry of `.mcp.json.example`, `.vscode/mcp.json.example`, `.mcp.json` or `examples/**` (minimal or read-only names first). `${workspaceFolder}` and `/path/to/<repo folder or project name>` become the repo path (the project name comes from pyproject.toml or package.json). Casper never guesses from README text or package scripts; without a source it says `Can't tell how to start this server. Add .mcp.json.example, or pass the command: casper mcp check . -- <command>`.

**Offline is the default, and it is best effort.** Everything the check starts gets an environment without credential-looking names (TOKEN, SECRET, PASSWORD, API_KEY …, also from the example's own env), web proxies pointed at a dead local port, and `UV_OFFLINE=1`, `PIP_NO_INDEX=1`, `npm_config_offline=true`. An HTTP server is contacted only on localhost; a remote one gives `Remote server: needs --live`. A program that reads its own `.env` file or opens SSH itself can still reach the network, and the report says so. An example config can't change the proxy or offline settings. Use `--env NAME=VALUE` to pass a setting on purpose; `--env` also wins over the example's own env.

**`--live`** keeps your real environment and makes a few read calls: `access_check` (only when Casper itself would call it: labeled read-only and needing no fields), then at most 3 tools that are labeled read-only, pass Casper's label and the name check, need no fields and have no confirm, dry_run or commit field. Write, destructive, run-command, unlabeled and router tools are never called. The report shows the time and an item count, never what came back.

`.casper/mcp-check.json` (optional):

```json
{ "start": ["uv", "run", "python", "jmcp.py", "-f", "devices-template.json", "-t", "stdio"],
  "doctor": "uv run hpe-mcp-doctor", "safetyTests": "uv run pytest -m safety", "tests": "make test" }
```

`start` may also be a server entry like in `.mcp.json`. Exit codes: 0 no problems, 1 problems (or warnings with `--strict`), 64 usage mistake. `--json` prints one `{version: 1, …}` report on stdout and progress on stderr.

Not in this build: a cross-check with the MCP Inspector CLI as a second client. It is a planned follow-up; Casper will never download it with npx.
