# Colour

Adapted and trimmed from pbakaus/impeccable reference/colorize.md (Apache-2.0, Copyright 2025
Paul Bakaus). Changed: shortened and rewritten for Casper.

Theme tokens only: change the project's colour variables or theme (CSS custom properties, the
Tailwind theme), never raw colours in components. Keep the brand colours it already has.

1. Screenshot at 390 and 1280 wide. Find the theme and each colour role: background, surface,
   text, muted text, border, accent, focus, danger, success.
2. Work out the contrast of every text and control pair from the values, for light and for dark
   (`prefers-color-scheme: dark` or the dark class; the browser tool shows only the light look).
   Text needs 4.5:1; large text, icons, control borders and focus rings 3:1. Show a short table.
3. Fix by changing tokens:
   - the accent marks actions and where you are, not decoration;
   - on a coloured surface, secondary text is tinted from that colour, never gray;
   - dark mode is designed, not inverted: surfaces get lighter as they rise;
   - colour never carries meaning alone (a word or icon beside red and green).
4. Work the table out again, replay checks and screenshot both widths again.
