# Bundled skills

These `SKILL.md` files are built into the `casper` binary (text imports in
`src/skills/bundled.ts`). They load only when a request picks them; see
[docs/SKILLS.md](../docs/SKILLS.md). Each file is still a normal Agent Skill: other tools ignore the
`casper-skill` block.

## Rules for a web skill (`skills/web/<name>/SKILL.md`)

- `name` starts with `web-`; `description` is one line of at most 200 characters; the body is at
  most 6 KiB. The loader refuses anything else.
- Guidance only: it never tells the AI to install a package or add a design system, and it says
  the repo's own style wins. `scoreWebSkill` in `src/skills/bundled.ts` picks it (UI work in a
  project with no styles yet); `tests/web-skill.test.ts` checks the text and the picking.
- Casper's own words. Borrow an idea only from a source whose licence allows it, and credit it here.

## Rules for a network skill (`skills/network/<platform>/SKILL.md`)

The loader refuses a file that breaks the first group, so a broken skill is a test and build
failure. `tests/network-skills-lint.test.ts` checks the rest.

Loader:

- `name` starts with `network-`; `description` is one line of at most 200 characters.
- A `casper-skill` block: `platform` (mist, central, central-classic, aoscx, junos, clearpass),
  `triggers.strong` (at least one), optional `triggers.weak` and `triggers.unless`, `frameworks`,
  `version`.
- Triggers are never common words (api, site, switch, device, token, config, network, cloud,
  wifi, aruba, juniper, hpe …). "central" may only be a weak trigger.
- The body is at most 6 KiB (6144 bytes).
- Exactly these `##` sections, in this order: When to use · Sign-in and tokens · Read first ·
  Changing things (Casper asks) · Paging and rate limits · Common traps · Testing with saved sample
  data · Public docs.
- "Changing things (Casper asks)" opens with these two lines:
  `MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.`
  `Casper also asks before a shell command reaches a new host.`
- Never: "secure", "guarantee(d)", "read-only", "read only", "safe to run", "harmless",
  "cannot change", "won't change".

Lint:

- "Read first" names at least one call that asks for data. No call or login is ever called
  read-only or safe: only the product's own access check decides what a token may do.
- Write calls (`POST`, `PUT`, `PATCH`, `DELETE`, commit, load, reboot, zeroize …) appear only under
  "Changing things", each on a `WRITE:` line or in a code block whose first line is `# WRITE`. A
  sign-in POST (token, login, logout) may appear under "Sign-in and tokens".
- Credentials come from environment variables only. Placeholders only: `<org_id>`, `<site_id>`,
  `<switch>`, `<clearpass>`, `00000000-0000-0000-0000-000000000000`, `*.example.com`, IPs from
  192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24. No real hostnames, tokens, serials or org IDs.
- Links are `https://` on public doc hosts (vendor docs, the vendors' GitHub orgs, PyPI, RFCs);
  at least two under "Public docs". No relative links: a bundled skill has no folder on disk.
- Only public vendor docs and public SDK repositories. Nothing internal, no customer data. A
  fact you could not check says "check the current docs".
- Plain short words for a network engineer.

## Rules for a home lab skill (`skills/homelab/<name>/SKILL.md`)

Picked and checked by the same code as a network skill; it shares the limit of two per request.
`tests/homelab-skills.test.ts` checks the rest.

- `name` starts with `homelab-`; one-line `description` of at most 200 characters; body at most 6 KiB.
- `casper-skill.platform`: media, docker, proxmox or nettrouble. Strong triggers are product names only (radarr,
  jellyfin, plex, gluetun, proxmox, pvesh, vzdump, compose stack, traceroute, tcpdump, nslookup …). Never a common word (docker,
  compose, container, vm, lxc, storage, backup, media, vpn, server, stack, restart …). `docker`, `qm`
  and `pct` may only be weak triggers; so is `docker compose`, which ordinary app work names too. A weak trigger needs one of the skill's own
  `triggers.context` words (or "home lab", "self hosted") in the same request.
- Exactly these `##` sections, in this order: When to use · Read first · Changing things (Casper
  asks) · Common traps · Public docs. "Changing things" opens with the same two lines as a network
  skill, and the same overclaiming words are refused.
- "Read first" names status and list calls (`/api/v3/health`, `docker compose ps`, `pvesh get`,
  `qm list`, `ip route`, `ss -tlnp` …). A change command (restart, `up -d`, `qm stop`, `vzdump`, a route, firewall or DNS change, any `POST`/`PUT`/`DELETE`
  call) appears only under "Changing things", on a `WRITE:` line or in a `# WRITE` block, with a
  snapshot or saved copy first and the undo line. qBittorrent's login POST may sit under "Read first".
- Keys and tokens from environment variables only. Placeholders only (`<vmid>`, `<container>`,
  `<pve_host>`, 192.0.2.x, `*.example.com`; the well-known 127.0.0.11, 127.0.0.53 and 1.1.1.1 may be named). Links are `https://` official docs (wiki.servarr.com,
  jellyfin.org, support.plex.tv, docs.docker.com, pve.proxmox.com, pbs.proxmox.com, man7.org, tcpdump.org, the nftables wiki, curl.se, RFCs, the projects'
  own GitHub repos), at least two under "Public docs".

## Rules for a design skill (`skills/design/<platform>/SKILL.md`)

A method for designing or reviewing a deployment (today: ClearPass NAC). Picked and checked by the same code as a
network skill; it shares the limit of two per request. `tests/design-skills.test.ts` checks the rest.

- `name` starts with `design-`; one-line `description` of at most 200 characters; body at most 6 KiB.
- `casper-skill.platform`: clearpass-nac. Strong triggers are product-plus-topic phrases ("clearpass nac",
  "network access control"). Never a common word (design, architecture, plan, review, guest, iot, byod, radius,
  802.1x, certificate, policy …). "clearpass", "cppm" and "nac" may only be weak triggers: they need a design
  word (design, architecture, rollout, deployment, migration, pilot, sizing …) in the same request. `unless`
  keeps API work (api, python, script, pyclearpass) with the network skill.
- Exactly these `##` sections, in this order: When to use · Intake questions · Design order · Diagrams · Common
  traps · Public docs. No "Changing things": a design skill teaches the order of work and changes nothing. The
  same overclaiming words are refused.
- The method, not product facts the model already knows. Generic examples only: no customer, company, site,
  host, SSID or person names. A trap you could not check against public docs is phrased without a number.
- Diagrams go through Casper's `visualize` tool (see docs/VISUALIZATION.md for its input).
- Links are `https://` on official vendor doc hosts, at least two under "Public docs".

## Changing a skill

1. Edit the file and bump `casper-skill.version`.
2. Put the new version and the file's SHA-256 in `skills/network/VERSIONS.json`,
   `skills/homelab/VERSIONS.json` or `skills/design/VERSIONS.json` (`sha256sum skills/<family>/<name>/SKILL.md`).
3. Run `bun test --parallel tests/network-skills-lint.test.ts tests/network-skills-pick.test.ts
   tests/homelab-skills.test.ts tests/design-skills.test.ts`. Add a prompt to `tests/fixtures/network-skills/prompts.json`,
   `tests/fixtures/homelab-skills/prompts.json` or `tests/fixtures/design-skills/prompts.json` when you change triggers.

A new platform also needs an import in `src/skills/bundled.ts` and a name in `NETWORK_PLATFORMS`,
`HOMELAB_PLATFORMS` or `DESIGN_PLATFORMS`.
