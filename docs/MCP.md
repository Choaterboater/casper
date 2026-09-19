# MCP capability broker (Phase 4)

Casper owns MCP connections, capability selection, safety checks, and result budgets. The pinned official MCP SDK handles the protocol. Pi knows only Casper's runtime-neutral custom tools; `src/runtime/pi.ts` translates them into SDK registrations. There is no OMP runtime dependency.

## Personal integrations, generic core

**HPE is optional, not a default integration for everyone.** Casper ships no HPE endpoint, credentials, or automatically connected server. The HPE-named fixtures are synthetic test cases; native router detection works for any server with that tool surface.

Keep personal HPE definitions in `~/.casper/profiles/stephen/mcp.json` and select that profile with `CASPER_PROFILE=stephen casper`. Other users and unselected profiles do not inherit those definitions. You must still explicitly connect the server. Alternatively, user-global `~/.casper/mcp.json` applies to all of your profiles. A project MCP file is shared with anyone who checks out that project if you commit it, so it is not the place for private credentials or personal-only integrations.

Real-HPE deployment validation is a gate for that optional integration, not a requirement to use Casper with unrelated MCP servers. No personal configuration or credentials are installed by the test suite.

## Configure and connect

Casper reads optional JSON files, in this precedence order (later definitions replace earlier names):

1. `~/.casper/mcp.json`
2. `~/.casper/profiles/<selected-profile>/mcp.json`
3. `<project>/mcp.json`
4. `<project>/.mcp.json`
5. `<project>/.casper/mcp.json`

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

The example URL is a placeholder, not a server to connect to. `type: "stdio"` is optional for command entries; URL entries accept `http` or `streamable-http`. Only HTTPS or loopback HTTP is accepted. URL userinfo, fragments, legacy SSE transport, and ambiguous command-plus-URL definitions are rejected. Stdio commands run directly (no implicit shell) at the project root, with the SDK's minimal inherited environment plus the explicit `env` map. Shell interpreters supplied as commands can still execute shell code.

`${ENV_NAME}` references in command, arguments, environment values, and HTTP header values resolve only on connection. Missing variables fail the connection. Casper does not run secret-fetching commands, provision OAuth, install servers, or write MCP configuration/credentials. Use environment references instead of committing secrets. Review the resolved configuration source before connecting, especially when project definitions override user definitions.

```text
/mcp                          # local status; no connection or model
/mcp connect local-docs        # authorize this loaded definition for this process
/mcp disconnect local-docs     # disconnect and revoke process-local consent
```

For one-shot tasks or preconnected interactive sessions, use repeatable **leading** CLI options:

```bash
casper --mcp local-docs "Find the documentation for pagination"
casper --mcp local-docs --mcp another-server
```

**Discovery is not permission.** All servers, including user/profile servers, start disconnected. Neither a `trusted` flag in project JSON nor a skill can authorize connection. Only the user's local connect command/CLI option does so. Consent lasts for this process; it is not persisted and is separate from skill trust. `/mcp` lists name, source file, transport, state, tool count, and controlled error messages, never command arguments, URLs, header values, or environment values. Server stderr is discarded rather than rendered.

Malformed entries produce diagnostics without taking down other entries. An invalid overriding entry removes that name rather than falling back to the lower-precedence executable. Files are limited to 1 MiB and the merged configuration to 64 servers. Unsupported configuration shapes are not silently imported. Restart to reload configuration changes.

## Small model-facing surface

For a connected generic catalog, Casper exposes:

- at most **six** task-selected direct MCP tools;
- `find_capability` for metadata search or one schema inspection;
- `call_capability` for fallback invocation by exact ID and arguments.

This is at most **eight additional tools**, not hundreds of schemas. Pi's existing seven coding tools remain available. Selection is lexical, deterministic, and renewed before each ordinary/repair prompt. The schema budget is 12,000 bytes per tool and 32,000 bytes for selected direct schemas, measured using the escaped JSON-string representation (a conservative bound for direct schemas too). Oversized schemas cannot be called through the fallback either.

Example model workflow:

```text
find_capability({ query: "rare site counter" })
find_capability({ id: "mcp:docs:read_site_counter" })
call_capability({ id: "mcp:docs:read_site_counter", arguments: { site: "lab" } })
```

The unused `query`/`id` field can be omitted or an empty string, accommodating providers that materialize optional string fields. Search returns up to five metadata summaries, not schemas. Exact-ID inspection returns `{ id, inputSchemaJson }`; parse `inputSchemaJson` to obtain the complete schema. Encoding it as a string preserves `enum`, `required`, and other schema arrays rather than truncating their semantics under the result-item budget. Descriptors carry stable server-qualified IDs, source, name, bounded description/tags, safety classification, and a schema reference. Both direct and fallback calls validate against the target input schema and share the same safety checks.

Provider-facing names are sanitized and hash-qualified; the broker retains exact server/tool mappings. Two servers exposing `status` do not overwrite each other. A native `find_tool` + `invoke_read_tool` surface is preferred when present; `invoke_tool` is also eligible but remains consequential. Casper does not recursively flatten a native router's backend catalog. With many connected routers, the same global direct-tool cap applies; the fallback can reach the rest.

## Safety

- Explicit MCP `readOnlyHint: true` permits reads after connection consent, unless a stronger classification applies.
- Destructive hints, destructive/execution/write names, and the generic `invoke_tool`/`invoke_tools_batch` dispatchers tighten classification.
- Optional `_meta["casper/safety"]` can classify diagnostic/write/destructive/exec/external-action tools. It cannot grant read permission.
- Unknown/unannotated tools are `external-action`, not implicitly safe reads. Descriptions claiming to be safe do not grant permission.
- **Every non-read call requires exact interactive confirmation.** The terminal shows its server-qualified ID, classification, and JSON arguments; only `yes` approves. Arguments cannot be altered by the confirmation callback, and changed/unavailable tool metadata or a disconnect/reconnect invalidates approval, even when the new server advertises an identical schema.
- Without the interactive confirmation UI (including one-shot runs), consequential calls fail closed. No blanket write flag, remembered approval, or model-controlled approval token exists. Concurrent confirmation requests and arguments too large to show completely (over 4 KiB) are denied.

These are operational checks, **not a sandbox or proof of server behavior**. A trusted server can lie in its annotations or perform side effects from a nominal read. Stdio servers execute with the user's permissions. Existing Pi shell/filesystem tools are unsandboxed and could access MCP configuration or bypass this interface. Only connect servers you trust; use credentials scoped appropriately. MCP descriptions/results are external content, not trusted instructions.

## Lifecycle and results

- No connection work during startup/status. Pi's SDK is imported only when a model session is first needed; local commands do not pay its import cost. Approved failed connections can reconnect on the next task; at most two attempts per server in a rolling 30-second window. No infinite background restart loop.
- Connect/discovery and tool requests use 10-second deadlines. Cancellation propagates through the MCP SDK. An in-flight request failure/cancellation also invalidates and closes that server connection to abort pending HTTP I/O; this can interrupt sibling calls to the same server, but not other servers. Cleanup may add a short grace period after the request deadline. Reconnection is on demand, under the same retry cap. A failed tool request is **never replayed automatically**: a lost response does not prove an external action did not happen.
- Paginated discovery allows at most 5,000 tools, 100 continuation pages, and 8 MiB of combined serialized tool definitions per server. Repeated cursors and duplicate names fail visibly.
- `notifications/tools/list_changed` refreshes catalogs atomically; bursts coalesce. Failed refreshes remove stale tools and close the affected connection, including unanswered discovery HTTP requests. Direct exposure updates on the next prompt; every call resolves against the current catalog, so removed tools cannot be invoked through stale wrappers.
- The broker caches normalized metadata, search terms, and compiled input validators only for the current catalog revision. Refresh, failure, disconnect, reconnect, and close invalidate the cache. Each connection has a separate identity, so a pending approval cannot transfer to a replacement connection.
- Interactive command failures are displayed without terminating the session; EOF ends the input loop. One-shot command failures still exit nonzero.
- One server's failure does not remove another server's tools. Stdio exit is detected immediately; HTTP call failures are reflected in status. There is no periodic health probe.
- Close cancels in-flight work, joins any teardown already started by another call, and prevents late connections from reappearing. Stdio close gets a short grace period, then TERM at 200 ms and KILL at 450 ms, inside the CLI's one-second exit deadline. This manages the **direct SDK-owned child**, not escaped/daemonized descendants; Windows is not validated. HTTP streams are aborted, not remote-server processes.
- Wire buffers/individual HTTP response streams are capped at 8 MiB. Very long notification streams can hit this cap and reconnect through the SDK's bounded stream retry policy.
- Every model-facing result envelope fits **16 KiB** serialized JSON and a global budget of **50 array entries**, including protocol arrays. Top-level MCP text content blocks are JSON-decoded before item bounding; binary protocol content is omitted. Content-block metadata is retained. Decoded application records are not reinterpreted as protocol blocks, even when they contain `type`, `text`, or image-like fields. Oversized scalar/object results fall back to a Unicode-safe preview. Errors retain `isError`; discarded data is explicitly disclosed.
- Provider continuation metadata is retained when it fits. Casper does not invent a cursor, refetch results automatically, or persist a raw artifact. Use narrower arguments or provider-native read pagination. Never replay a consequential operation just to obtain more output.

Configured credentials are absent from status/errors, but **server results and arguments may themselves contain secrets** and can persist in the Pi conversation. There is no general-purpose secret detector or output declassification mechanism.

## Validation and remaining acceptance

See [PHASE4_VERIFICATION.md](PHASE4_VERIFICATION.md). Tests exercise real local stdio and Streamable HTTP servers, JSON and SSE responses, large synthetic catalogs, the real Pi adapter with a local model-protocol fixture, and a live model using local MCP fixtures only.

A synthetic HPE-style catalog is not an actual HPE server. Real deployment-specific HPE acceptance, production credentials/endpoints, additional compatible config formats, and OAuth provisioning remain separate work requiring explicit authorization.
