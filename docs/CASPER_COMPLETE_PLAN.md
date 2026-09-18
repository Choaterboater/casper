# Casper — Complete Product & Engineering Plan

**Working name:** Casper  
**Product identity:** A project-aware coding companion built on Pi as a dependency, with a small Casper-owned control layer, progressive skills/capabilities, and evidence-based verification.  
**Primary interface:** Terminal/TUI first, with SDK/RPC integration points for desktop companions such as CasperCloud.  
**Core design goal:** Make a coding companion that works exceptionally well for your workflows while keeping the core generic enough for other developers to use.  
**Revision:** v2 — updated after comparing SkyN3t, both current HPE Networking MCP branches, GreenCLI, OMP, and the intended MindMesh/CasperCloud roles.

---

## 1. Executive Summary

Casper should **not** be a SkyN3t rewrite, an OMP reskin, a Pika-based workflow engine, or a giant prompt wrapped around Pi.

Casper should be its own product with a deliberately small control plane.

The revised architecture is:

```text
                              CASPER 👻
                                  │
                     ┌────────────┴────────────┐
                     │                         │
                   TUI/CLI                Casper Core
                                               │
              ┌────────────────────────────────┼────────────────────────────────┐
              │                                │                                │
        Project Intelligence              Skill Router                    Policy/Profile
              │                                │                                │
              └────────────────────────────────┼────────────────────────────────┘
                                               │
                                         Context Engine
                                               │
                                      AgentRuntime Adapter
                                               │
                              ┌────────────────┴────────────────┐
                              │                                 │
                       OMP Runtime                         Pi Runtime
                    (initial fast path)               (lean fallback/option)
                              │                                 │
                              └────────────────┬────────────────┘
                                               │
          ┌───────────────────────────────┬────┴────┬──────────────────────────────┐
          │                               │         │                              │
      Local coding                      MCP        LSP                        Visualization
 read/edit/bash/git              capability broker   symbols/diag             MindMesh/
                                       │                                      Mermaid/etc.
                                       │
                                external systems
                                               │
                                           Workspace
                                               │
                                   Casper Verification
                                               │
                                      pass ↙        ↘ fail
                                         done       repair
                                                      │
                                                      └──→ runtime
```

### Runtime decision

The decision is intentionally simple:

- **Create Casper as a new repository.**
- **Use Pi as a pinned dependency / SDK.**
- **Do not fork Pi.**
- **Do not use OMP as Casper's runtime or base.**
- **Use OMP only as a reference implementation for features worth recreating later.**

Casper still defines a small `AgentRuntime` boundary so Pi-specific code stays isolated:

```text
Casper Core
    ↓
AgentRuntime
    ↓
PiRuntime
    ↓
Pi SDK
```

Casper owns:

- project understanding;
- profiles and policy;
- skill selection;
- capability selection;
- low-token MCP/tool virtualization;
- verification and repair policy;
- visualization routing;
- Casper UX.

Pi owns the underlying agent/session/tool loop.

OMP is a source of patterns for later features such as LSP, debugger integration, MCP lifecycle, sessions, subagents, and tool UX. Those ideas should be ported selectively into Casper rather than inherited wholesale.

### Revised repo-learning principle

The existing projects are a **design corpus**, not dependencies that all need to be merged:

- **SkyN3t** — proof, repair, project awareness, worktree isolation, and lessons about over-orchestration.
- **secure-ssid/hpe-networking-mcp** — semantic tool routing, minimal tool surface, bounded responses, continuation, and workflow skill discovery.
- **nowireless4u/hpe-networking-mcp** — dynamic registries, safety classification, code-mode ideas, skill metadata/on-demand loading, and per-platform write gates.
- **GreenCLI** — robust MCP client lifecycle, transports, reconnection, tool collisions, credentials, and operator confirmations.
- **MindMesh** — visualization/mind maps/architecture maps through a generic visualization capability.
- **CasperCloud** — a future companion/client surface, not the definition of Casper.
- **OMP** — the most useful implementation source for IDE intelligence and coding runtime features.
- **Pi** — the architectural lesson that the core agent loop should stay small.

### Non-negotiable simplification

**Pika is out of the Casper design.**

Casper may keep the useful idea of a small project verification contract, but verification remains Casper-owned and simple: commands, structured results, evidence, and repair. No Pika kernel, profile packs, lease system, repo ownership model, or second orchestration framework.

The guiding principle for v1 is:

> **One strong primary coding session + selective skills + selective capabilities + strong evidence.**

Not a swarm. Not a factory. Not another control framework layered on top of the agent.

---

# 2. What Casper Is

Casper is:

> **A project-aware coding companion that understands a repository, loads only the knowledge and capabilities a task needs, executes through a Pi-family runtime, proves its work, repairs failures, and becomes more useful across projects without requiring giant prompts.**

The normal experience should be:

```bash
cd ~/Projects/something
casper
```

Casper starts, understands where it is, restores relevant context, shows a concise startup panel, and waits for something simple like:

```text
> add authentication
```

or:

```text
> fix the search bug
```

or:

```text
> add a Mist site-health MCP tool
```

Casper should infer as much as it safely can rather than forcing you to repeatedly explain:

- the framework;
- repository layout;
- existing architectural patterns;
- package manager;
- test command;
- preferred coding style;
- available MCP servers;
- which custom skills apply;
- what files are likely relevant.

That is the **promptless** direction.

---

# 3. What Casper Is NOT

Avoid allowing Casper to evolve into these things too early:

- a giant permanent multi-agent swarm;
- an autonomous software company simulator;
- a replacement for every IDE feature;
- a giant system prompt;
- a collection of hundreds of always-loaded tools;
- an automatic prompt-mutating research system;
- an opaque scoring system;
- a framework where every feature requires another agent;
- a fork that makes upgrading Pi/OMP painful;
- a Pika-managed repository workflow;
- SkyN3t 3.0 under another name.

The operating principle should be:

> **One strong primary agent, excellent context, strong skills, powerful tools, and deterministic verification first.**

Advanced orchestration comes later and only where it measurably helps.

---

# 4. Product Identity

The product is simply:

# **Casper**

Not:

- Casper Builder
- Casper AI Builder
- Casper Agent
- Casper IDE

Those descriptions may appear in documentation, but not as the product name.

A useful tagline is:

> **your coding companion**

The visual identity should be a **cute Pac-Man-style ghost**, based on the compact ghost art already chosen during design discussions.

Do **not** redesign the mascot during initial engineering work.

Treat the current ghost as a placeholder asset that can be polished separately.

Normal startup should be compact:

```text
        <Casper ghost>

           CASPER
     your coding companion

 project   my-project
 stack     TypeScript · React
 skills    5 selected
 mcp       3 available
 lsp       ready
 branch    main

 >
```

The ghost should remain small enough that Casper can show it on every startup without wasting terminal space.

Later states can subtly change the mascot/status presentation:

```text
ready
exploring
building
testing
repairing
done
```

Do not make animation a v1 requirement.

---

# 5. Core Technical Decision: Pi Dependency, No Fork

Casper should be a **new repository**.

Use Pi through its public SDK/package surface.

Do **not** fork Pi at the beginning.

Do **not** build Casper on OMP.

Do **not** fork OMP.

The clean boundary is:

```text
Casper
│
├── project/
├── profiles/
├── skills/
├── capabilities/
├── mcp/
├── verify/
├── visualize/
├── tui/
│
└── runtime/
    ├── types.ts
    └── pi.ts
         │
         ▼
       Pi SDK
```

Only `runtime/pi.ts` should know Pi deeply.

A simple interface is enough:

```ts
export interface AgentRuntime {
  start(options: RuntimeStartOptions): Promise<RuntimeSession>;
  dispose(): Promise<void>;
}

export interface RuntimeSession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  getState(): RuntimeState;
}
```

## Why Pi is the base

Pi gives Casper the smaller foundation:

```text
agent loop
models
sessions
tools
extensions
```

Casper adds the opinionated product layer:

```text
project intelligence
profiles
skills
capability routing
MCP virtualization
verification
repair
visualization
memory
UX
```

That separation keeps Casper understandable and easier to maintain.

## Why OMP is not the base

OMP already contains a large amount of functionality:

```text
LSP
DAP
MCP management
subagents
memory
browser/computer tooling
session trees
rule discovery
tool approval
custom tools
many runtime subsystems
```

Those are useful ideas, but making OMP Casper's base would mean inheriting a large moving architecture before Casper establishes its own identity.

Instead:

```text
Need LSP?
  study OMP's LSP implementation
  build the smallest Casper-compatible version

Need MCP reconnect?
  study OMP + GreenCLI
  implement only what Casper needs

Need subagents?
  study OMP
  add bounded explorer/reviewer roles only
```

## When would a Pi fork ever make sense?

Only if Casper eventually proves that a required feature cannot reasonably be implemented through Pi's public extension/SDK boundary.

Examples:

- a required hook is impossible externally;
- a core tool-loop behavior must change;
- a performance bottleneck is inside Pi and cannot be worked around;
- Casper needs a fundamental session semantic Pi cannot expose.

Even then, prefer:

1. adding a small adapter;
2. contributing a hook upstream;
3. maintaining a tiny patch set;

before creating a long-lived fork.

The default assumption is:

> **Casper depends on Pi; Casper does not own Pi.**

---

# 6. What to Borrow From Pi

Pi is Casper's primary runtime dependency and also the architectural model: keep the center small, keep tools explicit, and keep Casper-specific intelligence outside the agent kernel.

Use Pi for:

- agent/session execution;
- model interaction;
- streaming;
- built-in filesystem tools;
- bash/shell execution;
- edits and writes;
- extension plumbing;
- session persistence;
- skill loading primitives;
- context-file integration;
- custom tools;
- custom UI components;
- model/provider abstraction.

Do not duplicate these unless Casper has a concrete reason.

Casper should feel different because of what **Casper adds around Pi**, not because Casper rewrites Pi.

Current Pi documentation explicitly supports custom UIs, programmatic sessions, extensions, custom tools, skills, event interception, state persistence, and custom system prompts. That makes it the correct kernel for this project.

---

# 7. What to Borrow From OMP

OMP is **reference material**, not Casper's base runtime.

Use it as a working example of advanced coding-agent features that already exist in the Pi ecosystem.

## High-value OMP ideas to study

### LSP

Study:

- diagnostics;
- symbols;
- definitions;
- references;
- rename;
- code actions;
- diagnostics after writes.

Casper should implement only the subset it actually needs.

### Debugger / DAP

Useful later for:

- launching/attaching;
- breakpoints;
- stack frames;
- variables;
- evaluation;
- stepping.

This is not a v1 requirement.

### MCP lifecycle

Study OMP's handling of:

- discovery;
- parallel connection;
- reconnect;
- late tool arrival;
- `tools/list_changed`;
- partial failures;
- teardown.

Combine those lessons with GreenCLI's MCP client behavior.

### Sessions / branching

Study OMP's session tree and branch/resume behavior when Casper reaches that phase.

### Subagents

Study OMP's delegation model, but keep Casper's version narrow:

```text
explorer
reviewer
```

No swarm by default.

### Tool approval

OMP's read/write/exec distinction is useful as a reference for Casper's own safety classification.

### Context and rules discovery

OMP's compatibility with existing developer files is worth learning from:

```text
AGENTS.md
CLAUDE.md
GitHub instructions
Cursor rules
MCP configs
```

Casper should eventually be able to coexist with these formats.

## What Casper should not copy automatically

Do not port:

- advisor-on-every-turn;
- broad autonomous memory;
- swarm-heavy behavior;
- browser/computer control by default;
- automatic research;
- every tool;
- every MCP;
- every skill;
- all OMP configuration semantics.

The pattern is:

```text
OMP proves an idea can work
      ↓
Casper asks if it is actually needed
      ↓
Casper implements the smallest useful version
```

OMP is a **reference implementation library**, not a dependency Casper must architect around.

---

# 8. What to Learn From SkyN3t

SkyN3t already contains valuable experiments.

Treat those experiments as evidence.

## KEEP

### Proof over self-reporting

The model saying "done" means nothing.

The artifact should prove the work.

### Project/stack detection

Casper should automatically understand repository shape.

### Skills

SkyN3t showed that reusable task knowledge is more manageable than one giant prompt.

### Repair loops

When verification fails, the error should feed directly back into a bounded repair cycle.

### Frozen important decisions

Once Casper decides a task is using the existing React/Tauri architecture, it should not randomly switch architecture halfway through.

### Repo mapping

Understanding repository structure before editing is valuable.

### Outcome-based learning

Record what worked and what failed.

### Safe skill provenance

External skills should not silently gain trust.

## SIMPLIFY

SkyN3t concepts that should survive but become much smaller:

- build contracts;
- verification gates;
- project profiles;
- skill scoring;
- memory;
- model routing;
- architecture detection.

## DO NOT PORT YET

Do not copy these systems into Casper v1:

- Cortex;
- large autonomous agent swarm;
- full Mixture-of-Agents council;
- Best-of-N generation;
- heavy event sourcing;
- automatic policy mutation;
- giant stack registry;
- complicated deployment orchestration;
- large composite scoring systems.

If Casper eventually needs any of them, add them because Casper metrics demonstrate the need.

---


# 8A. Design Corpus Findings

The existing repositories should be mined for specific strengths instead of merged wholesale.

| Source | Keep / generalize for Casper | Do not carry over blindly |
| --- | --- | --- |
| `secure-ssid/hpe-networking-mcp` | semantic `find_tool` routing, minimal/default/direct exposure modes, bounded item/byte responses, read/write separation, continuation cursors, workflow skills | HPE-specific naming or product assumptions in core |
| `nowireless4u/hpe-networking-mcp` | dynamic tool registry, capability/safety metadata, metadata-only skill listing, on-demand skill bodies, platform write gates, code-mode lessons | platform-specific registry structure in core |
| `GreenCLI` | stdio + HTTP MCP handling, reconnect/dead detection, `tools/list_changed`, tool-name collision handling, secret handling, atomic config writes, confirmation UX | network-device-specific prompts/tools in core |
| `SkyN3t` | deterministic proof, repair loops, worktree isolation, project detection, idempotency/retry lessons, explicit approval boundaries | large agent catalog, factory pipeline, event-everything requirement, Cortex, Best-of-N by default |
| `MindMesh` | mind maps, architecture diagrams, dependency trees, troubleshooting trees, visual planning | coupling visualization to core agent logic |
| `CasperCloud` | future companion/client UX and ambient integration | coupling Casper's engine to one desktop app |
| `OMP` | runtime, LSP, DAP, MCP lifecycle, sessions, custom tools, context discovery | all features enabled by default |
| `Pi` | small-agent-loop philosophy and replaceable harness boundary | assumption that Casper must rebuild all IDE/runtime facilities itself |

## Best HPE MCP ideas to generalize

The strongest shared lesson from both HPE MCP branches is:

> **Large tool catalogs should not be handed directly to the model.**

Casper should generalize that into a **Capability Broker**.

The broker indexes tools from all connected sources:

```text
local built-ins
MCP server A
MCP server B
extensions
project capabilities
```

The model initially sees:

```text
small direct core toolset
+ task-selected tools
+ a discovery mechanism
```

not the entire catalog.

Preferred flow:

```text
task
  ↓
Casper preselects likely capabilities
  ↓
model works with small direct set
  ↓
if missing:
    search capability catalog
  ↓
load schema / promote capability
  ↓
call
```

If an MCP server already exposes its own low-token router such as `find_tool` + invocation meta-tools, Casper should recognize and prefer that surface.

For a generic MCP server that exposes 200 normal tools, Casper should build its **own local index** and expose only the relevant subset.

## Best skill-engine idea

Both HPE MCP branches independently reinforce progressive skill loading.

Casper skill context should be:

```text
startup:
  name + one-line description + tags

task:
  select likely skills

execution:
  load full SKILL.md only when needed
```

Do not inject 100 runbooks into a system prompt.

## Best GreenCLI ideas

Casper's MCP subsystem should inherit the operational lessons:

- support `stdio` and Streamable HTTP;
- tolerate one broken MCP without breaking Casper;
- detect dead servers;
- reconnect with bounded retry/circuit behavior;
- refresh tools after `tools/list_changed`;
- normalize tool-name collisions safely;
- keep secrets out of renderer/UI state;
- write credential/config data atomically;
- make read vs write consequences visible.

These are generic developer-tool behaviors, not networking-specific features.

---

# 8B. Pika Decision — Explicitly Excluded

Pika should **not** be part of Casper's runtime or repository workflow.

The comparison surfaced one useful concept from the newer HPE MCP branch:

```text
project declares:
- canonical checks
- project conventions
- what "verified" means
```

Casper should implement that directly.

Example:

```yaml
# .casper/project.yaml

verify:
  typecheck: "bun run check"
  test: "bun test"
  build: "bun run build"

rules:
  - "do not edit generated files"
  - "prefer existing dependencies"
```

That is enough.

Casper does **not** need:

- a separate verification kernel;
- profile-pack locks;
- task leases;
- repository claim/ownership semantics;
- a second workflow engine;
- a separate evidence database just to run tests;
- Pika as an execution dependency.

Rule:

> **Verification must reduce uncertainty, not create another layer that can fail independently of the project.**

---

# 8C. Generic Core, Personal Profile

Casper should be usable by other people, but optimizing the default design around real workflows is still valuable.

The right boundary is:

```text
Casper Core
    generic

Casper Profile
    user-specific

Project Config
    repo-specific
```

Example:

```text
~/.casper/
├── config.yaml
├── profiles/
│   ├── default/
│   └── stephen/
│       ├── rules.md
│       ├── skills/
│       ├── references.yaml
│       └── mcp.json
```

Your profile can prioritize:

```text
HPE Networking MCP
Mist knowledge
networking skills
MCP authoring patterns
your preferred coding behavior
your reference repos
```

Another developer can use Casper without seeing any of that.

The product should default to `default`, while your machine can select `stephen` automatically through local configuration.

Do not hard-code your domain into the binary.

Do not weaken Casper for hypothetical users either.

Build the generic abstraction once, then make your profile excellent.

---

# 9. Casper Architecture

Recommended destination architecture:

```text
casper/
│
├── src/
│   ├── app/
│   │   ├── bootstrap.ts
│   │   ├── lifecycle.ts
│   │   └── runtime.ts
│   │
│   ├── runtime/
│   │   ├── types.ts
│   │   └── pi.ts
│   │
│   ├── project/
│   │   ├── inspector.ts
│   │   ├── model.ts
│   │   ├── repo-map.ts
│   │   └── cache.ts
│   │
│   ├── profiles/
│   │   ├── loader.ts
│   │   ├── merge.ts
│   │   └── schema.ts
│   │
│   ├── context/
│   │   ├── engine.ts
│   │   ├── relevance.ts
│   │   └── budget.ts
│   │
│   ├── skills/
│   │   ├── registry.ts
│   │   ├── discovery.ts
│   │   ├── selector.ts
│   │   └── trust.ts
│   │
│   ├── capabilities/
│   │   ├── broker.ts
│   │   ├── registry.ts
│   │   ├── search.ts
│   │   ├── exposure.ts
│   │   ├── safety.ts
│   │   └── result-bounds.ts
│   │
│   ├── mcp/
│   │   ├── discovery.ts
│   │   ├── manager.ts
│   │   ├── index.ts
│   │   └── adapters.ts
│   │
│   ├── verify/
│   │   ├── verifier.ts
│   │   ├── checks/
│   │   ├── evidence.ts
│   │   └── repair-loop.ts
│   │
│   ├── visualize/
│   │   ├── types.ts
│   │   ├── router.ts
│   │   ├── mindmesh.ts
│   │   ├── mermaid.ts
│   │   └── graphviz.ts
│   │
│   ├── memory/
│   │   ├── project.ts
│   │   ├── outcomes.ts
│   │   └── references.ts
│   │
│   ├── agents/
│   │   ├── explorer.ts
│   │   └── reviewer.ts
│   │
│   ├── tui/
│   │   ├── app.ts
│   │   ├── banner.ts
│   │   ├── status.ts
│   │   └── tool-view.ts
│   │
│   └── cli/
│       └── main.ts
│
├── docs/
├── tests/
└── package.json
```

This is a **destination map**, not a request to scaffold 40 files immediately.

The architectural dependency direction should stay:

```text
TUI
 ↓
Casper Core
 ↓
Project / Policy / Skills / Capabilities
 ↓
AgentRuntime
 ↓
OMP or Pi
```

Never let application logic start importing OMP internals from all over the codebase.

Only runtime adapters should know the runtime deeply.

---

# 10. Casper Startup Flow

When `casper` starts:

```text
1. Resolve cwd + Git root
2. Load selected Casper profile
3. Determine repository trust
4. Load project rules/config
5. Restore cached Project Model
6. Refresh only stale deterministic project facts
7. Start Pi-backed AgentRuntime
8. Start LSP if applicable
9. Discover skill metadata
10. Discover MCP definitions
11. Connect only useful/required MCPs lazily
12. Build capability index
13. Restore lightweight project/session memory
14. Render ghost + concise status
15. Accept input
```

Important: do not make startup wait on every external integration.

Borrow the best behavior from OMP/GreenCLI:

```text
fast interactive startup
+ late MCP registration
+ partial failures tolerated
+ reconnect when needed
```

The prompt should appear quickly even if one MCP server is down.

The startup status can evolve as capabilities become ready:

```text
mcp  2 ready · 1 connecting
lsp  ready
```

instead of blocking the whole app.

---

# 11. Project Model

This is one of Casper's most important pieces.

Casper should maintain a compact machine-readable understanding of every project.

Example:

```json
{
  "schemaVersion": 1,
  "project": {
    "name": "example",
    "root": "/Projects/example",
    "git": true
  },
  "languages": ["typescript"],
  "frameworks": ["react", "tauri"],
  "packageManager": "pnpm",
  "commands": {
    "test": "pnpm test",
    "lint": "pnpm lint",
    "typecheck": "pnpm tsc --noEmit",
    "build": "pnpm build"
  },
  "architecture": {
    "components": "src/components",
    "services": "src/services",
    "state": "src/store",
    "tests": "tests"
  },
  "conventions": [
    "services own external API calls",
    "UI does not call MCP directly"
  ]
}
```

Possible storage:

```text
.casper/project.json
```

or, preferably for generated/cache information:

```text
~/.casper/projects/<project-id>/project.json
```

Keep **user-authored project rules inside the repo**, while generated/cache data can live outside it.

Recommended project-local files:

```text
.casper/
├── project.yaml
├── rules.md
├── skills/
└── mcp.json
```

---

# 12. Project Inspection

Casper should inspect high-signal files first.

Examples:

```text
package.json
pnpm-lock.yaml
bun.lock
pyproject.toml
uv.lock
Cargo.toml
go.mod
Dockerfile
docker-compose.yml
README.md
AGENTS.md
tsconfig.json
vite.config.*
next.config.*
.github/workflows/
src/
tests/
```

Use three discovery layers.

## Layer 1 — deterministic

No model needed.

Detect:

- languages;
- manifests;
- package manager;
- test frameworks;
- build tools;
- obvious frameworks;
- repository root;
- monorepo layout.

## Layer 2 — structural

Use file tree + symbol/index information to infer:

- component boundaries;
- service layers;
- API clients;
- database code;
- test organization.

## Layer 3 — model-assisted

Ask a model only for architectural observations that deterministic analysis cannot reliably make.

Cache the result.

---

# 13. Context Engine

Casper should **never dump the whole repository into the model**.

The context engine chooses what Pi sees.

Sources may include:

```text
current request
project model
project rules
relevant skills
repo-map results
LSP symbols
recent edits
test failures
selected source files
MCP result summaries
project memory
```

Context selection should be task-driven.

Example:

```text
User:
add disconnect support to Mist clients

Casper selects:
- task text
- Mist/MCP skill
- project rules
- relevant MCP tool implementation
- API client abstraction
- matching tests
- existing error handling
```

Not:

```text
entire source tree
+ entire API documentation
+ every skill
+ every MCP tool description
```

This is critical for speed.

---

# 14. Custom Skills

Skills are first-class, but they must stay cheap.

Casper should use an Agent Skills-compatible layout wherever possible:

```text
~/.casper/skills/
└── mcp-tool-authoring/
    ├── SKILL.md
    ├── examples/
    └── references/
```

Project skills:

```text
.casper/skills/
```

Casper should also be able to discover compatible skills already present for other harnesses instead of forcing migration.

## Skill metadata

Use small metadata that supports matching:

```yaml
---
name: mcp-tool-authoring
description: Build or modify MCP tools with bounded output and safe schemas.
tags:
  - mcp
  - tools
stacks:
  - typescript
  - python
intents:
  - add-tool
  - modify-tool
---
```

Domain-specific skills may add their own metadata:

```yaml
platforms:
  - mist
tools:
  - find_tool
  - invoke_read_tool
```

Unknown metadata should be preserved rather than rejected.

## Progressive disclosure

Borrow the best pattern from both HPE MCP branches and OMP:

```text
startup
  ↓
index:
  name
  description
  tags
  source
  trust

task arrives
  ↓
rank candidates
  ↓
load only selected SKILL.md bodies
```

A skill list response should normally contain summaries, not multi-paragraph instructions.

Suggested default:

```yaml
skills:
  maxActive: 6
```

This is a soft limit.

## Skill selection signals

Use:

```text
task text
project stack
changed/relevant files
project type
capabilities present
skill tags
previous successful use
explicit project/user preference
```

Do not rely only on keyword matching forever, but deterministic metadata matching is a good first implementation.

## Skills may recommend capabilities

A skill can state:

```text
recommended tools:
- Mist MCP
- browser
- LSP
```

That is a hint to the capability broker.

It is **not permission**.

The capability broker independently decides what can be exposed or called.

## Skill trust

Keep skills inspectable and source-aware.

Initial sources:

```text
builtin
user
project
compatible external harness directories
explicit external imports
```

External/untrusted content should not silently become always-on instructions.

## Personalized skill packs

Your profile can auto-prefer networking/MCP skills.

This remains profile behavior, not Casper core behavior.

---

# 15. Skills vs Capabilities

Keep a hard conceptual distinction.

## Skill

Teaches Casper **how** to do something.

Examples:

```text
mist-api
mcp-tool-authoring
react-ui
fastapi-patterns
hpe-networking
debugging
```

## Capability

Allows Casper to **actually perform** an action.

Examples:

```text
filesystem
shell
git
LSP
browser
Mist MCP
HPE Networking MCP
GitHub
```

A Markdown skill should never silently grant permissions.

Example:

```text
Mist skill
      +
Mist MCP capability
      =
Casper understands Mist and can act on Mist
```

This separation is worth preserving from the security philosophy used in SkyN3t.

---

# 16. Skill Trust

Suggested levels:

```text
builtin
trusted
project
reviewed-external
untrusted
blocked
```

For external skill repositories:

1. fetch;
2. record source/revision;
3. inspect;
4. install as untrusted;
5. user explicitly promotes;
6. only then include automatically.

Do not reproduce SkyN3t's entire evidence system initially.

A simple provenance record is enough:

```json
{
  "name": "some-skill",
  "source": "github.com/example/repo",
  "revision": "commit-sha",
  "trusted": true,
  "reviewedAt": "..."
}
```

---

# 17. MCP Architecture

MCP is a first-class Casper subsystem, but the model should **not receive the full MCP universe**.

This is one of the clearest lessons from both current HPE Networking MCP branches.

## 17.1 Connection layer

Reuse the underlying runtime's mature MCP transport/lifecycle where possible.

Casper needs:

- stdio;
- Streamable HTTP;
- authentication/header support;
- connection status;
- reconnect;
- `tools/list_changed`;
- cancellation;
- teardown;
- partial-server failure tolerance.

GreenCLI and OMP both provide strong reference behavior here.

## 17.2 Capability Broker

Casper adds a layer above raw MCP connections:

```text
MCP servers
    ↓
discover tools
    ↓
normalize metadata
    ↓
local capability index
    ↓
task-aware search
    ↓
small exposed tool set
```

This should be generic.

### Example

Three MCPs expose 340 combined tools.

The model might initially receive:

```text
read
edit
bash
grep
lsp
find_capability
mist_get_site_events
```

not all 340 schemas.

## 17.3 Prefer server-native routing when available

If an MCP exposes a low-token router such as:

```text
find_tool
invoke_read_tool
invoke_tool
```

Casper should detect that and prefer it instead of flattening the backend catalog.

That directly captures one of the strongest design decisions in `secure-ssid/hpe-networking-mcp`.

## 17.4 Generic servers

If the MCP exposes normal individual tools only:

1. ingest metadata locally;
2. build a lexical/semantic index;
3. rank tools for the task;
4. expose selected direct tools;
5. keep `find_capability` available for recovery.

This generalizes the HPE tool-RAG design for any MCP.

## 17.5 Tool metadata

Normalize tools into a shared shape:

```ts
interface CapabilityDescriptor {
  id: string;
  source: string;
  name: string;
  description: string;
  tags: string[];
  safety: "read" | "diagnostic" | "write" | "destructive" | "exec";
  schemaRef: string;
}
```

Do not copy large schemas into the always-on index.

Load schemas on demand.

## 17.6 Read/write separation

Borrow the safety separation from both HPE MCP implementations.

Casper should know whether a capability is:

```text
read
diagnostic
write
destructive
exec
external-action
```

Default policy can then say:

```text
read/diagnostic      allow
workspace write      allow or configured
exec                 configurable
destructive          prompt
external consequential action  prompt
```

Project/user policy can tighten this.

## 17.7 Bounded tool results

Borrow the response-budget concept from `secure-ssid/hpe-networking-mcp`.

Every capability result should be able to return:

```text
summary
bounded items
truncated: true/false
continuation/artifact reference
metadata
```

Do not pour multi-megabyte API responses into model context.

For generic tools that return too much data, Casper may store the raw result as an artifact and pass a compact summary/reference to the agent.

## 17.8 Continuation

For read-only large results, support safe pagination/continuation.

The exact cursor mechanism can vary by provider.

Casper's normalized result can look like:

```json
{
  "items": [],
  "truncated": true,
  "next": "opaque-continuation-id"
}
```

Do not provide generic continuation semantics for destructive operations.

## 17.9 Tool-name collisions

Borrow GreenCLI's lesson:

```text
server A: status
server B: status
```

must not silently overwrite.

Create stable internal IDs such as:

```text
mcp:mist:status
mcp:github:status
```

The provider-facing name may be shortened/sanitized, but Casper retains an exact resolver map.

## 17.10 MCP configuration

Support:

```text
~/.casper/mcp.json
.casper/mcp.json
mcp.json
.mcp.json
```

and import existing compatible configuration from popular tools where practical.

Do not require users to re-enter working MCP configuration just to use Casper.

---


# 17A. Visualization / MindMesh

Visualization is a **capability category**, not a special Casper mode.

Define a generic interface:

```ts
type VisualizationType =
  | "mindmap"
  | "architecture"
  | "dependency-graph"
  | "flowchart"
  | "troubleshooting-tree"
  | "plan";

interface VisualizationProvider {
  supports(type: VisualizationType): boolean;
  render(input: VisualizationInput): Promise<VisualizationResult>;
}
```

Providers:

```text
MindMeshProvider
MermaidProvider
GraphvizProvider
```

MindMesh can be your preferred interactive provider.

Fallback behavior:

```text
MindMesh available?
  yes → interactive MindMesh
  no  → Mermaid/Graphviz output
```

## Generic graph IR

Do not make Casper's reasoning output depend directly on MindMesh's file format.

Use a small intermediate representation:

```json
{
  "type": "mindmap",
  "title": "Authentication Architecture",
  "nodes": [
    {"id": "auth", "label": "Authentication"},
    {"id": "ui", "label": "UI"}
  ],
  "edges": [
    {"from": "ui", "to": "auth"}
  ]
}
```

Render that through the selected provider.

## Coding uses

Casper should be able to visualize:

```text
repository architecture
module dependencies
MCP tool organization
feature plans
refactor scope
authentication flow
data flow
test/verification flow
troubleshooting decision tree
```

Examples:

```text
> map out this repo
> show me the auth flow as a mind map
> visualize the MCP architecture before we change it
```

Visualization is read-only by default.

A visual plan does not automatically authorize code changes.

---

# 18. Model Routing

Model selection should mostly disappear from the normal user experience.

Casper defines roles:

```yaml
models:
  fast:
    provider: auto
    model: fast-default

  build:
    provider: auto
    model: coding-default

  reason:
    provider: auto
    model: reasoning-default

  review:
    provider: auto
    model: reasoning-default
```

Task router maps work to roles.

Example:

```text
repo exploration   → fast
small edit          → build
feature             → build
architecture        → reason
difficult debugging → reason
review              → review
```

The user can override models when desired.

Do not build a complex model tournament initially.

---

# 19. Build/Change Contract

Borrow the useful idea from SkyN3t without a heavy implementation. This is Casper-owned runtime state—not Pika, not a second workflow engine.

Before a substantial task, Casper forms a small task contract:

```json
{
  "intent": "feature",
  "goal": "add SSO",
  "constraints": [
    "preserve existing auth API",
    "do not replace React router"
  ],
  "expectedAreas": [
    "src/auth",
    "src/services"
  ],
  "verification": [
    "typecheck",
    "tests",
    "build"
  ]
}
```

This contract prevents architectural drift.

Do not expose this every time unless useful.

It is mostly runtime state.

---

# 20. Main Task Lifecycle

Default workflow:

```text
UNDERSTAND
    ↓
DISCOVER
    ↓
SELECT CONTEXT
    ↓
SELECT SKILLS
    ↓
SELECT CAPABILITIES
    ↓
DECIDE WHETHER PLAN IS NEEDED
    ↓
IMPLEMENT
    ↓
VERIFY
    ↓
REPAIR IF NEEDED
    ↓
REVIEW DIFF
    ↓
REPORT
```

Small changes may skip explicit planning.

Large architectural changes should have a plan.

The runtime—not the model alone—should own the state transitions.

Suggested states:

```ts
type TaskState =
  | "understand"
  | "discover"
  | "plan"
  | "implement"
  | "verify"
  | "repair"
  | "review"
  | "complete"
  | "blocked";
```

---

# 21. Verification

This is one of the most valuable lessons from SkyN3t, but Casper should implement it **without Pika**.

The rule is simple:

> **A model statement is not verification.**

Casper determines applicable checks from:

```text
explicit .casper/project.yaml
package/project manifests
known framework conventions
task type
user instruction
```

Potential checks:

```text
syntax
lint
typecheck
unit tests
targeted tests
build
boot/smoke
HTTP health
CLI invocation
LSP diagnostics
MCP protocol check
browser interaction
```

Each returns structured evidence:

```ts
interface VerificationResult {
  name: string;
  status: "pass" | "fail" | "skip";
  command?: string;
  exitCode?: number;
  evidence?: string;
  durationMs?: number;
}
```

Rules:

- `skip` is never converted to `pass`;
- missing optional tooling should be visible;
- project-native commands win over Casper guesses;
- run targeted checks first when useful;
- run broader gates before declaring completion for substantial changes;
- verification should be independently executable outside the model.

## Project verification config

Keep it tiny:

```yaml
verify:
  typecheck: bun run check:types
  lint: bun run lint
  test: bun test
  build: bun run build
```

No lock packs or external verification kernel are required.

## Runtime integration

Pi supplies the execution loop; Casper owns the verification policy and invokes project-native commands through normal tools. OMP may be consulted as a design reference for diagnostics or tooling behavior, but is not required at runtime.

---

# 22. Repair Loop

If verification fails:

```text
verification failure
       ↓
compact evidence
       ↓
Pi receives exact failure
       ↓
repair
       ↓
rerun affected checks
```

Default:

```yaml
repair:
  maxAttempts: 3
```

The repair prompt should include:

- exact failing command;
- error output;
- related changed files;
- relevant diagnostics;
- original task constraint.

It should **not** resend the entire original context unless needed.

---

# 23. LSP

LSP should be a core Casper capability after the first basic runtime is working.

Casper should use it for:

- diagnostics after writes;
- symbol lookup;
- go-to-definition;
- references;
- rename;
- workspace symbols;
- code actions.

High-value behavior:

```text
write file
  ↓
LSP diagnostics
  ↓
if new error introduced:
    repair before moving on
```

This can reduce the test/fix cycle substantially.

Do not couple Casper to one language server implementation.

Use adapters.

---

# 24. Debugger

Target for v2.

Create a common debugger interface:

```ts
interface DebugAdapter {
  launch(...)
  attach(...)
  setBreakpoint(...)
  continue(...)
  stepOver(...)
  stack(...)
  variables(...)
  evaluate(...)
}
```

Support high-value languages first.

Potential order:

```text
Node/TypeScript
Python
Go
Rust/C/C++ later
```

Do not make debugger support block Casper v1.

---

# 25. Subagents

Casper supports subagents only where delegation adds value.

Initial roles:

```text
explorer
reviewer
```

Later:

```text
debugger
tester
researcher
```

Keep agent descriptions task-focused.

Example:

```ts
delegate({
  role: "explorer",
  goal: "Find the complete authentication flow and return relevant files only",
  readOnly: true
});
```

Explorers should usually be read-only.

Multiple writing agents require isolated worktrees.

---

# 26. Worktree Isolation

Borrow one of SkyN3t's strongest operational patterns.

For risky/parallel changes:

```text
main workspace
    ↓
temporary Git worktree
    ↓
agent modifies candidate
    ↓
verify
    ↓
review diff
    ↓
merge/apply
```

Do not require worktrees for every tiny edit.

Suggested policy:

```yaml
workspace:
  isolateWhen:
    parallelAgents: true
    riskyRefactor: true
    experimentalBranch: true
```

---

# 27. Session Tree

Casper should expose session branching cleanly.

Commands:

```text
/tree
/branch <name>
/switch <branch>
```

Potential TUI:

```text
Session
● main
├─ auth-experiment
├─ react-query-refactor
└─ new-mcp-layout
```

Branching should preserve:

- conversation history;
- task contract;
- relevant project context;
- workspace branch/worktree relation where applicable.

---

# 28. Memory

Use several small, inspectable memory types rather than one giant magic memory system. Do not copy OMP-style autonomous memory merely because it exists; Casper should start with explicit project/outcome memory and add automation only after it proves useful.

## Session memory

Current conversation/task.

## Project memory

Stable facts about one repository.

Examples:

```text
uses pnpm
API calls belong in services/
Vitest is the test runner
don't call MCP directly from React components
```

## Personal build preferences

How you generally want Casper to work.

## Lessons

Evidence from previous tasks.

Keep memory inspectable.

Suggested location:

```text
~/.casper/
├── preferences.yaml
└── projects/
    └── <id>/
        ├── project.json
        ├── memory.jsonl
        └── outcomes.jsonl
```

---

# 29. Learning

Do **not** begin with autonomous prompt rewriting.

Start with evidence.

For each completed task record:

```json
{
  "task": "add MCP tool",
  "skills": [
    "typescript",
    "mcp-tool-authoring"
  ],
  "verification": {
    "tests": "pass",
    "typecheck": "pass"
  },
  "repairAttempts": 1,
  "accepted": true
}
```

Over time, Casper can answer:

```text
Which skills correlate with successful MCP work?
Which verifier catches most regressions?
Which project patterns are repeatedly reused?
Which routing decisions are wasting time?
```

Then Casper can propose changes.

Human approval comes before modifying important global policies.

---

# 30. Reusing Knowledge From Existing Projects

Existing repositories should become a **reference corpus**, not a source-code blender.

Casper can learn from:

```text
SkyN3t
both HPE Networking MCP branches
GreenCLI
CasperCloud
MindMesh
future projects
```

The extraction target is reusable patterns:

```text
problem
context
pattern
why it worked
tradeoffs
evidence/files
when to use
when not to use
```

Example:

```yaml
name: low-token-mcp-routing
source:
  repo: secure-ssid/hpe-networking-mcp
summary: >
  Keep the model-facing MCP surface small and discover tools lazily.
use_when:
  - server exposes many tools
avoid_when:
  - server already exposes only a handful of tools
```

## Promotion flow

Future command:

```bash
casper learn ~/Projects/some-repo
```

Casper produces candidates:

```text
✓ MCP result bounding
✓ atomic configuration write
✓ reconnect circuit behavior
✓ verification command pattern
? project-specific business logic
```

Candidates do not become global rules automatically.

Promotion options:

```text
reference only
project skill
global skill
ignore
```

## Use current repo state as authority

Reference projects are examples, not truth.

If a current project uses a different architecture, Casper follows the current project unless explicitly asked to migrate.

---

# 31. Reference Projects

Some projects should remain references rather than becoming skills.

Example profile configuration:

```yaml
references:
  skyn3t:
    repo: Choaterboater/skyn3t-2-0
    useFor:
      - verification
      - repair-loops
      - project-detection

  hpe-mcp-router:
    repo: secure-ssid/hpe-networking-mcp
    useFor:
      - tool-discovery
      - bounded-results
      - workflow-skills

  hpe-mcp-registry:
    repo: nowireless4u/hpe-networking-mcp
    useFor:
      - tool-registry
      - write-gating
      - skill-engine

  greencli:
    repo: Choaterboater/GreenCli
    useFor:
      - mcp-lifecycle
      - reconnect
      - credential-handling
      - confirmation-ux

  mindmesh:
    repo: Choaterboater/mindmesh
    useFor:
      - mindmaps
      - architecture-visualization

  caspercloud:
    repo: Choaterboater/CasperCloud
    useFor:
      - companion-ux
      - future-rpc-client
```

Reference retrieval should return small, relevant excerpts/summaries.

Do not inject whole repositories.

## Access note

If a reference repo is unavailable/private on a machine, Casper degrades cleanly.

References must never be required for normal core operation.

---

# 32. Profiles and Global Policy

Use profiles so Casper can be excellent for you without becoming HPE-specific for everyone.

Suggested layout:

```text
~/.casper/
├── config.yaml
├── profiles/
│   ├── default/
│   │   └── config.yaml
│   └── stephen/
│       ├── config.yaml
│       ├── rules.md
│       ├── skills/
│       ├── references.yaml
│       └── mcp.json
```

Example core/global configuration:

```yaml
behavior:
  autonomy: high
  askQuestions: onlyWhenBlocked
  inspectBeforeEditing: true

code:
  reuseExistingPatterns: true
  preserveArchitecture: true
  avoidOverengineering: true
  avoidUnnecessaryDependencies: true
  preferSmallChanges: true

verification:
  runAvailableTests: true
  runTypecheck: true
  runLint: true
  reviewDiff: true
  repairFailures: true
  maxRepairAttempts: 3

git:
  commit: neverUnlessRequested
  push: neverUnlessRequested
  confirmDestructive: true

skills:
  autoSelect: true
  maxActive: 6

capabilities:
  exposeMinimalSurface: true
  resultMaxBytes: 100000

mcp:
  autoDiscover: true
  connectMode: lazy

runtime:
  provider: pi

models:
  defaultRole: build
```

Your profile may add:

```yaml
skills:
  prefer:
    - mcp-tool-authoring
    - hpe-networking
    - mist-api

references:
  enabled: true

mcp:
  prefer:
    - hpe-networking
    - mist
```

These are profile preferences, not product assumptions.

---

# 33. Policy Precedence

Use predictable precedence:

```text
Casper safe defaults
        ↓
global config
        ↓
selected profile
        ↓
project policy
        ↓
project rules
        ↓
task contract
        ↓
current explicit user instruction
```

Safety restrictions cannot be bypassed by lower-level configuration.

---

# 34. TUI

Casper should feel polished without becoming an IDE clone.

Core layout:

```text
┌ Casper status ───────────────────────────────────┐
│ project · branch · model · skills · MCP · LSP   │
└──────────────────────────────────────────────────┘

conversation/tool stream

> input
```

Tool calls should be compact.

Example:

```text
✓ read  src/auth/session.ts
✓ grep  "refreshToken"
✓ edit  src/auth/session.ts      +18 -4
✗ test  npm test                 1 failed
↻ repair
✓ test  npm test                 42 passed
✓ build npm run build
```

Allow expansion when needed.

Do not print huge raw command logs by default.

---

# 35. Core Commands

Keep slash commands small.

Initial set:

```text
/help
/project
/skills
/mcp
/model
/verify
/diff
/tree
/branch
/reload
```

Potential later commands:

```text
/debug
/learn
/memory
/extensions
```

Normal work should not require commands.

---

# 36. Extension API

Casper extensions should build on Pi extensions where possible.

Casper-specific APIs can provide higher-level primitives:

```ts
casper.registerVerifier(...)
casper.registerProjectDetector(...)
casper.registerCapabilityProvider(...)
casper.registerSkillSource(...)
casper.registerContextProvider(...)
casper.registerVisualizationProvider(...)
```

An extension may expose Pi tools internally without requiring Casper to reinvent the lower-level interface.

Example:

```ts
export default function mistExtension(casper: CasperExtensionAPI) {
  casper.registerCapabilityProvider({
    name: "mist",
    ...
  });
}
```

---

# 37. Security & Trust

Casper will execute code. Trust must be explicit.

Repository state:

```text
untrusted
trusted
```

Before trust:

- inspect limited metadata;
- do not execute repository scripts;
- do not load project extensions;
- do not automatically run skill helper scripts.

After trust:

- normal tooling enabled according to policy.

Protect high-risk paths:

```text
.env
credentials
SSH keys
cloud credentials
production config
```

Destructive operations should require explicit confirmation unless the user has deliberately configured otherwise.

MCP server configuration should also have trust status.

---

# 38. Performance

Casper must feel faster than a heavy orchestration platform.

Rules:

### Lazy initialization

Do not start everything at startup.

### Tool minimization

Expose relevant tools only. Build a local capability index so MCP servers with hundreds of tools do not become hundreds of prompt schemas.

### Skill progressive disclosure

Only metadata initially.

### Project caching

Do not rebuild the entire repo model every session.

### Incremental indexing

Use Git/file hashes.

### Compact tool results

Avoid flooding context with shell output.

### Fast model for exploration

Use expensive reasoning only when useful.

### No automatic council

One agent by default.

---

# 39. Observability

Keep it simple and useful.

Track:

```text
task duration
model calls
tool calls
tokens if available
skills selected
MCP tools used
verification results
repair attempts
files changed
errors
```

Local logs:

```text
~/.casper/logs/
```

Project/task trace should be inspectable but not forced into the normal TUI.

Potential command:

```text
casper trace last
```

---

# 40. Recommended Implementation Phases

## Phase 0 — Pi runtime spike

Goal: prove Casper can own the UX/control layer while using Pi as a normal dependency.

Build:

- new Casper TypeScript/Bun repo;
- Pi dependency pinned to a tested version;
- `AgentRuntime` interface;
- `PiRuntime` adapter;
- compact ghost banner;
- cwd/Git detection;
- one normal coding prompt;
- event streaming into Casper's TUI.

Acceptance:

```text
casper
> fix this failing test
```

Casper can read/edit/run through Pi while the user only sees Casper.

Do not implement MCP broker, LSP, memory, subagents, or learning yet.

---

## Phase 1 — Casper-owned project/profile layer

Build:

- profile loader;
- project rules;
- deterministic stack detection;
- project model/cache;
- task classification;
- minimal policy merge.

Acceptance:

Casper can state:

```text
project
stack
package manager
build/test commands
selected profile
```

without rediscovering everything every turn.

---

## Phase 2 — Skills

Build:

- global/project skill discovery;
- compatible external skill discovery where useful;
- metadata index;
- task ranking;
- full body on demand;
- skill trust/source info.

Acceptance:

A TypeScript MCP task loads only relevant skill bodies.

---

## Phase 3 — Verification + repair

Build:

- Casper verifier registry;
- typecheck/lint/test/build adapters;
- evidence model;
- repair loop;
- concise TUI results.

Acceptance:

Casper encounters a real type/test failure, feeds exact evidence back into Pi, repairs it, and reruns checks.

No Pika.

---

## Phase 4 — MCP capability broker

Build:

- MCP connection/config support;
- normalize tool metadata;
- build local capability index;
- task-aware tool ranking;
- selective direct exposure;
- discovery fallback;
- result bounding;
- read/write safety classification;
- `/mcp` status.

Study OMP and GreenCLI for lifecycle/reconnect behavior.

Acceptance:

Connect a large HPE MCP catalog and prove the model receives a small surface while still finding less-common tools when needed.

Test both:

```text
secure-ssid router-style MCP
generic individual-tool MCP
```

---

## Phase 5 — LSP

Study OMP's implementation, then build the smallest Casper-owned LSP layer needed for:

- diagnostics after edits;
- symbols;
- definitions;
- references;
- rename.

Acceptance:

A repository-wide rename succeeds through language-aware operations and finishes without new diagnostics.

---

## Phase 6 — Visualization

Build:

- generic graph IR;
- `VisualizationProvider`;
- Mermaid fallback;
- MindMesh adapter.

Acceptance:

```text
> map out the authentication flow
```

produces a useful visual without affecting the code workspace.

---

## Phase 7 — Sessions/branches/worktrees

Add:

- named session branches;
- safe experiment worktrees;
- return-to-main workflow.

Study OMP's session design but keep Casper's implementation narrow.

---

## Phase 8 — Bounded subagents

Add only:

```text
explorer
reviewer
```

first.

Explorer should default read-only.

---

## Phase 9 — Memory/reference learning

Build:

- explicit project facts;
- task outcomes;
- reference-project search;
- `casper learn`;
- human promotion.

---

## Phase 10 — Debugger and richer clients

Later:

- DAP/debugger workflows;
- CasperCloud SDK/RPC client;
- richer browser verification;
- collaborative/remote use if valuable.

---

# 41. Features After v1

Once the main loop is excellent:

```text
debugger/DAP
browser testing
desktop integration
voice
visual diff
GitHub workflow integration
CI verification
remote sessions
shared sessions
plugin marketplace
reference-project retrieval
skill generator
skill evaluation
```

Treat each as independent.

---

# 42. Suggested v1 Boundary

A strong Casper v1 is:

```text
Casper TUI
+ Pi runtime adapter
+ project model
+ profiles/policy
+ progressive custom skills
+ verification/repair
+ MCP capability broker
+ LSP
+ MindMesh/Mermaid visualization
```

Do **not** delay v1 for:

```text
large multi-agent swarm
advisor model
automatic prompt mutation
Pika
Best-of-N
full debugger
desktop app
deployment platform
automatic policy evolution
```

The key v1 differentiator is:

> **Casper gives a small Pi runtime much better project context, smarter capability selection, and proof-oriented execution.**

---

# 43. Initial Repository Structure

Start small:

```text
casper/
├── src/
│   ├── cli.ts
│   ├── app.ts
│   │
│   ├── runtime/
│   │   ├── types.ts
│   │   └── pi.ts
│   │
│   ├── project/
│   │   ├── inspect.ts
│   │   └── model.ts
│   │
│   ├── config/
│   │   ├── load.ts
│   │   └── profile.ts
│   │
│   └── tui/
│       └── banner.ts
│
├── docs/
│   ├── CASPER_PLAN.md
│   └── IMPLEMENTATION_PLAN.md
├── tests/
├── package.json
└── tsconfig.json
```

Do not scaffold directories for features that do not exist yet.

---

# 44. First 10 Engineering Tasks

1. Create the new `casper` repository.
2. Use Bun/TypeScript.
3. Add Pi as a pinned dependency.
4. Define the small `AgentRuntime` interface.
5. Implement `PiRuntime`.
6. Create the `casper` CLI entry point.
7. Add the chosen compact ghost banner without redesigning it.
8. Detect cwd, Git root, branch, and basic project type.
9. Run one complete read/edit/test task through Casper.
10. Add an integration test using a tiny fixture repository.

Then **stop and use it**.

Before adding more subsystems, answer:

```text
Does Casper feel fast?
Is Pi easy to wrap cleanly?
Can Casper control context/tool exposure?
Can we intercept the events we need?
Can Pi be upgraded without touching the rest of Casper?
```

If yes, continue.

If no, fix the runtime boundary before adding more layers.

Do not solve runtime-boundary problems by forking Pi prematurely.

---

# 45. Second Engineering Slice

Build:

1. profile loader;
2. project model/cache;
3. `.casper/project.yaml`;
4. `.casper/rules.md`;
5. skill registry;
6. skill metadata ranking;
7. selected-skill injection;
8. first Casper verifier commands.

This is the first point where Casper becomes meaningfully different from running OMP directly.

---

# 46. Third Engineering Slice

Build the **capability broker**:

1. MCP config discovery;
2. reuse runtime MCP manager/lifecycle;
3. normalize tool metadata;
4. local search/index;
5. selective tool exposure;
6. router-style MCP detection;
7. safety classification;
8. result bounding;
9. tool-name collision resolver;
10. `/mcp` status.

Test with both HPE Networking MCP branches because they exercise different exposure styles.

---

# 47. Fourth Engineering Slice

Then add:

1. LSP policy/integration polish;
2. diagnostics after edits;
3. visualization IR;
4. Mermaid fallback;
5. MindMesh provider;
6. session branching;
7. optional worktree isolation.

After this slice, evaluate whether bounded subagents are actually needed.

---

# 48. Evaluation Suite

Casper needs its own tests for agent behavior.

Create fixture repositories:

```text
fixtures/
├── react-app/
├── fastapi-app/
├── typescript-mcp/
├── python-cli/
└── broken-project/
```

Evaluation tasks:

```text
add API endpoint
fix failing test
rename symbol
add React component
add MCP tool
repair type error
find bug without editing
respect project rule
avoid unnecessary dependency
```

Measure:

```text
task success
verification success
number of model calls
number of files touched
repair attempts
context tokens
wall-clock time
```

This replaces vague impressions with evidence.

---

# 49. Casper Design Rules

These should live near the top of the repository.

## Rule 1

**The runtime is replaceable; Casper owns the experience and policy.**

## Rule 2

**Project understanding before broad context dumping.**

## Rule 3

**Load knowledge on demand.**

## Rule 4

**Skills teach. Capabilities act.**

## Rule 5

**Large tool catalogs are indexed, not dumped into context.**

## Rule 6

**Proof beats self-reporting.**

## Rule 7

**Repair from evidence.**

## Rule 8

**One primary agent by default.**

## Rule 9

**Advanced features must justify their complexity.**

## Rule 10

**Keep Casper inspectable.**

## Rule 11

**Do not rebuild SkyN3t or Pika inside Casper.**

---

# 50. Decision Checklist for New Features

Before adding a feature, ask:

```text
Does this improve normal coding work?
Can this be an extension instead of core?
Does Pi already provide this?
Does OMP already provide this through its SDK?
Did one of the HPE MCPs or GreenCLI already solve the low-token/lifecycle problem?
Did SkyN3t already teach us a failure mode here?
Are we accidentally recreating Pika-like orchestration?
Will this add permanent context or tool overhead?
Can we measure whether this helps?
```

If a feature adds significant architectural complexity without a measurable workflow improvement, postpone it.

---

# 51. How Casper Fits With CasperCloud

Casper and CasperCloud should remain separate products/components.

Casper:

```text
coding companion engine
TUI/CLI
SDK/RPC
project intelligence
skills/capabilities
```

CasperCloud:

```text
desktop companion
ambient/promptless UX
possible Casper client
other MCP/product workflows
```

Potential relationship:

```text
Casper
  ├─ TUI
  ├─ SDK
  └─ RPC
       │
       ▼
CasperCloud
```

OMP already has an RPC mode worth studying for this boundary.

Do not couple Casper core to Tauri, a desktop UI, or CasperCloud state.

CasperCloud should be able to consume Casper later rather than Casper requiring CasperCloud.

The CasperCloud repository was not fully inspectable through the connected GitHub source during this design pass, so this plan intentionally relies only on its known role as a desktop companion and keeps the integration boundary loose.

---

# 52. Recommended Technology Choices

Initial recommendation:

```text
Language             TypeScript
Runtime              Bun
Agent runtime         Pi SDK/package
Runtime abstraction  AgentRuntime
Config               YAML + JSON
Schema validation    Zod/TypeBox-compatible
TUI                  Casper-owned views over Pi events
Storage              JSON/JSONL initially
Git                  native git/tool wrapper
Skills               Agent Skills-compatible SKILL.md
MCP                   Casper-owned broker/client layer
LSP                   Casper-owned, informed by OMP
Visualization         generic graph IR + MindMesh/Mermaid adapters
Verification          plain commands + structured Casper evidence
```

Why Bun/TypeScript:

- fast startup;
- good fit for terminal tooling;
- easy extension/tool authoring;
- keeps Casper close to the Pi ecosystem.

Do not add a database until memory/index requirements justify one.

Do not add Pika.

Do not add OMP as a runtime dependency.

Do not add a vector database just to implement first-pass tool selection. Start with metadata + lexical search and add embeddings only if evals prove they help.

---

# 53. Naming Internals

Externally everything is **Casper**.

Internal names should remain descriptive.

Good:

```text
ProjectModel
SkillRegistry
CapabilityRegistry
ContextEngine
Verifier
RepairLoop
ModelRouter
MCPManager
LSPManager
```

Avoid cute ghost names for architectural components.

The mascot can be playful; the codebase should remain obvious.

---

# 54. Documentation To Create Early

```text
README.md
docs/ARCHITECTURE.md
docs/PRINCIPLES.md
docs/SKILLS.md
docs/MCP.md
docs/PROJECT_MODEL.md
docs/VERIFICATION.md
docs/ROADMAP.md
docs/DESIGN_CORPUS.md
docs/SKYNET_LESSONS.md
docs/PERSONAL_PROFILES.md
```

`SKYNET_LESSONS.md` should explicitly document lessons from SkyN3t so future changes do not accidentally recreate the same complexity.

---

# 55. `SKYNET_LESSONS.md` Suggested Outline

```text
Things that worked
- deterministic verification
- repair loops
- project detection
- skills
- repo maps
- isolation
- evidence

Things that became expensive
- too many interacting subsystems
- large orchestration surfaces
- complex autonomous loops
- difficulty understanding why a decision was made

What Casper does differently
- runtime adapter owns the Pi/OMP boundary
- no Pika workflow layer
- one main agent
- small state machine
- progressive skills
- dynamic capabilities
- deterministic verification
- explicit feature boundaries
```

---

# 56. Target User Experience

Eventually the ideal session should feel like this:

```text
        <ghost>

          CASPER
    your coding companion

 project   mist-mcp
 stack     TypeScript
 branch    feature/events
 skills    typescript · mcp · mist-api
 mcp       Mist ✓ · 7/143 tools exposed
 lsp       TypeScript ✓

> add a tool that returns recent site events

Casper:
  inspecting existing tool patterns...
  found 3 related tools
  using existing pagination/error conventions

  ✓ added src/tools/site-events.ts
  ✓ registered tool
  ✓ added tests
  ✓ typecheck
  ✓ 48 tests passed

  Changed 3 files. No new dependencies.

>
```

The user did **not** need to say:

```text
Use the Mist MCP.
Read the tool directory.
Follow existing conventions.
Don't add dependencies.
Write tests.
Run typecheck.
Use TypeScript.
Keep output bounded.
```

Casper already knew.

That is the product.

---

# 57. Definition of Success

Casper succeeds when:

1. You can open almost any repository and start useful work immediately.
2. Prompts stay short because Casper understands the project.
3. The core stays generic while profiles make it excellent for specific users.
4. Skills load progressively instead of bloating every prompt.
5. Large MCP catalogs remain usable without flooding model context.
6. MCP crashes/reconnects do not take Casper down.
7. Verification catches false "done" claims without a second verification framework.
8. Repair loops use exact evidence.
9. LSP makes edits language-aware.
10. MindMesh/visualization can explain systems without being coupled to coding logic.
11. Pi remains a small runtime dependency rather than becoming Casper's product identity.
12. Casper can upgrade Pi with minimal changes because runtime-specific code remains isolated.
13. SkyN3t lessons improve the system without recreating SkyN3t complexity.
14. Your networking/MCP workflow is excellent through your profile while a new user gets a clean generic product.

---

# 58. Recommended First Milestone

Do not begin by implementing the entire document.

The first milestone is:

```text
casper
  ↓
compact ghost banner
  ↓
detect project + branch
  ↓
load profile
  ↓
start Pi through AgentRuntime
  ↓
perform a real code change
  ↓
run a real project check
  ↓
show concise result
```

This milestone answers the most important architectural question:

> **Can Casper stay clean and independent while Pi handles only the underlying agent loop?**

If yes, proceed to project intelligence, skills, verification, and capability routing.

If no, adjust the adapter or request/add a small Pi hook.

Do not jump directly to a fork.

---

# 59. Immediate Build Order

Use this order:

```text
01  new Casper repo
02  Bun + TypeScript scaffold
03  add Pi dependency
04  AgentRuntime interface
05  PiRuntime adapter
06  Casper TUI shell
07  exact chosen ghost/banner placeholder
08  project/Git detection
09  one end-to-end coding task
10  profile/config loader
11  project model/cache
12  skill discovery + progressive loading
13  verification
14  repair loop
15  MCP client/config discovery
16  capability broker / tool index
17  result bounding + safety classification
18  LSP
19  visualization IR
20  MindMesh adapter + Mermaid fallback
21  session branching/worktrees
22  bounded explorer/reviewer subagents
23  project/reference memory
24  `casper learn`
25  debugger
26  CasperCloud/RPC integration
```

Explicitly **not** in the initial chain:

```text
Pi fork
OMP runtime dependency
Pika
Cortex
Best-of-N
advisor-on-every-turn
automatic policy mutation
large swarm
```

Do not jump from step 5 to step 22.

---

# 60. Source Notes / Current References

This revision incorporates the current design patterns observed in the following repositories and documentation.

## OMP

- `can1357/oh-my-pi`
- SDK
- MCP lifecycle/config
- skills/context discovery
- tool approval
- session/RPC architecture
- LSP/DAP/subagent capabilities

Key conclusion:

**Use OMP as reference material only. Study its implementation when Casper reaches features such as LSP, DAP, MCP lifecycle, sessions, or subagents.**

## Pi

Pi is Casper's primary runtime dependency.

Key conclusion:

**Use Pi through a thin adapter. Do not fork it unless a proven limitation eventually leaves no better option.**

## `secure-ssid/hpe-networking-mcp`

Important patterns reviewed:

```text
semantic find_tool routing
minimal/default/direct exposure modes
invoke_read_tool vs invoke_tool
bounded response items/bytes
read-only continuation cursors
skill search/load
optional platform/toolset gating
```

Key conclusion:

**Generalize low-token tool routing into Casper's Capability Broker.**

## `nowireless4u/hpe-networking-mcp`

Important patterns reviewed:

```text
dynamic per-platform tool registry
safety/capability classification
write gates
skill metadata summaries
on-demand skill load
code-mode sandbox ideas
best-effort platform startup/health
```

Key conclusion:

**Use the registry/safety/skill-loading concepts, not HPE-specific architecture.**

## GreenCLI

Important patterns reviewed:

```text
stdio + HTTP MCP client
request correlation
dead-server detection
reconnect behavior
tool-list refresh
tool-name collision handling
atomic config writes
secret storage
provider-neutral tool plumbing
confirmation UX
```

Key conclusion:

**Use these lessons for Casper's client robustness and operator UX.**

## SkyN3t

Important patterns reviewed:

```text
deterministic proof
repair
worktree isolation
approval boundaries
project/stack detection
retries/idempotency
learning/reference patterns
```

Key conclusion:

**Carry the lessons, not the factory/orchestration architecture.**

## Pika

The newer HPE MCP branch contains a repository-contract/verification approach associated with Pika.

Decision:

**Pika is explicitly excluded from Casper.**

Keep only the simple concept of declaring project-native verification commands.

## MindMesh

User-defined role:

```text
mind maps
architecture diagrams
visual system breakdowns
planning/troubleshooting trees
```

Decision:

**Integrate through a generic VisualizationProvider with a neutral graph IR.**

## CasperCloud

User-defined role:

```text
desktop companion with MCP
```

Decision:

**Treat as a future Casper client/integration through SDK/RPC, not a dependency of Casper core.**

The linked CasperCloud and MindMesh repositories were not fully available through the connected GitHub installation during this comparison, so no unverified implementation claims from those repos are used here.

---

# Final Direction

The final runtime decision is intentionally unambiguous:

```text
                            👻 CASPER

                     Casper-owned product layer
                                │
        ┌───────────────────────┼────────────────────────┐
        │                       │                        │
   Project Model              Skills              Profile/Policy
        │                       │                        │
        └───────────────────────┼────────────────────────┘
                                │
                         Context Engine
                                │
                       Capability Broker
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
       Local tools             MCP                  Visual
                                                 MindMesh/etc.
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                │
                         AgentRuntime
                                │
                             Pi SDK
                                │
                            Workspace
                                │
                       Casper Verification
                                │
                       pass ↙        ↘ fail
                          done       repair
                                       │
                                       └──→ Pi
```

The decisions are:

```text
Fork Pi?          NO
Use Pi?           YES
Use OMP as base?  NO
Fork OMP?         NO
Study OMP?        YES
Use Pika?         NO
```

The role of each source is:

**Pi supplies the small agent runtime.**

**Casper owns project intelligence, policy, skills, capability routing, verification, visualization, and UX.**

**OMP is a reference implementation for advanced features.**

**The HPE MCP projects teach Casper how to scale large tool catalogs without drowning the model.**

**GreenCLI teaches Casper robust MCP lifecycle and operator UX.**

**SkyN3t teaches Casper verification, repair, and what complexity to avoid.**

**MindMesh gives Casper visual reasoning/output through a generic provider interface.**

**CasperCloud can consume Casper later through an SDK/RPC boundary.**

**Pika is not part of the architecture.**

And the core rule is:

> **Build Casper around Pi, not inside Pi.**
