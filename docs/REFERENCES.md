# Local reference search

Casper supports read-only search of explicitly configured local source paths.
It retrieves examples; it does not generate learning candidates, choose
promotions, rewrite rules, or certify that a pattern fits the current project.
The separate [`casper learn` command](LEARNING.md) produces inert drafts and
supports an explicit digest-bound human promotion command.

## Configure sources

Create either user-owned file:

- `~/.casper/references.yaml`
- `~/.casper/profiles/<selected-profile>/references.yaml`

```yaml
references:
  router:
    path: ~/Projects/reference-router
    paths: [README.md, docs, src]
    useFor: [MCP routing, lifecycle]
```

An optional `maxFileBytes` (a whole number from 1024 to 4194304) raises or lowers
the per-file size limit for one source; the default is 128 KiB. Use it for spec
repos with large files, such as one Junos YANG release.

`path` must be an absolute local directory or start with `~/`. `paths` is a
required list of literal relative files/directories; directories are recursive,
and `.` explicitly selects the root. Globs, traversal, remote URLs, shell commands
and environment interpolation are unsupported. `useFor` supplies optional
inspection labels, not instructions or a semantic search index.

Profile entries replace global entries by ID. `router: null` disables that ID for
the profile. An invalid individual override also removes the lower-priority entry
and emits a diagnostic instead of falling back to it. An unreadable/malformed
configuration file is reported and ignored; other valid files remain usable.

Existing profile-selection rules apply, including project selection of a
user-defined profile. Project-local `references.yaml` files and `references`
fields in project configuration are **not** source definitions. A project cannot
supply an arbitrary external root to the reference tool. External source
definitions are never installed automatically; `/references add` (below) downloads
a known spec repo only after you type yes.

`casper-promoted` is reserved. It cannot be supplied or overridden by these
configuration files. After a human promotes a learning candidate with the
`reference` disposition, Casper exposes the owner-state directory
`~/.casper/promoted-references/` under that source ID. The source is absent until
that real (non-symlink) directory exists. Promotion is create-only and copies the
reviewed candidate plus historical citations; it does not refresh or verify them.

Startup reads configuration metadata only. Repository content is opened on an
explicit local search or a model's `search_references` call. Configuration is
frozen until restart or a named-session workspace rebind. Content is read anew on
every search; no corpus index, embeddings, database, or result cache is created.

**Review the configured paths before enabling them:** configuring a source makes
its searchable text available to the parent model. Excerpts can contain sensitive
source text. Known device secrets (passwords, keys, SNMP communities; see
[SECRETS.md](SECRETS.md)) are shown as `<secret hidden>` by Casper's own rules
(netconan does not run here), and a line that matches only inside a hidden secret
is not returned. This is best effort; other secrets are not detected. Normal Pi session persistence may retain
requested tool results, just as it retains native read results. The reference
module does not create an additional raw-content store or memory facts/outcomes.

## Vendor spec repos: /references add

```text
/references add
mist-openapi  Mist API spec (MIT)
junos-yang    Junos YANG models, one release (needs a release, e.g. 23.4)
pycentral     Aruba Central Python SDK (Apache-2.0)

/references add pycentral
Will run: git -c core.hooksPath=/dev/null clone --depth 1 --filter=blob:none --sparse https://github.com/aruba/pycentral.git ~/.casper/reference-repos/pycentral
Will run: git -c core.hooksPath=/dev/null -C ~/.casper/reference-repos/pycentral sparse-checkout set pycentral docs
Download now? Type yes:
Downloading (up to 5 minutes; Ctrl+C stops it)...
Added pycentral to ~/.casper/references.yaml. Restart Casper to search it.
```

Casper shows the exact git commands first and runs them only after your typed
`yes` (never in one-shot runs, never from the AI). git runs without a shell, with
repo hooks off and prompts off, for at most 5 minutes. The clone is shallow and
sparse: only the folders shown are fetched.

- `junos-yang` needs a release: `/references add junos-yang 23.4` adds
  `junos-yang-23.4` with only that release's Junos config and common models, and a
  4 MiB file limit. Single YANG files can still be larger than that, so search may
  be partial.
- `mist-openapi` leaves out `mist.openapi.json` (one 3.5 MB line, useless for line
  search). For exact Mist endpoints and fields, `lookup_api` in hpe-networking-mcp
  is faster and complete; Casper prints that tip after adding it.
- An ID already in `~/.casper/references.yaml` is refused: `pycentral is already in
  ~/.casper/references.yaml. Nothing changed.` A failed download adds nothing:
  `Download failed (git exit 128). Nothing was added.` An existing
  `~/.casper/reference-repos/<id>` folder is never overwritten: remove it first or
  add it to `~/.casper/references.yaml` yourself.
- The entry is added to `~/.casper/references.yaml` without touching other entries
  or comments. Profile files are never changed. Search picks it up after a restart.

The folder layouts of these repos were not checked against the live repos when
this was written; if a download finds nothing to search, check the repo layout.

Use `lookup_api` (hpe-networking-mcp docs tools, see [MCP.md](MCP.md)) for exact
Mist and Central endpoints, and `search_references` for SDK code and YANG models.

## Local commands and model tool

```text
/references
/references search router reconnect
/references search * schema routing
/references add [name] [release]
```

These commands work without model credentials or Pi startup. `*` selects all
configured sources. CLI and tool output share JSON encoding that escapes C0,
DEL/C1 and bidi controls while preserving parsed values. Escaping counts toward
the serialized result budget. Invalid command/query/source arguments produce an error; a valid but incomplete
search reports `status: partial` rather than pretending the entire corpus had no
matches. CLI exit 0 means the local search command completed, not complete search
coverage; inspect its status/issues.

When at least one valid source is configured, normal parent tasks receive one
read-only tool:

```json
{"query":"schema routing","source":"router"}
```

Tool name: `search_references`. Omit `source` to search all configured sources.
Arguments cannot add roots, file paths, commands, or override search bounds. No
reference text is injected automatically into the initial task prompt. Read-only
subagents do not gain this tool in this slice.

Search is case-insensitive, literal and line-based: every whitespace-separated
term must appear on a matching line. It is not regex, fuzzy, cross-line or semantic
search. Results follow configured source-ID order, declared-path order, sorted
directory entries and line order; they are not relevance-scored.

Each match includes source ID, originating configuration file, resolved local
root, relative file, one-based line number, a matching-line excerpt and the SHA-256
of the bytes read from that file. Long excerpts are explicitly marked truncated.
A digest identifies observed bytes, not a commit, current-file guarantee, trust
grant, or verification evidence. Reference text is untrusted advisory data;
current repository evidence, rules and the user's request take precedence.

## Scope, incomplete results and lifecycle

Search reads regular UTF-8 files with supported documentation/source extensions:
`md`, `mdx`, `rst`, `txt`, `ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `py`, `go`, `rs`, `java`,
`cs`, `c`, `h`, `cpp`, `hpp`, `sh`, `sql`, `yaml`, `yml`, `json`, `toml`, `yang`.

Hidden entries, `node_modules`, `vendor`, `dist`, `build`, `coverage`, `target`,
`__pycache__`, standard package lockfiles, and unsupported extensions are excluded.
Eligible files are deduplicated by filesystem identity; an excluded filename or
lockfile cannot suppress an eligible hardlink. Directory cycle protection remains
separate from filename eligibility. Repository ignore/configuration files are not
executed or interpreted. Source roots are resolved explicitly; symlinks inside them, including parents of named
input files, are skipped. Non-regular files, unavailable paths, invalid text,
oversized files and scan limits produce partial results with issues. Missing
sources never trigger cloning, installation or provider calls, and do not prevent
ordinary Casper tasks.

Per-search resource bounds: 128 KiB per file (or the source's `maxFileBytes`), 4 MiB read allowance, 4,096 traversal/
line-batch work steps, and two seconds checked between operations; eight matches,
roughly 1 KiB per excerpt and 16 KiB for the entire serialized result. Trimming
removes whole matches, preserving the provenance of retained ones. `issueCount`
can exceed the retained issue messages. Narrow the query, source or configured
paths when results are partial. Queries admit 512 UTF-8 bytes / 16 terms.
Configuration files admit 64 KiB, 32 active sources, 32 paths per source, 256 bytes
per relative path and eight optional 128-byte labels. YAML aliases are unsupported.

Cancellation and shutdown abort searches and drain pending I/O. Workspace rebind
revokes old captured tools before loading new source metadata. Cancellation and
the deadline are cooperative, not hard preemption of filesystem calls. Lookups
are non-atomic and do not protect against a hostile same-user process replacing
paths during a read. This is not an OS sandbox; native runtime tools are unchanged.
Windows behavior is not independently validated.
