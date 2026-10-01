# Bundled skills

These `SKILL.md` files are built into the `casper` binary (text imports in
`src/skills/bundled.ts`). They load only when a request picks them; see
[docs/SKILLS.md](../docs/SKILLS.md). Each file is still a normal Agent Skill: other tools ignore the
`casper-skill` block.

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

## Changing a skill

1. Edit the file and bump `casper-skill.version`.
2. Put the new version and the file's SHA-256 in `skills/network/VERSIONS.json`
   (`sha256sum skills/network/<platform>/SKILL.md`).
3. Run `bun test tests/network-skills-lint.test.ts tests/network-skills-pick.test.ts`. Add a
   prompt to `tests/fixtures/network-skills/prompts.json` when you change triggers.

A new platform also needs an import in `src/skills/bundled.ts` and a name in `NETWORK_PLATFORMS`.
