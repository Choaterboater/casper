# Skills and the network skills pack

A skill is a short how-to file the AI reads only when a request needs it. Casper ships six network
skills inside the `casper` binary, and you can add your own.

The network skills pack is new in v0.2.18; releases before it have no bundled skills.
Your own skills work the same way in both; see [CONFIGURATION.md](CONFIGURATION.md#skills).

## The network skills pack

| Skill | Covers |
| --- | --- |
| `network-mist-api` | Juniper Mist cloud API: tokens, cloud hosts, org and site IDs, paging, 429 backoff, webhooks, `mistapi` |
| `network-central-api` | New HPE Aruba Networking Central (GreenLake sign-in): client credentials, monitoring and config paths, scopes, pycentral 2.x |
| `network-central-classic-api` | Classic Central API gateway: access and refresh tokens, `monitoring/v2/aps` style paths, offset paging, rate-limit headers |
| `network-aoscx-rest` | AOS-CX switch REST API: login and logout, REST version in the path, `depth`/`attributes`/`selector`, checkpoints, pyaoscx, Ansible |
| `network-junos-pyez` | Junos with PyEZ and NETCONF: facts, RPCs, tables, `\| display set`, lock, diff, `commit check`, `commit confirmed`, rollback |
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
  - or a change request (add, fix, test, set up) with a network word in a project whose Python
    packages include the SDK (`mistapi`, `pycentral`, `pyaoscx`, `pyclearpass`, `junos-eznc`,
    `ncclient`), or an Ansible collection Casper already detects.
- Examples: "list APs per site in Mist" picks the Mist skill; "commit confirmed on an MX" picks
  Junos; "Central device inventory" picks both Central skills (each says how to tell which Central
  you have). "fix the css", "add a mist effect to the landing page css" and "fix the central
  logging config" pick nothing.

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
loading off, bundled ones included. `/status` shows `skills    6 indexed (6 bundled)` or
`bundled: off`.

## Add your own

Put a `SKILL.md` in its own folder:

- `~/.casper/skills/<name>/SKILL.md`: yours, trusted.
- `<project>/.casper/skills/<name>/SKILL.md`: the project's, used only after `/skills inspect` and
  `/skills trust <id> <sha256>`.

```markdown
---
name: lab-mist-naming
description: Our naming rules for Mist sites and APs.
tags: [mist, naming]
---
Site names are <city>-<building>. AP names are <site>-ap<nn>.
```

Your own skills load next to the bundled ones, ranked as described in
[CONFIGURATION.md](CONFIGURATION.md#skills). To use the stricter network picking rule, copy the
`casper-skill` block from a bundled skill into your front-matter.

**Replacing a bundled skill.** A skill in `~/.casper/skills/` with the same name as a bundled one
(for example `network-mist-api`) is used in its place only while it keeps the same eight sections in
order, opens "Changing things" with the stop-and-ask line and the "Casper also asks" line, and uses
none of the words the pack avoids ("read-only", "safe to run", "guaranteed" …). If it drops any of
that, Casper uses the bundled text and `/skills diagnostics` says why. A project's same-name skill
never replaces a bundled one, even after `/skills trust`.

## Writing or changing a bundled skill

The rules are in [skills/README.md](../skills/README.md). The tests in
`tests/network-skills-lint.test.ts` check each file (layout, 6 KiB cap, links, placeholders, no
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
