import { runCli } from "./cli";

// A dedicated executable entrypoint avoids depending on import.meta.main after
// bundling. Windows compiled builds of the guarded source CLI silently exited.
runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
