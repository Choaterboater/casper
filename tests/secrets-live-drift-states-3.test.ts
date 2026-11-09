import { afterAll, expect, test } from "bun:test";
import { cleanUpLiveDrift, statePairs, STATE_PARTS } from "./support/live-drift";

// Part 3 of the state pairs of tests/secrets-live-drift.test.ts (decision 98), split so the parts run at once.
afterAll(cleanUpLiveDrift);

test("every window of each input is held where an input that sets a state, above or below it, makes the final scrub change it: part 3", async () => {
  const { checked, missed } = await statePairs(3, STATE_PARTS);
  expect(checked).toBeGreaterThan(1_000);
  expect(missed.slice(0, 40)).toEqual([]);
}, 600_000);
