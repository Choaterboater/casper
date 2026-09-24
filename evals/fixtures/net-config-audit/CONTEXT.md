# net-config-audit

Diffs configuration backups without noise and checks them against a baseline policy.
Supports Junos `display set` output and AOS-CX `show running-config`. All configs are synthetic.

## Normalization (`normalizeConfig(vendor, text)` → lines)

Both vendors: split on `\n`/`\r\n`, strip trailing whitespace, drop blank lines, then:

- **Junos:** drop comment lines (starting with `#`, e.g. `## Last commit: …`). Junos re-obfuscates
  `$9$` secrets every time it displays them, so replace each double-quoted `"$9$…"` value with `"$9$<masked>"`.
- **AOS-CX:** drop comment lines (starting with `!`, e.g. `!Version …`, `!export-password: default`) and the
  `Current configuration:` header. Configuration is hierarchical: an indented line belongs to the nearest
  preceding line with less indentation. Emit such lines as `<parent> > <child>` (trimmed, nested parents
  joined the same way, e.g. `interface 1/1/1 > no shutdown`), so identical sub-commands under different
  parents stay distinct. `exit` lines are dropped.

## Diff (`diffConfigs(vendor, before, after)`)

`{ added, removed }` over normalized lines: `added` = lines of `after` not in `before` (in `after` order),
`removed` = lines of `before` not in `after` (in `before` order). Duplicates count once.

## Compliance (`checkCompliance(vendor, text)`)

Returns `[{ rule, passed, detail }]` for the rules `ntp`, `aaa`, `snmpv2-off`, in that order. `detail` is a
short human explanation; for `snmpv2-off` failures it names every community found.

| Rule | Junos | AOS-CX |
|---|---|---|
| `ntp` | a `set system ntp server <addr>` line | a `ntp server <addr>` line **and** `ntp enable` |
| `aaa` | a `set system tacplus-server <addr>` or `set system radius-server <addr>` line, **and** `set system authentication-order` whose first method is `tacplus` or `radius` (`[ tacplus password ]` or `radius`) | a `tacacs-server host` or `radius-server host` line, **and** `aaa authentication login default group <g> …` whose first group `<g>` is `tacacs`, `radius`, or a group defined with `aaa group server tacacs\|radius <g>` |
| `snmpv2-off` | no `set snmp community <name> …` line | no `snmp-server community <name>` line |

## Conventions

- `src/normalize.ts`, `src/diff.ts`, `src/compliance.ts`; the vendor type is in `src/vendor.ts`.
- Pure functions, no I/O, no runtime dependencies.
