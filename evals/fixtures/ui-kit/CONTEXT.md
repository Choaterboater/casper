# ui-kit

Framework-free UI components that render HTML strings and keep their own state.

## Conventions

- One component per file in `src/components/`, exported by name from `src/index.ts`.
- A component is a factory `createX(options)` returning an object with `render(): string`
  plus methods that change state. `render()` always reflects the current state.
- All text goes through `escapeHtml` from `src/html.ts`; attributes are double-quoted.
- Invalid options throw an `Error` whose message starts with the component name, e.g. `Toggle: …`.
- Accessibility follows the WAI-ARIA Authoring Practices patterns.
