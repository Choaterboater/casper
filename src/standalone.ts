export {};

// A dedicated executable entrypoint avoids depending on import.meta.main after
// bundling. Windows compiled builds of the guarded source CLI silently exited.
// ssh starts this same program to ask for a password (see src/ssh/askpass.ts): answer it and stop, nothing else loads.
if (process.env.CASPER_ASKPASS_ENDPOINT && process.env.CASPER_ASKPASS_TOKEN) {
  const { processIO, runAskpassHelper } = await import("./ssh/askpass-helper");
  process.exit(await runAskpassHelper(process.argv.slice(2), process.env, processIO));
}
const { reportFatal, runCli } = await import("./cli-main");
runCli().catch(reportFatal);
