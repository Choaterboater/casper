/**
 * Stand-in for a network MCP server that fails or talks a lot on stderr.
 * Never contacts devices or external services.
 *
 * FIXTURE_MODE=fail-start: prints a Python-style traceback to stderr (including FIXTURE_SECRET and a
 *   token=abc123 pair, which Casper must hide), then exits 1 before answering anything.
 * FIXTURE_MODE=chatty: writes about 4 MB of log lines to stderr, then "done" on stdout, and exits 3.
 *   A reader that stops draining stderr leaves this process blocked forever.
 */
export {};

const mode = process.env.FIXTURE_MODE ?? "fail-start";

if (mode === "fail-start") {
  const secret = process.env.FIXTURE_SECRET ?? "";
  process.stderr.write([
    "INFO starting hpe-networking-mcp",
    `DEBUG connecting with client secret ${secret}`,
    "Traceback (most recent call last):",
    '  File "server.py", line 12, in <module>',
    "    config = load(token=abc123)",
    `KeyError: 'CENTRAL_BASE_URL' (secret was ${secret})`,
    "",
  ].join("\n"));
  process.exitCode = 1;
} else if (mode === "chatty") {
  const line = `INFO ${"x".repeat(1000)}\n`;
  for (let i = 0; i < 4000; i++) {
    if (!process.stderr.write(`${i} ${line}`)) await new Promise((resolve) => process.stderr.once("drain", resolve));
  }
  process.stderr.write("last chatty line\n");
  process.stdout.write("done\n");
  process.exitCode = 3;
}
