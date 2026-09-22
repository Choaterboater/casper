# Language-server support

Casper owns the LSP client, workspace policy, and tool surface. Pi only translates runtime-neutral tools and native-edit callbacks. OMP is reference material, not a dependency.

## Configure and connect

Optional metadata files, lowest to highest precedence:

- `~/.casper/lsp.json`
- `~/.casper/profiles/<selected-profile>/lsp.json`
- `<project>/.casper/lsp.json`

```json
{
  "lspServers": {
    "typescript": {
      "command": "/absolute/path/to/typescript-language-server",
      "args": ["--stdio"],
      "languages": { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript" }
    },
    "python": {
      "command": "/absolute/path/to/pyright-langserver",
      "args": ["--stdio"],
      "languages": { ".py": "python" }
    }
  }
}
```

`disabled: true` removes an inherited definition. Invalid named overrides also remove the earlier definition rather than silently starting it. Configuration is frozen at startup; restart after changing it. Use absolute executable paths where possible. No server is bundled into user configuration, automatically installed, or automatically started. The test-only language-server packages in devDependencies do not enable any server.

```text
/lsp
/lsp connect typescript
/lsp disconnect typescript
```

Or use a leading, repeatable `--lsp <name>` flag. Local commands do not start Pi or require model credentials. Connection consent lasts only for the process. The command executes at the project root without a shell, with the inherited environment. **Review the executable and configuration before connecting. This is execution consent, not sandboxing.** A language server can itself execute project plugins or other programs.

## Model tools

A connected server exposes one `lsp` tool with an explicit `server` and `operation`:

- `diagnostics`: `path`
- `symbols`: document symbols for `path`
- `workspaceSymbols`: optional `query`
- `definition` / `references`: `path`, `line`, `character`
- `rename`: `path`, `line`, `character`, `newName`

Positions are **zero-based UTF-16**, not byte offsets. Only UTF-16 servers are supported. Definition/reference results are server-provided navigation data, not authorization to read/write their targets. The tool is removed on the next prompt after disconnect; retained stale handlers still fail closed.

Successful native Pi `write`/`edit` results append LSP diagnostics before the next model request. Casper asks the model to repair new errors before continuing. It does not silently undo writes, guarantee the model repairs them, or start a second repair loop. Use `/verify` for project-wide checks. Shell writes are not intercepted. Queries and diagnostics resynchronize previously opened files from disk. Changed open dependencies invalidate cached diagnostic evidence and force new versions for all open documents after contents synchronize; unsupported/missing files fail visibly. Closed or unconfigured dependencies are subject to the server's own disk/watch behavior, so use project-wide checks for authoritative repository verification.

## Diagnostics are evidence, not silence

Reports explicitly distinguish:

- `fresh`: a matching document-version push, or a successful full pull against the synchronized snapshot, with disk content/identity rechecked before return.
- `unversioned`: a server publication observed after synchronization and a 250 ms quiet interval, but without proof of the document version. **Not verified clean.**
- `timeout` / `unavailable`: missing, failed, disconnected, or invalidated evidence. Empty items here never mean clean.

TypeScript Language Server 6.0.0 publishes unversioned diagnostics and may suppress identical reports, so follow-up reports can time out. Casper does not fabricate success. Pyright 1.1.414 publishes versioned diagnostics and is used for the strict rename acceptance test. Server version claims are trusted assertions, not independent compiler proofs. Ordinary document diagnostics do not establish that every repository file is clean.

## Rename safety

Rename is a language-server operation, not search-and-replace. Casper first snapshots all regular files matching this server's configured extensions, synchronizes them, requests the language-aware edit, validates every target and range, and displays the complete exact edit plan. Interactive users must type `yes`. One-shot mode denies rename. There is no model-supplied approval flag.

Before mutation, Casper rescans workspace membership and rechecks every original snapshot and connection identity. Disconnect cancels approval, pending lock acquisition, and remaining writes for that exact connection. In Pi, rename participates in the native per-file mutation queues, using deterministic lock ordering. The approval callback receives a detached copy. Symlinks escaping the root, protected directories (`.git`, `.casper`, `node_modules`), nonregular files, hardlinks, unsupported edit extensions, resource create/delete/rename operations, overlapping edits, and stale versions are rejected. Directory symlinks are not scanned. Rename targets must belong to the captured workspace.

After applying the text edits, Casper resynchronizes all captured files (including unchanged dependents) and gathers diagnostics as a batch. Collection uses one shared wait budget, at most eight concurrent collectors, and a final validation of all open snapshots; a detected concurrent disk change invalidates the whole batch. Changed paths and diagnostic statuses are returned separately: a successful write is **not** a successful verification. Diagnostic failure after a write does not conceal that the write happened.

Multi-file filesystem writes are **not atomic**. Each file is rechecked immediately before writing. If a later write fails, the error lists possibly modified paths, and Casper performs neither rollback nor replay. Inspect those paths before retrying. Snapshot checks/native queues protect ordinary concurrent activity, but cannot eliminate the final check/write race against external processes or adversarial filesystem changes. Native shell/filesystem tools remain unsandboxed. Server output, edit previews, and diagnostics may contain source or secrets and can persist in conversation history.

## Bounds and lifecycle

- 16 configured servers; 64 KiB per config; 32 extension mappings per server.
- 4 MiB protocol frames, 8 KiB headers, 64 in-flight requests per connection.
- 1 MiB per regular text file; 100 open documents per server.
- Rename scan: 10,000 entries, 100 matching files, 4 MiB original snapshots; 8 MiB combined original/replacement plan. Larger workspaces fail closed rather than silently rename a subset.
- Interactive approval preview: 16 KiB, never truncated for approval.
- Model output: 16 KiB and 50 array items with explicit truncation; no raw artifact.
- Default request/diagnostic deadline: 10 seconds. A post-rename diagnostic batch shares that wait budget rather than multiplying it by the number of files. Each serialized operation has a 60-second cancellation deadline including approval and post-edit diagnostics; queued operations start their budget when dequeued, but caller cancellation settles even while queued and prevents later execution. Approval and pre-mutation lock waits are abort-raced, so a late callback cannot start writes. Filesystem operations already in progress are drained rather than abandoned; their OS-level I/O cannot be forcibly time-bounded.
- Timeout/cancellation sends `$/cancelRequest`, removes local pending state, ignores late replies, and never replays a request. Cooperation is required to stop server-side analysis; disconnect kills the server.
- Startup consent is cancellable before process creation; immediate disconnect cannot launch a late server. Explicit reconnect only, no background healing. Shutdown attempts `shutdown`/`exit`, then kills the POSIX process group; Windows awaits verified-descendant cleanup; real-host validation is pending. Escaped/daemonized descendants are not guaranteed to be cleaned up.
- No dynamic registration, server-initiated workspace writes, command execution, code actions, formatting, remote transport, or automatic installation.
