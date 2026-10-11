---
name: web-frontend
description: How to build a web page or app UI that looks deliberate and works for everyone, in a project with no design of its own yet.
casper-web-skill:
  version: 1
---
## When to use

UI work (pages, forms, layout, styles) in a project that has no styles, components or design
files yet. If the project already has a look (a theme file, components, Tailwind config, a
design folder), follow that instead: the repo's style always wins over this file.

## Pick a small system first

- One type scale, about 6 steps, each 1.2 to 1.25 times the last (0.833, 1, 1.2, 1.44, 1.728,
  2.074 rem). Body text 1rem (16px), line height about 1.5. Two weights are enough.
- One spacing step (0.25rem) and use multiples of it: 4, 8, 12, 16, 24, 32, 40px. Same gaps for
  the same kind of thing.
- A few named colors as CSS variables: background, surface, text, muted text, border, one
  accent, danger, success. Give each a dark-mode value under
  `@media (prefers-color-scheme: dark)`. Use the names in code, never raw hex in components.
- Put all of it in one file (`theme.css` or the Tailwind theme) so the look changes in one place.
- Choose a heading and body font pair and one accent that suit this product (a serif display
  face for a cafe or shop, say; never Inter alone), with the system stack as the fallback, and a
  corner radius that fits the brief.

## Structure

- Build what the brief asks: don't add features it did not ask for (a cart or basket, accounts,
  search). A call to action with nothing behind it links to the contact section.
- Real elements: `header`, `nav`, `main`, `section`, `footer`, `h1` to `h3` in order (one
  `h1`), `button` for actions, `a` for going somewhere, `ul`/`ol` for lists, `table` for
  tables of data.
- `<html lang="...">` and a real `<title>`.
- Every image has `alt`: what it shows, or `alt=""` when it is only decoration.
- An icon-only button gets `aria-label`. Prefer a word next to the icon.

## Forms

- Every input, select and textarea has a visible `<label for>`. A placeholder is not a label.
- Say what went wrong next to the field, in words ("Enter an email like name@example.com"),
  and link it with `aria-describedby`. Keep what the user typed.
- Disable a button only while its request runs, and say so ("Saving…").

## Touch, focus and size

- Buttons, links in lists and form fields are at least 44 by 44px to tap.
- Keep a visible focus ring (`:focus-visible` with the accent color). Never remove outlines
  without a replacement. Everything works with Tab, Enter and Escape.
- Lay out for a 390px wide phone first, then widen. No sideways scroll; long words and tables
  wrap or scroll inside their own box.
- At 390px the header stays one row: the brand and a Menu button (`aria-expanded`, Escape
  closes it) that opens the nav. Extra header items go in the menu.
- Respect `prefers-reduced-motion`: no needed meaning in animation.

## Color and contrast

- Body text at least 4.5:1 against its background; large text and borders of controls 3:1.
- Never use color alone to carry meaning (add a word or icon to red/green states).
- Check both light and dark values; set `color-scheme` to match, and images and their frames too.

## Repeated items

- Products, services or plans: each gets its own image or visual and its own action (a button or
  link that does something). Never reuse one image with a different label, and never link
  stock or CDN images you have not checked.
- Cards in a row: the card body gets `flex: 1` and the price or action `margin-top: auto`, so they
  line up. Check a desktop row with more than one column.

## Drawing SVG

Icons (small UI glyphs): one stroke width and style for all of them, `currentColor` or the CSS
variables so they follow dark mode, a few shapes, `aria-hidden="true"` or a `<title>`.

Illustrations (hero, product, about art) should look like a polished product picture:

- First read `illustration-kit.svg` in this skill's base directory and copy the materials
  (steel, chrome, wood, ceramic, glass, paint, enamel, paper, stone, fabric), shadows and
  textures you need into `<defs>`.
- Build back to front: background and wall glow, ground, cast shadow, the main body's faces,
  details, highlights.
- One light from the top-left: a lit side, a darker side face and a top face for depth, shadows
  falling down-right. Soft contact and cast shadows from the kit's filters.
- Add a little real detail (screws, seams, a dial's ticks, labels).
- `role="img"` with `<title>` and `<desc>`; a `viewBox` and no fixed size, sized with CSS.
- For photo-like images, use make_picture when it is offered.

## States

Every view that shows data has all four: loading (a short line or skeleton), empty (says what
will appear and how to add the first one), error (what happened and what to do, with a retry),
and the normal view. Long text and very long names must not break the layout.

## Avoid the generated look

Choose the page's shape before writing code, to suit the content: an off-center hero, an
uneven tile grid, one reading column, a split screen.

These make a page look machine-made; skip them unless the user asks:

- purple or blue-to-purple gradients, glowing blobs, glass panels;
- emoji used as icons or bullet points;
- every block in a rounded card with a shadow; cards inside cards;
- giant centered hero with vague text ("Unlock your potential"), three feature cards below;
- lorem ipsum, "John Doe", 555 or 000 numbers, a "demo" note on the page: write real-looking text;
- many accent colors; text in gradient; everything centered.

Prefer plain alignment to a grid, real words, one accent used rarely, and whitespace.

## Check it

Open the page at 390px and at desktop width. Tab through it. Read it in dark mode. Casper's page
check opens changed pages and notes missing labels, alt text, button names, low contrast, and
SVGs with no viewBox or name and icons that stay light in dark mode.
