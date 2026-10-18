# Layout

Adapted and trimmed from pbakaus/impeccable reference/layout.md (Apache-2.0, Copyright 2025
Paul Bakaus). Changed: shortened and rewritten for Casper.

Change the structure inside the page's look, not the look.

1. Screenshot at 390 and 1280 wide. Squint: can you still tell the main thing, the next thing and
   the groups, in that order?
2. Before editing, name the main reading path, what belongs together, and what leads.
3. Fix:
   - group by spacing before adding boxes or borders: tight inside a group, generous between;
   - one spacing scale, the project's; `gap` between siblings;
   - more space above a heading than below it; body text 65 to 75 characters wide;
   - cards only for things that really are equal, never cards inside cards;
   - on a phone, stack or reorder by importance; Tab order matches what you see.
   - never shrink a tap target below 44px or remove a focus ring to tighten spacing.
4. Record `no-horizontal-overflow` at 390 and `no-overlap` of the header and the content before the
   edit; replay them after it and screenshot both widths again.
