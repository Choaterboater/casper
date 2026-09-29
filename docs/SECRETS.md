# Secrets Casper hides from the AI

Device configs are full of secrets: login passwords, RADIUS and TACACS keys,
Wi-Fi PSKs, SNMP communities. Casper swaps each one it recognises for
`<secret hidden>` before the AI reads the text, and tells the AI how many it hid:

```text
set system root-authentication encrypted-password "<secret hidden>"
3 secrets hidden before the AI saw this (passwords, keys, SNMP communities).
```

This hides **known secret formats**, not every secret. Unusual formats
(EdgeConnect, ClearPass XML exports, JSON with odd key names) can still get
through. Check what a tool returns before you share it.

## What is scrubbed

- **MCP results: always.** Every result from an MCP server is scrubbed before it
  is cut to size and before the AI sees it. Text blocks that hold JSON are opened,
  scrubbed and written back as JSON. Values under keys such as `password`,
  `psk`, `secret`, `community`, `api_key`, `access_token`, `wpa_passphrase`, or
  any key ending in `_password`, `_secret`, `_psk`, `_passphrase` or
  `_community`, device keys such as `pre_shared_key`, `tacacs_key`,
  `radius_key`, `wep_key` and `secret_key`, and login tokens (`token`,
  `api_token`, `bearer_token`), are hidden too. `next_cursor`, `cursor`,
  `list_key`, `key`, `public_key`, paging tokens (`next_token`, `page_token`)
  and anything under `_pagination` are left alone, so paging keeps working. The result says
  `secretsHidden: N`.
- **Files you or the AI read: config files for device secrets.** A native `read` is scrubbed
  for `.cfg`, `.conf` and `.set` files, and for files under a folder named
  `configs`, `backups` or `oxidized`. Source code (`.ts`, `.py`, `.json`,
  `.yaml`, `.md` and so on) is never changed by the device rules, even under those folders, so test
  fixtures stay as they are.
- **`.env`, INI and credential files: always.** In `.env`, `.env.*`, `*.env`,
  `.envrc`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `credentials*`,
  `secrets.*`, `*.ini`, `*.properties`, `*.tfvars`, `*.tfstate`, `*.pem`,
  `*.key` and `id_rsa`-style files, every value whose name looks secret is
  hidden, and so are private keys: `MIST_APITOKEN=<secret hidden>`. Names and
  other settings (`MIST_HOST=api.mist.com`) stay, so the AI still knows what
  the file holds.
- **Secret-named values in any output: always.** In what `read`, `grep`,
  `bash` and `powershell` return, a value after a secret-looking name
  (`password=hunter2`, `"client_secret": "..."`, `api_key: ...`,
  `Authorization: Bearer ...`) is hidden when it looks like a real value.
  Code such as `token = getToken()` or `password: str` is left alone.
- **Your own secret environment values: always.** Exact copies of the values of
  Casper's secret-named environment variables (`OPENROUTER_API_KEY`,
  `MIST_API_TOKEN`, `CENTRAL_CLIENT_SECRET` ...; 8 characters or longer, not
  paths) are hidden wherever they turn up, so `printenv` shows the AI
  `<secret hidden>`.
- **Command and grep output: only when it looks like a config.** Output from
  `bash`, `powershell` or `grep` (failed commands too) is scrubbed when it has two config lines such as `hostname`,
  `version 23.4;`, `## Last commit` or `interface 1/1/1`, or any line that
  clearly carries a secret (`snmp-server community X`, `wpa-passphrase X`).
  When a command prints a lot, Pi saves the whole output to a
  `pi-bash-<id>.log` (or `pi-powershell-<id>.log`) file; reading that file back
  gets the same check. Other `.log` files are left alone.
- **Subagents** (`/delegate`) and other read-only helpers, such as the security
  check's model review, get the same scrubbing for what they read.
- **Reference search excerpts** (`/references search`, `search_references`)
  are scrubbed with Casper's own rules (not netconan), and a line that only matches inside a hidden secret is not
  returned.

The note `N secrets hidden before the AI saw this (...)` is added to the result
the AI reads.

## What is hidden, per platform

| Platform | Hidden |
| --- | --- |
| AOS-CX | Any value after `plaintext` or `ciphertext` (user passwords, RADIUS/TACACS keys, SNMPv3 `auth-pass`/`priv-pass`, NTP, OSPF and BGP keys), `snmp-server community X` |
| AOS 8 / Instant | `wpa-passphrase`, `wpa-hexkey`, `key` lines inside an `aaa authentication-server radius`/`tacacs` block, `mgmt-user` hashes, `ipsec` keys, SNMPv3 `auth-prot`/`priv-prot` passwords |
| AOS-S | `password manager` or `operator` values after `plaintext` or `sha1`, `radius-server host ... key X`, `snmp-server community X` |
| Junos (set and curly) | `encrypted-password`, `simple-password`, `authentication-key`, `authentication-password`, `privacy-password`, `pre-shared-key`, `md5 N key`, SNMP community names, and any `$9$...` value anywhere |
| Cisco IOS / NX-OS / ASA | `enable secret` and `enable password`, `username ... secret` or `password`, `snmp-server community`, SNMPv3 `auth`/`priv`, `key-string`, `crypto isakmp key`, `pre-shared-key`, `message-digest-key`, `ntp authentication-key`, `wpa-psk`, `standby ... authentication`, `passwd` |
| Any | PEM private keys, `$1$`/`$5$`/`$6$`/`$8$`/`$y$` hashes after a password word |

Left as they are, on purpose: `******`, SSH public keys, certificates, and
hpe-networking-mcp's own `hpe_mcp_secret_<32 hex>` tokens. The server swaps
those tokens back for the real value itself, so the AI can pass one back to that
server. They are **not hidden from device writes**; that is how the server is
designed.

## The AI can't send a hidden secret back

The AI never saw the real value, so it must not write the marker over it:

The same goes for `<line hidden: secret>`.

- An MCP call whose arguments contain `<secret hidden>` is refused before you
  are asked: `Not executed (this change still has <secret hidden> in it). Casper
  hid that secret from the AI, so the AI can't send it back. Type the real value
  yourself or leave that line out.`
- A native `edit` or `write` whose new text contains it is refused: `Not
  written: the new text has <secret hidden> in it. That would replace a real
  secret in the file. Keep the original line.`
- A `bash` or `powershell` command that contains it is refused: `Not run: the
  command has <secret hidden> in it. It could write the marker over a real
  secret. Keep the original line, or ask the user to make this change.`

A shell command can still change a config file in other ways (for example a
script that writes a file from scratch). These checks stop the marker itself,
not every rewrite. The check is literal: it also stops a source file edit or a
`grep` command that only mentions the marker text.

## netconan: an extra check, not the main one

When [netconan](https://github.com/intentionet/netconan) is installed, Casper
also runs `netconan -p` on text that looks like a config (up to 2 MiB), in a
private temporary folder that is removed afterwards. The text is never passed
on the command line. Casper's own rules always run first, on the original text:
netconan misses Aruba formats (it left AOS-CX `ciphertext` values, AOS 8
`wpa-passphrase` and `mgmt-user` hashes in place when tested). netconan can only
add markers; its made-up replacement values never reach the AI. A line it
removed becomes `<line hidden: secret>`.

`CASPER_NETCONAN=off` turns it off; `CASPER_NETCONAN=/path/to/netconan` picks a
program. If netconan fails or takes longer than 10 seconds, Casper's own result
is used and `/secrets` says `netconan did not finish; built-in scrub used.`

## Commands

```text
/secrets
Secrets: hidden in MCP results, .env and credential files (always). Device configs in files and command output: on. Extra check: netconan not found (built-in only).

/secrets files off
Device configs in files and command output: off for this session. MCP results, .env and credential files are still scrubbed.

/secrets files on
Device configs in files and command output: on.
```

`/secrets files off` turns off the device config rules only. `.env` and
credential files, secret-named values and your secret environment values stay
hidden.

Only you can type these; the AI has no way to turn scrubbing off. MCP results
are always scrubbed.

## Limits

- Scrubbing works line by line on known formats. It is best effort: a secret in
  a format Casper doesn't know reaches the AI.
- The approval box, `/mcp` and server questions mask secrets on your screen, but
  the server still gets the real value you approve.
- Secrets the AI already had (for example ones you typed in a request, or ones
  in a file that is not a config file) stay in the conversation and the saved
  session like any other text.
- `/secrets files off` turns device config scrubbing off for subagents too.
- The AI's file tools can't open private places such as `~/.ssh` at all, but its
  shell can. See [SECURITY.md](SECURITY.md) for what is blocked and what is not.
- `casper learn` reads repo text without this scrubbing.
- If the check itself fails on a tool's output, the AI gets `Output not shown:
  Casper could not check it for device secrets. Try a smaller read or another
  command.` instead of the raw text.
