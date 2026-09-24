# net-radius-test

`radtest`-style tool that sends one RADIUS Access-Request (RFC 2865, PAP) and reports the answer.
Tests use a local UDP mock server; no real RADIUS server or secret is involved.

## Layout

- `src/packet.ts`: encoding/decoding. `encodeAccessRequest` (User-Name, hidden User-Password,
  NAS-Identifier) and `decodePacket` are done and tested.
- `src/client.ts`: `radiusTest(options)` sends the request over UDP and interprets the reply.
- `src/cli.ts`: `main(argv, io)` for the command line, where `io` is `{ out(text: string): void; err(text: string): void }` (both
  write text exactly as given, like `process.stdout.write`: include the `\n` at the end of every line). `argv` holds only the arguments
  (like `process.argv.slice(2)`), never the runtime or script path;
  it returns the exit code and never calls `process.exit`.

## Protocol rules the client must follow

- Codes: 1 Access-Request, 2 Access-Accept, 3 Access-Reject, 11 Access-Challenge.
- A reply is only trusted when its Identifier matches the request **and** its Response Authenticator
  equals `MD5(Code + Identifier + Length + RequestAuthenticator + Attributes + Secret)`. Anything else
  is silently discarded and the client keeps waiting.
- No valid reply within `timeoutMs`: resend the identical packet (same Identifier and Request
  Authenticator), up to `retries` times. `attempts` counts every send.
- When the retries run out: status `bad-response` if any discarded reply had the right Identifier but a
  wrong authenticator (usually a wrong shared secret), else `timeout`.
- Attributes to report: every Reply-Message (18); Vendor-Specific (26) sub-attributes
  Cisco (vendor 9) type 1 `Cisco-AVPair` (all of them, in order) and Aruba (vendor 14823) type 1
  `Aruba-User-Role` (the first one). A single Vendor-Specific attribute may hold several sub-attributes.
  Other vendors and types are ignored.

## Exit codes (CLI)

0 Access-Accept, 1 Access-Reject or Access-Challenge, 2 timeout or bad-response, 64 usage error.
