export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

export type Match =
  | { status: 200; route: string; name: string; params: Record<string, string> }
  | { status: 204 | 405; allow: string[] }
  | { status: 400 | 404 };

type Segment =
  | { kind: "static"; text: string }
  | { kind: "param"; name: string }
  | { kind: "typed"; name: string; type: "int" | "slug" }
  | { kind: "optional"; name: string }
  | { kind: "wildcard"; name: string };

interface RouteEntry {
  method: string;
  patternSegments: Segment[];
  rawPattern: string;
  name: string;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INT_RE = /^[0-9]+$/;
const SLUG_RE = /^[a-z0-9-]+$/;
const KIND_RANK: Record<Segment["kind"], number> = { static: 0, typed: 1, param: 2, optional: 3, wildcard: 4 };

function validateName(name: string): void {
  if (!NAME_RE.test(name)) throw new RouteError("invalid param name");
}

function parseSegments(rawSegments: string[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i]!;
    const isLast = i === rawSegments.length - 1;
    if (raw.startsWith("*")) {
      if (!isLast) throw new RouteError("wildcard must be last");
      const name = raw.slice(1).length > 0 ? raw.slice(1) : "*";
      segments.push({ kind: "wildcard", name });
      continue;
    }
    if (raw.startsWith(":")) {
      const typedMatch = /^:([^<]+)<([^>]+)>$/.exec(raw);
      if (typedMatch) {
        const name = typedMatch[1]!;
        const type = typedMatch[2]!;
        validateName(name);
        if (type !== "int" && type !== "slug") throw new RouteError(`unknown param type ${type}`);
        segments.push({ kind: "typed", name, type });
        continue;
      }
      const optionalMatch = /^:(.+)\?$/.exec(raw);
      if (optionalMatch) {
        const name = optionalMatch[1]!;
        validateName(name);
        if (!isLast) throw new RouteError("optional param must be last");
        segments.push({ kind: "optional", name });
        continue;
      }
      const name = raw.slice(1);
      validateName(name);
      segments.push({ kind: "param", name });
      continue;
    }
    segments.push({ kind: "static", text: raw });
  }
  return segments;
}

function parsePattern(pattern: string): Segment[] {
  if (!pattern.startsWith("/")) throw new RouteError("pattern must start with /");
  let normalized = pattern;
  if (normalized !== "/" && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized === "/") return [];
  return parseSegments(normalized.slice(1).split("/"));
}

function shapeKey(segments: Segment[]): string {
  return JSON.stringify(
    segments.map((segment) => {
      if (segment.kind === "static") return ["static", segment.text];
      if (segment.kind === "typed") return ["typed", segment.type];
      return [segment.kind];
    }),
  );
}

function precedenceCompare(a: Segment[], b: Segment[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const rankA = KIND_RANK[a[i]!.kind];
    const rankB = KIND_RANK[b[i]!.kind];
    if (rankA !== rankB) return rankA - rankB;
  }
  return a.length - b.length;
}

function matchFixedSegment(segment: Segment, value: string, params: Record<string, string>): boolean {
  if (segment.kind === "static") return segment.text === value;
  if (segment.kind === "param") {
    params[segment.name] = value;
    return true;
  }
  if (segment.kind === "typed") {
    const ok = segment.type === "int" ? INT_RE.test(value) : SLUG_RE.test(value);
    if (!ok) return false;
    params[segment.name] = value;
    return true;
  }
  return false;
}

function tryMatchPattern(pattern: Segment[], request: string[]): Record<string, string> | null {
  if (pattern.length === 0) return request.length === 0 ? {} : null;
  const last = pattern[pattern.length - 1]!;
  if (last.kind === "optional") {
    if (request.length !== pattern.length && request.length !== pattern.length - 1) return null;
  } else if (last.kind === "wildcard") {
    if (request.length < pattern.length - 1) return null;
  } else if (request.length !== pattern.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length - 1; i++) {
    if (!matchFixedSegment(pattern[i]!, request[i]!, params)) return null;
  }
  if (last.kind === "wildcard") {
    params[last.name] = request.slice(pattern.length - 1).join("/");
  } else if (last.kind === "optional") {
    if (request.length === pattern.length) params[last.name] = request[pattern.length - 1]!;
  } else if (!matchFixedSegment(last, request[pattern.length - 1]!, params)) {
    return null;
  }
  return params;
}

function parsePath(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  const cut = path.search(/[?#]/);
  const withoutQuery = cut === -1 ? path : path.slice(0, cut);
  const collapsed = withoutQuery.replace(/\/+/g, "/");
  const trimmed = collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
  if (trimmed === "/") return [];
  const rawSegments = trimmed.slice(1).split("/");
  const decoded: string[] = [];
  for (const raw of rawSegments) {
    try {
      decoded.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return decoded;
}

export class Router {
  private routes: RouteEntry[] = [];

  add(method: string, pattern: string, name: string): void {
    const upperMethod = method.toUpperCase();
    const segments = parsePattern(pattern);
    const key = shapeKey(segments);
    for (const route of this.routes) {
      if (route.method === upperMethod && shapeKey(route.patternSegments) === key) {
        throw new RouteError("duplicate route");
      }
    }
    this.routes.push({ method: upperMethod, patternSegments: segments, rawPattern: pattern, name });
  }

  match(method: string, path: string): Match {
    const requestMethod = method.toUpperCase();
    const requestSegments = parsePath(path);
    if (requestSegments === null) return { status: 400 };

    const candidates: { route: RouteEntry; params: Record<string, string>; index: number }[] = [];
    this.routes.forEach((route, index) => {
      const params = tryMatchPattern(route.patternSegments, requestSegments);
      if (params !== null) candidates.push({ route, params, index });
    });
    candidates.sort(
      (x, y) => precedenceCompare(x.route.patternSegments, y.route.patternSegments) || x.index - y.index,
    );

    if (candidates.length === 0) return { status: 404 };

    let i = 0;
    while (i < candidates.length) {
      let j = i;
      while (
        j + 1 < candidates.length
        && precedenceCompare(candidates[i]!.route.patternSegments, candidates[j + 1]!.route.patternSegments) === 0
      ) {
        j++;
      }
      const tier = candidates.slice(i, j + 1);
      const chosen = tier.find((entry) => entry.route.method === requestMethod)
        ?? tier.find((entry) => entry.route.method === "ANY")
        ?? (requestMethod === "HEAD" ? tier.find((entry) => entry.route.method === "GET") : undefined);
      if (chosen) {
        return { status: 200, route: chosen.route.rawPattern, name: chosen.route.name, params: chosen.params };
      }
      i = j + 1;
    }

    const methods = new Set(candidates.map((entry) => entry.route.method));
    if (methods.has("GET")) methods.add("HEAD");
    methods.add("OPTIONS");
    const allow = [...methods].sort();
    return requestMethod === "OPTIONS" ? { status: 204, allow } : { status: 405, allow };
  }

  list(): string[] {
    return this.routes
      .map((route, index) => ({ route, index }))
      .sort((a, b) => precedenceCompare(a.route.patternSegments, b.route.patternSegments) || a.index - b.index)
      .map((entry) => `${entry.route.method} ${entry.route.rawPattern}`);
  }
}
