# Polish

Adapted and trimmed from pbakaus/impeccable reference/polish.md (Apache-2.0, Copyright 2025
Paul Bakaus). Changed: shortened and rewritten for Casper.

Refine the page and keep its look, words and behaviour. If the design itself is wrong, say so and
suggest a redesign instead of making one.

1. Open the page at 390 and at 1280 wide and screenshot both. Use its main path yourself.
2. Before editing, record a check for each problem you will fix (overflow, overlap, a state's text).
3. Fix in this order, finishing one level before the next:
   1. broken: a task that fails, a dead control, lost input, a path the keyboard cannot reach;
   2. missing states: loading, empty, error, success, disabled;
   3. hierarchy and responsive: the main action easy to find, groups made by spacing, nothing
      overflowing at 390;
   4. visual: alignment to the project's spacing, the same style for the same role, colours from
      the theme, hover and focus states, icons in one style;
   5. cleanup: debug output, dead styles, duplicates you made.
4. Use the project's own components and theme; add nothing new to the look.
   Never make access worse: keep tap targets at least 44px, focus rings, labels and contrast.
   A `min-height`, padding or outline that does this is not a dead style.
5. End by replaying every check and taking fresh screenshots at 390 and 1280. Say what changed
   and what you left.
