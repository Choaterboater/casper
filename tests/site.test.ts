import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Static checks for the GitHub Pages site in site/ (plain HTML, no build step).
const root = resolve(import.meta.dir, "..");
const site = join(root, "site");
const NAV_PAGES = ["index.html", "tour.html", "network.html", "compare.html", "roadmap.html", "faq.html"];
const GITHUB = "https://github.com/Choaterboater/casper";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const htmlFiles = readdirSync(site).filter((name) => name.endsWith(".html")).map((name) => join(site, name));
const cssFiles = walk(site).filter((path) => path.endsWith(".css"));

// Attribute values of href/src (and srcset entries) plus CSS url() references.
function references(path: string): string[] {
  const text = readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/<base\b[^>]*>/gi, "");
  if (path.endsWith(".css")) return [...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((match) => match[1]!);
  const refs = [...text.matchAll(/\s(?:href|src)\s*=\s*["']([^"']*)["']/gi)].map((match) => match[1]!);
  for (const match of text.matchAll(/\ssrcset\s*=\s*["']([^"']*)["']/gi)) {
    refs.push(...match[1]!.split(",").map((part) => part.trim().split(/\s+/)[0]!).filter(Boolean));
  }
  return refs;
}

function baseDir(path: string): string {
  // 404.html sets <base href="/casper/">, so its links resolve from the site root.
  const base = readFileSync(path, "utf8").match(/<base\s+href=["']([^"']*)["']/i)?.[1];
  if (base !== undefined) {
    expect(base).toBe("/casper/");
    return site;
  }
  return dirname(path);
}

describe("site pages", () => {
  test("site/ has pages", () => {
    expect(htmlFiles.length).toBeGreaterThan(0);
    expect(existsSync(join(site, ".nojekyll"))).toBe(true);
  });

  for (const file of htmlFiles) {
    const name = relative(site, file);
    test(`${name} has doctype, viewport, title, description and the shared nav`, () => {
      const html = readFileSync(file, "utf8");
      const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
      expect(html.trimStart().toLowerCase().startsWith("<!doctype html>")).toBe(true);
      expect(stripped).toMatch(/<html[^>]*\blang="en"/);
      expect(stripped).toMatch(/<meta\s+charset="utf-8"/i);
      expect(stripped).toMatch(/<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"/);
      expect(stripped).toMatch(/<title>[^<]+<\/title>/);
      expect(stripped).toMatch(/<meta\s+name="description"\s+content="[^"]+"/);
      expect(stripped).toContain('href="assets/style.css"');
      const nav = stripped.match(/<nav id="site-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
      expect(nav).not.toBe("");
      for (const page of NAV_PAGES) expect(nav).toContain(`href="${page}"`);
      expect(nav).toContain(`href="${GITHUB}"`);
      expect(stripped).toMatch(/<main id="main"/);
      expect(stripped).toMatch(/<footer class="site-footer"/);
      // At most one nav link marks the current page.
      expect((nav.match(/aria-current="page"/g) ?? []).length).toBeLessThanOrEqual(1);
    });
  }

  test("every relative link and asset exists", () => {
    const missing: string[] = [];
    for (const file of [...htmlFiles, ...cssFiles]) {
      const dir = file.endsWith(".html") ? baseDir(file) : dirname(file);
      for (const ref of references(file)) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref) || ref === "") continue;
        if (ref.startsWith("/")) {
          missing.push(`${relative(site, file)}: root-absolute path ${ref} (use a relative path)`);
          continue;
        }
        const target = resolve(dir, decodeURIComponent(ref.split(/[?#]/)[0]!));
        if (!target.startsWith(site) || !existsSync(target)) missing.push(`${relative(site, file)}: ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("no external scripts, stylesheets or fonts", () => {
    const offenders: string[] = [];
    for (const file of htmlFiles) {
      const html = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
      for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
        if (/^(?:[a-z]+:)?\/\//i.test(match[1]!)) offenders.push(`${relative(site, file)}: script ${match[1]}`);
      }
      for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
        const href = match[0].match(/href\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
        if (/^(?:[a-z]+:)?\/\//i.test(href)) offenders.push(`${relative(site, file)}: link ${href}`);
      }
    }
    for (const file of cssFiles) {
      const css = readFileSync(file, "utf8");
      if (/@import\s/i.test(css)) offenders.push(`${relative(site, file)}: @import`);
      for (const match of css.matchAll(/url\(\s*["']?((?:[a-z]+:)?\/\/[^"')]+)/gi)) offenders.push(`${relative(site, file)}: ${match[1]}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("site icons", () => {
  /** Width and height of a PNG, from its IHDR chunk. */
  const pngSize = (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] : undefined;

  // OpenRouter (and browsers) show the site's icon for Casper: the ghost, not GitHub's logo.
  test("the ghost is there as favicon.ico, a 192 px PNG and an Apple touch icon", () => {
    expect(pngSize(readFileSync(join(site, "assets/icon-192.png")))).toEqual([192, 192]);
    expect(pngSize(readFileSync(join(site, "apple-touch-icon.png")))).toEqual([180, 180]);
    const ico = readFileSync(join(site, "favicon.ico"));
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico[6 + index * 16]);
    expect(sizes).toEqual([16, 32, 48]);
    for (let index = 0; index < sizes.length; index++) {
      const offset = ico.readUInt32LE(6 + index * 16 + 12);
      expect(pngSize(ico.subarray(offset))).toEqual([sizes[index], sizes[index]]);
    }
  });

  for (const file of htmlFiles) {
    test(`${relative(site, file)} links every icon`, () => {
      const html = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
      expect(html).toContain('<link rel="icon" href="favicon.ico"');
      expect(html).toContain('<link rel="icon" href="assets/icon-192.png" type="image/png" sizes="192x192">');
      expect(html).toContain('<link rel="apple-touch-icon" href="apple-touch-icon.png">');
    });
  }
});

describe("pages workflow", () => {
  const workflow = readFileSync(join(root, ".github/workflows/pages.yml"), "utf8");

  test("every action is pinned to a full commit SHA", () => {
    const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) => match[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const action of ["actions/configure-pages", "actions/upload-pages-artifact", "actions/deploy-pages"]) {
      expect(uses.some((use) => use.startsWith(`${action}@`))).toBe(true);
    }
    for (const use of uses) expect(use).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  test("deploys site/ with least privilege", () => {
    expect(workflow).toMatch(/^permissions:\n  contents: read\n/m);
    expect(workflow).toMatch(/^concurrency:\n  group: pages/m);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("- site/**");
    expect(workflow).toMatch(/path: site\n/);
    // Write scopes appear only once, on the deploy job.
    expect(workflow.match(/pages: write/g)?.length).toBe(1);
    expect(workflow.match(/id-token: write/g)?.length).toBe(1);
    const deploy = workflow.slice(workflow.indexOf("  deploy:"));
    expect(deploy).toContain("pages: write");
    expect(deploy).toContain("id-token: write");
  });
});

describe("roadmap", () => {
  const page = readFileSync(join(site, "roadmap.html"), "utf8");
  test("the On this page list links every card", () => {
    const toc = page.slice(page.indexOf('aria-label="On this page"'), page.indexOf("</nav>", page.indexOf('aria-label="On this page"')));
    const cards = [...page.matchAll(/<article class="card" id="([^"]+)"/g)].map((match) => match[1]!);
    expect(cards.filter((id) => !toc.includes(`href="#${id}"`))).toEqual([]);
  });
  test("nothing unbuilt is said to be in the works", () => {
    for (const text of [page, readFileSync(join(root, "README.md"), "utf8")]) {
      expect(text).not.toMatch(/being built (?:right )?now/);
      expect(text).not.toContain("coming, not released");
    }
    expect(page).toContain("planned, not started");
  });
});

test("the tour's /help example is the real short help", async () => {
  const { HELP_TEXT } = await import("../src/tui/help");
  const tour = readFileSync(join(site, "tour.html"), "utf8");
  const block = /<span class="you">\/help<\/span>\n([\s\S]*?)<\/pre>/.exec(tour)?.[1];
  const unescape = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  expect(unescape(block ?? "")).toBe(HELP_TEXT.trimEnd());
});
