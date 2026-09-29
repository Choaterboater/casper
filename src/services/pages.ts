/** Which pages a page check opens after edits, from the changed files and the routing conventions of
 * the project's framework. Pure: no file system, no prompt text. */

export const MAX_PAGES = 5;
export const MAX_CONFIGURED_PAGES = 8;

export interface SkippedPage { path: string; why: string }
export interface PagePlan { open: string[]; skipped: SkippedPage[] }
/** The project setting `pages:`: `off`, or paths that are always opened. */
export type PagesSetting = "off" | string[];

const PAGE_PATH = /^\/(?!\/)[^\s\\?#]*$/;

/** Validates the project layer's `pages` setting; every error names the dotted path. */
export function parsePagesSetting(value: unknown, label = ".casper/project.yaml"): PagesSetting | undefined {
  if (value === undefined || value === null) return undefined;
  const fail = (message: string): never => { throw new Error(`Invalid ${label}: ${message}`); };
  if (value === "off" || value === false) return "off";
  if (!Array.isArray(value)) return fail("pages must be off or a list of paths such as /dashboard");
  if (value.length > MAX_CONFIGURED_PAGES) fail(`pages lists ${value.length} paths; at most ${MAX_CONFIGURED_PAGES} are allowed`);
  const pages = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length > 256 || !PAGE_PATH.test(entry) || /[\x00-\x1f\x7f]/.test(entry)) {
      return fail(`pages[${index}] must be a path on the site such as /dashboard (no //, \\, spaces, ? or #)`);
    }
    return entry;
  });
  return [...new Set(pages)];
}

const EXT = (name: string) => /\.[^./]+$/.exec(name)?.[0].toLowerCase() ?? "";
const SCRIPT_PAGE = new Set([".tsx", ".ts", ".jsx", ".js", ".mdx", ".md"]);
const FRONTEND = new Set([".tsx", ".jsx", ".ts", ".js", ".mjs", ".cjs", ".vue", ".svelte", ".astro", ".css", ".scss", ".sass", ".less", ".html", ".htm", ".mdx"]);
/** Tests, dependencies and build caches never mean a page changed. */
const NOT_PAGES = /(^|\/)(node_modules|\.next|\.nuxt|\.svelte-kit|\.astro|\.output|dist|build|coverage|__pycache__|\.venv|venv|tests?|__tests__|e2e|cypress|playwright)\//;
const TEST_FILE = /\.(test|spec|stories)\.[^.]+$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;

/** Files that are only prose; outside page folders they never make pages worth opening. */
const DOCS = /\.(md|markdown|txt|rst|adoc)$|(^|\/)(LICENSE|NOTICE|CHANGELOG|AUTHORS)[^/]*$|^docs\//i;

type Route = { path: string; skip?: string } | undefined;

/** Turns route folder names into a URL path. Groups `(name)` are dropped; `[[optional]]` is dropped;
 * `[id]` or `[...slug]` cannot be opened without a value. */
function routeFrom(segments: string[]): NonNullable<Route> {
  const kept: string[] = [];
  let dynamic: string | undefined;
  for (const segment of segments) {
    if (!segment || /^\(.*\)$/.test(segment) || /^\[\[.*\]\]$/.test(segment)) continue;
    if (!dynamic && /\[.+\]/.test(segment)) dynamic = /\[[^\]]+\]/.exec(segment)![0];
    kept.push(segment);
  }
  const path = `/${kept.join("/")}`;
  return dynamic ? { skip: `it needs a value for ${dynamic}`, path } : { path };
}

function nextApp(file: string): Route | "not-page" {
  const match = /^(?:src\/)?app\/(?:(.*)\/)?(page|layout)\.(tsx|ts|jsx|js|mdx)$/.exec(file);
  if (!match) return /^(?:src\/)?app\/(.*\/)?route\.(ts|js)$/.test(file) ? "not-page" : undefined;
  const segments = (match[1] ?? "").split("/").filter(Boolean);
  // Parallel-route slots, private folders and intercepting routes are not addresses of their own.
  if (segments.some(segment => segment.startsWith("@") || segment.startsWith("_") || segment.startsWith("(."))) return undefined;
  return routeFrom(segments);
}

function nextPages(file: string): Route | "not-page" {
  const match = /^(?:src\/)?pages\/(.+)$/.exec(file);
  if (!match || !SCRIPT_PAGE.has(EXT(file))) return undefined;
  const segments = match[1]!.replace(/\.[^./]+$/, "").split("/");
  if (segments[0] === "api") return "not-page";
  if (["_app", "_document", "_error", "_middleware"].includes(segments.at(-1)!)) return undefined;
  if (segments.at(-1) === "index") segments.pop();
  return routeFrom(segments);
}

function sveltekit(file: string): Route | "not-page" {
  const match = /^src\/routes\/(?:(.*)\/)?\+(page|layout)(?:\.server)?\.(svelte|ts|js)$/.exec(file);
  if (!match) return /^src\/routes\/(.*\/)?\+server\.(ts|js)$/.test(file) ? "not-page" : undefined;
  return routeFrom((match[1] ?? "").split("/").filter(Boolean));
}

function nuxt(file: string): Route {
  const match = /^(?:app\/)?pages\/(.+)\.vue$/.exec(file);
  if (!match) return undefined;
  const segments = match[1]!.split("/");
  if (segments.at(-1) === "index") segments.pop();
  return routeFrom(segments);
}

function astro(file: string): Route | "not-page" {
  const match = /^src\/pages\/(.+)\.(astro|md|mdx|html)$/.exec(file);
  if (!match) return /^src\/pages\/.+\.(ts|js)$/.test(file) ? "not-page" : undefined;
  const segments = match[1]!.split("/");
  if (segments.at(-1) === "index") segments.pop();
  return routeFrom(segments);
}

/** Whether a changed file can change what a page shows (so `/` is opened when no route matches it). */
function frontEndFile(file: string, streamlit: boolean): boolean {
  if (NOT_PAGES.test(file) || TEST_FILE.test(file)) return false;
  const ext = EXT(file);
  if (streamlit) return ext === ".py" || ext === ".css" || /^\.streamlit\/[^/]+\.toml$/.test(file) || /^(static|assets)\//.test(file);
  return FRONTEND.has(ext) || /^(public|static|assets)\//.test(file);
}

/**
 * The pages to open for these changed files. File-routed frameworks (Next, SvelteKit, Nuxt, Astro) map a
 * changed page file to its address. Everything else that is front-end code (components, styles, an SPA's
 * router, a Streamlit app) opens `/`. Pages from the `pages:` setting are always opened. At most MAX_PAGES
 * are opened; dynamic routes and the rest are listed as skipped with the reason.
 */
export function changedPages(frameworks: readonly string[], changedPaths: readonly string[], configured?: PagesSetting): PagePlan {
  if (configured === "off") return { open: [], skipped: [] };
  const has = (name: string) => frameworks.includes(name);
  const streamlit = has("streamlit");
  const routers: Array<(file: string) => Route | "not-page"> = [];
  if (has("next")) routers.push(nextApp, nextPages);
  if (has("sveltekit")) routers.push(sveltekit);
  if (has("nuxt")) routers.push(nuxt);
  if (has("astro")) routers.push(astro);

  const found: string[] = [], skipped: SkippedPage[] = [];
  let fallback = false, codeChanged = false;
  for (const raw of changedPaths) {
    const file = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!file || file.startsWith("/") || file.startsWith("../")) continue;
    if (NOT_PAGES.test(file) || TEST_FILE.test(file)) continue;
    if (!DOCS.test(file)) codeChanged = true;
    let route: Route | "not-page" = undefined;
    for (const router of routers) { route = router(file); if (route) break; }
    if (route === "not-page") continue;
    if (route?.skip) {
      const path = route.path;
      if (!skipped.some(entry => entry.path === path)) skipped.push({ path, why: route.skip });
      continue;
    }
    if (route) { if (!found.includes(route.path)) found.push(route.path); continue; }
    if (frontEndFile(file, streamlit)) fallback = true;
  }
  if (fallback && !found.includes("/")) found.push("/");

  const wanted = [...new Set([...(configured ?? []), ...found])];
  // Pages are opened only after a change a page can show. The user's listed pages are opened after any
  // code change (an API edit can break them too), never after a docs-only change.
  const all = found.length || skipped.length || (configured?.length && codeChanged) ? wanted : [];
  return { open: all.slice(0, MAX_PAGES), skipped: [...skipped, ...all.slice(MAX_PAGES).map(path => ({ path, why: `only ${MAX_PAGES} pages are opened per check` }))] };
}
