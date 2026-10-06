import { expect, test } from "bun:test";
import { isSecretFile, scrubAssignments, scrubPlainSecrets } from "../src/secrets/files";
import { Scrubber } from "../src/secrets/netconan";
import { keepLiterally } from "../src/secrets/patterns";
import { scrubText, scrubValue } from "../src/secrets/scrub";
import { scrubToolOutput } from "../src/secrets/tool-output";

const scrubber = new Scrubber({ env: { CASPER_NETCONAN: "off" } });
const options = { env: {}, loginFile: "/nonexistent/auth.json" };
const BODY = Array.from({ length: 6 }, (_, index) => `MIIEowIBAAKCAQEAx${index}Fake0Key0Body0Line0For0Tests0Only0abcdefghijklmnopqrstuv`.slice(0, 64));
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", ...BODY, "-----END RSA PRIVATE KEY-----", ""].join("\n");

test("a key file read from part way down hides the key body, with or without its BEGIN line", async () => {
  // read offset 2: the body and the END line, no BEGIN line.
  const fromTwo = PEM.split("\n").slice(1).join("\n");
  for (const file of ["certs/key.pem", "deploy.key", "keys/id_rsa"]) {
    const result = await scrubToolOutput(scrubber, "read", { path: file, offset: 2 }, [fromTwo], undefined, options);
    for (const line of BODY) expect(result!.texts[0]).not.toContain(line);
    expect(result!.note).toContain("private keys");
  }
  // offset 2, limit 3: body lines only, no BEGIN and no END.
  const middle = BODY.slice(0, 3).join("\n");
  const sliced = await scrubToolOutput(scrubber, "read", { path: "certs/key.pem", offset: 2, limit: 3 }, [middle], undefined, options);
  for (const line of BODY.slice(0, 3)) expect(sliced!.texts[0]).not.toContain(line);
  // tail -n +2 key.pem, sed 1d, grep -v BEGIN: command output that keeps the END line.
  const tail = await scrubToolOutput(scrubber, "bash", { command: "tail -n +2 certs/key.pem" }, [fromTwo], undefined, options);
  for (const line of BODY) expect(tail!.texts[0]).not.toContain(line);
  expect(tail!.texts[0]).toContain("-----END RSA PRIVATE KEY-----");
  // An ordinary long word in a key file's comment is not a key line; a certificate in command output stays.
  expect(scrubText("# rotate yearly\n").hidden).toBe(0);
  const cert = "-----BEGIN CERTIFICATE-----\n" + BODY.join("\n") + "\n-----END CERTIFICATE-----\n";
  expect(await scrubToolOutput(scrubber, "bash", { command: "cat cert.pem" }, [cert], undefined, options)).toBeUndefined();
});

test("a PGP private key block is a private key", async () => {
  const pgp = "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQdGBGXabcdEFGHijklMNOPqrstUVWXyz0123456789abcdefABCDEF\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----\n";
  const result = scrubText(pgp);
  expect(result.kinds).toContain("private-key");
  expect(result.text).not.toContain("lQdGBGXabcd");
  const read = await scrubToolOutput(scrubber, "read", { path: "keys/private.asc" }, [pgp], undefined, options);
  expect(read!.texts[0]).not.toContain("lQdGBGXabcd");
  expect(scrubText("-----BEGIN PGP PRIVATE KEY BLOCK----- lQdGBGXabcd -----END PGP PRIVATE KEY BLOCK-----").text).not.toContain("lQdGBGXabcd");
});

test(".pgpass passwords are hidden; host, port, database and user stay", async () => {
  const pgpass = "# local\nlocalhost:5432:appdb:app:S3cretP4ss!\n*:*:*:postgres:Sup3r\\:Adm1n#\n";
  for (const file of ["proj/.pgpass", "proj/pgpass.conf"]) {
    const result = await scrubToolOutput(scrubber, "read", { path: file }, [pgpass], undefined, options);
    expect(result!.texts[0]).toBe("# local\nlocalhost:5432:appdb:app:<secret hidden>\n*:*:*:postgres:<secret hidden>\n");
    expect(result!.note).toBe("2 secrets hidden before the AI saw this (passwords).");
  }
  expect(isSecretFile("C:\\Users\\me\\AppData\\Roaming\\postgresql\\pgpass.conf")).toBe(true);
});

test("Docker registry logins in an auth field are hidden; the registry and email stay", async () => {
  const dockercfg = '{"https://index.docker.io/v1/":{"auth":"dXNlcjpTM2NyZXRQNHNzIQ==","email":"u@example.com"}}';
  const config = '{\n  "auths": {\n    "registry.example.com": {\n      "auth": "dXNlcjpTM2NyZXRQNHNzIQ=="\n    }\n  }\n}';
  for (const [file, text] of [["home/.dockercfg", dockercfg], ["proj/docker/config.json", config], ["home/.docker/config.json", config]] as const) {
    const result = await scrubToolOutput(scrubber, "read", { path: file }, [text], undefined, options);
    expect(result!.texts[0]).not.toContain("dXNlcjpTM2NyZXRQNHNz");
    expect(result!.texts[0]).toContain(file.endsWith(".dockercfg") ? "index.docker.io" : "registry.example.com");
  }
  const cat = await scrubToolOutput(scrubber, "bash", { command: "cat ~/.dockercfg" }, [dockercfg], undefined, options);
  expect(cat!.texts[0]).not.toContain("dXNlcjpTM2NyZXRQNHNz");
  expect(cat!.texts[0]).toContain("u@example.com");
  // In code, auth is a word, not a login.
  expect(scrubAssignments("  auth: 'basic',\n  const auth = getAuth();\n", false).hidden).toBe(0);
});

test("Authorization headers are hidden in any case; prose about tokens stays", () => {
  const leaks = [
    "> authorization: bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.s3cr3tS1gnatur3abc",
    "[http] extraheader = AUTHORIZATION: basic dXNlcjpnaHBfYWJjZGVmZ2hpams=",
    "        extraheader = AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hzX2FiY2RlZmdoaWpr",
    "Authorization: BEARER eyJhbGciOiJIUzI1NiJ9abcdefgh",
    "proxy-authorization: basic cHJveHl1c2VyOnByb3h5cGFzc3dvcmQxMjM=",
  ];
  for (const line of leaks) {
    const result = scrubPlainSecrets(line, { env: {} });
    expect(result.hidden).toBe(1);
    expect(result.text).toContain("<secret hidden>");
  }
  for (const prose of ["token refreshed for the session", "the bearer authentication flow", "authorization: basic auth is off"]) {
    expect(scrubPlainSecrets(prose, { env: {} }).hidden).toBe(0);
  }
});

test("file and MCP output agree on which JSON names are secrets", async () => {
  const device = { radius_server: { passkey: "Rad1usK3y!" }, snmpv3: { auth_pass_phrase: "Auth-Phrase-1" }, ntp: { "key-string": "NtpK3y-1" } };
  const read = await scrubToolOutput(scrubber, "read", { path: "configs/sw1.json" }, [JSON.stringify(device, null, 2)], undefined, options);
  for (const value of ["Rad1usK3y!", "Auth-Phrase-1", "NtpK3y-1"]) expect(read!.texts[0]).not.toContain(value);
  const cloud = { aws_secret_access_key: "wJalrXUtnFEMIK7MDENG", credentials: "c-r-e-d-1234", apitoken: "abcd-1234-efgh", bearer: "eyJhbGciOi", key: "vlan", next_cursor: "abc", token_type: "Bearer" };
  const mcp = scrubValue(cloud);
  for (const value of ["wJalrXUtnFEMIK7MDENG", "c-r-e-d-1234", "abcd-1234-efgh", "eyJhbGciOi"]) expect(JSON.stringify(mcp.value)).not.toContain(value);
  expect(mcp.value).toMatchObject({ key: "vlan", next_cursor: "abc", token_type: "Bearer" });
});

test("only the marker itself counts as already hidden, not any value that starts with <secret", () => {
  expect(keepLiterally("<secret hidden>")).toBe(true);
  expect(keepLiterally("<secret hidden>;")).toBe(true);
  expect(keepLiterally("<secret\u00a0hidden>")).toBe(true);
  expect(keepLiterally("<secret-token-0123456789>")).toBe(false);
  expect(scrubPlainSecrets("TOKEN=<secretive-but-real-token-0123456789>", { secretFile: true, env: {} }).hidden).toBe(1);
});
