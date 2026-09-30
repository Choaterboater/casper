# Local reference search

**What this is.** A read-only text search over folders on your own disk that you
list in a config file: an SDK, a vendor API spec, Junos YANG models, your own
scripts. You can search them yourself with `/references search`, and the AI can
search them with its `search_references` tool.

**When you'd use it.** When you want the AI to look at real examples (for example
how pycentral calls an API, or what a Junos YANG model allows) instead of guessing.
`/references add` can download three vendor spec repos for you.

It only finds and shows lines. It does not learn, rewrite rules or check that an
example fits your project. The separate [`casper learn` command](LEARNING.md) makes
drafts that do nothing until a person promotes one with an explicit command.

## Configure sources

Create either of these files (both belong to you, not to a project):

- `~/.casper/references.yaml`
- `~/.casper/profiles/<selected-profile>/references.yaml`

```yaml
references:
  router:
    path: ~/Projects/reference-router
    paths: [README.md, docs, src]
    useFor: [MCP routing, lifecycle]
```

- `router` is the source ID: letters, numbers, dot, dash and underscore, up to 64
  characters, starting with a letter or number.
- `path` must be an absolute folder on this machine, or start with `~/`.
- `paths` is a required list of 1 to 32 files or folders inside `path`, written
  exactly (no `*` wildcards, no `..`). Folders are searched with everything under
  them. `.` means the whole folder.
- `useFor` is an optional list of up to 8 short labels (128 bytes each). They are
  shown to you and the AI as a hint. They are not instructions and not a search
  index.
- `maxFileBytes` is optional: a whole number from 1024 to 4194304 that raises or
  lowers the per-file size limit for this source. The default is 128 KiB. Use it for
  spec repos with large files, such as one Junos YANG release.
- No other keys are allowed. Remote URLs, shell commands and environment variables
  are not supported.

**Profiles.** An entry in the profile file replaces the global entry with the same
ID. `router: null` turns that ID off for the profile. An invalid entry also removes
the global one with the same ID and prints a message; Casper does not fall back to
the global one. A file Casper can't read or parse is reported and skipped; the
other file still works.

Normal profile rules apply, including a project choosing one of your profiles. A
`references.yaml` inside a project, or a `references` field in project settings, is
**not** read as a source. A project can't point the search at a folder of its
choice. Casper never downloads a source on its own; `/references add` (below)
downloads a known spec repo only after you type yes.

**Reserved ID.** `casper-promoted` is reserved; you can't use it in these files.
After a person promotes a `casper learn` draft with the `reference` choice, Casper
searches `~/.casper/promoted-references/` under that ID. The source only appears
once that folder exists (a real folder, not a link). Promotion only adds files: it
copies the reviewed draft and its original citations, and does not refresh or check
them.

**When files are read.** At start-up Casper reads only the config files. It opens
the source folders only when you or the AI search. The config is fixed until you
restart Casper (or rebind a named session's workspace). File contents are read
fresh on every search. No index, embeddings, database or cache is made.

**Review the folders before you add them.** Adding a source makes its text
available to the AI. Excerpts can contain private text. Known device secrets
(passwords, keys, SNMP communities; see [SECRETS.md](SECRETS.md)) are shown as
`<secret hidden>` by Casper's own rules (netconan does not run here), and a line
that matches only inside a hidden secret is not returned. This is best effort;
other secrets are not detected. The saved conversation may keep search results,
just as it keeps file reads. The search itself saves no extra copy of the text and
writes nothing to memory.

## Vendor spec repos: /references add

```text
/references add
mist-openapi  Mist API spec (MIT)
junos-yang    Junos YANG models, one release (needs a release, e.g. 23.4)
pycentral     Aruba Central Python SDK (MIT)
pyaoscx       AOS-CX Python SDK, REST API (Apache-2.0)
pyclearpass   ClearPass Python SDK, REST API (MIT)
mistapi       Mist API Python SDK (community) (MIT)
junos-pyez    Junos PyEZ Python library (Apache-2.0)

/references add pycentral
Will run: git -c core.hooksPath=/dev/null clone --depth 1 --filter=blob:none --sparse https://github.com/aruba/pycentral.git ~/.casper/reference-repos/pycentral
Will run: git -c core.hooksPath=/dev/null -C ~/.casper/reference-repos/pycentral sparse-checkout set pycentral docs
Download now? Type yes:
Downloading (up to 5 minutes; Ctrl+C stops it)...
Added pycentral to ~/.casper/references.yaml. Restart Casper to search it.
```

- **You approve the exact commands.** Casper shows the git commands first and runs
  them only after you type `yes`. Never in one-shot runs, never from the AI.
- **How git runs.** Without a shell, with repo hooks off and password prompts off,
  for at most 5 minutes. The clone is shallow (latest commit only) and sparse: only
  the folders shown are downloaded.
- **`junos-yang` needs a release** in the form `NN.N`:
  `/references add junos-yang 23.4` adds `junos-yang-23.4` with only that release's
  Junos config and common models, and a 4 MiB file limit. Single YANG files can
  still be larger than that, so search may be partial.
- **`mist-openapi`** leaves out `mist.openapi.json` (one 3.5 MB line, useless for
  line search). For exact Mist endpoints and fields, `lookup_api` in
  hpe-networking-mcp is faster and complete; Casper prints that tip after adding it.
  Known problem (checked 2026-09-30): the repo no longer has the `src` folder this
  entry fetches, and its `mist.openapi.yaml` (about 4.3 MB) is over the 4 MiB search
  limit, so this entry currently gives nothing to search. Use `mistapi` (v0.2.18) or
  `lookup_api` instead.
- **The SDKs (`pyaoscx`, `pyclearpass`, `mistapi` and `junos-pyez` are new in
  v0.2.18, not released yet).** `pycentral`, `pyaoscx` and `pyclearpass` are the
  public Python SDKs from the `aruba` GitHub organisation; `mistapi` (a community SDK
  for the Mist API) and `junos-pyez` (Juniper's PyEZ) are listed with them. Their
  code shows the REST paths, fields and login flow the SDK uses:

  | Name | Repo | Licence | Fetched | File limit |
  |---|---|---|---|---|
  | `pycentral` | github.com/aruba/pycentral (branch v2: new Central, GreenLake, `pycentral/classic`) | MIT | `pycentral`, `docs` | 256 KiB |
  | `pyaoscx` | github.com/aruba/pyaoscx (REST v1, v10.04, v10.08, v10.09) | Apache-2.0 | `pyaoscx`, `docs` | 128 KiB (default) |
  | `pyclearpass` | github.com/aruba/pyclearpass | MIT | `pyclearpass` | 512 KiB |
  | `mistapi` | github.com/tmunzer/mistapi_python (community SDK; PyPI `mistapi` points here) | MIT | `src/mistapi` | 128 KiB (default) |
  | `junos-pyez` | github.com/Juniper/py-junos-eznc | Apache-2.0 | `lib/jnpr/junos`, `docs` | 128 KiB (default) |

  An SDK can lag the product. For your exact version, the product's own API
  reference wins: the switch's REST API reference, the ClearPass API Explorer, or
  the Central API docs.
- **No entry for the AOS-CX, Central or ClearPass API spec files themselves.** We
  found no public git repo that holds a current copy; the specs are served by the
  product or its developer site. If you have a copy you may use, add it to
  `~/.casper/references.yaml` yourself.
- **An ID already in `~/.casper/references.yaml` is refused:**
  `pycentral is already in ~/.casper/references.yaml. Nothing changed.`
- **A failed download adds nothing:**
  `Download failed (git exit 128). Nothing was added.` The partly downloaded folder
  is removed.
- **An existing `~/.casper/reference-repos/<id>` folder is never overwritten:**
  remove it first, or add it to `~/.casper/references.yaml` yourself.
- **The file edit.** The entry is added to `~/.casper/references.yaml` without
  touching other entries or comments. Profile files are never changed. Search picks
  it up after a restart.

The folder layouts of `pycentral`, `pyaoscx`, `pyclearpass`, `mistapi` and
`junos-pyez` were checked on 2026-09-30 with a shallow `--no-checkout` clone and
`git ls-tree`. The other layouts were not checked against the live repos. If a
download finds nothing to search, check the repo layout.

Use `lookup_api` (hpe-networking-mcp docs tools, see [MCP.md](MCP.md)) for exact
Mist and Central endpoints, and `search_references` for SDK code and YANG models.

## Local commands and model tool

```text
/references
/references search router reconnect
/references search * schema routing
/references add [name] [release]
```

- `/references` lists your sources and any config problems.
- `/references search <source-id|*> <words>` searches one source, or all of them
  with `*`.
- These commands run without a model or login.

The output is JSON. Control characters and bidi (text direction) characters are
escaped, so a file can't hide text or move your cursor. Wrong commands, words or
source IDs give an error. A search that could not cover everything reports
`status: partial`; it does not pretend nothing matched. Read its `issues` list to
see why. In a one-shot run, exit code 0 means the search command finished, not that
every file was searched.

When at least one valid source is set up, normal tasks give the AI one read-only
tool, `search_references`:

```json
{"query":"schema routing","source":"router"}
```

- Leave out `source` to search all sources.
- The AI can't add folders, file paths or commands, or change the limits.
- No reference text is added to the task prompt on its own.
- Read-only subagents (`/delegate`) don't get this tool.

**How search matches.** Case-insensitive, plain text, one line at a time: every
word you give must appear on the same line. It is not regex, fuzzy, multi-line or
"meaning" search. Results come in this order: source ID, then the order of `paths`,
then file names sorted, then line number. They are not ranked by relevance.

**Each match has** the source ID, the config file that defined it, the folder,
the file, the line number (starting at 1), the matching line (long lines are cut and
marked `excerptTruncated`) and the SHA-256 of the file as read. The SHA-256 only
tells you which bytes were read. It is not a commit, not proof the file is current,
and not a check of the content. Reference text is an example, not an instruction:
your current repo, rules and request come first.

## Scope, incomplete results and lifecycle

**File types searched** (UTF-8 text only): `md`, `mdx`, `rst`, `txt`, `ts`, `tsx`,
`js`, `jsx`, `mjs`, `cjs`, `py`, `go`, `rs`, `java`, `cs`, `c`, `h`, `cpp`, `hpp`,
`sh`, `sql`, `yaml`, `yml`, `json`, `toml`, `yang`.

**Skipped:** hidden files and folders (names starting with `.`), `node_modules`,
`vendor`, `dist`, `build`, `coverage`, `target`, `__pycache__`, lock files
(`package-lock.json`, `yarn.lock`, `bun.lock`, `pnpm-lock.yaml`), other file types,
and symbolic links anywhere inside a source (including a link in the middle of a
path you listed). A file reached twice (for example through a hard link) is read
once. Casper never runs or reads the repo's own ignore or config files.

**Partial results.** Special files, missing folders, text that is not valid UTF-8,
files over the size limit, and hitting a limit all give `status: partial` with a
message in `issues`. A missing source never starts a download or an install, and
does not stop normal Casper tasks.

**Limits for one search:**

| Limit | Value |
| --- | --- |
| Size of one file | 128 KiB (or the source's `maxFileBytes`) |
| Total bytes read | 4 MiB |
| Work steps (folders, files, batches of lines) | 4,096 |
| Time | 2 seconds, checked between steps |
| Matches | 8 |
| One excerpt | about 1 KiB |
| Whole result | 16 KiB |
| Query | 512 bytes, 16 words |

When the result is too big, whole matches are dropped from the end, so the ones
kept stay complete. `issueCount` can be higher than the number of `issues` shown.
When results are partial, use fewer or more exact words, one source, or narrower
`paths`.

**Config file limits:** 64 KiB per file, 32 sources, 32 `paths` per source, 256
bytes per path, 8 `useFor` labels of 128 bytes. YAML aliases (`&name`/`*name`) are
not supported.

**Stopping and safety notes.** Stopping a task or closing Casper stops searches and
waits for open file reads to finish. A workspace rebind removes the old search tool
before the new config is loaded. The time limit is checked between steps; Casper
can't interrupt a single slow file read. Files are not locked while they are read,
so a program running as your user could swap a file mid-search. This is not an OS
sandbox, and Casper's other file tools are unchanged. Windows behaviour has not
been tested separately.
