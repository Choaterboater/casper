# 64. A network write says what it does in plain words; what was sent is behind Ctrl+T

Date: 2026-11-02. Status: proposed. Amends the MCP change box and change rows as docs/MCP.md and docs/TERMINAL_UX.md
described them (no earlier decision records them); decisions 43 and 45 (how boxes are answered) are unchanged.

## Decision

- **Plain words first.** A Mist, Central or ClearPass tool's change box opens with what it does, read from the tool's
  name, what it sends and the objects this session's results named: `Change in Mist: Create RF template
  Standard-RF-80MHz (a copy of Standard-RF; 5 GHz width 40 → 80 MHz)`, `Change in Mist: Set site Lab-Site's RF template
  to Standard-RF-80MHz (now Standard-RF)`, `Change in Mist: Run the radio channel plan (RRM) on 5 GHz at site Lab-Site`.
  `Runs: <tool> (through invoke_tool)` still follows. Another server's tool keeps its name as the first line.
- **Values one per line.** A nested object's values each get a line under a dotted path (`body.band_5.bandwidth 80`),
  never one wrapped line of JSON. On the rich terminal the box shows the first 8, then `… N more values · Ctrl+T shows
  all`, and Ctrl+T shows every value as sent (secrets hidden) while the box is open. The plain terminal has no Ctrl+T
  and shows every value.
- **The value before.** Before an update that asks (or that `Yes to everything` covers), Casper reads the fields it
  changes through the same server's `invoke_read_tool` (`mist_update_site_info` → `mist_get_site_info`), sending only the
  call's ids, for at most 3 seconds, with no box and no line. Any failure leaves `(was …)` out. Ids are said by the
  names this session's results gave them; else as a short id (`00000000…`).
- **The row and the receipt.** The change row reads `◆ Changed in Mist: site Lab-Site now uses RF template
  Standard-RF-80MHz (was Standard-RF)`, with `To undo: set it back to Standard-RF` on the line under it when Casper can
  tell. A router's own `name` (the tool it runs) is never the row's target any more. What was sent is behind Ctrl+T,
  never a box of JSON. Every change whose call ran is on the receipt's Devices row (`In Mist: …. To undo: …`) and in the
  JSON receipt (`mcpChanges`), whether or not the folder can be compared and also when the request read as a question:
  such a task prints its card. A call that failed or never went out is left off; one cut off on the way says `Casper
  can't tell whether it finished`.

## Why

The owner's Mist session made three real changes (a new RF template, a site's RF template, the 5 GHz channel plan). The
box showed the template as one wrapped JSON line, the row said `◆ Changed in network: mist_create_org_rf_template
mist_create_org_rf_template` above 40 lines of JSON, and the receipt said only `Changes unknown: not a project folder`
and `Checks skipped: this read as a question`. None of it said what changed or how to put it back.

## Guard rails

- The words are display only. What asks, the choices, their order, Enter on No, `Yes to everything` and the 4 KB limit
  (arguments too long to show are not run) are unchanged; the box still shows every value on the plain terminal and
  every value through Ctrl+T on the rich one.
- The read before is a read: only `invoke_read_tool`, only a name Casper's labels read as a read (`*_get_*`), only the
  ids the AI's own call carries, only on a server whose router is connected and not hidden, never while planning
  refuses the change. Its result is scrubbed like any other and is never shown to the AI.
- Words, names and values in them pass through the same masking and terminal-text rules as the box; a secret the box
  hides is never in its words.
