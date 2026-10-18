# Skills and the network skills pack

A skill is a short how-to file the AI reads only when a request needs it. Casper ships six network
skills, four home lab skills, one design skill and two frontend skills inside the `casper` binary, and you can add your own.

The network skills pack is new in v0.2.18; releases before it have no bundled skills.
Your own skills work the same way in both; see [CONFIGURATION.md](CONFIGURATION.md#skills).
Skills someone else wrote can come as a pack you add with `/pack add`; see [PACKS.md](PACKS.md).

## The network skills pack

| Skill | Covers |
| --- | --- |
| `network-mist-api` | Juniper Mist cloud API: tokens, cloud hosts, org and site IDs, paging, 429 backoff, webhooks, `mistapi` |
| `network-central-api` | New HPE Aruba Networking Central (GreenLake sign-in): client credentials, monitoring and config paths, scopes, pycentral 2.x |
| `network-central-classic-api` | Classic Central API gateway: access and refresh tokens, `monitoring/v2/aps` style paths, offset paging, rate-limit headers |
| `network-aoscx-rest` | AOS-CX switch REST API: login and logout, REST version in the path, `depth`/`attributes`/`selector`, checkpoints and `checkpoint auto`, pyaoscx, Ansible, one test switch first |
| `network-junos-pyez` | Junos with PyEZ and NETCONF: facts, RPCs, tables, `\| display set`, lock, diff, `commit check`, `commit confirmed`, rollback, one test device first |
| `network-clearpass-api` | ClearPass Policy Manager REST API: API clients, OAuth token, endpoints, sessions, guests, paging, CoA traps |

Every skill has the same eight parts, in this order: When to use · Sign-in and tokens · Read first ·
Changing things (Casper asks) · Paging and rate limits · Common traps · Testing with saved sample
data · Public docs.

What they teach, in short:

- **Read first.** The calls that ask for data come first (who am I, sites, device list, version).
  No skill calls any call or login read-only: only the product's own access check decides what a
  token or login may do.
- **Changes wait for you.** "Changing things" opens with one line: changes through an MCP server
  are asked in Casper's change box (the AI doesn't ask again in chat); anything else that changes a
  device (scripts, playbooks, shell) stops and asks you first, with the exact call. Every change call is marked `WRITE:`. The
  AI is told to GET the object first, show you the diff, and say how to undo.
- **Credentials from environment variables only**, never in code, output or saved samples.
- **Tests with saved sample data**, never live calls: pytest with `pytest-recording
  --record-mode=none`, `responses`, `respx`, or PyEZ tables reading saved XML. Recording happens
  once, by hand, with your OK, and the saved file is scrubbed and marked "Sample data, not from a
  real network".
- **No guessed numbers.** Where a limit or path could not be checked in public docs, the skill says
  "check the current docs".

What "Casper asks" means here: the shell sandbox asks before a shell command reaches a host you have
not allowed, and lab checks (`/verify <name>`) only run when you start them. Casper does not look at
HTTP methods, so once a host is allowed, it is the skill's own rule that makes the AI stop and ask
before a change.

## How the AI gets them

- **Zero tokens until a request needs one.** No skill text, list or description is in the prompt
  by default. Picking is a local word match: no model call, no network, no file read (the text is
  inside the binary).
- **When one is picked**, its body (at most 6 KiB, about 1,500 tokens) goes into that one request,
  and you see ` skills selected: network-mist-api`. The next request is picked again from scratch.
  At most two network skills go into one request.
- **What picks a skill:**
  - a product word: "mist api", "juniper mist", "mistapi", "aos-cx", "pyaoscx", "pyez",
    "commit confirmed", "clearpass", "cppm", "aruba central", "pycentral", "greenlake", "apigw" …;
  - or a looser word ("mist", "junos", "central", "cx", "display set", "commit check") together
    with a network word such as site, ap, switch, device, inventory, token, api, rest, python,
    script, netconf, rpc or playbook;
  - SDKs (`mistapi`, `pycentral`, `pyaoscx`, `pyclearpass`, `junos-eznc`, `ncclient`) and
    detected Ansible collections boost an already matching change request; the project's stack
    alone never selects a skill. Generic words such as config, token, python or script need a
    product/subject match too.
- Examples: "list APs per site in Mist" picks the Mist skill; "commit confirmed on an MX" picks
  Junos; "Central device inventory" picks both Central skills (each says how to tell which Central
  you have). "fix the css", "add a mist effect to the landing page css" and "fix the central
  logging config" pick nothing. A discussion of `ps` options and `git config` credential keys
  picks no networking skill, even in a Junos/Ansible project.

## See them, stop them, turn them off

```
/skills                             lists all skills; bundled ones show [bundled; trusted]
/skills inspect network-mist-api@bundled   prints the text
/skills block network-mist-api@bundled     never pick this one again
```

Turn the whole pack off in `~/.casper/config.yaml` or a profile:

```yaml
skills:
  bundled: false   # default true
```

A project's `.casper/project.yaml` cannot turn the pack off: the skills only make the AI more
careful, so a repository must not be able to remove them. `skills.maxActive: 0` turns all skill
loading off, bundled ones included. `/status` shows `skills    13 indexed (13 bundled)` or
`bundled: off`.

## The home lab skills

| Skill | Covers |
| --- | --- |
| `homelab-media-stack` | Radarr, Sonarr and the other *arr apps, Prowlarr, Plex, Jellyfin, Emby, qBittorrent, SABnzbd, NZBGet: status and health calls, one `/data` mount for hardlinks, PUID/PGID, remote path mappings, API keys, Gluetun and a VPN leak check |
| `homelab-docker-compose` | A Docker Compose health and drift sweep: `docker compose ps` and `config --quiet`, health checks, restart loops, `:latest` images that moved on, config hash drift, orphans, volumes and bind mounts, `.env` kept out of git, a rollback tag before an update |
| `homelab-proxmox` | Proxmox VE and Backup Server: `pvesh get /cluster/resources`, `qm list`, `pct list`, `pvesm status`, quorum, full storage, API tokens (`user@realm!name`, privilege separation), `qm snapshot`/`pct snapshot` before a change with the rollback line, vzdump and PBS |
| `homelab-network-troubleshooting` | Finding where traffic stops, one layer at a time: link and Wi-Fi, address and DHCP lease, gateway, DNS (local against public resolver, split DNS, Pi-hole/AdGuard), `traceroute`/`mtr`, listeners and ports (`ss -tlnp`, `nc -vz`, `Test-NetConnection`), TLS with `openssl s_client`, `curl -v`, MTU, firewall rules as reads, `tcpdump` only after asking, Docker networking; rules saved before a firewall, route or DNS change, with the undo line |

They are picked and limited the same way as the network skills (two per request, network and home
lab together), and their "Changing things (Casper asks)" part opens with the same stop-and-ask line.
They have five parts: When to use · Read first · Changing things (Casper asks) · Common traps · Public
docs. Only product and tool names pick them: "radarr won't import from qbittorrent", "check my proxmox cluster
for full storage", "my compose stack keeps restarting" and "traceroute shows packet loss" each pick one; "docker", "docker compose",
"qm" and "pct" count only next to a word such as unhealthy, restarting, drift, vm or lxc, so "write a
docker compose file for the api" or "show the cpu pct in the status bar" pick nothing. For the network
troubleshooting skill only tool names and plain symptoms pick it (traceroute, tcpdump, nslookup, mtu,
"dns not resolving", "no route to host"); "connection refused", "dns", "ping" and "mtu" count only next to
a word such as lan, router, firewall or vpn, and words such as parser, tests, component or websocket rule it
out, so "connection refused from postgres in the test", "parse tcpdump output into json" or "add DNS
records to the terraform" pick nothing. `/skills block homelab-proxmox@bundled`
stops one.

## The design skill

| Skill | Covers |
| --- | --- |
| `design-clearpass-nac` | A method for designing or reviewing a ClearPass NAC deployment: short intake questions, then the design document in order (current vs NAC state, device inventory, a decision tree with rule IDs and a default deny, one workflow per SSID or port with a fallback, use-case table, guest, IoT and BYOD registration, service order, cluster and platform, protocols and certificates, phased rollout with monitor mode first, day 2), flowcharts and an architecture diagram through the `visualize` tool, common traps |

A design skill teaches the order of work, not product facts, and changes nothing, so it has no
"Changing things" part. Its six parts: When to use · Intake questions · Design order · Diagrams · Common
traps · Public docs. It is picked and limited the same way as the network skills (two bundled skills per
request). "ClearPass NAC" and "network access control" pick it; "clearpass", "cppm" and "nac" count only next
to a word such as design, architecture, rollout, deployment, migration, pilot or sizing. Words such as api,
python, script or pyclearpass rule it out, and a clear design request ("design a ClearPass NAC for 3 sites with
guest and IoT") rules out `network-clearpass-api`, so API code and a design each get their own skill. "design a
NAC with Cisco ISE" picks nothing. `/skills block design-clearpass-nac@bundled` stops it.

## The frontend skills

Casper ships two: `web-frontend` gives a project with no look yet a deliberate one, and
`web-quality` holds the checks every page needs, in any project.

New in v0.2.23. `web-frontend` is Casper's own short guide to giving a page or app UI a deliberate
look: one type scale and spacing step, a few named colors with dark-mode values in one theme file,
real HTML elements, a 390px phone width first with a one-row header and a Menu button, and the focus
ring in the accent color.
It asks for a font pair and accent that suit the product (never Inter alone; the system stack is the
fallback), a page shape chosen before the code, its own image and action for each product or plan,
and cards whose prices and buttons line up in a row. For SVG it tells icons from illustrations: icons
use one stroke style and `currentColor` or the theme colors so they follow dark mode; an illustration
(hero, product, about art) is built back to front with one light from the top-left, a side and top face
for depth, soft shadows and a little real detail, `role="img"` with `<title>` and `<desc>`, and a
`viewBox`. For its materials the AI first reads `illustration-kit.svg`, a file shipped with the skill
(brushed steel, chrome, wood, ceramic, glass, paint, enamel, paper, stone and fabric, contact and cast
shadows, a glow, a sheen and brushed-metal and grain textures, each ready to copy). The kit is never in the
prompt: when the skill is picked, Casper writes it to a new temporary folder only you can open, names that
folder as the skill's base directory, and removes it when Casper exits. For photo-like images the skill
asks for `make_picture` when that tool is offered. The field labels, focus, 44px tap targets, 4.5:1
contrast, states and the list of what makes a page look machine-made are in `web-quality`, which
comes with it.

- **Picked only for UI work in a project with no look of its own yet:** a request with a web word
  (web app, website, landing page, html, css, navbar, frontend …), or, in a project with a web
  framework (React, Vue, Svelte, Vite, Next, Django, Flask …), a word such as page, form, layout,
  header, button or design, that isn't a question, in a project where Casper finds no styles,
  components or design folder and no styling package (Tailwind, styled-components, Emotion). In a
  Python, Ansible or Mist project, "add a header row to the CSV" or "fetch all pages from the API"
  doesn't pick it. When the project has a look, the repo's style always wins and the skill
  stays out (`web-quality` still comes). `casper new web-app` and `vite-react` start with a theme
  file, so they follow that.
- Zero tokens until picked; about 1,100 tokens when it is. It never installs anything or adds a
  design system.
- `/skills block web-frontend@bundled` stops it. A `web-frontend` skill in `~/.casper/skills/`
  (your house style) is used in its place.
- `web-frontend` is written for Casper; no text is copied from another skill.

### The quality checks: `web-quality`

New. `web-quality` holds the rules that hold whatever a page looks like, so it is picked for UI work
in **every** web project, including one with its own theme, components or Tailwind. It never gives
look advice (no type scale, palette, fonts or theme file): it says to keep the project's colours,
fonts, spacing and components, and to keep anything below the project's style already uses.

- **Refuse:** signs of a machine-made page: a small label (eyebrow) above a heading, 01 / 02 / 03
  on things that are not a sequence, a coloured side border over 1px, hard offset shadows, a 1px
  border under a wide soft shadow, monospace to look technical, cream with terracotta and
  near-black with acid green, gradient text, cards inside cards, purple gradients and glass,
  `transition: all`, gray text on a coloured background, lorem ipsum.
- **Verify:** rules you can check on the page: lines of 65 to 75 characters, more space above a
  heading than below, 4.5:1 contrast in light and dark, a visible focus ring, 44 by 44px tap
  targets that never overlap, no `user-scalable=no`, no sideways scroll at 390px, animations of
  `transform` and `opacity` only, tabs and filters kept in the URL, colour never alone.
- **Forms:** a visible label, 16px input text on phones, the right `type`, `autocomplete` and
  `inputmode`, paste never blocked, errors next to the field and focus on the first one on
  submit. Then real elements, alt text, and loading, empty and error states.
- **Picked by the same words as `web-frontend`** (a web word anywhere; page, form, layout, header,
  button or design only in a web-framework project; never for a question), but whether or not the
  project has a look. In a project with no look yet both come: `web-frontend` for the look,
  `web-quality` for the checks (about 1,100 and 950 tokens; the old single skill was about
  1,500). In a Tailwind or themed project only `web-quality` comes. Zero tokens until picked; it
  has no files.
- `/skills block web-quality@bundled` stops it; a `web-quality` skill in `~/.casper/skills/` is
  used in its place.
- Adapted and trimmed from [pbakaus/impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0),
  [anthropics/skills](https://github.com/anthropics/skills) frontend-design (Apache-2.0),
  [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) (MIT)
  and [jakubkrehel/make-interfaces-feel-better](https://github.com/jakubkrehel/make-interfaces-feel-better)
  (MIT), shortened and rewritten in Casper's words. The notices are in `THIRD_PARTY_NOTICES.txt`
  (`casper --licenses`).

## Add your own

Put a `SKILL.md` in its own folder:

- `~/.casper/skills/<name>/SKILL.md`: yours, trusted.
- `<project>/.casper/skills/<name>/SKILL.md`: the project's, used only after `/skills trust <id>`
  shows it and you pick `2 Trust it` (scripts can still pass the hash: `/skills trust <id> <sha256>`).

```markdown
---
name: lab-mist-naming
description: Our naming rules for Mist sites and APs.
tags: [mist, naming]
---
Site names are <city>-<building>. AP names are <site>-ap<nn>.
```

Your own skills load next to the bundled ones, ranked as described in
[CONFIGURATION.md](CONFIGURATION.md#skills). Words inside a link in your request (`https://…`, `github.com/owner/repo`)
don't count toward a skill's name, tags or description: a repository named `casper-network-mcp` doesn't pick a
skill tagged `mcp`. Keep tags specific; a word as broad as `mcp` matches more requests than you mean. To use the stricter network picking rule, copy the
`casper-skill` block from a bundled skill into your front-matter.

**Replacing a bundled skill.** A skill in `~/.casper/skills/` with the same name as a bundled one
(for example `network-mist-api`) is used in its place only while it keeps the same eight sections in
order, opens "Changing things" with the stop-and-ask line and the "Casper also asks" line, and uses
none of the words the pack avoids ("read-only", "safe to run", "guaranteed" …). If it drops any of
that, Casper uses the bundled text and `/skills diagnostics` says why. A project's same-name skill
never replaces a bundled one, even after `/skills trust`.

## Writing or changing a bundled skill

The rules are in [skills/README.md](../skills/README.md). The tests in
`tests/network-skills-lint.test.ts` (and `tests/homelab-skills.test.ts` and `tests/design-skills.test.ts` for the home lab and design skills) check each file (layout, 6 KiB cap, links, placeholders, no
secret-looking values, write calls only under "Changing things"), and
`tests/network-skills-pick.test.ts` checks which prompts pick which skill.

## Sources

The skills use only public vendor docs and public SDK repositories: aruba/pycentral (MIT),
aruba/pyaoscx (Apache-2.0), aruba/pyclearpass (MIT), aruba/aoscx-ansible-collection (Apache-2.0),
Juniper/py-junos-eznc (Apache-2.0), Juniper/ansible-junos-stdlib (Apache-2.0), mistsys/mist_openapi
(MIT) and tmunzer/mistapi_python (MIT). They state facts and short call names in their own words;
no text is copied. The vendor doc sites could not be opened while the pack was written, so every
number or path that could not be checked says "check the current docs". The product's own API
reference for your version is always the final word.
