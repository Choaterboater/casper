# Harden

Adapted and trimmed from pbakaus/impeccable reference/harden.md (Apache-2.0, Copyright 2025
Paul Bakaus). Changed: shortened and rewritten for Casper.

Make the page hold up with real data and real mistakes.

1. Open it at 390 and 1280 wide; find the views that show data or take input.
2. Try each of these and record a check for it (use `{run}` where a value must be new each run):
   - long text: fill the main text field with a 200-character string with no spaces, submit or
     show it, and check `no-horizontal-overflow`;
   - empty: no items yet, or a filter that matches nothing;
   - loading: what shows while a request runs (read the code when you cannot slow it down);
   - error: a failed request or a rejected input says what happened and what to do, with a retry;
   - very long names and numbers in lists, headers and buttons.
3. Fix what breaks: wrap, or cut off with the full text in a title; `min-width: 0` on flex
   children; a state for each case; keep what the user typed after an error; focus the first error.
4. Replay every check and screenshot both widths again.
