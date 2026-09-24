import { HttpError, LoginError, LogoutError } from "./errors";

export interface SessionOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly fetch?: typeof fetch;
}

export interface Session {
  get<T = unknown>(path: string): Promise<T>;
}

const API = "/rest/v10.09";

/** The `id` cookie value from a Set-Cookie header, without attributes. */
function sessionCookie(header: string | null): string | null {
  const match = /(?:^|,\s*)id=([^;,\s]+)/.exec(header ?? "");
  return match ? `id=${match[1]}` : null;
}

export async function withSession<T>(options: SessionOptions, work: (session: Session) => Promise<T>): Promise<T> {
  const fetcher = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const login = await fetcher(`${base}${API}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: options.username, password: options.password }).toString(),
  });
  if (!login.ok) throw new LoginError(login.status);
  const cookie = sessionCookie(login.headers.get("set-cookie"));
  if (!cookie) throw new LoginError(login.status);

  const session: Session = {
    async get<R>(path: string) {
      const response = await fetcher(`${base}${API}${path}`, { headers: { cookie, accept: "application/json" } });
      if (!response.ok) throw new HttpError(response.status, path);
      return await response.json() as R;
    },
  };

  let result: T;
  try {
    result = await work(session);
  } catch (error) {
    await fetcher(`${base}${API}/logout`, { method: "POST", headers: { cookie } }).catch(() => undefined);
    throw error;
  }
  let logout: Response;
  try { logout = await fetcher(`${base}${API}/logout`, { method: "POST", headers: { cookie } }); }
  catch (error) { throw new LogoutError(null, { cause: error }); }
  if (!logout.ok) throw new LogoutError(logout.status);
  return result;
}
