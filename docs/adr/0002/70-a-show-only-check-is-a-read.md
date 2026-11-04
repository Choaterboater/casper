# 70. A show-only check the server labels read is a read; a check is never a change

Date: 2026-11-03. Status: proposed. Extends the router rules in [MCP.md](../../MCP.md#safety) (a routed call is judged by
the real tool and the kind its server's `find_tool` gave it).

## Decision

In a real session, `get_lldp_neighbors` through `invoke_read_tool` (Central's troubleshooting API running
`show lldp neighbors`) showed `Change in Central: get lldp neighbors … May make the change (dry_run is not set) … Make
this change?`, then `◆ Changed in network: get_lldp_neighbors` and a Devices row on the receipt. To stop read prompts the
owner picked "Yes to everything on Network", which also lets reboots and deletes run unasked.

- **The server says it is a read.** casper-network-mcp keeps such tools `kind: troubleshoot` (its own gate lets only that
  kind POST to the troubleshooting API) and labels them `read` in `find_tool`. Casper runs a routed call to one like a
  read: no box. This is still the server's label deciding, as for `readOnlyHint`; a name never loosens a label.
- **A check is not a change.** A call labelled `diagnostic` (ping, traceroute) still asks, but its box says
  `Run a check [on <device>] in <product>: <tool>`, `A check: it changes no settings.` and `Run this check?`. It is not a
  `◆ Changed in` row, not on the receipt's Devices row, and not counted as a change /undo can't reach.

## Guard rails

- A name with a link-check word (ping, traceroute, iperf, speedtest, cable, nslookup, blink) asks whatever the server's
  label, as before.
- `read` counts only with `kind: troubleshoot`, and only while every `find_tool` hit for that tool said so; any later
  hit without it, or with a riskier kind, ends it. A hit never lowers a kind.
- Without the server's `read` label nothing changes: a troubleshooting kind is `diagnostic` and asks.
- A check whose arguments set a preview switch or `confirm` keeps the existing lines and still asks.
