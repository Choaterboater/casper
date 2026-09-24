/** A mock AOS-CX-style switch: form login, cookie sessions, a session limit and logout accounting. */
export interface MockOptions {
  maxSessions?: number;
  /** Paths (after /rest/v10.09) that answer with this status instead of data. */
  failures?: Record<string, number>;
  logoutStatus?: number;
  /** Paths whose body is not valid JSON. */
  garbled?: string[];
}

export function startMockSwitch(options: MockOptions = {}) {
  const sessions = new Set<string>();
  const stats = { logins: 0, rejectedLogins: 0, logouts: 0, requests: [] as string[] };
  let counter = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/rest\/v10\.09/, "") + url.search;
    stats.requests.push(`${request.method} ${path}`);
    if (request.method === "POST" && url.pathname === "/rest/v10.09/login") {
      const form = new URLSearchParams(await request.text());
      if (form.get("username") !== "admin" || form.get("password") !== "lab-password") { stats.rejectedLogins++; return new Response("", { status: 401 }); }
      if (sessions.size >= (options.maxSessions ?? 3)) return new Response("session limit reached", { status: 503 });
      const token = `tok${++counter}`;
      sessions.add(token);
      stats.logins++;
      return new Response("", { status: 200, headers: { "set-cookie": `id=${token}; Path=/; HttpOnly` } });
    }
    const token = /(?:^|;\s*)id=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (!token || !sessions.has(token)) return new Response("", { status: 401 });
    if (request.method === "POST" && url.pathname === "/rest/v10.09/logout") {
      sessions.delete(token);
      stats.logouts++;
      return new Response("", { status: options.logoutStatus ?? 200 });
    }
    const failure = options.failures?.[path];
    if (failure) return new Response("", { status: failure });
    if (options.garbled?.includes(path)) return new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/system?attributes=hostname,firmware_version") return Response.json({ hostname: "lab-sw1", firmware_version: "FL.10.13.1000" });
    if (path === "/system/interfaces") return Response.json({ "1%2F1%2F1": {}, "1%2F1%2F2": {}, "vlan1": {} });
    return new Response("", { status: 404 });
  } });
  return { baseUrl: `http://127.0.0.1:${server.port}`, stats, openSessions: () => sessions.size, stop: () => server.stop(true) };
}
