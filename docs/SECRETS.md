# Secrets Casper hides from the AI

**What this is.** Device configs are full of secrets: login passwords, RADIUS and
TACACS keys, Wi-Fi PSKs, SNMP communities. Casper swaps each one it recognises for
`<secret hidden>` before the AI reads the text, and tells the AI how many it hid.

**When it matters.** Any time the AI reads a config: from an MCP server (Central,
Junos, Oxidized and so on), from a `.cfg` backup on disk, or from a command such as
`cat router.conf`. It is on by default. You don't need to set anything up.

```text
set system root-authentication encrypted-password "<secret hidden>"
3 secrets hidden before the AI saw this (passwords, keys, SNMP communities).
```

This hides **known secret formats**, not every secret. Unusual formats
(EdgeConnect, ClearPass XML exports, JSON with odd key names) can still get
through. Check what a tool returns before you share it.

## What is scrubbed

"Scrubbed" means Casper replaced the secret values with `<secret hidden>`.

- **MCP results: always.** Every result from an MCP server is scrubbed before it
  is cut to size and before the AI sees it. Text blocks that hold JSON are opened,
  scrubbed and written back as JSON. JSON values are hidden when their key looks
  like a secret:
  - keys such as `password`, `passwd`, `passphrase`, `psk`, `secret`, `community`,
    `api_key`, `access_token`, `refresh_token`, `client_secret`, `private_key` and
    `wpa_passphrase`;
  - any key ending in `_password`, `_secret`, `_psk`, `_passphrase` or `_community`;
  - device keys such as `pre_shared_key`, `tacacs_key`, `radius_key`, `wep_key` and
    `secret_key`;
  - login tokens (`token`, `api_token`, `bearer_token`).

  `next_cursor`, `cursor`, `list_key`, `key`, `public_key`, paging tokens
  (`next_token`, `page_token`) and anything under `_pagination` are left alone, so
  paging keeps working. The result says `secretsHidden: N`.
- **Files you or the AI read: config files only.** A `read` is scrubbed for `.cfg`,
  `.conf` and `.set` files, and for files under a folder named `configs`, `backups`
  or `oxidized`. Source code and data files (`.ts`, `.py`, `.json`, `.yaml`, `.md`
  and so on) are never changed, even under those folders, so test files stay as
  they are.
- **Command and grep output: only when it looks like a config.** Output from
  `bash`, `powershell` or `grep` (failed commands too) is scrubbed when it has two
  config lines such as `hostname`, `version 23.4;`, `## Last commit` or
  `interface 1/1/1`, or any line that clearly carries a secret
  (`snmp-server community X`, `wpa-passphrase X`, a PEM private key). When a command
  prints a lot, Pi (the agent engine Casper runs on) saves the whole output to a
  `pi-bash-<id>.log` (or `pi-powershell-<id>.log`) file; reading that file back gets
  the same check. Other `.log` files are left alone.
- **Subagents** (`/delegate`, or the AI's delegate tool) get the same scrubbing for
  what they read.
- **Reference search excerpts** (`/references search`, `search_references`) are
  scrubbed with Casper's own rules (not netconan). A line that only matches inside
  a hidden secret is not returned. See [REFERENCES.md](REFERENCES.md).

The note `N secrets hidden before the AI saw this (...)` is added to the result the
AI reads.

## What is hidden, per platform

Casper keeps the words around the secret, so the AI still sees what kind of line it
is. Only the value is replaced.

| Platform | Hidden |
| --- | --- |
| AOS-CX | The value after `plaintext` or `ciphertext` on password and key lines (user passwords, RADIUS/TACACS keys, SNMPv3 `auth-pass`/`priv-pass`, NTP, OSPF and BGP keys), `snmp-server community X` |
| AOS 8 / Instant | `wpa-passphrase`, `wpa-hexkey`, `key` lines inside an `aaa authentication-server radius`/`tacacs` (or `wlan auth-server`) block, `mgmt-user` hashes, `ipsec` keys on `masterip`/`localip` lines, SNMPv3 `auth-prot`/`priv-prot` passwords |
| AOS-S | `password manager`, `operator` or `port-access` values after `plaintext`, `sha1` or `sha-256`, `radius-server host ... key X`, `snmp-server community X` |
| Junos (set and curly) | `encrypted-password`, `simple-password`, `authentication-key`, `authentication-password`, `privacy-password`, `pre-shared-key`, `md5 N key`, SNMP community names, and any `$9$...` value anywhere |
| Cisco IOS / NX-OS / ASA | `enable secret` and `enable password`, `username ... secret` or `password`, `snmp-server community`, SNMPv3 `auth`/`priv`, `key-string`, `crypto isakmp key`, `pre-shared-key`, `message-digest-key`, `ntp authentication-key`, `wpa-psk`, `standby ... authentication`, `passwd` |
| Any | PEM private keys; the word after `password`, `secret` or `passwd` at the start of a line or after a space (common words like `manager` or `none` are skipped); `$1$`/`$2a$`/`$5$`/`$6$`/`$8$`/`$y$` hashes after a password, secret or hash word |

Left as they are, on purpose: `******`, SSH public keys, certificates, and
hpe-networking-mcp's own `hpe_mcp_secret_<32 hex>` tokens. That server swaps those
tokens back for the real value itself, so the AI can pass one back to it. They are
**not hidden from device writes**; that is how the server is designed.

## The AI can't send a hidden secret back

The AI never saw the real value, so it must not write the marker over it. Casper
refuses any of these that still contain `<secret hidden>` (or
`<line hidden: secret>`, see netconan below):

- An MCP call whose arguments contain it is refused before you are asked:
  `Not executed (this change still has <secret hidden> in it). Casper hid that
  secret from the AI, so the AI can't send it back. Type the real value yourself or
  leave that line out.`
- An `edit` or `write` whose new text contains it is refused: `Not written: the new
  text has <secret hidden> in it. That would replace a real secret in the file.
  Keep the original line.` (The old text an edit looks for may contain it; only new
  text counts.)
- A `bash` or `powershell` command that contains it is refused: `Not run: the
  command has <secret hidden> in it. It could write the marker over a real secret.
  Keep the original line, or ask the user to make this change.`

A shell command can still change a config file in other ways (for example a script
that writes a file from scratch). These checks stop the marker itself, not every
rewrite. The check is a plain text match, so it also stops an edit to a source file
that only mentions the marker text, or a shell command such as
`grep "<secret hidden>" notes.txt`.

## netconan: an extra check, not the main one

[netconan](https://github.com/intentionet/netconan) is a free tool that hides
secrets in network configs. When it is installed, Casper also runs `netconan -p` on
text that looks like a config (up to 2 MiB, and at most 4 config texts per
result).

- It runs in a private temporary folder that is removed afterwards. The config
  text is never passed on the command line.
- Casper's own rules always run first, on the original text. netconan misses Aruba
  formats (it left AOS-CX `ciphertext` values, AOS 8 `wpa-passphrase` and
  `mgmt-user` hashes in place when tested).
- netconan can only add markers. Its made-up replacement values never reach the AI.
  A line it removed or rewrote becomes `<line hidden: secret>`.
- `CASPER_NETCONAN=off` turns it off. `CASPER_NETCONAN=/path/to/netconan` picks a
  program. Otherwise Casper looks for `netconan` on your `PATH`.
- If netconan fails or takes longer than 10 seconds, Casper's own result is used,
  and both the result note and `/secrets` say
  `netconan did not finish; built-in scrub used.`

To install it: `pip install netconan` (or `pipx install netconan`).

## Commands

```text
/secrets
Secrets: hidden in MCP results (always). Files and command output: on. Extra check: netconan not found (built-in only).

/secrets files off
Files and command output: off for this session. MCP results are still scrubbed.

/secrets files on
Files and command output: on.
```

When netconan is found, the first line ends with `Extra check: netconan <version> (found).`

Only you can type these; the AI has no way to turn scrubbing off. MCP results are
always scrubbed. `/secrets files off` lasts until you turn it on again or restart
Casper.

## Limits

- Scrubbing works line by line on known formats. It is best effort: a secret in a
  format Casper doesn't know reaches the AI.
- The approval box, `/mcp` and server questions mask secrets on your screen, but
  the server still gets the real value you approve.
- Secrets the AI already had (for example ones you typed in a request, or ones in a
  file that is not a config file) stay in the conversation and the saved session
  like any other text.
- `/secrets files off` turns file and command scrubbing off for subagents too.
- `casper learn` reads repo text without this scrubbing.
- If the check itself fails on a tool's output, the AI gets `Output not shown:
  Casper could not check it for device secrets. Try a smaller read or another
  command.` instead of the raw text.
