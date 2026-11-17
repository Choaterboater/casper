import { expect, test } from "bun:test";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixture, savedConversations } from "./support/scripting";

cleanUpAfterEach();

test("/resume <words> lists the saved conversations that mention every word, with no model call", async () => {
  const f = await fixture();
  expect((await f.run(["remember the Café ALPHA"])).exit).toBe(0);
  expect((await f.run(["remember BRAVO"])).exit).toBe(0);
  const [bravo, alpha] = await savedConversations(f);
  expect(alpha && bravo && alpha !== bravo).toBeTruthy();
  const asked = f.payloads.length;

  const found = await f.run(["/resume cafe alpha"]);
  expect({ exit: found.exit, stderr: found.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(found.stdout).toContain(`${alpha}  remember the Café ALPHA`);
  expect(found.stdout).toContain("· remember the Café ALPHA");
  expect(found.stdout).not.toContain(bravo!);
  // Both answered LOCAL_RESPONSE, newest first; Casper's own classification lines are not searched.
  const both = await f.run(["/resume local_response"]);
  expect(both.stdout.indexOf(bravo!)).toBeGreaterThan(-1);
  expect(both.stdout.indexOf(bravo!)).toBeLessThan(both.stdout.indexOf(alpha!));
  const none = await f.run(["/resume classification"]);
  expect(none.stdout).toContain("No saved conversation here mentions classification.");
  expect(f.payloads.length).toBe(asked);
}, childTestLimit(6));
