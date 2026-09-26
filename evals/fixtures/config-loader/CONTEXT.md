# config-loader

Loads application configuration from defaults, a parsed JSON file and environment variables.

## Conventions

- `loadConfig` lives in `src/config.ts`; `ConfigError` and the value types are exported from there.
- The defaults object is the schema: its keys are the only allowed keys and each default's type is the only allowed type.
- Inputs are never mutated, and the returned object shares nothing mutable with them.
- Tests live in `tests/`. No runtime dependencies.
