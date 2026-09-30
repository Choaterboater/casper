import { cleanEnv } from "./env";

// In-process tests read process.env directly (config profiles, the agent store, provider keys), so a
// developer's own PI_*/CASPER_* variables or provider keys would give them a different suite than CI's.
// Start every test file from the same clean environment; tests that need a variable set it themselves.
const clean = cleanEnv();
for (const name of Object.keys(process.env)) if (!(name in clean)) delete process.env[name];

// The shell sandbox holds nothing in the suite by default, whatever this machine has installed, so a test's
// checks and commands run the same on every host. Sandbox tests build their own ShellSandbox (a fake engine,
// or the real one where bubblewrap or sandbox-exec is there: tests/support/platform.ts sandboxAvailable).
const { sandboxDefaults } = await import("../../src/sandbox/manager");
const { passThroughEngine } = await import("../../src/sandbox/runtime");
sandboxDefaults.engine = passThroughEngine;
sandboxDefaults.problem = () => undefined;

// A session's sandbox becomes the process-wide one (useSandbox) until its app closes. One a test leaves open
// changes later tests in the same run (their checks, the security header), and a real one keeps its network
// relays running after the suite: bun test runs no exit handlers. Close every app and sandbox a test opens.
const { afterEach } = await import("bun:test");
const { currentSandbox, useSandbox } = await import("../../src/sandbox/manager");
afterEach(() => {
  if (!currentSandbox()) return;
  useSandbox(undefined);
  throw new Error("This test left a session's shell sandbox open: close the app (app.close()) or the sandbox in a finally.");
});
