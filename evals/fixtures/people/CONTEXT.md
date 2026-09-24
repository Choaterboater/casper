# people

User records shared by the directory, email and billing modules.

## Rules

- `src/user.ts` owns the `User` type and every name-formatting helper; other modules never build
  name strings themselves.
- `bun test` and `bun run typecheck` (strict `tsc --noEmit -p tsconfig.json` over `src` and `tests`) must both pass.
- Keep `tsconfig.json` and `bun-test.d.ts` as they are. No runtime dependencies.
