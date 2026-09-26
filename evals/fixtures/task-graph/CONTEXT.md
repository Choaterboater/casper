# task-graph

Orders build tasks so every task runs after the tasks it depends on.

## Conventions

- The scheduler lives in `src/schedule.ts`; its error classes are exported from there.
- A graph is a record from task name to the names it depends on.
- Names compare by plain string order (`<`), never locale order.
- Tests live in `tests/`. No runtime dependencies.
