import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CASPER_VERSION } from "../src/version";

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const section = (text: string, start: string, end: string) => {
  expect(text).toContain(start);
  expect(text).toContain(end);
  return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
};

// These are release-preparation assertions, not tests of the features themselves.
const changes = {
  Added: ["crew panel", "node:test", "Export this session", "/details all"],
  Changed: ["continue session", "Switch there", "Approval and question boxes", "First version steps"],
  Fixed: ["/export", "WSL", "holding only `.casper`", "grep pattern"],
};

test("v0.3.9 notes publish each user-facing change once under Added, Changed or Fixed", async () => {
  expect(CASPER_VERSION).toBe("0.3.9");
  const release = await read("docs/RELEASE.md");
  const notes = section(release, "## v0.3.9:", "## v0.3.8:");
  expect(notes).not.toMatch(/not released|unreleased|test-only|#(?:5[23])\d/i);
  expect([...notes.matchAll(/^### (.+)$/gm)].map(match => match[1])).toEqual(Object.keys(changes));
  const groups = notes.split(/^### /m).slice(1);
  for (const [index, [group, phrases]] of Object.entries(changes).entries()) {
    const lines = groups[index]!.trim().split("\n");
    expect(lines.shift()).toBe(group);
    const bullets = lines.filter(line => line.trim());
    expect(bullets).toHaveLength(phrases.length);
    expect(bullets.every(line => line.startsWith("- "))).toBe(true);
    for (const phrase of phrases) expect(bullets.filter(line => line.includes(phrase))).toHaveLength(1);
  }
  // Historical release content must retain its original version and WMI transition.
  expect(release).toContain("## v0.3.8: /continue that stays where it is, a pasted transcript read as context, and refusals that say why");
  expect(release).toContain("## v0.3.7: a new conversation at every start, fewer red marks that weren't failures, and code that isn't hidden as a secret");
  expect(release).toContain("## v0.3.6: /look without the slash, one key to fix what a look found, and browser checks that last the conversation");
  expect(release).toContain("## v0.3.5: work that keeps going until it is done, plan questions asked at once, and apps that stay running");
  expect(release).toContain("## v0.3.4: rows for OpenRouter's free, cheapest, newest and smartest models in /model");
  expect(release).toContain("## v0.3.3: failover when a model hits its limit, and a model list that stays current");
  expect(release).toContain("## v0.3.2: lines you type during a task, skills you add in chat, and pages that need a browser");
  expect(release).toContain("## v0.3.1: MCP servers on your own network, with the keys they need");
  expect(release).toContain("## v0.3.0: a context bar in the footer, diagrams in the browser, and small local models that get further");
  expect(release).toContain("## v0.2.50: receipts you can read, an AI that says what it is doing, and local models that compact in time");
  expect(release).toContain("## v0.2.46: local models that work, honest proof, and a browser that waits for web apps");
  expect(release).toContain("## v0.2.45: sign in for the AI's browser, the right network server, and fewer false Incompletes");
  expect(release).toContain("## v0.2.44: app databases are data, clearer sign-ins, and real reviewer lines");
  expect(release).toContain("## v0.2.43: timeouts on time, fewer false alarms, and tests for plain scripts");
  expect(release).toContain("## v0.2.42: missing programs named, and checks only for the AI's changes");
  expect(release).toContain("## v0.2.41: logins on any home, ssh by name, and no project push");
  expect(release).toContain("## v0.2.40: /look, steadier OpenRouter runs, ssh hosts by name, and a Home Assistant skill");
  expect(release).toContain("## v0.2.39: try the app before done");
  expect(release).toContain("## v0.2.38: plans that stay on");
  expect(release).toContain("## v0.2.37: builders opt-in");
  expect(release).toContain("## v0.2.36: empty projects, designed plans");
  expect(release).toContain("## v0.2.35: plain live steps");
  expect(release).toContain("updater, so install 0.2.35 on Windows");
});

test("v0.3.9 release bullets are short single sentences without internal implementation terms", async () => {
  const notes = section(await read("docs/RELEASE.md"), "## v0.3.9:", "## v0.3.8:");
  const bullets = notes.split("\n").filter(line => line.startsWith("- "));
  expect(bullets.length).toBeGreaterThan(0);
  for (const bullet of bullets) {
    expect(bullet.slice(2).trim().split(/\s+/).length, bullet).toBeLessThanOrEqual(25);
    expect(bullet.match(/[.!?](?:\s|$)/g)).toHaveLength(1);
    expect(bullet).toEndWith(".");
    expect(bullet).not.toMatch(/head\/gap\/tail|inherited pipes|deferred selection|process.close|worker cleanup|Git status/i);
  }
});

test("the roadmap ships v0.3.9 first and leaves no merged work in the next-release box", async () => {
  const page = await read("site/roadmap.html");
  const box = section(page, '<section id="next"', '<section id="coming"');
  expect(box).toContain("Built, not released");
  expect(box).toContain("everything built so far is in v0.3.9");
  expect(box).not.toContain("<li>");
  const current = section(page, 'id="v0309"', 'id="v0308"');
  expect(page).toContain('href="#v0309"');
  expect(current).toContain("current preview");
  for (const phrase of ["A crew you can watch", "Ctrl+O", "Plain words", "continue session", "/export", "Switch there", "Keys in boxes",
    "node:test", "WSL", ".casper"]) expect(current).toContain(phrase);
  const previous = section(page, 'id="v0308"', 'id="v0307"');
  expect(previous).toContain("previous preview");
  for (const phrase of ["/continue stays", "/resume", "An early 1", "1 Continue …", "Transcripts are context", "Big job",
    "Refusals that say why", "$d/cli.js"]) expect(previous).toContain(phrase);
  expect(section(page, 'id="v0307"', 'id="v0306"')).toContain("released");
  // A release card's id is its own: the planned "v0.3 · Crews" card keeps id="v030".
  expect(page.match(/id="v030"/g)).toHaveLength(1);
});

test("current docs and site installation targets name v0.3.9 without relabelling old captures", async () => {
  const tag = `v${CASPER_VERSION}`;
  for (const file of ["README.md", "docs/SCRIPTING.md", "docs/WINDOWS.md", "docs/RELEASE.md", "site/index.html"]) {
    const tags = [...(await read(file)).matchAll(/releases\/download\/(v\d+\.\d+\.\d+)/g)].map(match => match[1]);
    expect({ file, tags: [...new Set(tags)] }).toEqual({ file, tags: [tag] });
  }
  for (const file of ["404", "_template", "compare", "faq", "index", "network", "roadmap", "tour"]) {
    expect(await read(`site/${file}.html`)).toContain(`<strong>Casper ${CASPER_VERSION}</strong>`);
  }
  expect(await read("docs/DOCTOR.md")).toContain(`✓ Casper ${CASPER_VERSION}, the newest release`);
  const home = await read("site/index.html");
  expect(home).toContain(`New in ${CASPER_VERSION}`);
  expect(home).toContain("Verified background updates are on by default");
  expect(home).toContain("Helpers that build are off by default");
  expect(home).toContain("/look");
  expect(home).toContain("tries a changed app");
  const faq = await read("site/faq.html");
  expect(faq).toContain(`Straight answers about Casper ${CASPER_VERSION}`);
  expect(faq).toContain("Verified background updates are on by default");
  expect(faq).toContain("Updates: auto / notify only / off");
  expect(faq).toContain("row above the prompt");
  expect(faq).not.toContain("Nothing updates on its own");
  for (const text of [faq, await read("docs/TERMINAL_UX.md")]) expect(text).toContain("Casper 0.3.10 is out · casper update");
  expect(await read("site/tour.html")).toContain(`More in ${CASPER_VERSION}`);
  expect(await read("site/compare.html")).toContain(`plain Pi vs Casper ${CASPER_VERSION}`);
  const readme = await read("README.md");
  expect(readme).toContain(`v${CASPER_VERSION}:`);
  expect(readme).not.toMatch(/built, not released|next preview/i);
  for (const file of ["SCRIPTING", "SESSIONS", "UNDO", "VERIFICATION", "NEW", "TERMINAL_UX", "WINDOWS", "SECURITY", "SECURITY_CHECKS", "DEBUGGER"]) {
    expect(await read(`docs/${file}.md`)).not.toMatch(/built, not released|next preview/i);
  }
  for (const file of ["faq", "tour", "compare"]) expect(await read(`site/${file}.html`)).not.toMatch(/built, not released/i);
  expect(await read("site/captures/README.md")).toContain("real Casper 0.2.33 runs");
  expect(await read("docs/CREWS.md")).toContain("v0.2.35 the crew's full checks");
});

test("preview limits disclose opt-in sandboxing, automatic updates and the unproven Windows upgrade", async () => {
  const limits = (await read("docs/RELEASE.md")).split("## Known preview limits")[1]!;
  expect(limits).toContain("sandbox is off unless you turn it on");
  expect(limits).toContain("Windows has no sandbox");
  expect(limits).toContain("background updates are on by default");
  expect(limits).toContain("no rollback");
  expect(limits).toContain("0.2.35 → 0.2.36");
  expect(limits).toContain("first real test of the WMI handoff");
  expect(limits).toContain("not yet verified");
  expect(limits).not.toContain("nothing updates on its own");
});
