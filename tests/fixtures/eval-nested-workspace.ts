import path from "node:path";
import { runEvalTask } from "../../evals/runner";
import { findEvalTask } from "../../evals/tasks";

// A harmless probe: even the unfixed runner cannot edit the enclosing repository.
let factories = 0;
let starts = 0;
let runtimeCwd: string | undefined;
const result = await runEvalTask(findEvalTask("fix-failing-test")!, {
  repoRoot: path.resolve(import.meta.dir, "../.."),
  homeDir: process.argv[2],
  autoVerify: false,
  runtimeFactory: () => {
    factories++;
    return {
      async start(options) {
        starts++;
        runtimeCwd = options.cwd;
        throw new Error("Probe refuses to execute any candidate work");
      },
      async dispose() {},
    };
  },
});
console.log(JSON.stringify({ factories, starts, runtimeCwd, result }));
