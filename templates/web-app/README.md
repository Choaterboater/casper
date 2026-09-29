# {{name}}

A React web app on Bun, started from the Casper `web-app` template (`bun init --react`).

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

`.casper/project.yaml` tells Casper how to start the dev server (`services.web`), so Casper can
open the pages after a change.
