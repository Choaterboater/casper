# portcheck

`portcheck` checks whether TCP services answer, for scripts and humans.

## Conventions

- `src/cli.ts` exports `main(argv, io)`; it never calls `process.exit` or writes to the console
  directly, so tests drive it in-process. `bin/portcheck` is a thin wrapper.
- Network probes live in `src/probe.ts`; argument parsing lives in `src/args.ts`.
- Exit codes: 0 every target open, 1 any target not open, 64 usage error.
- No runtime dependencies; use `node:net` / `node:tls`.
