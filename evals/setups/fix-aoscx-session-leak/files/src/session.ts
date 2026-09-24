import { LoginError } from "./errors";

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

export async function withSession<T>(options: SessionOptions, work: (session: Session) => Promise<T>): Promise<T> {
  const fetcher = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const login = await fetcher(`${base}${API}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: options.username, password: options.password }).toString(),
  });
  if (!login.ok) throw new LoginError(login.status);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const session: Session = {
    async get<R>(path: string) {
      const response = await fetcher(`${base}${API}${path}`, { headers: { cookie, accept: "application/json" } });
      return await response.json() as R;
    },
  };

  const result = await work(session);
  await fetcher(`${base}${API}/logout`, { method: "POST", headers: { cookie } });
  return result;
}
