---
name: web-quality
description: Checks that make a web page work for everyone and not look machine-made, in any project. The project's own colours, fonts and components still win.
casper-web-skill:
  version: 1
---
## When to use

Any UI work: pages, forms, layout, styles, in a project with or without its own look. Keep the
project's colours, fonts, spacing and components; these rules are about how the page works and
reads. Where the user or the project's existing style already uses something in Refuse, keep it.

Adapted and trimmed from pbakaus/impeccable (Apache-2.0, Copyright 2025 Paul Bakaus),
anthropics/skills frontend-design (Apache-2.0, Anthropic, PBC), vercel-labs/web-interface-guidelines
(MIT, Copyright (c) 2025 Vercel Labs) and jakubkrehel/make-interfaces-feel-better (MIT, Copyright (c)
2026 Jakub Krehel). Changed: shortened and rewritten for Casper.

## Refuse

These make a page look machine-made. When you reach for one, rewrite the element instead:

- a small label (eyebrow, kicker) above a heading: the heading speaks for itself;
- 01 / 02 / 03 markers on things that are not a sequence;
- a coloured left or right border over 1px on cards, list items or alerts;
- hard offset shadows (`box-shadow: 4px 4px 0`); a 1px border under a wide soft shadow (use one);
- monospace to look technical, rather than for code, data or numbers;
- the stock palettes: cream with a terracotta accent, near-black with acid green;
- gradient text: emphasis comes from weight or size;
- cards inside cards; a page that is only same-size cards of icon, heading and text;
- purple gradients, glowing blobs, glass panels, emoji as icons;
- `transition: all`: name the properties;
- gray text on a coloured background: tint it from that colour;
- lorem ipsum, "John Doe", 555 numbers, vague lines ("Unlock your potential").

## Verify

Check each on the page itself, not as an intention:

- Body text lines are 65 to 75 characters long (`max-width: 70ch`).
- There is more space above a heading than below it.
- Text is at least 4.5:1 against its background; large text and control borders 3:1. Check
  light and dark.
- Everything you can Tab to shows a visible focus ring (`:focus-visible`). Never
  `outline: none` without a replacement.
- Tap targets are at least 44 by 44px, and two never overlap.
- The viewport tag never sets `user-scalable=no` or `maximum-scale=1`.
- At 390px wide nothing scrolls sideways; long words and tables wrap or scroll in their own box.
- Animations move only `transform` and `opacity`, and stop under `prefers-reduced-motion`.
- The URL holds the open tab, filters and page, so Back and a shared link work.
- Colour never carries meaning alone: add a word or icon.

## Forms

- Every field has a visible `<label for>`. A placeholder is not a label.
- Inputs use 16px text or larger on phones (smaller makes iOS zoom in).
- Give each input the right `type`, `autocomplete` and `inputmode` (email, tel, numeric,
  one-time-code).
- Never block paste.
- Say what went wrong next to the field, in words, linked with `aria-describedby`. Keep what the
  user typed. On submit, move focus to the first field with an error.
- Keep the submit button enabled until the request starts, then say so ("Saving…").

## Structure and states

- Real elements: `button` for actions, `a` for going somewhere, one `h1`, headings in order.
- `<html lang>`, `alt` on every image (`alt=""` for decoration), `aria-label` on icon-only
  buttons.
- Every view with data has loading, empty (what will appear, how to add the first), error (what
  happened, what to do, a retry) and the normal view. Very long names and text do not break it.

## Check it

Open the page at 390px and at desktop width, Tab through it, and read it in dark mode. Casper's
page check notes missing labels, alt text, button names and low contrast; the browser tool's
`check` can prove no sideways scroll and no overlap.
