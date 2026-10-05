# {{name}}

A Vite + React + TypeScript app, started from the Casper `vite-react` template
(`bun create vite --template react-ts`).

## Use it

```sh
bun run dev       # Vite dev server with hot reload
bun run build     # typecheck, then a static build in dist/
bun run preview   # serve the build
```

## Check it

```sh
bun test            # page tests (happy-dom stands in for the browser)
bun run typecheck   # TypeScript
bun run lint        # oxlint
```

## The look

`src/theme.css` holds the app's own small theme: a color palette (light and dark), a type scale,
spacing steps and corner sizes, as CSS variables. Use them (`var(--ink)`, `var(--space-4)`)
rather than raw colors and sizes, and change the look in that one file.

`.casper/project.yaml` tells Casper how to start the dev server (`services.web`), so Casper can
open the pages after a change.
