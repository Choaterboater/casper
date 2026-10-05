# {{name}}

A React web app on Bun with Tailwind, started from the Casper `web-app` template
(`bun init --react=tailwind`).

## Use it

```sh
bun dev          # dev server with hot reload
bun run build    # static build in dist/
bun start        # production server
```

## Check it

```sh
bun test            # page tests (happy-dom stands in for the browser)
bun run typecheck   # TypeScript
```

## The look

`src/theme.css` holds the app's own small theme: a color palette (light and dark), a type scale,
the spacing step and corner sizes, as CSS variables that Tailwind reads. Use the theme's names
(`bg-paper`, `text-ink`, `text-muted`, `border-line`, `bg-accent`, `text-danger`) rather than raw
colors, and change the look in that one file.

`.casper/project.yaml` tells Casper how to start the dev server (`services.web`), so Casper can
open the pages after a change.
