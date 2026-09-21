export interface Request {
  readonly method: string;
  readonly path: string;
}

export interface Response {
  readonly status: number;
  readonly body: unknown;
}

export type Handler = (request: Request) => Response;

/** Exact-match router: keys are `"METHOD /path"`. Unmatched requests are 404. */
export function createRouter(routes: Readonly<Record<string, Handler>>) {
  return (request: Request): Response => {
    const handler = routes[`${request.method} ${request.path}`];
    return handler ? handler(request) : { status: 404, body: { error: "not found" } };
  };
}
