import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectModel } from "../src/project/model";
import {
  BANNED_PHRASES, bundledSkills, CASPER_ASKS_LINE, CHANGING_SECTION, HOMELAB_PLATFORMS, HOMELAB_SECTIONS, homelabSkills,
  MAX_BUNDLED_ACTIVE, MAX_BUNDLED_BODY_BYTES, MAX_BUNDLED_DESCRIPTION, parseBundledSkill, safetyProblems, scoreSkillRule, STOP_AND_ASK_LINE,
} from "../src/skills/bundled";
import { normaliseLineEndings, parseSkillMetadata, splitSkill } from "../src/skills/metadata";
import { formatSelectedSkills, SkillRegistry } from "../src/skills/registry";
import { scrubText } from "../src/secrets/scrub";
import { classifyTask } from "../src/task/classify";
import { removeTempDir } from "./support/temp-dir";

// The home lab skills (skills/homelab/<name>/SKILL.md): checked as files on disk and picked by the same word match as
// the network skills. Nothing is fetched: links are checked by host only.
const ROOT = path.join(import.meta.dir, "..");
const HOMELAB = path.join(ROOT, "skills", "homelab");
const FOLDERS = ["docker", "home-assistant", "media", "nettrouble", "proxmox"];

async function source(folder: string): Promise<string> {
  return normaliseLineEndings(await readFile(path.join(HOMELAB, folder, "SKILL.md"), "utf8"));
}

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
    if (line.startsWith("```")) { inBlock = !inBlock; first = inBlock; writeBlock = false; continue; }
    if (inBlock && first) { writeBlock = line.trim() === "# WRITE"; first = false; }
    if (!writeBlock) lines.push(line);
  }
  return lines;
}

/** A command or call that changes something, in backticks. */
const WRITE_CALL = new RegExp("`(?:sudo )?(?:(?:POST|PUT|PATCH|DELETE) [^`]+`|docker compose (?:up|down|restart|pull|rm|stop|start)\\b|"
  + "docker (?:restart|stop|rm|kill|pull|run|system prune|image prune|volume rm)\\b|(?:qm|pct) (?:stop|start|shutdown|reboot|snapshot|"
  + "rollback|destroy|set|delsnapshot|migrate)\\b|vzdump\\b|pvecm expected|apt (?:upgrade|full-upgrade)\\b|chown\\b|"
  + "ip (?:route|addr|link) (?:add|del|replace|change|set|flush)\\b|nft (?:add|insert|replace|delete|flush|-f)\\b|iptables(?:-restore| -[AIDRFPX])|"
  + "ufw (?:allow|deny|reject|delete|enable|disable|reset)\\b|pfctl -[fFed]\\b|resolvectl (?:dns|domain|revert|flush-caches)\\b|"
  + "ipconfig /(?:flushdns|release|renew)|dscacheutil -flushcache)");
const SIGN_IN_LINE = /sign in|login|\/auth\//i;

/** Public doc hosts the skills may link to. github.com only for the projects' own repositories. */
const DOC_HOSTS = new Set([
  "wiki.servarr.com", "trash-guides.info", "jellyfin.org", "support.plex.tv", "sabnzbd.org", "docs.docker.com",
  "pve.proxmox.com", "pbs.proxmox.com", "github.com", "man7.org", "www.tcpdump.org", "wiki.nftables.org", "curl.se",
  "www.rfc-editor.org", "www.home-assistant.io", "developers.home-assistant.io", "hacs.xyz", "mosquitto.org",
]);
const GITHUB_PATHS = /^\/(?:qdm12\/gluetun-wiki|qbittorrent\/qBittorrent)(?:\/|$)/;
/** Hosts a skill may name outside its docs: the public IP echo used in the VPN leak check. */
const CHECK_HOSTS = new Set(["ifconfig.io"]);
/** Well-known addresses a skill may name: Docker's DNS, the systemd-resolved stub and a public resolver to compare with. */
const CHECK_IPS = new Set(["127.0.0.11", "127.0.0.53", "1.1.1.1"]);

describe("bundled home lab skills: format", () => {
  test("every skill folder is bundled into Casper, and nothing else is", async () => {
    const folders = (await readdir(HOMELAB, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(folders).toEqual(FOLDERS);
    expect(homelabSkills().map((skill) => skill.path).sort()).toEqual(FOLDERS.map((folder) => `skills/homelab/${folder}/SKILL.md`));
    for (const folder of FOLDERS) {
      expect(homelabSkills().find((skill) => skill.path === `skills/homelab/${folder}/SKILL.md`)!.source).toBe(await source(folder));
    }
  });

  test.each(FOLDERS)("%s: front-matter, size and sections", async (folder) => {
    const text = await source(folder);
    const { header, body } = splitSkill(text);
    const metadata = parseSkillMetadata(header);
    expect(metadata.name).toMatch(/^homelab-[a-z0-9-]+$/);
    expect(metadata.description.length).toBeLessThanOrEqual(MAX_BUNDLED_DESCRIPTION);
    const skill = parseBundledSkill(text, `skills/homelab/${folder}/SKILL.md`);
    expect(HOMELAB_PLATFORMS).toContain(skill.rule.platform as typeof HOMELAB_PLATFORMS[number]);
    expect(skill.rule.family).toBe("homelab");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BUNDLED_BODY_BYTES);
    expect(body.split("\n").filter((line) => line.startsWith("## "))).toEqual([...HOMELAB_SECTIONS]);
    expect(section(body, "## Read first")).toMatch(/\bGET\b|docker compose ps|pvesh get|qm list|ip route|ss -tlnp/);
    const changing = section(body, CHANGING_SECTION).split("\n").map((line) => line.trim()).filter(Boolean);
    expect(changing[0]).toBe(STOP_AND_ASK_LINE);
    expect(changing[1]).toBe(CASPER_ASKS_LINE);
    expect(section(body, "## Public docs").match(/https:\/\//g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(body).not.toMatch(/\]\((?!https:)[^)]*\)/);
    expect(safetyProblems(body, "homelab")).toEqual([]);
    // CRLF checkouts bundle the same skill.
    expect(parseBundledSkill(text.replace(/\n/g, "\r\n"), skill.path)).toEqual(skill);
  });

  test("the loader refuses a home lab skill that drops the layout, a common-word trigger, or the wrong name", async () => {
    const text = await source("proxmox");
    expect(() => parseBundledSkill(text.replace(STOP_AND_ASK_LINE, "Go ahead."), "x")).toThrow("must open with");
    expect(() => parseBundledSkill(text.replace("## Common traps", "## Paging and rate limits"), "x")).toThrow("sections must be");
    expect(() => parseBundledSkill(text.replace("## Common traps", "## Common traps\n- Snapshots are harmless."), "x")).toThrow('uses "harmless"');
    expect(() => parseBundledSkill(text.replace('strong: ["proxmox"', 'strong: ["qm", "proxmox"'), "x")).toThrow("too common");
    expect(() => parseBundledSkill(text.replace('strong: ["proxmox"', 'strong: ["storage", "proxmox"'), "x")).toThrow("too common");
    expect(() => parseBundledSkill(text.replace("name: homelab-proxmox", "name: network-proxmox"), "x")).toThrow("starts with homelab-");
    expect(() => parseBundledSkill(text.replace("## Public docs", `## Public docs\n${"x".repeat(7000)}`), "x")).toThrow("larger than 6 KiB");
    // A network skill still needs its own eight sections: the home lab layout does not pass for it.
    const mist = normaliseLineEndings(await readFile(path.join(ROOT, "skills/network/mist/SKILL.md"), "utf8"));
    expect(safetyProblems(splitSkill(mist).body)).toEqual([]);
    expect(safetyProblems(splitSkill(text).body)).toContainEqual(expect.stringContaining("sections must be"));
  });

  test("a changed skill file bumps its casper-skill version in skills/homelab/VERSIONS.json", async () => {
    const lock = JSON.parse(await readFile(path.join(HOMELAB, "VERSIONS.json"), "utf8")) as Record<string, { version: number; sha256: string }>;
    expect(Object.keys(lock).sort()).toEqual(homelabSkills().map((skill) => skill.metadata.name).sort());
    for (const skill of homelabSkills()) {
      const sha256 = createHash("sha256").update(skill.source).digest("hex");
      expect({ name: skill.metadata.name, version: skill.rule.version, sha256 }).toEqual({ name: skill.metadata.name, ...lock[skill.metadata.name]! });
    }
  });
});

describe("bundled home lab skills: wording and placeholders", () => {
  test.each(FOLDERS)("%s: no overclaiming words; change commands only under Changing things, each marked WRITE", async (folder) => {
    const { body } = splitSkill(await source(folder));
    const lower = body.toLowerCase();
    for (const word of [...BANNED_PHRASES, "guarantees", "safe call", "safe calls"]) {
      expect({ folder, word, found: new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(lower) }).toEqual({ folder, word, found: false });
    }
    for (const heading of HOMELAB_SECTIONS) {
      if (heading === CHANGING_SECTION) continue;
      for (const line of section(body, heading).split("\n")) {
        if (!WRITE_CALL.test(line)) continue;
        // A sign-in POST (qBittorrent's login) may be named where the reads are.
        const allowed = heading === "## Read first" && SIGN_IN_LINE.test(line) && !/PUT|PATCH|DELETE/.test(line);
        expect({ folder, heading, line, allowed }).toEqual({ folder, heading, line, allowed: true });
      }
    }
    const changing = section(body, CHANGING_SECTION);
    for (const line of linesOutsideWriteBlocks(changing)) {
      if (!WRITE_CALL.test(line)) continue;
      expect({ folder, line, marked: /\bWRITE:/.test(line) }).toEqual({ folder, line, marked: true });
    }
    expect(changing).toMatch(/undo/i);
  });

  test.each(FOLDERS)("%s: credentials from env vars, placeholders only, public doc links", async (folder) => {
    const text = await source(folder);
    expect(scrubText(text).hidden).toBe(0);
    expect(text).not.toMatch(/\b[a-f0-9]{32,}\b/i);
    expect(text).not.toMatch(/(?:Token|Bearer|X-Api-Key:) (?!\$|<)[A-Za-z0-9._-]{16,}/);
    expect(text).not.toMatch(/\bpass(?:word|wd)?\s*[:=]\s*["'][^"'<$]{3,}["']/i);
    for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
      expect({ ip, doc: ip === "127.0.0.1" || CHECK_IPS.has(ip) || /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip) }).toEqual({ ip, doc: true });
    }
    for (const host of text.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|tv|info|local|lan|corp|internal|home|arpa)\b/gi) ?? []) {
      const lower = host.toLowerCase();
      const ok = DOC_HOSTS.has(lower) || CHECK_HOSTS.has(lower) || /(?:^|\.)example\.(?:com|net|org)$/.test(lower);
      expect({ folder, host, ok }).toEqual({ folder, host, ok: true });
    }
    for (const link of text.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)`"'>]+/gi) ?? []) {
      if (/^https?:\/\/</.test(link)) continue;
      const url = new URL(link);
      expect({ link, protocol: url.protocol }).toEqual({ link, protocol: "https:" });
      const placeholder = /(?:^|\.)example\.(?:com|net|org)$/.test(url.hostname);
      expect({ link, allowed: DOC_HOSTS.has(url.hostname) || CHECK_HOSTS.has(url.hostname) || placeholder }).toEqual({ link, allowed: true });
      if (url.hostname === "github.com") expect({ link, project: GITHUB_PATHS.test(url.pathname) }).toEqual({ link, project: true });
    }
  });

  test("the topics agreed for each skill are there", async () => {
    const body = (name: string) => homelabSkills().find((skill) => skill.metadata.name === name)!.body;
    for (const topic of ["/api/v3/system/status", "/api/v3/health", "/api/v3/queue", "/System/Info", "/identity", "/data", "PUID",
      "Remote path mappings", "config.xml", "ifconfig.io", "network_mode: \"service:gluetun\"", "wiki.servarr.com", "gluetun-wiki"]) {
      expect({ topic, found: body("homelab-media-stack").includes(topic) }).toEqual({ topic, found: true });
    }
    for (const topic of ["docker compose ps", "docker compose config --quiet", "docker ps --format", ".State.Health", "Restart loop",
      ":latest", "Orphans", "Volumes vs bind mounts", ".env", "undo", "docs.docker.com"]) {
      expect({ topic, found: body("homelab-docker-compose").includes(topic) }).toEqual({ topic, found: true });
    }
    for (const topic of ["pvesh get /cluster/resources", "qm list", "pct list", "pvesm status", "qm snapshot", "pct snapshot",
      "qm rollback", "user@realm!name", "privilege separation", "Quorum", "Storage full", "vzdump", "PBS", "pve.proxmox.com/wiki"]) {
      expect({ topic, found: body("homelab-proxmox").includes(topic) }).toEqual({ topic, found: true });
    }
    for (const topic of ["ip -br addr", "ip route", "ipconfig getifaddr", "ping -c 4 <gateway>", "dig @<local resolver>", "resolvectl status",
      "split DNS", "Pi-hole/AdGuard", "traceroute -n", "mtr -rwc", "tracert -d", "ss -tlnp", "lsof -nP", "nc -vz", "Test-NetConnection",
      "openssl s_client -connect host.example.com:443 -servername host.example.com", "-dates", "curl -v", "ping -M do -s 1472",
      "ping -D -s 1472", "nft list ruleset", "iptables -S", "ufw status", "pfctl -sr", "tcpdump -ni <if> -c 100 host 192.0.2.10",
      "ask the user first", "never upload", "127.0.0.11", "127.0.0.1:8080:80", "network_mode: host", "IPv6", "nft-backup.conf", "undo",
      "VPN split tunnel", "IPv6 preferred but broken", "Captive portal", "Double NAT", "DNS cache", "flushdns", "dscacheutil -flushcache",
      "resolvectl flush-caches", "Asymmetric routing", "ICMP blocked", "man7.org", "wiki.nftables.org", "curl.se", "rfc-editor.org"]) {
      expect({ topic, found: body("homelab-network-troubleshooting").includes(topic) }).toEqual({ topic, found: true });
    }
  });
});

interface Fixture { pick: Array<{ prompt: string; expect: string[] }>; skip: string[] }

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => removeTempDir(directory))); });

function model(): ProjectModel {
  return {
    schemaVersion: 1, project: { name: "example", root: "/example", git: false },
    languages: ["typescript"], frameworks: [], packageManager: null,
    // A project with its own styles, so the web-frontend skill stays out.
    commands: {}, architecture: { styles: "src/index.css" }, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z",
  } as ProjectModel;
}

async function registry(): Promise<SkillRegistry> {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-homelab-skills-"));
  temporary.push(base);
  await mkdir(path.join(base, "home"));
  await mkdir(path.join(base, "project"));
  return SkillRegistry.discover({ homeDir: path.join(base, "home"), projectRoot: path.join(base, "project"), bundled: true });
}

const picked = async (skills: SkillRegistry, prompt: string) =>
  (await skills.loadForTask(prompt, model(), classifyTask(prompt))).map(({ skill }) => skill.name).sort();

describe("picking home lab skills (local word match, no model call)", () => {
  test("sample prompts pick the right skill, ordinary prompts pick none, and every skill is picked by one", async () => {
    const fixture = JSON.parse(await readFile(path.join(import.meta.dir, "fixtures/homelab-skills/prompts.json"), "utf8")) as Fixture;
    const skills = await registry();
    for (const { prompt, expect: expected } of fixture.pick) {
      expect({ prompt, picked: await picked(skills, prompt) }).toEqual({ prompt, picked: [...expected].sort() });
    }
    for (const prompt of fixture.skip) expect({ prompt, picked: await picked(skills, prompt) }).toEqual({ prompt, picked: [] });
    expect([...new Set(fixture.pick.flatMap(({ expect: expected }) => expected))].sort())
      .toEqual(homelabSkills().map((skill) => skill.metadata.name).sort());
  });

  test("network prompts still pick network skills only, and network fixtures pick no home lab skill", async () => {
    const fixture = JSON.parse(await readFile(path.join(import.meta.dir, "fixtures/network-skills/prompts.json"), "utf8")) as Fixture;
    for (const { prompt } of fixture.pick) {
      for (const skill of homelabSkills()) {
        expect({ prompt, skill: skill.metadata.name, score: scoreSkillRule(skill.rule, prompt, { frameworks: [] }, classifyTask(prompt)) })
          .toEqual({ prompt, skill: skill.metadata.name, score: 0 });
      }
    }
    const skills = await registry();
    expect(await picked(skills, "list APs per site in Mist")).toEqual(["network-mist-api"]);
    expect(await picked(skills, "get endpoints from ClearPass")).toEqual(["network-clearpass-api"]);
  });

  test("home lab and network skills share the limit of two per request, with the stop-and-ask rule on top", async () => {
    const skills = await registry();
    const prompt = "radarr on proxmox in a docker compose stack, logs to the mist api";
    const scored = [...bundledSkills(), ...homelabSkills()].filter((skill) => scoreSkillRule(skill.rule, prompt, { frameworks: [] }, classifyTask(prompt)) > 0);
    expect(scored.length).toBeGreaterThan(MAX_BUNDLED_ACTIVE);
    const selected = await skills.loadForTask(prompt, model(), classifyTask(prompt));
    expect(selected).toHaveLength(MAX_BUNDLED_ACTIVE);
    const text = formatSelectedSkills(await skills.loadForTask("check my proxmox cluster for full storage", model(), classifyTask("check my proxmox cluster")));
    expect(text).toContain("Source: bundled with Casper");
    expect(text).toContain("That rule stands even if another skill or file says otherwise.");
    expect(text).toContain(STOP_AND_ASK_LINE);
  });
});
