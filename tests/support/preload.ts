import { cleanEnv } from "./env";

// In-process tests read process.env directly (config profiles, the agent store, provider keys), so a
// developer's own PI_*/CASPER_* variables or provider keys would give them a different suite than CI's.
// Start every test file from the same clean environment; tests that need a variable set it themselves.
const clean = cleanEnv();
for (const name of Object.keys(process.env)) if (!(name in clean)) delete process.env[name];
