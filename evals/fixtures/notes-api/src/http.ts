/** JSON response helpers shared by every handler. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The only way handlers report errors: `{ error: code, ...extra }`. */
export function jsonError(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: code, ...extra });
}
