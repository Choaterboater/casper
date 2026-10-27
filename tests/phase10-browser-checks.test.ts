import { expect } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserSession } from "../src/browser/session";
import { browserTool } from "../src/browser/tools";
import { browserFixtures, browserTest, executable, freePort } from "./support/browser-fixture";

const { cleanup, fixture } = browserFixtures();

// What a check says: failures and their nearest matches, withdrawals, steps, what an action changed and the final page.

browserTest("a failing check names up to 3 real elements like it, and on a replay how to fix a wrong check; text ignores runs of whitespace", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, '<!doctype html><h1 id="page-title">Hello\n   Casper</h1><button class="save-button">Save</button><p class="status">Saved   ok</p>');
  const run = (assertions: unknown[]) => f.session.run({ action: "check", scenario: { name: "Hints", url: f.url, scope: { inputs: ["index.html"] }, steps: [], assertions } });
  // Line breaks and runs of spaces count as one space on both sides; the text must otherwise match.
  expect(await run([{ kind: "text", selector: "h1", expected: "Hello Casper" }, { kind: "text", selector: ".status", expected: " Saved    ok " }]))
    .toMatchObject({ status: "pass", assertions: [{ status: "pass", actual: "Hello Casper" }, { status: "pass", actual: "Saved ok" }] });
  const hint = "If the check itself is wrong, record a corrected check of this page and withdraw this one (replacedBy: its id once it passes); if the page is wrong, fix it.";
  const recorded = await run([{ kind: "visible", selector: "#title" }, { kind: "text", selector: "#save-btn", expected: "Save" },
    { kind: "text", selector: "h1", expected: "hello casper" }, { kind: "visible", selector: "button" }]) as { id: string; status: string; assertions: Array<Record<string, unknown>> };
  // Recorded before an edit a check is meant to fail: the real elements, but no hint to withdraw it.
  expect(recorded.status).toBe("fail");
  expect((recorded.assertions[0]!.near as string[])[0]).toBe('h1#page-title "Hello Casper"');
  expect(recorded.assertions.some(a => "hint" in a)).toBe(false);
  const failed = await f.session.run({ action: "replay", id: recorded.id }) as { status: string; assertions: Array<Record<string, unknown>> };
  expect(failed.status).toBe("fail");
  expect(failed.assertions[0]).toMatchObject({ status: "fail", actual: "Expected one element; found 0", hint });
  expect((failed.assertions[0]!.near as string[])[0]).toBe('h1#page-title "Hello Casper"');
  expect(failed.assertions[1]).toMatchObject({ status: "fail", hint });
  expect((failed.assertions[1]!.near as string[])[0]).toBe('button.save-button "Save"');
  // A wrong text says what is there and still fails: case is not ignored.
  expect(failed.assertions[2]).toMatchObject({ status: "fail", actual: "Hello Casper", hint });
  expect((failed.assertions[2]!.near as string[]).length).toBeLessThanOrEqual(3);
  expect(failed.assertions[3]).toEqual({ kind: "visible", status: "pass", actual: true });
}, 30_000);

browserTest("a check with no scope whose page saves to a file git ignores, or to a data file, stays fresh and can be withdrawn; another file it writes makes it stale", async () => {
  const run = async (git: boolean, saved: string, ignore = true) => {
    const f = await fixture();
    if (ignore) await writeFile(path.join(f.project, ".gitignore"), "data/\n");
    await writeFile(f.sourceFile, '<!doctype html><button>Book</button><p id="state">Free</p><script>document.querySelector("button").onclick = async () => { await fetch("/book", { method: "POST" }); document.querySelector("#state").textContent = "Booked"; }</script>');
    if (git) {
      expect(Bun.spawnSync(["git", "init", "-q"], { cwd: f.project }).exitCode).toBe(0);
      if (!saved.startsWith("data/")) {
        await writeFile(path.join(f.project, saved), "[]");
        expect(Bun.spawnSync(["git", "add", saved], { cwd: f.project }).exitCode).toBe(0);
      }
    }
    // The app's own server, writing a booking into the project as the check's click runs.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/book") {
        await mkdir(path.dirname(path.join(f.project, saved)), { recursive: true });
        await writeFile(path.join(f.project, saved), JSON.stringify([{ at: Date.now() }]));
        return new Response("ok");
      }
      return new Response(await readFile(f.sourceFile), { headers: { "content-type": "text/html" } });
    } });
    cleanup.push(async () => { server.stop(true); });
    const check = await f.session.run({ action: "check", scenario: { name: "Book", url: `http://127.0.0.1:${server.port}`,
      steps: [{ action: "click", selector: "button", impact: "local-test", reason: "books a test slot" }],
      assertions: [{ kind: "text", selector: "#state", expected: "Booked!" }] } }) as { id: string };
    return { f, check, withdraw: () => f.session.run({ action: "withdraw", id: check.id, reason: "expected text had a typo" }) };
  };
  const ignored = await run(true, "data/db.json");
  expect(ignored.check).toMatchObject({ status: "fail", freshness: "fresh" });
  expect(await ignored.withdraw()).toMatchObject({ status: "withdrawn" });
  // A .gitignore counts with no git repository too.
  expect((await run(false, "data/db.json")).check).toMatchObject({ status: "fail", freshness: "fresh" });
  // The model's own edit of an ignored file the page may serve still counts: any edit or command makes the check stale.
  const edited = await run(true, "data/db.json");
  await writeFile(path.join(edited.f.project, "data", "db.json"), "[]");
  edited.f.session.invalidate();
  await expect(edited.withdraw()).rejects.toThrow("Code/tool writes observed after this browser check");
  // The app's own data store (a tracked bookings.json, data/db.json with no .gitignore) is not code: every check that
  // books a slot would otherwise go stale and never get its repair turn.
  for (const [git, saved, ignore] of [[true, "bookings.json", true], [false, "data/db.json", false]] as const)
    expect((await run(git, saved, ignore)).check).toMatchObject({ status: "fail", freshness: "fresh" });
  for (const [git, saved, ignore] of [[true, "bookings.html", true], [false, "data/notes.txt", false]] as const) {
    const stale = await run(git, saved, ignore);
    expect(stale.check).toMatchObject({ status: "fail", freshness: "stale", reason: "Declared inputs changed during browser reproduction." });
    await expect(stale.withdraw()).rejects.toThrow("Declared inputs changed during browser reproduction");
  }
}, 60_000);

browserTest("{run} in a fill value is new on each run of a check, so a sign-up passes again; a fixed email that passed before gets a hint", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, '<!doctype html><input id="email"><button id="go">Register</button><p id="out"></p><script>document.querySelector("#go").onclick = async () => { const r = await fetch("/register?email=" + encodeURIComponent(document.querySelector("#email").value)); document.querySelector("#out").textContent = await r.text(); }</script>');
  // The app refuses an email already registered.
  const emails: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/register") {
      const email = url.searchParams.get("email")!;
      if (emails.includes(email)) return new Response("That email is already registered");
      emails.push(email);
      return new Response("Registered");
    }
    return new Response(await readFile(f.sourceFile), { headers: { "content-type": "text/html" } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const signUp = (name: string, email: string) => f.session.run({ action: "check", scenario: { name, url: `http://127.0.0.1:${server.port}`, scope: { inputs: ["index.html"] },
    steps: [{ action: "fill", selector: "#email", value: email, impact: "local-test", reason: "test sign-up" }, { action: "click", selector: "#go", impact: "local-test", reason: "test sign-up" }],
    assertions: [{ kind: "text", selector: "#out", expected: "Registered" }] } }) as Promise<{ id: string; status: string; assertions: Array<Record<string, unknown>> }>;
  const fresh = await signUp("account-register", "user-{run}@example.com");
  expect(fresh.status).toBe("pass");
  expect(await f.session.run({ action: "replay", id: fresh.id })).toMatchObject({ status: "pass" });
  expect(emails).toHaveLength(2);
  expect(emails[0]).not.toBe(emails[1]);
  for (const email of emails) expect(email).toMatch(/^user-[a-z0-9]+@example\.com$/);
  // The stored check keeps {run}.
  expect((f.session as unknown as { scenarios: Map<string, { scenario: { steps: Array<{ value?: string }> } }> }).scenarios.get(fresh.id)!.scenario.steps[0]!.value).toBe("user-{run}@example.com");
  // A fixed email passes once, then the page refuses it: the failure says to use {run}.
  const hint = "It passed before: a sign-up or booking may need a new value each run; use {run} in the fill value.";
  const fixed = await signUp("account-register b", "fixed@example.com");
  expect(fixed.status).toBe("pass");
  expect(await f.session.run({ action: "replay", id: fixed.id })).toMatchObject({ status: "fail", assertions: [{ actual: "That email is already registered", hint }] });
  // A check that failed when recorded gets no such hint.
  const failing = await signUp("account-register c", "fixed@example.com");
  expect(failing.status).toBe("fail");
  const again = await f.session.run({ action: "replay", id: failing.id }) as { status: string; assertions: Array<Record<string, unknown>> };
  expect(again.status).toBe("fail");
  expect(again.assertions[0]!.hint).not.toBe(hint);
}, 30_000);

browserTest("a failed check the AI wrote wrong can be withdrawn with a reason: it stays in the report, never decides it, and is never replayed", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, "<!doctype html><h1>Hello Casper</h1>");
  const scenario = (name: string, expected: string) => ({ name, url: f.url, scope: { inputs: ["index.html"] }, steps: [], assertions: [{ kind: "text", selector: "h1", expected }] });
  const wrong = await f.session.run({ action: "check", scenario: scenario("Heading", "Hello Caspr") });
  expect(wrong).toMatchObject({ status: "fail", freshness: "fresh" });
  const right = await f.session.run({ action: "check", scenario: scenario("Heading b", "Hello Casper") });
  expect(right).toMatchObject({ status: "pass", freshness: "fresh" });
  expect((await f.session.report()).status).toBe("fail");
  // A passing check, a missing reason or an unknown id is refused.
  await expect(f.session.run({ action: "withdraw", id: right.id, reason: "not needed" })).rejects.toThrow("Only a failed or unfinished check can be withdrawn; this one passed");
  await expect(f.session.run({ action: "withdraw", id: wrong.id })).rejects.toThrow("Browser reason is missing");
  await expect(f.session.run({ action: "withdraw", id: "nope", reason: "x" })).rejects.toThrow("Unknown browser check id");
  expect(await f.session.run({ action: "withdraw", id: wrong.id, reason: "expected text had a typo" }))
    .toMatchObject({ id: wrong.id, name: "Heading", status: "withdrawn", reason: "expected text had a typo" });
  expect(await f.session.report()).toMatchObject({ status: "pass", checks: [
    { id: wrong.id, status: "withdrawn", withdrawn: "expected text had a typo", baseline: "fail" }, { id: right.id, status: "pass" }] });
  await expect(f.session.run({ action: "withdraw", id: wrong.id, reason: "again" })).rejects.toThrow("already withdrawn");
  await expect(f.session.run({ action: "replay", id: wrong.id })).rejects.toThrow("This check was withdrawn; record a new check");
  // After a later edit Casper's end replay runs the other check, never the withdrawn one.
  f.session.invalidate();
  const replayed: string[] = [];
  await f.session.replayStale(0, undefined, name => replayed.push(name));
  expect(replayed).toEqual(["Heading b"]);
  expect(await f.session.report()).toMatchObject({ status: "pass", checks: [{ id: wrong.id, status: "withdrawn" }, { id: right.id, status: "pass", freshness: "fresh" }] });
}, 30_000);

browserTest("a failed check can't be withdrawn once anything changed after it: an edit, a command or its files", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, "<!doctype html><h1>Hello Casper</h1>");
  const failing = await f.session.run({ action: "check", scenario: { name: "Heading", url: f.url, scope: { inputs: ["index.html"] }, steps: [],
    assertions: [{ kind: "text", selector: "h1", expected: "Saved" }] } });
  expect(failing).toMatchObject({ status: "fail", freshness: "fresh" });
  // An edit or command Casper saw after the failure.
  f.session.invalidate();
  await expect(f.session.run({ action: "withdraw", id: failing.id, reason: "wrong text" })).rejects.toThrow("Code/tool writes observed after this browser check: fix the page and replay it");
  // Replayed after that change it still fails, fresh: the failure may be real (a fix that didn't work), so still refused.
  expect(await f.session.run({ action: "replay", id: failing.id })).toMatchObject({ status: "fail", freshness: "fresh" });
  await expect(f.session.run({ action: "withdraw", id: failing.id, reason: "wrong text" })).rejects.toThrow("A change was made after this check was recorded");
  // A check whose file changes on disk after it failed.
  const other = await f.session.run({ action: "check", scenario: { name: "Heading 2", url: f.url, scope: { inputs: ["index.html"] }, steps: [],
    assertions: [{ kind: "text", selector: "h1", expected: "Saved" }] } });
  expect(other).toMatchObject({ status: "fail", freshness: "fresh" });
  await writeFile(f.sourceFile, "<!doctype html><h1>Hello again</h1>");
  await expect(f.session.run({ action: "withdraw", id: other.id, reason: "wrong text" })).rejects.toThrow("Declared local inputs changed after this browser check: fix the page and replay it");
  expect(await f.session.report()).toMatchObject({ status: "fail", checks: [{ status: "fail" }, { status: "fail" }] });
}, 30_000);

browserTest("after a change a wrong check can be withdrawn by naming a later passing check of the same page; an older, failing or other-page one is refused", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, '<!doctype html><section id="done"><h2>Booked</h2><p>Monday 09:00</p></section><p id="total">Total: 100</p>');
  const scenario = (name: string, url: string, selector: string, expected: string) => ({ name, url, scope: { inputs: ["index.html"] }, steps: [],
    assertions: [{ kind: "text", selector, expected }] });
  const older = await f.session.run({ action: "check", scenario: scenario("Older", f.url, "h2", "Booked") });
  const wrong = await f.session.run({ action: "check", scenario: scenario("Booking", f.url, "#done", "Booked") }) as { id: string; assertions: Array<Record<string, unknown>> };
  // The text is there, inside a wider element: the hint says to narrow the selector, even on the recording run.
  expect(wrong.assertions[0]).toMatchObject({ status: "fail", hint: "The expected text is inside this element with other text: point the selector at the element that holds only it (see near)." });
  // A wrong text that merely contains the expected one is a page that may be wrong: no hint to narrow the selector.
  const total = await f.session.run({ action: "check", scenario: scenario("Total", f.url, "#total", "Total: 10") }) as { assertions: Array<Record<string, unknown>> };
  expect(total.assertions[0]).toMatchObject({ status: "fail", actual: "Total: 100" });
  expect("hint" in total.assertions[0]!).toBe(false);
  f.session.invalidate();
  const refused = await f.session.run({ action: "withdraw", id: wrong.id, reason: "selector too wide" }).catch((e: Error) => e.message);
  expect(refused).toContain("or record a corrected check of the same page and, once it passes, withdraw this one with replacedBy: its id");
  const failing = await f.session.run({ action: "check", scenario: scenario("Booking 2", f.url, "h2", "Booked!") });
  const elsewhere = await f.session.run({ action: "check", scenario: scenario("Booking 3", `${f.url}/other`, "h2", "Booked") });
  expect(elsewhere).toMatchObject({ status: "pass" });
  const withdraw = (replacedBy: unknown) => f.session.run({ action: "withdraw", id: wrong.id, reason: "selector too wide", replacedBy });
  await expect(withdraw(older.id)).rejects.toThrow("replacedBy must name a check recorded after this one");
  await expect(withdraw(failing.id)).rejects.toThrow("replacedBy must name a check whose latest run passed");
  await expect(withdraw(elsewhere.id)).rejects.toThrow("replacedBy must check the same page as this one (/), not /other");
  await expect(withdraw(wrong.id)).rejects.toThrow("replacedBy must be the id of another check");
  // A check that only shows the page loads, or one at another viewport, can't stand in for it.
  const loads = await f.session.run({ action: "check", scenario: { name: "Loads", url: f.url, scope: { inputs: ["index.html"] }, steps: [], assertions: [{ kind: "visible", selector: "h2" }] } });
  const phone = await f.session.run({ action: "check", scenario: { ...scenario("Phone", f.url, "#done h2", "Booked"), viewport: { width: 390, height: 844 } } });
  expect([loads, phone]).toMatchObject([{ status: "pass" }, { status: "pass" }]);
  await expect(withdraw(loads.id)).rejects.toThrow("replacedBy must test at least what this check did; it has fewer text assertions");
  await expect(withdraw(phone.id)).rejects.toThrow("replacedBy must check the page at the same viewport as this one (1280×800)");
  // The same page (its query aside), recorded later, passing: it takes the old check's place.
  const right = await f.session.run({ action: "check", scenario: scenario("Booking fixed", `${f.url}/?date=2026-10-19`, "#done h2", "Booked") });
  expect(right).toMatchObject({ status: "pass" });
  expect(await withdraw(right.id)).toMatchObject({ status: "withdrawn", reason: `selector too wide (replaced by "Booking fixed", ${right.id})` });
  const report = await f.session.report();
  expect(report.checks.find(c => c.id === wrong.id)).toMatchObject({ status: "withdrawn", withdrawn: `selector too wide (replaced by "Booking fixed", ${right.id})` });
  // The failing replacement candidate still counts on its own.
  expect(report.status).toBe("fail");
}, 30_000);

browserTest("a replay whose own server is gone opens the same path on Casper's server; with none up it could not check (incomplete, not failed)", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, "<!doctype html><h1>Hello Casper</h1>");
  const own = () => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => new Response(await readFile(f.sourceFile), { headers: { "content-type": "text/html" } }) });
  const scenario = (name: string, url: string, expected: string) => ({ name, url, scope: { inputs: ["index.html"] }, steps: [], assertions: [{ kind: "text", selector: "h1", expected }] });
  // The AI started this server itself, recorded a check on it, then stopped it.
  const first = own(), gone = first.port;
  const moved = await f.session.run({ action: "check", scenario: scenario("Home", `http://127.0.0.1:${gone}/index.html?x=1`, "Hello Casper") });
  const failed = await f.session.run({ action: "check", scenario: scenario("Home wrong", `http://127.0.0.1:${gone}/index.html`, "Bye") });
  expect(moved).toMatchObject({ status: "pass" });
  expect(failed).toMatchObject({ status: "fail" });
  await first.stop(true);
  f.session.invalidate();
  // No server answers: nothing was checked, so neither the old pass nor the old failure stands.
  await expect(f.session.run({ action: "replay", id: moved.id })).rejects.toThrow(`Nothing answers at http://127.0.0.1:${gone} any more and Casper runs no server for this project; start it with serve and replay`);
  await f.session.replayStale(0);
  expect(await f.session.report()).toMatchObject({ status: "incomplete", checks: [
    { id: moved.id, status: "incomplete", reason: expect.stringContaining("Could not check. Nothing answers") },
    { id: failed.id, status: "incomplete", reason: expect.stringContaining("Could not check. Nothing answers") }] });
  // Casper's own server runs the project now: the replay opens the same path there.
  const port = await freePort();
  await f.session.run({ action: "serve", script: "files", url: `http://127.0.0.1:${port}/`, impact: "local-test", reason: "Synthetic files" });
  const again = await f.session.run({ action: "replay", id: moved.id });
  expect(again).toMatchObject({ status: "pass", url: `http://127.0.0.1:${gone}/index.html?x=1`,
    notes: [`opened on Casper's server http://127.0.0.1:${port}: nothing answers at http://127.0.0.1:${gone} any more`] });
  expect(await f.session.run({ action: "replay", id: failed.id })).toMatchObject({ status: "fail", freshness: "fresh" });
}, 30_000);

browserTest("a new check whose step selector matches several elements is not kept, so it can't hold the result at incomplete", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, "<!doctype html><button>A</button><button>B</button><h1>Hi</h1>");
  const error = await f.session.run({ action: "check", scenario: { name: "Two buttons", url: f.url, scope: { inputs: ["index.html"] },
    steps: [{ action: "click", selector: "button", impact: "local-test", reason: "Test" }], assertions: [{ kind: "visible", selector: "h1" }] } }).catch((e: Error) => e.message);
  expect(error).toContain("it matches 2: name one element and record the check again (nothing was recorded)");
  expect((await f.session.report()).checks).toHaveLength(0);
}, 30_000);

browserTest("a check step waits up to 5 s for its target to appear or be enabled; several matches fail at once", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><h1>Slots</h1><button id="go" disabled>Go</button><p id="out"></p><script>
    setTimeout(() => { const b = document.createElement("button"); b.id = "slot"; b.textContent = "10:00";
      b.onclick = () => { document.getElementById("out").textContent += "slot "; }; document.body.append(b); }, 1500);
    setTimeout(() => { const g = document.getElementById("go"); g.disabled = false; g.onclick = () => { document.getElementById("out").textContent += "go"; }; }, 1000);</script>`);
  const late = await f.session.run({ action: "check", scenario: { name: "Late slot", url: f.url, scope: { inputs: ["index.html"] }, steps: [
    { action: "click", selector: "#slot", impact: "local-test", reason: "Pick a slot" },
    { action: "click", selector: "#go", impact: "local-test", reason: "Continue" }],
    assertions: [{ kind: "text", selector: "#out", expected: "slot go" }] } });
  expect(late).toMatchObject({ status: "pass" });
  let started = performance.now();
  const never = await f.session.run({ action: "check", scenario: { name: "Missing", url: f.url, scope: { inputs: ["index.html"] },
    steps: [{ action: "click", selector: "#never", impact: "local-test", reason: "Test" }], assertions: [{ kind: "visible", selector: "h1" }] } }).catch((e: Error) => e.message);
  expect(never).toContain("it matches 0");
  expect(performance.now() - started).toBeGreaterThan(4_900);
  await writeFile(f.sourceFile, "<!doctype html><button>A</button><button>B</button><h1>Hi</h1>");
  started = performance.now();
  const two = await f.session.run({ action: "check", scenario: { name: "Two", url: f.url, scope: { inputs: ["index.html"] },
    steps: [{ action: "click", selector: "button", impact: "local-test", reason: "Test" }], assertions: [{ kind: "visible", selector: "h1" }] } }).catch((e: Error) => e.message);
  expect(two).toContain("it matches 2");
  expect(performance.now() - started).toBeLessThan(4_000);
}, 40_000);

browserTest("a covered button fails its click naming the cover; a click that changes nothing and a confirm dialog are reported", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><h1>Items</h1><button id="save">Save</button><button id="dead">Dead</button>
    <button id="del" onclick="if (confirm('Clear this item?')) document.querySelector('h1').textContent = 'Cleared'">Clear</button>
    <button id="add" onclick="document.querySelector('h1').textContent = 'Added'">Add</button>
    <label for="agree">Agree</label><input id="agree" type="checkbox" style="position:absolute;left:0;top:300px">
    <input id="name" aria-label="Name"><button id="pin" aria-pressed="false" onclick="this.setAttribute('aria-pressed', 'true')">Pin</button>
    <a id="new" href="/?open" target="_blank">Help</a>
    <div class="toast" style="position:fixed;inset:0;background:#fff">Saved <span>just now</span></div>
    <script>document.querySelector('.toast').style.display = location.search ? 'none' : ''</script>`);
  await f.session.run({ action: "open", url: f.url });
  const step = (selector: string) => ({ action: "click", selector, impact: "local-test", reason: "Test" });
  const covered = await f.session.run(step("#save")).catch((e: Error) => e.message);
  expect(covered).toContain('button "Save" is covered by div.toast "Saved just now"');
  await f.session.run({ action: "open", url: `${f.url}/?open` });
  const dead = await f.session.run(step("#dead"));
  expect(dead).toMatchObject({ executed: true, note: 'nothing changed after clicking button "Dead"' });
  const added = await f.session.run(step("#add"));
  expect(added.note).toBeUndefined();
  expect(await f.session.run(step("#agree"))).not.toHaveProperty("note");
  // Clicking into a field and a toggle that only changes aria-pressed change something.
  for (const selector of ["#name", "#pin"]) expect(await f.session.run(step(selector))).not.toHaveProperty("note");
  const asked = await f.session.run(step("#del"));
  expect(asked.dialogs).toEqual(['confirm dialog "Clear this item?": Casper answered Cancel']);
  // A check names the dialog and the dead click on its steps.
  const check = await f.session.run({ action: "check", scenario: { name: "Clear", url: `${f.url}/?open`, scope: { inputs: ["index.html"] },
    steps: [step("#dead"), step("#del")], assertions: [{ kind: "text", selector: "h1", expected: "Items" }] } });
  expect(check).toMatchObject({ status: "pass", notes: ['step 1: nothing changed after clicking button "Dead"', 'step 2: confirm dialog "Clear this item?": Casper answered Cancel'] });
  // So does a link that opens a new tab.
  await f.session.run({ action: "open", url: `${f.url}/?open` });
  expect(await f.session.run(step("#new"))).not.toHaveProperty("note");
}, 40_000);

browserTest("an action's result says what changed on the page: text that appeared, controls added or removed, focus, title and address", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><title>Form</title><h1>Sign up</h1><input id="email" aria-label="Email"><button id="send">Join</button>
    <button id="next" onclick="location.hash = 'two'">Next</button><button id="plain" onclick="this.after('Done')">Plain</button><div id="box"><button id="redraw">Redraw</button></div><script>
    document.getElementById("box").onclick = () => { const b = document.createElement("button"); b.textContent = "Redraw"; b.id = "redraw";
      document.getElementById("box").replaceChildren(b, "Again"); b.focus(); };</script><p class="toast" hidden>Check your email address</p><script>
    document.getElementById("send").onclick = () => { document.querySelector(".toast").hidden = false; document.title = "Form (1 error)";
      document.getElementById("send").remove(); const retry = document.createElement("button"); retry.textContent = "Try again"; document.body.append(retry);
      document.getElementById("email").focus(); };</script>`);
  await f.session.run({ action: "open", url: f.url });
  const step = (selector: string) => ({ action: "click", selector, impact: "local-test", reason: "Test" });
  const sent = await f.session.run(step("#send"));
  expect(sent.changes).toEqual({ title: "Form (1 error)", appeared: "Check your email address", controlsAdded: ['button "Try again"'],
    controlsRemoved: ['button "Join"'], focus: 'textbox "Email"' });
  // Focus landing on the clicked button is not named.
  const plain = await f.session.run(step("#plain"));
  expect(plain.changes).toEqual({ appeared: "Done" });
  // Nor on the same button drawn again.
  const redrawn = await f.session.run(step("#redraw"));
  expect(redrawn.changes).toEqual({ appeared: "Again" });
  const typed = await f.session.run({ action: "fill", selector: "#email", value: "a@example.com", impact: "local-test", reason: "Test" });
  expect(typed).not.toHaveProperty("changes");
  const moved = await f.session.run(step("#next"));
  expect(moved.changes).toMatchObject({ previousUrl: `${f.url}/` });
  expect(moved.url).toBe(`${f.url}/#two`);
}, 40_000);

browserTest("a new check that stops part way gives its id back, and can be withdrawn until anything changes", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, "<!doctype html><h1>Hi</h1>");
  const scenario = { name: "Save button", url: f.url, scope: { inputs: ["index.html"] },
    steps: [{ action: "click", selector: "#save", impact: "local-test", reason: "Test" }], assertions: [{ kind: "visible", selector: "h1" }] };
  const error = await f.session.run({ action: "check", scenario }).catch((e: Error) => e.message);
  const id = /check id ([\w-]+)/.exec(String(error))?.[1];
  expect(error).toContain("replay it once the page is ready, or withdraw it if the check is wrong");
  expect(await f.session.report()).toMatchObject({ status: "incomplete", checks: [{ id, status: "incomplete" }] });
  expect(await f.session.run({ action: "withdraw", id, reason: "wrong selector" })).toMatchObject({ status: "withdrawn" });
  expect(await f.session.report()).toMatchObject({ checks: [{ id, status: "withdrawn" }] });
  // After an edit or command it may be a real failure: replay it instead.
  const again = await f.session.run({ action: "check", scenario }).catch((e: Error) => e.message);
  const second = /check id ([\w-]+)/.exec(String(again))?.[1];
  f.session.invalidate();
  await expect(f.session.run({ action: "withdraw", id: second, reason: "x" })).rejects.toThrow("A change was made after this check was recorded: replay it");
}, 30_000);

browserTest("a check recorded before its server ran is recorded by its first finished run: a failure there can be withdrawn, one after a later edit can't", async () => {
  const f = await fixture();
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = closed.port;
  closed.stop(true);
  const scenario = (name: string) => ({ name, url: `http://127.0.0.1:${port}/`, scope: { inputs: ["index.html"] }, steps: [],
    assertions: [{ kind: "text", selector: "h1", expected: "Booking" }] });
  const record = async (name: string) => /check id ([\w-]+)/.exec(String(await f.session.run({ action: "check", scenario: scenario(name) }).catch((e: Error) => e.message)))?.[1];
  const first = await record("Home");
  const second = await record("Home 2");
  expect(await f.session.report()).toMatchObject({ checks: [{ id: first, baseline: "incomplete" }, { id: second, baseline: "incomplete" }] });
  // The app is written (an edit), but another app answers on that port.
  f.session.invalidate();
  const other = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("<!doctype html><h1>Another app</h1>", { headers: { "content-type": "text/html" } }) });
  try {
    await expect(f.session.run({ action: "withdraw", id: first, reason: "wrong port" })).rejects.toThrow("A change was made after this check was recorded: replay it");
    const replayed = await f.session.run({ action: "replay", id: first }) as { status: string; assertions: Array<Record<string, unknown>> };
    expect(replayed).toMatchObject({ status: "fail", baseline: "fail", freshness: "fresh" });
    expect(replayed.assertions.some(a => "hint" in a)).toBe(false);
    expect(await f.session.run({ action: "withdraw", id: first, reason: "another app owns that port" })).toMatchObject({ status: "withdrawn" });
    // Its first finished run is a real baseline: a failure after a later edit may be real, so it stays locked.
    expect(await f.session.run({ action: "replay", id: second })).toMatchObject({ status: "fail", baseline: "fail" });
    f.session.invalidate();
    expect(await f.session.run({ action: "replay", id: second })).toMatchObject({ status: "fail", freshness: "fresh" });
    await expect(f.session.run({ action: "withdraw", id: second, reason: "x" })).rejects.toThrow("A change was made after this check was recorded, so its failure may be real");
    expect(await f.session.report()).toMatchObject({ status: "fail", checks: [{ id: first, status: "withdrawn" }, { id: second, status: "fail" }] });
  } finally { other.stop(true); }
}, 30_000);

browserTest("the browser tool's screenshot comes with the picture, and its text no longer says to read the PNG", async () => {
  const f = await fixture();
  const tool = browserTool(f.session);
  expect((await tool.execute({ action: "open", url: f.url })).images).toBeUndefined();
  const shot = await tool.execute({ action: "screenshot" });
  expect(shot.isError).toBeUndefined();
  expect(shot.images).toHaveLength(1);
  expect(shot.images![0]!.mimeType).toBe("image/png");
  expect(Buffer.from(shot.images![0]!.data, "base64").subarray(1, 4).toString()).toBe("PNG");
  expect(shot.text).not.toContain("read tool");
  expect(shot.text).not.toContain(shot.images![0]!.data.slice(0, 64));
  expect(JSON.parse(shot.text).data.path).toEqual(expect.stringContaining(f.state));
  expect(tool.description).not.toContain("read the PNG");
  expect(tool.description).toContain("Casper replays stale checks at the end");
}, 20_000);

browserTest("a check and a replay bring the final page's picture and short text, so the model needs no open, inspect or screenshot after", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><title>Booking</title><h1>Hello Casper</h1><p>${"slot ".repeat(2000)}</p>${Array.from({ length: 30 }, (_, i) => `<button id="b${i}">Book ${i}</button>`).join("")}`);
  const tool = browserTool(f.session);
  const scenario = { name: "Heading", url: f.url, steps: [], assertions: [{ kind: "text", selector: "h1", expected: "Hello Casper" }] };
  const checked = await tool.execute({ action: "check", scenario });
  expect(checked.isError).toBeUndefined();
  expect(checked.images).toHaveLength(1);
  expect(Buffer.from(checked.images![0]!.data, "base64").subarray(1, 4).toString()).toBe("PNG");
  expect(Buffer.byteLength(checked.text)).toBeLessThanOrEqual(16_384);
  const data = JSON.parse(checked.text).data;
  expect(data).toMatchObject({ status: "pass", finalPage: { title: "Booking", url: expect.stringContaining(f.url) } });
  expect(data.finalPage.text.length).toBeLessThanOrEqual(1500);
  expect(data.finalPage.elements).toHaveLength(20);
  expect(data.finalPage.elements[0]).toMatchObject({ selector: "#b0" });
  expect(data.finalPage.screenshot).toEqual(expect.stringContaining(f.state));
  const replayed = await tool.execute({ action: "replay", id: data.id });
  expect(replayed.images).toHaveLength(1);
  expect(JSON.parse(replayed.text).data.finalPage.title).toBe("Booking");
  // Never kept: the report and its checks carry no page text or picture.
  expect(JSON.stringify(await f.session.report())).not.toContain("finalPage");
}, 30_000);

browserTest("with showPages off a check's final page comes as text only", async () => {
  const f = await fixture({ checkPictures: () => false });
  const tool = browserTool(f.session);
  const checked = await tool.execute({ action: "check", scenario: { name: "Heading", url: f.url, steps: [], assertions: [{ kind: "text", selector: "h1", expected: "Hello Casper" }] } });
  expect(checked.images).toBeUndefined();
  expect(JSON.parse(checked.text).data.finalPage).toMatchObject({ title: "Browser fixture" });
  expect(JSON.parse(checked.text).data.finalPage.screenshot).toBeUndefined();
}, 20_000);

browserTest("a failing check on a crowded page keeps a whole result: its final page gets fewer controls and shorter text", async () => {
  const f = await fixture();
  const long = (i: number) => `item-${i}-${"x".repeat(120)}`;
  await writeFile(f.sourceFile, `<!doctype html><title>Shop</title><h1>Shop</h1><p>${"Unicode text 文字 ".repeat(200)}</p>${Array.from({ length: 30 }, (_, i) =>
    `<a href="#" id="${long(i)}" name="${long(i)}">\n  <div>${"Product name that is quite long ".repeat(5)}</div>\n</a>`).join("")}${Array.from({ length: 4 }, (_, i) =>
    `<div class="price-${i}">${"Long price text ".repeat(80)}</div>`).join("")}`);
  const checked = await browserTool(f.session).execute({ action: "check", scenario: { name: "Prices", url: f.url, steps: [],
    assertions: Array.from({ length: 4 }, (_, i) => ({ kind: "text", selector: `.price-${i}`, expected: "Cheap" })) } });
  const result = JSON.parse(checked.text);
  expect(result).toMatchObject({ summary: "Complete result.", truncated: false, data: { status: "fail", finalPage: { title: "Shop" } } });
  expect(result.data.assertions).toHaveLength(4);
  expect(result.data.finalPage.elements.length).toBeLessThan(20);
}, 30_000);

browserTest("stopping while the final page is read leaves the decided check as it was", async () => {
  const stop = new AbortController();
  const f = await fixture({ checkPictures: () => { stop.abort(); return true; } });
  const checked = await browserTool(f.session).execute({ action: "check", scenario: { name: "Heading", url: f.url, steps: [], assertions: [{ kind: "text", selector: "h1", expected: "Hello Casper" }] } }, stop.signal);
  expect(checked.images).toBeUndefined();
  expect((await f.session.report()).checks[0]).toMatchObject({ status: "pass" });
}, 20_000);

browserTest("fill types into number, email and date fields; password stays out; a scoped overflow check looks at one element", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><meta name="viewport" content="width=device-width"><main>
    <input id="count" type="number" value="4"><input id="mail" type="email"><input id="day" type="date"><input id="secret" type="password">
    <div id="wide" style="width:200px;overflow-x:auto"><table style="width:650px"><tr><td>row</td></tr></table></div>
    <p id="out"></p></main><script>for (const id of ["count","mail","day"]) document.getElementById(id).oninput = () => {
      document.getElementById("out").textContent = ["count","mail","day"].map(i => document.getElementById(i).value).join("|"); };</script>`);
  const result = await f.session.run({ action: "check", scenario: { name: "Fields at phone width", url: f.url, viewport: { width: 390, height: 800 }, steps: [
    { action: "fill", selector: "#count", value: "16", impact: "local-test", reason: "Synthetic count" },
    { action: "fill", selector: "#mail", value: "a@example.test", impact: "local-test", reason: "Synthetic address" },
    { action: "fill", selector: "#day", value: "2026-09-30", impact: "local-test", reason: "Synthetic date" },
  ], assertions: [{ kind: "text", selector: "#out", expected: "16|a@example.test|2026-09-30" }, { kind: "no-horizontal-overflow" },
    { kind: "no-horizontal-overflow", selector: "#wide" }] } });
  expect(result).toMatchObject({ status: "fail", assertions: [{ status: "pass" }, { status: "pass" }, { status: "fail" }] });
  await f.session.run({ action: "open", url: f.url });
  // A password field takes a made-up test password only as a local test on a page on this computer.
  await expect(f.session.run({ action: "fill", selector: "#secret", value: "x", impact: "uncertain", reason: "Login" })).rejects.toThrow("A password field is filled only as a local test");
  expect(await f.session.run({ action: "fill", selector: "#secret", value: "test-pass-123", impact: "local-test", reason: "Synthetic test account" })).toMatchObject({ executed: true });
}, 25_000);

browserTest("a check can log in to a local page with a made-up password; payment and file inputs stay out", async () => {
  // Browser clicks on, the default: a "Log in" button on a local page runs without asking.
  const f = await fixture({ allowActions: () => true });
  await writeFile(f.sourceFile, `<!doctype html><main><input id="user" type="email"><input id="pw" type="password" autocomplete="current-password">
    <button id="go">Log in</button><p id="out"></p><input id="card" autocomplete="cc-number"><input id="up" type="file"></main>
    <script>document.getElementById("go").onclick = () => { document.getElementById("out").textContent =
      document.getElementById("pw").value === "test-pass-123" ? "Signed in" : "Wrong password"; };</script>`);
  const result = await f.session.run({ action: "check", scenario: { name: "Log in", url: f.url, scope: { inputs: ["index.html"] }, steps: [
    { action: "fill", selector: "#user", value: "a@example.test", impact: "local-test", reason: "Made-up test account" },
    { action: "fill", selector: "#pw", value: "test-pass-123", impact: "local-test", reason: "Made-up test password" },
    { action: "click", selector: "#go", impact: "local-test", reason: "Log in to the local test account" },
  ], assertions: [{ kind: "text", selector: "#out", expected: "Signed in" }] } });
  expect(result).toMatchObject({ status: "pass" });
  await f.session.run({ action: "open", url: f.url });
  await expect(f.session.run({ action: "fill", selector: "#card", value: "4242424242424242", impact: "local-test", reason: "x" })).rejects.toThrow("Payment, one-time-code and file-upload");
  await expect(f.session.run({ action: "fill", selector: "#up", value: "a.txt", impact: "local-test", reason: "x" })).rejects.toThrow("Payment, one-time-code and file-upload");
}, 25_000);

browserTest("local synthetic interactions proceed while consequential actions require approval", async () => {
  const approvals: unknown[] = [];
  const f = await fixture({ confirm: async request => { approvals.push(request); return false; } });
  await f.session.run({ action: "open", url: f.url });
  await f.session.run({ action: "click", selector: "button", impact: "local-test", reason: "Synthetic fixture button" });
  expect(approvals).toEqual([]);
  await expect(f.session.run({ action: "click", selector: "button", impact: "consequential", reason: "Send a real message" })).rejects.toThrow("approval");
  expect(approvals).toHaveLength(1);
  await expect(f.session.run({ action: "click", selector: "button" })).rejects.toThrow("impact");
}, 20_000);

browserTest("the next task's browser replays an earlier task's check: it counts there only once it runs, and that run is its baseline", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, "<!doctype html><h1>Old title</h1>");
  const title = await f.session.run({ action: "check", scenario: { name: "Title", url: f.url, scope: { inputs: ["index.html"] }, steps: [],
    assertions: [{ kind: "text", selector: "h1", expected: "New title" }] } }) as { id: string };
  expect(title).toMatchObject({ status: "fail", baseline: "fail" });
  await writeFile(f.sourceFile, "<!doctype html><h1>New title</h1>");
  f.session.invalidate();
  expect(await f.session.run({ action: "replay", id: title.id })).toMatchObject({ status: "pass", baseline: "fail" });
  // That task ends and its browser closes; the next task's browser has the check.
  await f.session.close();
  const next = new BrowserSession({ projectRoot: f.project, stateDirectory: f.state, executablePath: executable, carried: f.session.carried() });
  cleanup.push(() => next.close());
  expect(await next.report()).toMatchObject({ status: "incomplete", checks: [] });
  // Its first run here is this task's before-edit result: the earlier task's failure is not this task's proof.
  expect(await next.run({ action: "replay", id: title.id })).toMatchObject({ status: "pass", baseline: "pass", freshness: "fresh" });
  expect(await next.report()).toMatchObject({ status: "pass", checks: [{ id: title.id, status: "pass", baseline: "pass" }] });
}, 60_000);

browserTest("an earlier task's failed check is withdrawn in the next task only after it runs there, or for a replacement that ran there", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, "<!doctype html><h1>Hello</h1>");
  const scenario = (name: string, expected: string) => ({ name, url: f.url, scope: { inputs: ["index.html"] }, steps: [],
    assertions: [{ kind: "text", selector: "h1", expected }] });
  const typo = await f.session.run({ action: "check", scenario: scenario("Typo", "Helo") }) as { id: string };
  const spelled = await f.session.run({ action: "check", scenario: scenario("Spelled", "Hello") }) as { id: string };
  expect([typo, spelled]).toMatchObject([{ status: "fail" }, { status: "pass" }]);
  await f.session.close();
  const next = new BrowserSession({ projectRoot: f.project, stateDirectory: f.state, executablePath: executable, carried: f.session.carried() });
  cleanup.push(() => next.close());
  await expect(next.run({ action: "withdraw", id: typo.id, reason: "typo" })).rejects.toThrow("recorded in an earlier task: replay it first");
  await expect(next.run({ action: "withdraw", id: typo.id, reason: "typo", replacedBy: spelled.id })).rejects.toThrow("replacedBy must name a check run in this task");
  expect(await next.run({ action: "replay", id: spelled.id })).toMatchObject({ status: "pass" });
  expect(await next.run({ action: "withdraw", id: typo.id, reason: "typo", replacedBy: spelled.id })).toMatchObject({ status: "withdrawn" });
  // Withdrawn here, it is named on this task's receipt, and its replacement decides.
  expect(await next.report()).toMatchObject({ status: "pass", checks: [{ id: typo.id, status: "withdrawn" }, { id: spelled.id, status: "pass" }] });
  // One that runs here first can be withdrawn as any check whose failure came before any change.
  const again = new BrowserSession({ projectRoot: f.project, stateDirectory: f.state, executablePath: executable,
    carried: [{ ...f.session.carried()[0]! }] });
  cleanup.push(() => again.close());
  expect(await again.run({ action: "replay", id: typo.id })).toMatchObject({ status: "fail", baseline: "fail" });
  expect(await again.run({ action: "withdraw", id: typo.id, reason: "typo" })).toMatchObject({ status: "withdrawn" });
}, 60_000);
