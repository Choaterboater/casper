# Guidelines

Adapted and trimmed from vercel-labs/web-interface-guidelines command.md (MIT, Copyright (c)
2025 Vercel Labs). Changed: shortened and rewritten for Casper.

Report only: change no files.

1. Open the page at 390 and at 1280 wide, `screenshot` each, run `diagnostics` and `inspect`.
2. Record a check for what a check can prove: at 390, `no-horizontal-overflow`; at 1280,
   `no-overlap` of the header and the main content. `inspect` tap targets at 390 (44 by 44px).
3. Read the page's source and go through these rules:
   - Interaction: real `<button>` and `<a>`, never a clickable `<div>`; icon buttons have a label;
     focus shows with `:focus-visible` and no `outline: none` left bare; sticky bars never hide
     the focused element; delete asks or offers undo; zoom is never turned off.
   - Forms: every field has a label, a fitting `type`, `name` and `autocomplete`; paste works;
     errors sit by the field; submit stays usable until the request starts.
   - Animation: `transform` and `opacity` only, no `transition: all`, a calmer version under
     `prefers-reduced-motion`, and it can be interrupted.
   - Layout: notched screens get `env(safe-area-inset-*)`; long text wraps or truncates
     (`min-width: 0` on flex children); images have width and height.
   - Content: `…` not `...`, loading text ends with `…`, numbers in columns use tabular figures,
     buttons say what they do, errors say how to fix it, dates and numbers use `Intl`.
   - Performance: below-the-fold images lazy, long lists virtualised, no layout reads during render.
   - Theming: `color-scheme` set for dark mode, `theme-color` matches the page, `<select>` readable.
   - URL state: tabs, filters and pages live in the URL so a link reopens the same view.
4. Report the checks first, then each finding as one line: rule, where (file:line or selector),
   fix. Group by file; write "passes" for a file with none. No preamble.
