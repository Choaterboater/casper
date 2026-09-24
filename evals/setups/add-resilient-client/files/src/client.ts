import { HttpError } from "./errors";

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
}

export interface Client {
  get<T>(path: string): Promise<T>;
}

export function createClient(options: ClientOptions): Client {
  const fetcher = options.fetch ?? fetch;
  return {
    async get<T>(path: string) {
      const url = new URL(path, options.baseUrl).toString();
      const response = await fetcher(url, {
        headers: { accept: "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      });
      if (!response.ok) throw new HttpError(response.status, url);
      return await response.json() as T;
    },
  };
}
