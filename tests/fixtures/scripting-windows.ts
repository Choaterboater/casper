// Separate CLI process: exercise Windows' unsupported-sandbox policy on every host,
// without replacing path, fs, command execution or the receipt/proof implementation.
import { ShellSandbox } from "../../src/sandbox/manager";

const detect = ShellSandbox.detect;
ShellSandbox.detect = (options) => detect({ ...options, platform: "win32" });
const { reportFatal, runCli } = await import("../../src/cli-main");
await runCli().catch(reportFatal);
