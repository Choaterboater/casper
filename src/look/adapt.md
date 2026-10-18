# Adapt

Adapted and trimmed from pbakaus/impeccable reference/adapt.md (Apache-2.0, Copyright 2025
Paul Bakaus). Changed: shortened and rewritten for Casper.

Make the page work at phone, tablet and desktop widths.

1. Open it at 390, 768 and 1280 wide and screenshot each.
2. Before editing, record a check at each width: `no-horizontal-overflow`, and `no-overlap` of the
   header and the main content.
3. `inspect` the tap targets at 390: buttons, links in lists and fields are at least 44 by 44px
   (a pseudo-element can grow the hit area) and never overlap.
4. Fix with the project's own breakpoints and components: stack or reorder by importance; the
   header stays one row with a Menu button at 390; tables and code scroll in their own box; images
   keep their shape; inputs use 16px text; the viewport tag never sets `user-scalable=no`.
5. Replay every check and screenshot the three widths again.
