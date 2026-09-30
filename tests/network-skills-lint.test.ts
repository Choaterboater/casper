import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  BANNED_PHRASES, bundledSkills, CASPER_ASKS_LINE, CHANGING_SECTION, MAX_BUNDLED_BODY_BYTES, MAX_BUNDLED_DESCRIPTION,
  NETWORK_PLATFORMS, parseBundledSkill, REQUIRED_SECTIONS, safetyProblems, STOP_AND_ASK_LINE,
} from "../src/skills/bundled";
import { parseSkillMetadata, splitSkill } from "../src/skills/metadata";
import { scrubText } from "../src/secrets/scrub";

// Lints every bundled network skill as a file on disk, so a skill added to skills/network but not to
// src/skills/bundled.ts fails here too. Nothing is fetched: links are checked by host only.
const ROOT = path.join(import.meta.dir, "..");
const NETWORK = path.join(ROOT, "skills", "network");

async function skillFiles(): Promise<Array<{ file: string; relative: string; source: string }>> {
  const names = (await readdir(NETWORK, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(names.map(async (name) => {
    const file = path.join(NETWORK, name, "SKILL.md");
    return { file, relative: `skills/network/${name}/SKILL.md`, source: await readFile(file, "utf8") };
  }));
}

/** Only public doc hosts. github.com only for the vendors' own orgs and the Mist SDK. */
const DOC_HOSTS = new Set([
  "developer.arubanetworks.com", "arubanetworking.hpe.com", "www.hpe.com", "support.hpe.com", "www.juniper.net",
  "pypi.org", "junos-pyez.readthedocs.io", "ncclient.readthedocs.io", "docs.ansible.com", "www.rfc-editor.org",
  "datatracker.ietf.org", "github.com",
]);
const GITHUB_PATHS = /^\/(?:aruba|Juniper|mistsys|HewlettPackard)\/|^\/tmunzer\/mistapi_python(?:\/|$)/;
/** Hostnames a skill may name: public vendor API hosts, doc hosts and example domains. */
const NAMED_HOSTS = new Set([
  ...DOC_HOSTS, "api.mist.com", "api.eu.mist.com", "api.gc1.mist.com", "sso.common.cloud.hpe.com",
]);

function section(body: string, heading: string): string {
  const start = body.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const rest = body.slice(start + heading.length + 2);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Lines of a section outside `# WRITE` code blocks. */
function linesOutsideWriteBlocks(text: string): string[] {
  const lines: string[] = [];
  let inBlock = false;
  let writeBlock = false;
  let first = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inBlock = !inBlock; first = inBlock; writeBlock = false;
      continue;
    }
    if (inBlock && first) { writeBlock = line.trim() === "# WRITE"; first = false; }
    if (!writeBlock) lines.push(line);
  }
  return lines;
}

const WRITE_VERB = /\b(?:POST|PUT|PATCH|DELETE)\b|\.commit\(|commit confirmed|\bload (?:merge|replace|override|set|update)\b|\bcu\.load\b|request system|\breboot\b|\bzeroize\b/;
const SIGN_IN_LINE = /sign-in|login|logout|log out|\/oauth|token|\.post\(/i;

describe("bundled network skills: format", () => {
  test("every skill folder is bundled into Casper, and nothing else is", async () => {
    const files = await skillFiles();
    expect(files.map(({ relative }) => relative).sort()).toEqual(bundledSkills().map((skill) => skill.path).sort());
    for (const { source, relative } of files) {
      const bundled = bundledSkills().find((skill) => skill.path === relative)!;
      expect(bundled.source).toBe(source);
    }
  });

  test.each(["aoscx", "central", "central-classic", "clearpass", "junos", "mist"])("%s: front-matter, size and sections", async (folder) => {
    const source = await readFile(path.join(NETWORK, folder, "SKILL.md"), "utf8");
    const { header, body } = splitSkill(source);
    const metadata = parseSkillMetadata(header);
    expect(metadata.name).toMatch(/^network-[a-z0-9-]+$/);
    expect(metadata.description.length).toBeLessThanOrEqual(MAX_BUNDLED_DESCRIPTION);
    expect(metadata.description).not.toContain("\n");
    const skill = parseBundledSkill(source, `skills/network/${folder}/SKILL.md`);
    expect(NETWORK_PLATFORMS).toContain(skill.rule.platform);
    expect(skill.rule.strong.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BUNDLED_BODY_BYTES);
    expect(body.split("\n").filter((line) => line.startsWith("## "))).toEqual([...REQUIRED_SECTIONS]);
    expect(body.indexOf("\n## Read first\n")).toBeLessThan(body.indexOf(`\n${CHANGING_SECTION}\n`));
    // "Read first" names at least one call that asks for data.
    expect(section(body, "## Read first")).toMatch(/\bGET\b|\bget_|\bdev\.facts\b|\brpc\.get_/);
    const changing = section(body, CHANGING_SECTION).split("\n").map((line) => line.trim()).filter(Boolean);
    expect(changing[0]).toBe(STOP_AND_ASK_LINE);
    expect(changing[1]).toBe(CASPER_ASKS_LINE);
    expect(section(body, "## Public docs").match(/https:\/\//g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(body).not.toMatch(/\]\((?!https:)[^)]*\)/); // no relative links: a bundled skill has no folder
    expect(safetyProblems(body)).toEqual([]);
  });

  test("the loader refuses a skill that drops the layout, the stop-and-ask line or the size cap", async () => {
    const source = await readFile(path.join(NETWORK, "mist", "SKILL.md"), "utf8");
    expect(() => parseBundledSkill(source.replace(STOP_AND_ASK_LINE, "Go ahead."), "x")).toThrow("must open with");
    expect(() => parseBundledSkill(source.replace("## Read first", "## Reads"), "x")).toThrow("sections must be");
    expect(() => parseBundledSkill(source.replace("## Common traps", "## Common traps\nThese calls are read-only."), "x")).toThrow('uses "read-only"');
    expect(() => parseBundledSkill(source.replace("## Public docs", `## Public docs\n${"x".repeat(7000)}`), "x")).toThrow("larger than 6 KiB");
    expect(() => parseBundledSkill(source.replace('weak: ["mist"]', 'weak: ["api"]'), "x")).toThrow("too common");
    expect(() => parseBundledSkill(source.replace("platform: mist", "platform: fortigate"), "x")).toThrow("platform must be");
  });
});

describe("bundled network skills: wording", () => {
  test.each(["aoscx", "central", "central-classic", "clearpass", "junos", "mist"])("%s: no overclaiming words; write calls only under Changing things", async (folder) => {
    const { body } = splitSkill(await readFile(path.join(NETWORK, folder, "SKILL.md"), "utf8"));
    const lower = body.toLowerCase();
    for (const word of [...BANNED_PHRASES, "guarantees", "safe call", "safe calls"]) {
      expect({ folder, word, found: new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(lower) }).toEqual({ folder, word, found: false });
    }
    for (const heading of REQUIRED_SECTIONS) {
      if (heading === CHANGING_SECTION) continue;
      for (const line of linesOutsideWriteBlocks(section(body, heading))) {
        if (!WRITE_VERB.test(line)) continue;
        // A sign-in POST (token, login, logout) is allowed where sign-in is taught.
        const allowed = heading === "## Sign-in and tokens" && SIGN_IN_LINE.test(line) && !/PUT|PATCH|DELETE/.test(line);
        expect({ folder, heading, line, allowed }).toEqual({ folder, heading, line, allowed: true });
      }
    }
    // Under Changing things, every line naming a write call is marked WRITE (or sits in a # WRITE block).
    for (const line of linesOutsideWriteBlocks(section(body, CHANGING_SECTION))) {
      // A call is a verb followed by a path in backticks (`PUT /rest/...`); "`PUT` replaces ..." explains, it is not a call.
      if (!/`(?:POST|PUT|PATCH|DELETE) [^`]+`/.test(line)) continue;
      expect({ folder, line, marked: /\bWRITE:/.test(line) }).toEqual({ folder, line, marked: true });
    }
    expect(section(body, CHANGING_SECTION)).toMatch(/WRITE/);
  });
});

describe("bundled network skills: no secrets, no real hosts", () => {
  test.each(["aoscx", "central", "central-classic", "clearpass", "junos", "mist"])("%s: placeholders only", async (folder) => {
    const source = await readFile(path.join(NETWORK, folder, "SKILL.md"), "utf8");
    expect(scrubText(source).hidden).toBe(0);
    expect(source).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // JWT
    expect(source).not.toMatch(/\b[a-f0-9]{32,}\b/i);
    expect(source.replace(/https:\/\/\S+/g, "")).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
    expect(source).not.toMatch(/(?:Token|Bearer) [A-Za-z0-9._-]{16,}/);
    for (const uuid of source.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? []) {
      expect(uuid).toBe("00000000-0000-0000-0000-000000000000");
    }
    expect(source).not.toMatch(/\bpass(?:word|wd)?\s*[:=]\s*["'][^"'<$]{3,}["']/i);
    // IPv4 literals only from the documentation ranges.
    for (const ip of source.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
      expect({ ip, doc: /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip) }).toEqual({ ip, doc: true });
    }
    for (const ip of source.match(/192\.0\.2\.x/g) ?? []) expect(ip).toBe("192.0.2.x");
    // Every dotted name that looks like a host is a public vendor, doc or example host.
    const hosts = source.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|local|lan|corp|internal|intra)\b/gi) ?? [];
    for (const host of hosts) {
      const lower = host.toLowerCase();
      const ok = NAMED_HOSTS.has(lower) || /(?:^|\.)example\.(?:com|net|org)$/.test(lower);
      expect({ folder, host, ok }).toEqual({ folder, host, ok: true });
    }
    // Links: https only, on the doc host list, github only for the vendors' own repos.
    for (const link of source.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)`"'>]+/gi) ?? []) {
      if (link.startsWith("wss://<") || link.startsWith("https://<") || link.startsWith("https://{")) continue;
      const url = new URL(link);
      expect({ link, protocol: url.protocol }).toEqual({ link, protocol: "https:" });
      expect({ link, allowed: DOC_HOSTS.has(url.hostname) }).toEqual({ link, allowed: true });
      if (url.hostname === "github.com") expect({ link, vendor: GITHUB_PATHS.test(url.pathname) }).toEqual({ link, vendor: true });
    }
  });

  test("the lint catches a pasted token, a real-looking host and an internal host", () => {
    const planted = [
      "Authorization: Token 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a",
      "https://mist.corp.internal/api",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.x",
    ];
    expect(scrubText(planted[0]).hidden + (/\b[a-f0-9]{32,}\b/i.test(planted[0]) ? 1 : 0)).toBeGreaterThan(0);
    expect(/\b(?:[a-z0-9-]+\.)+(?:internal)\b/i.test(planted[1])).toBe(true);
    expect(/eyJ[A-Za-z0-9_-]{10,}/.test(planted[2])).toBe(true);
  });
});

describe("bundled network skills: version lock", () => {
  test("a changed skill file bumps its casper-skill version in skills/network/VERSIONS.json", async () => {
    const lock = JSON.parse(await readFile(path.join(NETWORK, "VERSIONS.json"), "utf8")) as Record<string, { version: number; sha256: string }>;
    const skills = bundledSkills();
    expect(Object.keys(lock).sort()).toEqual(skills.map((skill) => skill.metadata.name).sort());
    for (const skill of skills) {
      const entry = lock[skill.metadata.name]!;
      const sha256 = createHash("sha256").update(skill.source).digest("hex");
      // Edit a skill: bump casper-skill.version and write the new version and digest here.
      expect({ name: skill.metadata.name, version: skill.rule.version, sha256 }).toEqual({ name: skill.metadata.name, version: entry.version, sha256: entry.sha256 });
    }
  });
});
