# Type

Adapted and trimmed from pbakaus/impeccable reference/typeset.md (Apache-2.0, Copyright 2025
Paul Bakaus). Changed: shortened and rewritten for Casper.

Improve the type with the project's own fonts; change a font only if the user asks.

1. Screenshot at 390 and 1280 wide; `inspect` the headings, body, labels and numbers.
2. Check: can heading, body, label and data be told apart at a glance? Are two sizes too close to
   do different jobs? Does each role look the same everywhere?
3. Fix:
   - body text at least 16px, line height about 1.5, lines 65 to 75 characters;
   - few sizes and weights, clearly apart; the same role in the same style;
   - `text-wrap: balance` on headings and `text-wrap: pretty` on body text;
   - `font-variant-numeric: tabular-nums` on numbers that change or line up in columns;
   - long headings and words wrap at 390 without overflow;
   - light text on a dark background gets a little more line height;
   - load only the fonts and weights the page uses.
4. Record `no-horizontal-overflow` at 390 before the edit, replay it after, and screenshot both
   widths again.
