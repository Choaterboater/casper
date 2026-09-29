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
