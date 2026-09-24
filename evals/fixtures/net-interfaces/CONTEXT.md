# net-interfaces

Parses `show interfaces` output captured from switches and routers into one vendor-neutral model.
All sample data is synthetic (documentation address ranges, made-up MACs).

## Entry point

`parseInterfaces(vendor, text)` in `src/parse.ts`, where `vendor` is `"iosxe" | "junos" | "aoscx"`.
It returns `{ interfaces: Interface[], truncated: boolean }` (types in `src/model.ts`). Vendor parsers
live in `src/vendors/<vendor>.ts`; shared helpers (MAC normalization, pager detection, parent names,
LAG linking) live in `src/common.ts`.

## Model rules (all vendors)

- `name`: exactly as the device prints it. Interfaces appear in transcript order.
- `parent`: for a name containing `.` (sub-interface / logical unit), the part before the last `.`; else null.
- `mac`: lowercase `aa:bb:cc:dd:ee:ff` (IOS-XE prints `aabb.ccdd.eeff`); null when absent.
- `mtu`, `speedMbps`: numbers, or null when absent. A printed speed of 0 or "Unspecified" is null.
  `Gb/s` / `Gbps` values are converted to Mb/s.
- `description`: the text after `Description:` (or `Description :`), trimmed; null when absent or empty.
- `ipv4`: every IPv4 address with its prefix length, e.g. `192.0.2.1/24`, in printed order.
- `lagMembers`: on a LAG interface, its member names; on others, `[]`. A member printed with an
  abbreviated name (IOS-XE `Gi1/0/1`) is expanded to the full name of the interface in the same
  transcript whose type starts with the abbreviation (case-insensitive) and whose number matches;
  when no such interface is in the transcript it stays as printed.
- `lag`: on a member interface present in the transcript, the name of its LAG; else null.
- Truncation: a pager prompt line (`--More--`, `---(more)---`, `-- MORE --`, any case) means the capture
  was cut. Set `truncated: true`, drop the interface block that was being printed when the prompt
  appeared (for Junos, the physical interface together with all its logical units), and ignore everything after it. An interface block is complete when the next block starts
  or the text ends without a pager prompt.

## Vendor specifics

| | IOS-XE | Junos | AOS-CX |
|---|---|---|---|
| Block start | `<name> is <state>, line protocol is <up\|down>` | `Physical interface: <name>, <Enabled\|Administratively down>, Physical link is <Up\|Down>`; logical units start with `  Logical interface <name> (...)` | `Interface <name> is <up\|down>` or `Aggregate <name> is <up\|down>` |
| `adminUp` | false only for `administratively down` | physical: `Enabled`; logical: parent's `adminUp` and the unit's first `Flags:` line has no `Disabled` token | `Admin state is up` |
| `operUp` | `line protocol is up` | physical: `Physical link is Up`; logical: the unit's first `Flags:` line has an `Up` token | `is up` on the block line |
| `mtu` | `MTU <n> bytes` | physical: `MTU: <n>` on the `Link-level type` line; logical: `Protocol inet, MTU: <n>` | `MTU <n>` |
| `speedMbps` | `<n>Mb/s` / `<n>Gb/s` in the duplex line | `Speed: <n>mbps` / `<n>Gbps` | `Speed <n> Mb/s` |
| `mac` | `Hardware is …, address is <aabb.ccdd.eeff>` | `Current address: <mac>` | `MAC Address: <mac>` (also `MAC Address         : <mac>`) |
| `ipv4` | `Internet address is <a/p>` | `Local: <a>` with the prefix length of the same line's `Destination: <net/p>`; `/32` when there is no `Destination` | `IPv4 address <a/p>` (a trailing `secondary` is ignored) |
| LAG | `Port-channel<n>` block: `Members in this channel: <names>` | a logical unit with `Protocol aenet, AE bundle: <ae>.<unit>` makes its physical interface a member of `<ae>`; such `aenet` units are not listed as interfaces | `Aggregate` block: `Aggregated-interfaces : <names>` |
