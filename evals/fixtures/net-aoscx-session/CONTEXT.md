# net-aoscx-session

A small client for an AOS-CX-style switch REST API. Tests use a local mock switch.

## API (v10.09 subset)

- `POST /rest/v10.09/login`, form body `username=…&password=…`. 200 sets a session cookie
  (`Set-Cookie: id=<token>; Path=/; HttpOnly`); 401 means bad credentials.
- Every other call sends the cookie back (`Cookie: id=<token>`). Without it the switch answers 401.
- `POST /rest/v10.09/logout` ends the session.
- The switch allows only a few concurrent sessions. A session that is never logged out stays open until
  it times out, and further logins fail. **Every successful login must be followed by exactly one logout**,
  whatever happens in between.

## Conventions

- `withSession(options, work)` in `src/session.ts` owns login/logout; `work(session)` gets a
  `session.get(path)` that returns parsed JSON. Higher-level calls (`src/system.ts`) only use `withSession`.
- Errors are the classes in `src/errors.ts`: `LoginError` for a rejected login, `HttpError` (with
  `status` and `path`) for any other non-2xx response, `LogoutError` when logout itself fails.
- If `work` or a request fails, that error is what the caller sees, even if logout then fails too.
  If `work` succeeds but logout fails, the call rejects with `LogoutError`.
- No runtime dependencies.
