// The state pairs of tests/secrets-live-drift-states-*.test.ts with every table of the collected table as a state input,
// not one per shape (decision 98): run it on a change to src/secrets or the live check, and give the result in its pull
// request. `bun tests/support/live-drift-all.ts`. Like the suite's preload, it starts from a clean environment with a
// throwaway HOME before anything is loaded, so this machine's own settings and logins are never read.
import { rm } from "node:fs/promises";
import { isolatedEnvironment } from "./env";

const { home, env } = isolatedEnvironment();
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, env);
const { cleanUpLiveDrift, STATE_PARTS, stateContexts, statePairs } = await import("./live-drift");
let checked = 0;
const missed: string[] = [];
try {
  console.log(`${stateContexts(true).length} state inputs (${stateContexts().length} in the suite)`);
  for (let part = 1; part <= STATE_PARTS; part++) {
    const result = await statePairs(part, STATE_PARTS, true);
    checked += result.checked;
    missed.push(...result.missed);
    console.log(`part ${part} of ${STATE_PARTS}: ${result.checked} pairs, ${result.missed.length} windows not held`);
  }
} finally {
  await cleanUpLiveDrift();
  await rm(home, { recursive: true, force: true });
}
console.log(`${checked} pairs, ${missed.length} windows not held`);
for (const line of missed.slice(0, 40)) console.log(line);
process.exit(missed.length ? 1 : 0);
