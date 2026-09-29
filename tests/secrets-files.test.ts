import { expect, test } from "bun:test";
import { isSecretFile, isSecretName, scrubAssignments, scrubPlainSecrets, secretEnvValues } from "../src/secrets/files";
import { Scrubber } from "../src/secrets/netconan";
import { scrubToolOutput } from "../src/secrets/tool-output";

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
