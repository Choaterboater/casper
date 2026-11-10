import { expect, test } from "bun:test";
import { isSecretFile, isSecretName, scrubAssignments, scrubPlainSecrets, secretEnvValues } from "../src/secrets/files";
import { Scrubber } from "../src/secrets/netconan";
import { scrubProseSecrets } from "../src/secrets/prose";
import { scrubToolOutput } from "../src/secrets/tool-output";
import { removeTempDir } from "./support/temp-dir";

const scrubber = new Scrubber({ env: { CASPER_NETCONAN: "off" } });
const DOTENV = "# Mist\nMIST_APITOKEN=abc123\nexport CENTRAL_CLIENT_SECRET=\"s3cr3t value\"\nMIST_HOST=api.mist.com\nDB_PASSWORD=hunter2 # local\n";

test("read('.env') hides every secret-named value and keeps names and plain settings", async () => {
  const result = await scrubToolOutput(scrubber, "read", { path: ".env" }, [DOTENV], undefined, { env: {} });
  const text = result!.texts[0]!;
  expect(text).not.toContain("abc123");
  expect(text).not.toContain("s3cr3t value");
  expect(text).not.toContain("hunter2");
  expect(text).toBe("# Mist\nMIST_APITOKEN=<secret hidden>\nexport CENTRAL_CLIENT_SECRET=\"<secret hidden>\"\nMIST_HOST=api.mist.com\nDB_PASSWORD=<secret hidden> # local\n");
  expect(result!.note).toBe("3 secrets hidden before the AI saw this (passwords, keys).");
});

test(".env and credential files stay hidden with /secrets files off; device configs do not", async () => {
  const off = { configs: false, env: {} };
  expect((await scrubToolOutput(scrubber, "read", { path: "deploy/.env.production" }, [DOTENV], undefined, off))!.texts[0]).not.toContain("abc123");
  expect(await scrubToolOutput(scrubber, "read", { path: "backups/sw1.cfg" }, ["snmp-server community FixtureComm"], undefined, off)).toBeUndefined();
});

test("INI, JSON credential files and private keys are scrubbed", async () => {
  const ini = "[default]\naws_access_key_id = AKIAEXAMPLEKEY\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG\nregion = eu-west-1\n";
  const iniText = (await scrubToolOutput(scrubber, "read", { path: "config/credentials" }, [ini], undefined, { env: {} }))!.texts[0]!;
  expect(iniText).not.toContain("wJalrXUtnFEMI");
  expect(iniText).toContain("region = eu-west-1");
  const json = "{\n  \"client_id\": \"abc\",\n  \"client_secret\": \"GOCSPX-1234567\",\n  \"refresh_token\": \"1//0gRefresh\"\n}";
  const jsonText = (await scrubToolOutput(scrubber, "read", { path: "secrets.json" }, [json], undefined, { env: {} }))!.texts[0]!;
  expect(jsonText).not.toContain("GOCSPX-1234567");
  expect(jsonText).not.toContain("1//0gRefresh");
  expect(jsonText).toContain("\"client_id\": \"abc\"");
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
  expect((await scrubToolOutput(scrubber, "read", { path: "deploy/id_ed25519" }, [key], undefined, { env: {} }))!.texts[0]).not.toContain("b3BlbnNzaC1rZXktdjEAAAA");
});

test("cat and grep of a .env hide the values; grepped source code stays as it is", async () => {
  const cat = await scrubToolOutput(scrubber, "bash", { command: "cat .env" }, [DOTENV], undefined, { env: {} });
  expect(cat!.texts[0]).not.toContain("abc123");
  const grep = await scrubToolOutput(scrubber, "grep", { pattern: "TOKEN" }, ["./.env:2:MIST_APITOKEN=abc123"], undefined, { env: {} });
  expect(grep!.texts[0]).toBe("./.env:2:MIST_APITOKEN=<secret hidden>");
  const code = [
    "src/auth.ts:3:  const token = await getToken(user);",
    "src/auth.py:9:    password: str",
    "src/auth.py:10:    self.api_key = api_key",
    "src/client.ts:4:  headers.Authorization = `Bearer ${token}`;",
    "src/usage.ts:1:  max_tokens: 4096,",
    "src/app.ts:5:if (token == expected) return;",
  ].join("\n");
  expect(await scrubToolOutput(scrubber, "grep", { pattern: "token" }, [code], undefined, { env: {} })).toBeUndefined();
});

test("exact values of secret-named environment variables are hidden in command output", async () => {
  const env = { OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef", MIST_API_TOKEN: "mist-0123456789", PATH: "/usr/bin", HOME: "/home/x",
    GOOGLE_APPLICATION_CREDENTIALS: "/home/x/key.json", SHORT_TOKEN: "abc" };
  expect(secretEnvValues(env)).toEqual(["sk-or-v1-0123456789abcdef", "mist-0123456789"]);
  const out = await scrubToolOutput(scrubber, "bash", { command: "printenv" }, ["sk-or-v1-0123456789abcdef\nvalue: mist-0123456789\n/usr/bin"], undefined, { env });
  expect(out!.texts[0]).toBe("<secret hidden>\nvalue: <secret hidden>\n/usr/bin");
  // A file read that holds a copy of a key is covered too.
  expect((await scrubToolOutput(scrubber, "read", { path: "notes.md" }, ["key is sk-or-v1-0123456789abcdef"], undefined, { env }))!.texts[0]).toBe("key is <secret hidden>");
});

test("secret file and secret name rules", () => {
  for (const name of [".env", ".env.local", "prod.env", ".envrc", ".netrc", "credentials", "aws_credentials.ini", "app.ini", "secrets.yaml", "terraform.tfvars", "server.pem", "id_rsa"]) expect([name, isSecretFile(`a/${name}`)]).toEqual([name, true]);
  for (const name of ["env.ts", "README.md", "package.json", "environment.py", ".envelope"]) expect([name, isSecretFile(name)]).toEqual([name, false]);
  for (const name of ["MIST_APITOKEN", "CENTRAL_CLIENT_SECRET", "DB_PASSWORD", "aws_secret_access_key", "apiKey", "wpa_passphrase", "token", "refresh_token"]) expect([name, isSecretName(name)]).toEqual([name, true]);
  for (const name of ["MIST_HOST", "TOKEN_URL", "aws_access_key_id", "next_token", "max_tokens", "PWD", "key", "password_file", "LOG_LEVEL"]) expect([name, isSecretName(name)]).toEqual([name, false]);
});

test("several pairs on one line are each checked", () => {
  expect(scrubAssignments("user=bob, password=hunter22, token=t0ken123", false).text).toBe("user=bob, password=<secret hidden>, token=<secret hidden>");
  expect(scrubPlainSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc", { env: {} }).text).toBe("Authorization: Bearer <secret hidden>");
});

test("a private key printed by a command is hidden even with /secrets files off", async () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
  const out = await scrubToolOutput(scrubber, "bash", { command: "cat deploy_key" }, [key], undefined, { configs: false, env: {} });
  expect(out!.texts[0]).not.toContain("b3BlbnNzaC1rZXktdjEAAAA");
});

test("a key file's certificate armor line still gets the device rules: a community after an END on the same line goes", async () => {
  // Made-up values. A key file's armor line used to skip the device rules, so this community reached the AI.
  const pem = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUFixtureCertBody0123456789abcdefABCDEF\n-----END CERTIFICATE----- snmp-server community FixComm77 RO\n";
  for (const configs of [true, false]) {
    const out = await scrubToolOutput(scrubber, "read", { path: "certs/bundle.pem" }, [pem], undefined, { configs, env: {} });
    expect([configs, out?.texts[0]]).toEqual([configs, pem.replace("FixComm77", "<secret hidden>")]);
  }
});

test("passwords inside addresses and webhook or DSN addresses are hidden", async () => {
  const env = "DATABASE_URL=postgres://admin:Sup3rS3cret@db.local:5432/app\nSLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0/B0/abcd1234\nSENTRY_DSN=https://k3y@o1.ingest.sentry.io/1\nAPP_URL=https://example.com\n";
  const read = await scrubToolOutput(scrubber, "read", { path: ".env" }, [env], undefined, { configs: false, env: {} });
  expect(read!.texts[0]).toBe("DATABASE_URL=postgres://admin:<secret hidden>@db.local:5432/app\nSLACK_WEBHOOK_URL=<secret hidden>\nSENTRY_DSN=<secret hidden>\nAPP_URL=https://example.com\n");
  // git remote -v and similar command output: the password part goes, the rest stays.
  const shell = await scrubToolOutput(scrubber, "bash", { command: "git remote -v" }, ["origin\thttps://bot:ghp_abcdef012345@github.com/o/r.git (fetch)\norigin\tssh://git@github.com/o/r.git (push)"], undefined, { configs: false, env: {} });
  expect(shell!.texts[0]).toBe("origin\thttps://bot:<secret hidden>@github.com/o/r.git (fetch)\norigin\tssh://git@github.com/o/r.git (push)");
  expect(isSecretName("webhook_url")).toBe(true);
  expect(isSecretName("webhook_enabled")).toBe(false);
});

test("webhook and DSN environment values are hidden even without a password in them; other URLs stay", async () => {
  const env = { SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T0/B0/abcd1234", TEAMS_WEBHOOK: "https://example.webhook.office.com/webhookb2/xyz789",
    SENTRY_DSN: "https://o1.ingest.sentry.io/api/1/abcdef", TOKEN_URL: "https://auth.example.com/oauth/token", API_TOKEN_ENDPOINT: "https://api.example.com/v2" };
  expect(secretEnvValues(env).sort()).toEqual([env.SENTRY_DSN, env.SLACK_WEBHOOK_URL, env.TEAMS_WEBHOOK].sort());
  const out = await scrubToolOutput(scrubber, "bash", { command: "printenv" }, [`${env.SLACK_WEBHOOK_URL}\n${env.TOKEN_URL}`], undefined, { env });
  expect(out!.texts[0]).toBe(`<secret hidden>\n${env.TOKEN_URL}`);
});

test("a webhook or DSN on this machine (localhost, 127.x, ::1) is not a login and stays shown", () => {
  const env = { STRIPE_WEBHOOK_URL: "http://localhost:4242/webhooks", DATABASE_DSN: "postgres://localhost/app", LOCAL_DSN: "postgres://127.0.0.1:5432/app",
    V6_WEBHOOK: "http://[::1]:9000/hook", DEV_WEBHOOK: "http://app.localhost:3000/hook", SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T0/B0/abcd1234",
    LOOKALIKE_WEBHOOK: "https://localhost.example.com/hook" };
  expect(secretEnvValues(env).sort()).toEqual([env.LOOKALIKE_WEBHOOK, env.SLACK_WEBHOOK_URL].sort());
});

test("keys in Casper's login file are hidden wherever they show up", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os"); const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-login-values-"));
  try {
    const loginFile = path.join(dir, "auth.json");
    await writeFile(loginFile, JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-v1-0123456789abcdef" }, other: { type: "oauth", access: "eyJhbGciOiJIUzI1NiJ9.abcdefghijkl", expires: 1 } }));
    const result = await scrubToolOutput(scrubber, "bash", { command: "cat auth.json" }, [`key sk-or-v1-0123456789abcdef and eyJhbGciOiJIUzI1NiJ9.abcdefghijkl`], undefined, { configs: false, env: {}, loginFile });
    expect(result!.texts[0]).toBe("key <secret hidden> and <secret hidden>");
    // A missing login file hides nothing extra.
    expect(await scrubToolOutput(scrubber, "bash", { command: "echo" }, ["sk-or-v1-0123456789abcdef"], undefined, { configs: false, env: {}, loginFile: path.join(dir, "none.json") })).toBeUndefined();
  } finally { await removeTempDir(dir); }
});

test("service tool JSON is checked string by string", async () => {
  const text = JSON.stringify({ data: { service: "web", logs: "ready\nAPI_TOKEN=tok-live-778899\n" } });
  const result = await scrubToolOutput(scrubber, "service", { action: "logs" }, [text], undefined, { configs: false, env: {} });
  expect(JSON.parse(result!.texts[0]!)).toEqual({ data: { service: "web", logs: "ready\nAPI_TOKEN=<secret hidden>\n" } });
});

test("git diff output: a secret on a removed line is hidden like one on an added line", () => {
  const diff = "-API_KEY = \"q8Zr2LmN7vXk4TpW\"\n+API_KEY = \"w3Kd9PqR1sTu6VxY\"\n-db_password: hunter2hunter2\n+token = get_token()\n-x-flag = 1";
  const result = scrubAssignments(diff, false);
  expect(result.text).toBe("-API_KEY = \"<secret hidden>\"\n+API_KEY = \"<secret hidden>\"\n-db_password: <secret hidden>\n+token = get_token()\n-x-flag = 1");
  expect(result.hidden).toBe(3);
});

test("lab logins written as prose, markdown or a table are hidden; the words around them stay", async () => {
  const doc = [
    "## BUILD-SERVER lab",
    "Proxmox: root / Example!Pass99",
    "**Password:** hunter22x",
    "Password: **Summer**",
    "pw: `abc123`",
    "the password is S3cret!x now",
    "password Winter2024",
    "login: admin / Adm1n!",
    "creds: netops / N3t0ps",
    "ssh admin:Sup3r@10.0.0.5",
    "| Host | User | Password |",
    "|---|---|---|",
    "| build-server | root | Example!Pass99 |",
  ].join("\n");
  const result = await scrubToolOutput(scrubber, "read", { path: "docs/lab.md" }, [doc], undefined, { configs: false, env: {} });
  const text = result!.texts[0]!;
  for (const secret of ["Example!Pass99", "hunter22x", "Summer", "abc123", "S3cret!x", "Winter2024", "Adm1n!", "N3t0ps", "Sup3r"]) expect([secret, text.includes(secret)]).toEqual([secret, false]);
  expect(text.split("\n")).toEqual([
    "## BUILD-SERVER lab",
    "Proxmox: root / <secret hidden>",
    "**Password:** <secret hidden>",
    "Password: **<secret hidden>**",
    "pw: `<secret hidden>`",
    "the password is <secret hidden> now",
    "password <secret hidden>",
    "login: admin / <secret hidden>",
    "creds: netops / <secret hidden>",
    "ssh admin:<secret hidden>@10.0.0.5",
    "| Host | User | Password |",
    "|---|---|---|",
    "| build-server | root | <secret hidden> |",
  ]);
});

// Made-up values. Each table is drawn the way its tool draws it: a rule under the header, and for some one between rows.
const GRID_SECRETS = ["Fake-Grid-Pass-0001", "Fake-Grid-Pass-0002"];
/** A table of two logins. `head` and `body` are the bars of the header and of the rows; each rule is its left end, fill, cross and right end. */
function grid(head: string, body: string, rules: { top?: string; under: string; between?: string; bottom?: string }): string[] {
  const widths = [8, 21, 6];
  const rule = (marks?: string) => marks ? [`${marks[0]}${widths.map((width) => marks[1]!.repeat(width)).join(marks[2])}${marks[3]}`] : [];
  const row = (bar: string, cells: string[]) => `${bar}${cells.map((cell, at) => ` ${cell.padEnd(widths[at]! - 1)}`).join(bar)}${bar}`;
  return [...rule(rules.top), row(head, ["user", "password", "role"]), ...rule(rules.under), row(body, ["app", GRID_SECRETS[0]!, "rw"]),
    ...rule(rules.between), row(body, ["backup", GRID_SECRETS[1]!, "ro"]), ...rule(rules.bottom)];
}
const GRIDS: Array<[string, string[]]> = [
  ["mysql, psql with a border, tabulate pretty", grid("|", "|", { top: "+-++", under: "+-++", bottom: "+-++" })],
  ["tabulate grid", grid("|", "|", { top: "+-++", under: "+=++", between: "+-++", bottom: "+-++" })],
  ["a line of = under the header", grid("|", "|", { under: "====" })],
  ["a box with a rule between rows (tabulate simple_grid, rich with lines)", grid("│", "│", { top: "┌─┬┐", under: "├─┼┤", between: "├─┼┤", bottom: "└─┴┘" })],
  ["rich's default table", grid("┃", "│", { top: "┏━┳┓", under: "┡━╇┩", bottom: "└─┴┘" })],
  ["tabulate fancy_grid, pveum", grid("│", "│", { top: "╒═╤╕", under: "╞═╪╡", between: "├─┼┤", bottom: "╘═╧╛" })],
  ["tabulate heavy_grid", grid("┃", "┃", { top: "┏━┳┓", under: "┣━╋┫", between: "┣━╋┫", bottom: "┗━┻┛" })],
  ["tabulate double_grid", grid("║", "║", { top: "╔═╦╗", under: "╠═╬╣", between: "╠═╬╣", bottom: "╚═╩╝" })],
  ["tabulate rounded_grid", grid("│", "│", { top: "╭─┬╮", under: "├─┼┤", between: "├─┼┤", bottom: "╰─┴╯" })],
  // psql's own table has no bar at either end of a row.
  ["psql", [" usename |       passwd        | role ", "---------+---------------------+------", " app     | Fake-Grid-Pass-0001 | rw", " backup  | Fake-Grid-Pass-0002 | ro", "(2 rows)"]],
  ["psql, a row with no name", [" usename |       passwd        | role ", "---------+---------------------+------", " app     | Fake-Grid-Pass-0001 | rw", "         | Fake-Grid-Pass-0002 | ro", "(2 rows)"]],
  ["psql with unicode lines", [" usename │       passwd        │ role ", "─────────┼─────────────────────┼──────", " app     │ Fake-Grid-Pass-0001 │ rw", " backup  │ Fake-Grid-Pass-0002 │ ro", "(2 rows)"]],
];

test("a rule line under a table's header or between its rows keeps the Password column hidden: mysql, psql, rich and tabulate grids", async () => {
  let windows = 0;
  for (const [name, lines] of GRIDS) {
    const header = lines.findIndex((line) => /pass/.test(line));
    const want = lines.map((line) => GRID_SECRETS.reduce((out, secret) => out.replace(secret, "<secret hidden>"), line));
    // The words around the secrets stay: the header, the other cells and every rule.
    expect([name, scrubPlainSecrets(lines.join("\n"), { env: {} }).text.split("\n")]).toEqual([name, want]);
    // Every run of whole lines with the header in view, as an output cut anywhere would be read: no run shows a
    // secret or a secret's tail. (A row whose header is above the run has no column to go by.)
    for (let start = 0; start <= header; start++) {
      for (let end = start + 1; end <= lines.length; end++) {
        for (const [tool, input] of [["bash", { command: "./logins.sh" }], ["read", { path: "notes/logins.txt" }]] as const) {
          const text = lines.slice(start, end).join("\n");
          const out = (await scrubToolOutput(scrubber, tool, input, [text], undefined, { env: {} }))?.texts[0] ?? text;
          windows++;
          for (const secret of GRID_SECRETS) {
            for (const part of [secret, secret.slice(-6)]) expect([name, tool, start, end, part, out.includes(part)]).toEqual([name, tool, start, end, part, false]);
          }
        }
      }
    }
  }
  expect(windows).toBeGreaterThan(200);
  // Under a device config's lines the device rules read the output first: the same columns go.
  for (const [name, lines] of GRIDS) {
    const text = ["hostname lab-sw1", "snmp-server community FixtureComm9 RO", ...lines].join("\n");
    const out = (await scrubToolOutput(scrubber, "bash", { command: "./logins.sh" }, [text], undefined, { env: {} }))!.texts[0]!;
    for (const secret of ["FixtureComm9", ...GRID_SECRETS]) expect([name, secret, out.includes(secret.slice(-6))]).toEqual([name, secret, false]);
  }
});

test("a table's rules hide no more than its secret column: a key and value table keeps its names, and the next table starts fresh", () => {
  const plain = (text: string) => scrubPlainSecrets(text, { env: {} }).text;
  // pveum and pvesh draw "key | value": the key column names the rows, and only the token's value goes.
  const uuid = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
  const pveum = ["┌──────────────┬──────────────────────────────────────┐", "│ key          │ value                                │",
    "╞══════════════╪══════════════════════════════════════╡", "│ full-tokenid │ root@pam!sampleapp                   │",
    "├──────────────┼──────────────────────────────────────┤", "│ info         │ {\"privsep\":\"1\"}                      │",
    "├──────────────┼──────────────────────────────────────┤", `│ value        │ ${uuid} │`,
    "└──────────────┴──────────────────────────────────────┘"];
  expect(plain(pveum.join("\n")).split("\n")).toEqual(pveum.map((line) => line.replace(uuid, "<secret hidden>")));
  // A table with no secret column stays whole, with any rules.
  const nicknames = (lines: string[]) => lines.join("\n").replace(/password|passwd/, "nickname").replaceAll("Fake-Grid-Pass-000", "Fixture-Nick-Name-0");
  for (const [name, lines] of GRIDS) expect([name, plain(nicknames(lines))]).toEqual([name, nicknames(lines)]);
  // A bottom edge and then a top edge: a table printed right under a table of logins is read by its own header.
  for (const [name, logins] of [GRIDS[1]!, GRIDS[4]!]) {
    const hidden = logins.join("\n").replaceAll(/Fake-Grid-Pass-000\d/g, "<secret hidden>");
    expect([name, plain(`${logins.join("\n")}\n${nicknames(logins)}`)]).toEqual([name, `${hidden}\n${nicknames(logins)}`]);
  }
  // Text after a table ends it.
  expect(plain(`${GRIDS[0]![1].join("\n")}\n2 rows in set\n| app | Fixture-Nick-Name-01 | rw |`)).toContain("| app | Fixture-Nick-Name-01 | rw |");
});

test("a key column is kept only in a two-column key and value table; psql's table is read with CRLF line ends, by its row names, and with a bar inside a value", async () => {
  const plain = (text: string) => scrubPlainSecrets(text, { env: {} }).text;
  // Made-up values. Each case: its lines, what must not show (a secret, or the pieces a bar cuts it into), what must stay.
  const cases: Array<{ name: string; lines: string[]; gone: string[]; stay: string[] }> = [
    // A key column beside a value column and anything else holds keys, as on a table with no value column.
    { name: "name, key and value", gone: ["Fake-Api-Key-0001", "Fake-Api-Key-0002"], stay: ["billing", "eu-west"],
      lines: ["| name | key | value |", "|---|---|---|", "| billing | Fake-Api-Key-0001 | eu-west |", "| search | Fake-Api-Key-0002 | us-east |"] },
    { name: "service, key and values, a grid", gone: ["Fake-Api-Key-0001"], stay: ["billing", "eu-west"],
      lines: ["+---------+-------------------+---------+", "| service | key               | values  |", "+---------+-------------------+---------+",
        "| billing | Fake-Api-Key-0001 | eu-west |", "+---------+-------------------+---------+"] },
    { name: "psql: usename, keys and value", gone: ["Fake-Api-Key-0001"], stay: ["billing", "eu-west"],
      lines: [" usename |       keys        |  value  ", "---------+-------------------+---------", " billing | Fake-Api-Key-0001 | eu-west", "(1 row)"] },
    // psql's key and value table: the key column names the rows, and a row named password hides its value.
    { name: "psql: key and value", gone: ["Fake-Grid-Pass-0001", "Fake-Tok-Value-0002"], stay: ["host", "db.example.test", "password", "token"],
      lines: ["   key    |        value        ", "----------+---------------------", " host     | db.example.test", " password | Fake-Grid-Pass-0001", " token    | Fake-Tok-Value-0002", "(3 rows)"] },
    // psql does not escape a bar inside a value: the row is one cell longer than its header.
    { name: "psql: a bar inside a password", gone: ["Fake-Grid", "Pass-0001", "Fake-Grid-Pass-0002"], stay: ["app", "backup"],
      lines: [" usename |       passwd        | role ", "---------+---------------------+------", " app     | Fake-Grid|Pass-0001 | rw", " backup  | Fake-Grid-Pass-0002 | ro", "(2 rows)"] },
    { name: "psql: a bar inside a value under a row name", gone: ["Fake-Grid", "Pass-0001"], stay: ["host", "password"],
      lines: ["   key    |        value        ", "----------+---------------------", " host     | db.example.test", " password | Fake-Grid|Pass-0001", "(2 rows)"] },
    { name: "Markdown: a bar inside a password", gone: ["Fake-Grid", "Pass-0001"], stay: ["app"],
      lines: ["| user | password | role |", "|---|---|---|", "| app | Fake-Grid|Pass-0001 | rw |"] },
  ];
  let windows = 0;
  for (const { name, lines, gone, stay } of cases) {
    const header = lines.findIndex((line) => /key|pass/.test(line));
    // Unix and Windows line ends (psql on Windows, a saved .txt).
    for (const end of ["\n", "\r\n"]) {
      const out = plain(lines.join(end));
      for (const part of gone) expect([name, end, part, out.includes(part), out.includes(part.slice(-6))]).toEqual([name, end, part, false, false]);
      for (const word of stay) expect([name, end, word, out.includes(word)]).toEqual([name, end, word, true]);
      // Every run of whole lines with the header in view, through the final scrub.
      for (let start = 0; start <= header; start++) {
        for (let stop = start + 1; stop <= lines.length; stop++) {
          const text = lines.slice(start, stop).join(end);
          const shown = (await scrubToolOutput(scrubber, "bash", { command: "./logins.sh" }, [text], undefined, { env: {} }))?.texts[0] ?? text;
          windows++;
          for (const part of gone) expect([name, end, start, stop, part, shown.includes(part), shown.includes(part.slice(-6))]).toEqual([name, end, start, stop, part, false, false]);
        }
      }
    }
  }
  expect(windows).toBeGreaterThan(60);
  // Every grid of the tests above reads the same with CRLF line ends.
  for (const [name, lines] of GRIDS) {
    const out = plain(lines.join("\r\n"));
    for (const secret of GRID_SECRETS) expect([name, secret, out.includes(secret.slice(-6))]).toEqual([name, secret, false]);
  }
});

/** Each case: its lines, what must not show (a secret, or the pieces a bar cuts it into), what must stay. Made-up values. */
type TableCase = { name: string; lines: string[]; gone: string[]; stay: string[] };
async function expectTables(cases: TableCase[]): Promise<void> {
  for (const { name, lines, gone, stay } of cases) {
    for (const end of ["\n", "\r\n"]) {
      const out = scrubPlainSecrets(lines.join(end), { env: {} }).text;
      const shown = (await scrubToolOutput(scrubber, "bash", { command: "./report.py" }, [lines.join(end)], undefined, { env: {} }))?.texts[0] ?? lines.join(end);
      for (const text of [out, shown]) {
        for (const part of gone) expect([name, end, part, text.includes(part), text.includes(part.slice(-6))]).toEqual([name, end, part, false, false]);
        for (const word of stay) expect([name, end, word, text.includes(word)]).toEqual([name, end, word, true]);
      }
    }
  }
}

test("a table printed after a line of dashes, or a grid's top edge right under Markdown rows, is read by its own header", async () => {
  const pipe = (first: string[], second: string[]) => [...first, ...second];
  const logins = ["| password            | user |", "|---------------------|------|", "| Fake-Grid-Pass-0001 | a    |"];
  const swapped = ["| user | password            |", "|------|---------------------|", "| b    | Fake-Grid-Pass-0002 |"];
  const grid = ["+------+---------------------+", "| user | password            |", "+======+=====================+", "| b    | Fake-Grid-Pass-0002 |", "+------+---------------------+"];
  const gone = ["Fake-Grid-Pass-0001", "Fake-Grid-Pass-0002"];
  await expectTables([
    // A Python script printing tabulate's pipe or github tables with print('-' * 40) between them.
    { name: "pipe tables with a line of dashes between", gone, stay: ["| user | password            |", "| b    |", "| a    |"], lines: pipe(logins, ["-".repeat(40), ...swapped]) },
    { name: "pipe tables with a line of = between", gone, stay: ["| user | password            |", "| b    |"], lines: pipe(logins, ["=".repeat(40), ...swapped]) },
    { name: "grid tables with a line of dashes between", gone, stay: ["| user | password            |", "| b    |"],
      lines: pipe(["+---------------------+------+", "| password            | user |", "+=====================+======+", "| Fake-Grid-Pass-0001 | a    |", "+---------------------+------+"], ["-".repeat(40), ...grid]) },
    // Markdown rows and then straight away a grid's single top edge.
    { name: "Markdown rows and then a grid", gone, stay: ["| user | password            |", "| b    |"], lines: pipe(logins, grid) },
    // A bare rule right under the header is the header's rule: the rows below it are still read.
    { name: "a line of dashes under the header", gone: ["Fake-Grid-Pass-0001"], stay: ["| a    |"], lines: ["| password            | user |", "-".repeat(30), "| Fake-Grid-Pass-0001 | a    |"] },
  ]);
});

test("a Markdown row with no last bar is hidden from its first secret cell to its end, so a bar inside the value hides no less", async () => {
  await expectTables([
    { name: "a bar inside the password", gone: ["Fake-Grid", "Pass-0001"], stay: ["| app |", "| user | password | role |"],
      lines: ["| user | password | role |", "|---|---|---|", "| app | Fake-Grid|Pass-0001"] },
    { name: "no bar inside the password", gone: ["Fake-Grid-Pass-0002"], stay: ["| app |"], lines: ["| user | password | role |", "|---|---|---|", "| app | Fake-Grid-Pass-0002"] },
    // A header with no last bar: its rows are read the same way. A row with a last bar keeps the cells after the secret.
    { name: "no last bar anywhere", gone: ["Fake-Grid", "Pass-0001", "Fake-Grid-Pass-0002"], stay: ["| app |", "| backup |", "| ops | <secret hidden> | ro |"],
      lines: ["| user | password | role", "|---|---|---", "| app | Fake-Grid|Pass-0001", "| backup | Fake-Grid-Pass-0002 | ro", "| ops | Fake-Grid-Pass-0003 | ro |"] },    // A line with one bar has no cells: it stays as it is.
    { name: "a line with one bar", gone: [], stay: ["| a note on one bar"], lines: ["| user | password | role |", "|---|---|---|", "| a note on one bar"] },
  ]);
});

test("mysql's EXPLAIN and DESCRIBE keep their key column: it names an index there, not a secret", async () => {
  const explain = ["+----+-------------+-------+------+---------------+-----------+---------+-------+------+-------+",
    "| id | select_type | table | type | possible_keys | key       | key_len | ref   | rows | Extra |",
    "+----+-------------+-------+------+---------------+-----------+---------+-------+------+-------+",
    "|  1 | SIMPLE      | users | ref  | idx_email     | idx_email | 1022    | const |    1 | NULL  |",
    "+----+-------------+-------+------+---------------+-----------+---------+-------+------+-------+"];
  const describe = ["+-------+--------------+------+-----+---------+----------------+", "| Field | Type         | Null | Key | Default | Extra          |",
    "+-------+--------------+------+-----+---------+----------------+", "| id    | int          | NO   | PRI | NULL    | auto_increment |",
    "| email | varchar(255) | YES  | UNI | NULL    |                |", "| team  | int          | YES  | MUL | NULL    |                |",
    "+-------+--------------+------+-----+---------+----------------+"];
  for (const lines of [explain, describe]) expect(scrubPlainSecrets(lines.join("\n"), { env: {} }).text).toBe(lines.join("\n"));
  // Any other table's key column is still hidden.
  await expectTables([{ name: "a key column beside a table name", gone: ["Fake-Api-Key-0001"], stay: ["billing"],
    lines: ["+---------+-------------------+", "| table   | key               |", "+---------+-------------------+", "| billing | Fake-Api-Key-0001 |", "+---------+-------------------+"] }]);
});

test("a key and value table hides the value of any row whose name holds a secret: api_key, db_password, Secret Key", async () => {
  const rows = [["api_key", "Fake-Api-Key-0001"], ["db_password", "Fake-Grid-Pass-0001"], ["client_secret", "Fake-Client-Sec-0001"],
    ["secret_key", "Fake-Secret-Key-0001"], ["Secret Key", "Fake-Secret-Key-0002"], ["token_type", "bearer-fixture"], ["host", "db.example.test"]];
  const gone = rows.slice(0, 5).map(([, value]) => value!);
  const stay = ["api_key", "Secret Key", "bearer-fixture", "db.example.test"];
  const boxed = (head: string) => ["+---------------+----------------------+", `| ${head.padEnd(13)} | value                |`, "+---------------+----------------------+",
    ...rows.map(([key, value]) => `| ${key!.padEnd(13)} | ${value!.padEnd(20)} |`), "+---------------+----------------------+"];
  await expectTables([
    { name: "key and value", gone, stay, lines: boxed("key") },
    { name: "setting and value", gone, stay, lines: boxed("setting") },
    { name: "psql: key and value", gone, stay,
      lines: ["      key      |        value         ", "---------------+----------------------", ...rows.map(([key, value]) => ` ${key!.padEnd(13)} | ${value}`), "(7 rows)"] },
    { name: "setting and value, a bar inside the value", gone: ["Fake-Grid", "Pass-0009"], stay: ["db_password", "| port        | 5432 |"],
      lines: ["| setting     | value |", "|---|---|", "| port        | 5432 |", "| db_password | Fake-Grid|Pass-0009 |"] },
  ]);
  // A table of names and what they mean is not a key and value table: its words stay.
  const docs = "| Option | Meaning |\n|---|---|\n| `client_secret` | The OAuth client's secret |\n| api_key | Your service key |";
  expect(scrubPlainSecrets(docs, { env: {} }).text).toBe(docs);
});

test("a file or branch name with login in it is not a login: the name after it stays", () => {
  for (const command of [
    "git log origin/fix/login-expired origin/fix/minors",
    "bun test --parallel tests/mcp-network-login-ask.test.ts tests/capabilities-kinds.test.ts",
    "bun test tests/login.test.ts tests/other-logins.test.ts",
    "cat docs/sign-in.md docs/account.md",
  ]) expect(scrubPlainSecrets(command, { env: {} })).toMatchObject({ text: command, hidden: 0 });
  // A login written as words still is one.
  expect(scrubPlainSecrets("login admin / Adm1n!", { env: {} }).text).toBe("login admin / <secret hidden>");
  expect(scrubPlainSecrets("sign-in root / R00tpw", { env: {} }).text).toBe("sign-in root / <secret hidden>");
  expect(scrubPlainSecrets("username/password: admin / Adm1n!", { env: {} }).text).toBe("username/password: admin / <secret hidden>");
});

test("Proxmox API tokens and token=<uuid> are hidden, in output and in the pveum token table", () => {
  const uuid = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
  expect(scrubPlainSecrets(`curl -k -H "Authorization: PVEAPIToken=root@pam!sampleapp=${uuid}" https://build-server:8006/api2/json/nodes`, { env: {} }).text).not.toContain(uuid);
  expect(scrubPlainSecrets(`TOKEN_ID=root@pam!sampleapp; echo root@pam!sampleapp=${uuid}`, { env: {} }).text).toBe("TOKEN_ID=root@pam!sampleapp; echo root@pam!sampleapp=<secret hidden>");
  expect(scrubPlainSecrets(`token=${uuid.replace(/-/g, "")}abcd`, { env: {} }).text).toBe("token=<secret hidden>");
  const table = `│ full-tokenid │ root@pam!sampleapp │\n│ value        │ ${uuid} │`;
  expect(scrubPlainSecrets(table, { env: {} }).text).toBe("│ full-tokenid │ root@pam!sampleapp │\n│ value        │ <secret hidden> │");
  // Ids that name something, not a login, stay.
  const ids = `site_id=${uuid} token_id=${uuid} org ${uuid}`;
  expect(scrubPlainSecrets(ids, { env: {} }).text).toBe(ids);
});

test("a long word is checked quickly: the Proxmox token rule starts only at the start of a word", () => {
  const started = performance.now();
  expect(scrubProseSecrets("x".repeat(64_000)).hidden).toBe(0);
  expect(performance.now() - started).toBeLessThan(500);
  expect(scrubPlainSecrets("id=root@pam!ci=0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", { env: {} }).text).toBe("id=root@pam!ci=<secret hidden>");
});

test("a Proxmox login with its realm, a bold login and a token id followed by its secret are hidden too", () => {
  const uuid = "3f1c2a4e-9b7d-4e21-8c55-0a1b2c3d4e5f";
  for (const [text, want] of [
    ["Proxmox: https://198.51.100.20:8006 root@pam / Example-Pass1", "Proxmox: https://198.51.100.20:8006 root@pam / <secret hidden>"],
    ["* **root** / **Example-Pass1**", "* **root** / **<secret hidden>**"],
    [`PVE token: root@pam!sampleapp ${uuid}`, "PVE token: <secret hidden> <secret hidden>"],
    [`sampleapp token secret ${uuid}`, "sampleapp token secret <secret hidden>"],
  ] as const) expect(scrubPlainSecrets(text, { env: {} }).text).toBe(want);
  // A token's id on its own, and a uuid on a line about something else, stay.
  for (const text of [`token id ${uuid}`, `vmid 101 uuid ${uuid}`, "full-tokenid root@pam!sampleapp"]) expect(scrubPlainSecrets(text, { env: {} }).text).toBe(text);
});

test("ordinary sentences about passwords and tokens stay readable", () => {
  for (const text of [
    "The password is stored on the switch. Set the secret for the RADIUS server first.",
    "Change the password on first login. The pass rate was 39 of 39 tests.",
    "Use a strong password (12+ chars). Store the API key in .env, see the token docs.",
    "git@github.com:org/repo.git and mailto:bob@example.com",
    "cd /root / tmp",
    "tests pass: 39 passed",
  ]) expect(scrubPlainSecrets(text, { env: {} }).text).toBe(text);
});

test("passwords the AI types into commands are hidden: sshpass, --password, curl -u, mysql -p, sudo -S, chpasswd", () => {
  const cases: Array<[string, string]> = [
    ["sshpass -p 'Example2024!' ssh root@198.51.100.20 uptime", "sshpass -p '<secret hidden>' ssh root@198.51.100.20 uptime"],
    ["sshpass -p Example2024 ssh root@10.0.0.5 id", "sshpass -p <secret hidden> ssh root@10.0.0.5 id"],
    ["pvesh create /access/ticket --username root@pam --password Example2024!", "pvesh create /access/ticket --username root@pam --password <secret hidden>"],
    ["wget --user=root --password='Example2024!' http://x", "wget --user=root --password='<secret hidden>' http://x"],
    ["curl -k -u root@pam:Example2024! https://10.0.0.5:8006/", "curl -k -u root@pam:<secret hidden> https://10.0.0.5:8006/"],
    ["mysql -u root -pExample2024! sampleapp", "mysql -u root -p<secret hidden> sampleapp"],
    ["ipmitool -I lanplus -H 10.0.0.9 -U admin -P Example2024! power status", "ipmitool -I lanplus -H 10.0.0.9 -U admin -P <secret hidden> power status"],
    ["smbclient -U admin%Example2024! //nas/share", "smbclient -U admin%<secret hidden> //nas/share"],
    ["echo 'Example2024!' | sudo -S systemctl restart sampleapp", "echo '<secret hidden>' | sudo -S systemctl restart sampleapp"],
    ["ssh build-server \"echo svc:NewPass99 | chpasswd\"", "ssh build-server \"echo svc:<secret hidden> | chpasswd\""],
    ["The root password for the lab is Example2024!", "The root password for the lab is <secret hidden>"],
    ["user root pass Example2024!", "user root pass <secret hidden>"],
    ["tokenid: root@pam!sampleapp\nvalue: 0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", "tokenid: root@pam!sampleapp\nvalue: <secret hidden>"],
  ];
  for (const [command, shown] of cases) expect(scrubPlainSecrets(command, { env: {} }).text).toBe(shown);
  // Flags and sentences that are not a password stay.
  for (const text of ["cmd --token-file /etc/x", "ssh -p 22 host", "mysql -p sampleapp", "curl -u $USER:$PASS http://x", "npm run build --pass-through",
    "You pass 3 args", "The password for that account was changed", "tar -cvpf x.tar ."]) {
    expect(scrubPlainSecrets(text, { env: {} }).text).toBe(text);
  }
});
