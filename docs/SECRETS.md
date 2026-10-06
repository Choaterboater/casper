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
  - login tokens (`token`, `api_token`, `bearer_token`);
  - the secret names file and command output use too (`aws_secret_access_key`,
    `credentials`, `apitoken`, `bearer` ...), so a JSON config saved to disk and the
    same JSON from a server hide the same values.

  `next_cursor`, `cursor`, `list_key`, `key`, `public_key`, paging tokens
  (`next_token`, `page_token`) and anything under `_pagination` are left alone, so
  paging keeps working. The result says `secretsHidden: N`.
- **Files you or the AI read: config files for device secrets.** A `read` is
  scrubbed for `.cfg`, `.conf` and `.set` files, and for files under a folder named
  `configs`, `backups` or `oxidized`. Source code and data files (`.ts`, `.py`,
  `.json`, `.yaml`, `.md` and so on) are never changed by the device rules, even
  under those folders, so test files stay as they are.
- **`.env`, INI and credential files: always (from v0.2.16).** In
  `.env`, `.env.*`, `*.env`, `.envrc`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`
  (`pgpass.conf`), `.dockercfg`, Docker's `config.json`, `credentials*`, `secrets.*`,
  `*.ini`, `*.properties`, `*.tfvars`, `*.tfstate`, `*.pem`, `*.key` and `id_rsa`-style
  files, every value whose name looks secret is hidden, and so are private keys
  (PEM and PGP): `MIST_APITOKEN=<secret hidden>`. A `.pgpass` line keeps its host, port,
  database and user and hides the password; a Docker `"auth"` value (user:password) is
  hidden. A key file read from part way down (no BEGIN line) still hides the key's body.
  Names and other settings (`MIST_HOST=api.mist.com`) stay, so the AI still knows what
  the file holds.
- **Secret-named values in any output: always (from v0.2.16).** In what `read`,
  `grep`, `bash`, `powershell` and the `service` tool (dev server logs and replies)
  return, a value after a secret-looking name (`password=hunter2`,
  `"client_secret": "..."`, `api_key: ...`, `SLACK_WEBHOOK_URL=...`,
  `SENTRY_DSN=...`, `Authorization: Bearer ...`, in any case: `authorization: bearer ...`,
  git's `extraheader = AUTHORIZATION: basic ...`) is hidden when it looks like a real
  value, and so is the password inside an address
  (`postgres://app:<secret hidden>@db/app`). Code such as `token = getToken()` or
  `password: str` is left alone.
- **Logins written as notes: always (from v0.2.19).** The way people write lab logins in a
  markdown file or a command is hidden too: `root / <secret hidden>`, `root@pam / <secret hidden>`,
  `**root** / **<secret hidden>**`, `login: admin / <secret hidden>`,
  `creds: user / <secret hidden>`, `**Password:** <secret hidden>`, `pw: <secret hidden>`,
  `the password is <secret hidden>`, `admin:<secret hidden>@10.0.0.5`, the cells of a table's Password
  column, Proxmox API tokens (`root@pam!name=<secret hidden>`, `PVEAPIToken=...`, the value row of
  `pveum user token add`), a token's secret written after its id (`root@pam!sampleapp <secret hidden>`)
  and `token=<uuid or long hex>`. In commands: `sshpass -p`, `--password`,
  `--token`, `curl -u user:<secret hidden>`, `mysql -p`, `ipmitool -P`, `smbclient -U user%...`,
  `echo ... | sudo -S` and `echo user:... | chpasswd`. Where plain words could follow, only a value
  that looks like a secret (a digit or a symbol) is hidden, so a sentence such as "The password is
  stored on the switch" stays as it is.
- **Commands the AI sent: always (from v0.2.19).** A secret the AI typed into a command is hidden
  before Casper shows the command, keeps it in `/output` and records, or puts it on the receipt. The
  AI already has it, so the receipt says `A secret appeared in a command; change it after this task.`
- **Your own secret environment values: always (from v0.2.16).** Exact copies of the
  values of Casper's secret-named environment variables (`OPENROUTER_API_KEY`,
  `MIST_API_TOKEN`, `CENTRAL_CLIENT_SECRET`, `SLACK_WEBHOOK_URL`, `SENTRY_DSN` ...;
  8 characters or longer, not paths, and not plain web addresses except webhook and DSN ones)
  are hidden wherever they turn up, so `printenv` shows the AI `<secret hidden>`. The
  keys and sign-in tokens in Casper's login file (`~/.casper/agent/auth.json`) are
  hidden the same way, so `cat` of that file in the AI's shell shows none of them.
- **Network logins: always.** The Mist, Central and ClearPass logins you add for
  Casper's network server (`/mcp login`) live only in `~/.casper/network-logins.json`
  (mode 0600; the AI's tools and shell can't open it). Casper adds them to that
  server's environment when it starts, never to `mcp.json`. The tokens, the Central
  client ID and the Central secret are hidden wherever they turn up: in tool output,
  in the AI's shell output and in what the server prints on its error output. The
  addresses (Mist cloud, Central region, ClearPass address) are not secrets and stay.
- **Command and grep output: only when it looks like a config.** Output from
  `bash`, `powershell` or `grep` (failed commands too) is scrubbed when it has two
  config lines such as `hostname`, `version 23.4;`, `## Last commit` or
  `interface 1/1/1`, or any line that clearly carries a secret
  (`snmp-server community X`, `wpa-passphrase X`, a PEM private key). When a command
  prints a lot, Pi (the agent engine Casper runs on) saves the whole output to a
  `pi-bash-<id>.log` (or `pi-powershell-<id>.log`) file; reading that file back gets
  the same check. Other `.log` files are left alone.
- **Subagents** (`/delegate`, or the AI's delegate tool) get the same scrubbing for
  what they read. The `/security-review` AI review (from v0.2.17) gets
  it too, with device configs hidden even when `/secrets files off`, and it never
  opens key or `.env` files or files gitleaks flagged (see
  [SECURITY_CHECKS.md](SECURITY_CHECKS.md#the-ai-review)).
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
| Any | PEM private keys; the word after `password`, `secret` or `passwd` at the start of a line or after a space on the same line (common words like `manager` or `none`, a list of key words such as `password secret hash` or `password | secret`, and code or table marks such as `=`, `|` or `||` are skipped; a password that is literally `secret` or all punctuation is still hidden); `$1$`/`$2a$`/`$5$`/`$6$`/`$8$`/`$y$` hashes after a password, secret or hash word |

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
Secrets: hidden in MCP results, .env and credential files (always). Device configs in files and command output: on. Extra check: netconan not found (built-in only).

/secrets files off
Device configs in files and command output: off for this session. MCP results, .env and credential files are still scrubbed.

/secrets files on
Device configs in files and command output: on.
```

(In v0.2.15 `/secrets` said
`Secrets: hidden in MCP results (always). Files and command output: on.` and had
no `.env` rules.) `/secrets files off` turns off the device config rules only.
`.env` and credential files, secret-named values and your secret environment values
stay hidden.

When netconan is found, the first line ends with `Extra check: netconan <version> (found).`

Only you can type these; the AI has no way to turn scrubbing off. MCP results are
always scrubbed. `/secrets files off` lasts until you turn it on again or restart
Casper.

## Limits

- Scrubbing works line by line on known formats. It is best effort: a secret in a
  format Casper doesn't know reaches the AI. Lab logins written with no spaces
  (`root/Example-Pass1`) or in a sentence ("use root and Example-Pass1") are not hidden,
  because they look like a path or plain words.
- A private key's body in command output is recognised by its BEGIN or END line; a
  piece of one with neither (`head -n 20 key.pem | tail -n 5`) is not. In a key file
  (`*.pem`, `*.key`, `id_rsa`) every long base64 line is hidden, so a certificate read
  from part way down a `.pem` is hidden too.
- Lines longer than 4 KB (minified code, one-line JSON) are checked in 4 KB pieces
  that overlap by 512 characters, so a huge line can't stall Casper. A secret and the
  words before it, up to 512 characters together, always sit whole in one piece and
  are checked as on a short line. A value cut by a piece's end is checked again from
  just before it; if it is longer than a piece, the rest of the line is hidden.
- The approval box, `/mcp` and server questions mask secrets on your screen, but
  the server still gets the real value you approve.
- Secrets the AI already had (for example ones you typed in a request, or ones in a
  file that is not a config file) stay in the conversation and the saved session
  like any other text.
- `/secrets files off` turns device config scrubbing off for subagents too.
- From v0.2.16 the AI's file tools can't open private places such as `~/.ssh` at
  all. From v0.2.19 a shell command that names one is refused too, even with the
  sandbox off; that is a text check a script can get past, so the shell sandbox
  (v0.2.17) is what holds. See [SECURITY.md](SECURITY.md) for what is blocked and
  what is not.
- A command the AI sent stays in the saved conversation as the AI wrote it; only
  what Casper shows and keeps is scrubbed.
- `casper learn` reads repo text without this scrubbing.
- If the check itself fails on a tool's output, the AI gets `Output not shown:
  Casper could not check it for device secrets. Try a smaller read or another
  command.` instead of the raw text.
