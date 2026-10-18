# Audit

Adapted and trimmed from pbakaus/impeccable reference/audit.md (Apache-2.0, Copyright 2025
Paul Bakaus). Changed: shortened and rewritten for Casper.

Report only: change no files.

1. Open the page at 390 wide. Run `diagnostics` (console and network problems) and `inspect`.
2. Record two checks and report how they came out:
   - at 390 wide, `no-horizontal-overflow`;
   - at 1280 wide, `no-overlap` of the header and the main content (selectors from `inspect`,
     such as `header` and `main`).
3. Read the page's source for what the browser cannot show.
4. Score each 0 to 4 in a table, with the key finding:
   - Accessibility: text contrast 4.5:1, labels, alt text, headings in order, visible focus,
     everything works with the keyboard.
   - Performance: console errors, failed requests, large images with no size or lazy loading,
     animations of layout properties, `transition: all`.
   - Theming: colours from the theme or tokens, not raw values in components; dark mode works.
   - Responsive: no sideways scroll, 44 by 44px tap targets, no fixed widths that break at 390.
   - Integrity: the page does what it shows (no dead buttons, made-up numbers or placeholder text).
   Total out of 20: 18 or more excellent, 14 good, 10 needs work, below that poor.
5. List the issues P0 to P3 with where (file:line or selector), what it does to people, the fix
   and the /look command for it. Few P3s. End with what works well.
