import { reportFatal, runCli } from "./cli-main";

// A dedicated executable entrypoint avoids depending on import.meta.main after
// bundling. Windows compiled builds of the guarded source CLI silently exited.
runCli().catch(reportFatal);
