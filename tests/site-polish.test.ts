import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const site = resolve(import.meta.dir, "../site");
const read = (file: string) => readFileSync(join(site, file), "utf8");
const text = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

describe("site polish content", () => {
  test("roadmap and its contents lead with next, planned, later, then released", () => {
    const page = read("roadmap.html");
    const order = ["next", "coming", "later", "released"];
    const positions = order.map(id => page.indexOf(`<section id="${id}"`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const toc = page.match(/<nav class="toc"[\s\S]*?<\/nav>/)![0];
    const links = order.map(id => toc.indexOf(`href="#${id}"`));
    expect(links).toEqual([...links].sort((a, b) => a - b));
    // Preserve the branch's already-fixed Next release, not older release notes.
    for (const heading of ["The browser works without asking.", "Fewer interruptions.", "Honest endings.", "Pages that feel right.", "Pictures.", "Secrets.", "Local models.", "Home lab."]) expect(page).toContain(heading);
  });

  test("every released version is a details card, only the latest three start open, badges sit beside headings", () => {
    const page = read("roadmap.html");
    const released = page.slice(page.indexOf('<section id="released"'));
    const releases = [...released.matchAll(/<details class="card release" id="([^"]+)"[^>]*>[\s\S]*?<\/details>/g)];
    expect(releases).toHaveLength(24);
    expect(releases.slice(0, 3).map(match => match[1])).toEqual(["v0235", "v0234", "v0233"]);
    releases.forEach((match, i) => {
      expect(/\bopen\b/.test(match[0].slice(0, match[0].indexOf(">")))).toBe(i < 3);
      expect(match[0]).toMatch(/<summary class="release-heading">\s*<h3[^>]*>[^<]+<\/h3>\s*<span class="badge/);
    });
    for (const heading of page.matchAll(/<h3[^>]*>[\s\S]*?<\/h3>/g)) expect(heading[0]).not.toContain('class="badge');
  });

  test("home receipt is a real crop: verdict first, four or five evidence lines, no sandbox note", () => {
    const page = read("index.html");
    const section = page.match(/<section class="split" aria-labelledby="receipt">([\s\S]*?)<\/section>/)![1]!;
    const receipt = text(section.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)![1]!);
    const lines = receipt.split("\n");
    expect(lines[0]).toStartWith("▌ ✓ Verified");
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(receipt).not.toMatch(/sandbox/i);
    const original = read("captures/receipt-verified.txt");
    for (const line of lines) expect(original).toContain(line);
    expect(section).toContain("Cropped");
    expect(page).toMatch(/<a class="btn[^\"]*" href="#install">Install<\/a>/);
    expect(page).toContain('<span class="cmd-label visually-hidden">macOS / Linux</span>');
  });

  test("comparison says plainly what Pi is and names no other tool in a table; Pi content is retained lower down", () => {
    const page = read("compare.html");
    expect(page).toContain("Casper is built on Pi, an open-source coding agent.");
    expect(page).not.toContain('id="tools"');
    expect(page.indexOf('id="start"')).toBeGreaterThan(page.indexOf('id="pick"'));
    expect(page.indexOf('id="table"')).toBeGreaterThan(page.indexOf('id="start"'));
    expect(page.indexOf('id="pi-wins"')).toBeGreaterThan(page.indexOf('id="table"'));
    expect(page).toContain('<h2 id="start-h">What it\'s built on</h2>');
    expect(page).toContain("Casper uses Pi's SDK as a pinned library");
  });

  test("network setup is the first section, while own-server setup stays available", () => {
    const page = read("network.html");
    expect(page.match(/<section id="([^"]+)"/)![1]).toBe("setup-casper");
    expect(page).toContain("Casper sets it up for you (Mist, Central, ClearPass)");
    expect(page).toContain('id="setup-own"');
    expect(page).toContain("Casper can set up its network server (casper-network-mcp 0.1.3");
    const toc = page.match(/<nav class="toc"[\s\S]*?<\/nav>/)![0];
    expect(toc.match(/href="#([^"]+)"/)![1]).toBe("setup-casper");
  });

  test("every page with contents uses one layout: page head, then a short-labelled sidebar beside the sections", () => {
    for (const file of ["tour.html", "network.html", "compare.html", "roadmap.html", "faq.html"]) {
      const page = read(file);
      const order = ['<div class="contents-layout">', '<header class="page-head">', "<h1>", '<nav class="toc"', '<div class="page-sections">', "<section"];
      const positions = order.map(marker => page.indexOf(marker));
      expect({ file, positions }).toEqual({ file, positions: [...positions].sort((a, b) => a - b) });
      expect(positions.every(position => position >= 0)).toBe(true);
      const toc = page.match(/<nav class="toc"[\s\S]*?<\/nav>/)![0];
      const long = [...toc.matchAll(/<a href="#[^"]+">([^<]+)<\/a>/g)].map(match => text(match[1]!)).filter(label => label.length > 32);
      expect({ file, long }).toEqual({ file, long: [] });
    }
    const css = read("assets/style.css");
    expect(css).not.toMatch(/--measure:\s*none/);
    expect(css).not.toMatch(/@media \(min-width: ?1600px\)/);
  });

  test("tour opens with the big things, without the parenthesized list", () => {
    const lead = text(read("tour.html").match(/<p class="lead">([\s\S]*?)<\/p>/)![1]!);
    expect(lead).toStartWith("Here are the big things");
    expect(lead).not.toMatch(/[()]/);
    expect(lead).toContain("More in 0.2.35");
  });
});
