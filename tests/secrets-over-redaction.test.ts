import { expect, test } from "bun:test";
import { SECRET_RULES } from "../src/secrets/patterns";
import { SECRET_MARKER, scrubText } from "../src/secrets/scrub";
import { hideCommandSecrets, scrubAssignments, scrubPlainSecrets } from "../src/secrets/files";
import { redactPreview } from "../src/tui/format";

// Ordinary code that once came back with "password" hidden and a "fail" literal gone.
const CODE = [
  "type Kind = \"password\" | \"hash\" | \"key\";",
  "const label = kind === \"secret\"",
  "  ? \"password\" | \"hash\"",
  "  : \"other\";",
  "return { status: matched.pass ? \"pass\" : \"fail\" };",
].join("\n");

test("the broad password rules never reach past the end of a line", () => {
  const generic = SECRET_RULES.filter((rule) => rule.platform === "generic" && rule.id.startsWith("generic-"));
  expect(generic.length).toBeGreaterThan(0);
  for (const rule of generic) {
    for (const gap of ["\n", "\r", "\v", "\f", " ", " "]) {
      for (const text of [`secret${gap}"password" | "hash"`, `password${gap}hunter2`, `passwd${gap}  "fail"`]) {
        rule.re.lastIndex = 0;
        expect({ rule: rule.id, text, match: rule.re.exec(text)?.[0] }).toEqual({ rule: rule.id, text, match: undefined });
      }
    }
  }
});

test("a lone carriage return or line separator inside a line does not join two lines", () => {
  for (const gap of ["\r", " ", "\v"]) {
    const text = `secret${gap}"password" | "hash"`;
    expect(scrubText(text).text).toBe(text);
  }
});

test("code that names the keywords stays as it is", () => {
  expect(scrubText(CODE).text).toBe(CODE);
  expect(scrubPlainSecrets(CODE, { env: {} }).text).toBe(CODE);
});

test("a bare keyword list or punctuation is never taken for the secret", () => {
  for (const line of [
    "password | secret | passwd",
    "password secret hash",
    "fields: password, secret, hash",
    "| password | secret |",
    "    password = hosts[\"all\"][\"vars\"][\"ansible_password\"]",
    "secret || password",
  ]) expect({ line, out: scrubText(line).text }).toEqual({ line, out: line });
});

test("a ternary's string results are not secret values", () => {
  for (const line of [
    "status: matched.pass ? \"pass\" : \"fail\",",
    "const word = hidden === 1 ? \"secret\" : \"secrets\";",
    "x = ok ? 'password' : 'token-missing'",
  ]) expect({ line, out: scrubPlainSecrets(line, { env: {} }).text }).toEqual({ line, out: line });
});

test("real secrets on one line are still hidden", () => {
  expect(scrubText("username admin password Hunter2x").text).toBe(`username admin password ${SECRET_MARKER}`);
  expect(scrubText("password \"S3cret!\"").text).toBe(`password "${SECRET_MARKER}"`);
  expect(scrubText("  secret 5 $1$abcd$efghijklmnop").text).toContain(SECRET_MARKER);
  expect(scrubText("password\tTabbed9").text).toBe(`password\t${SECRET_MARKER}`);
  expect(scrubPlainSecrets("{\"password\": \"hunter22\"}", { env: {} }).text).toBe(`{"password": "${SECRET_MARKER}"}`);
  expect(scrubPlainSecrets("const config = { password: \"hunter22\" };", { env: {} }).text).toContain(SECRET_MARKER);
});

test("a password that is itself a key word, or all punctuation, is still hidden", () => {
  for (const [line, hidden] of [
    ["password secret", `password ${SECRET_MARKER}`],
    ["local-user admin password secret", `local-user admin password ${SECRET_MARKER}`],
    ["snmp password secret", `snmp password ${SECRET_MARKER}`],
    ["password hash", `password ${SECRET_MARKER}`],
    ["password password", `password ${SECRET_MARKER}`],
    ["password secret Hunter2", `password ${SECRET_MARKER} Hunter2`],
    ["password !@#$%^&*", `password ${SECRET_MARKER}`],
    ["secret ----", `secret ${SECRET_MARKER}`],
  ]) expect({ line, out: scrubText(line).text }).toEqual({ line, out: hidden });
});

test("a key word inside a longer word does not stop the next password being hidden", () => {
  expect(scrubText("rehash password Hunter2x").text).toBe(`rehash password ${SECRET_MARKER}`);
  expect(scrubText("password secret;").text).toBe(`password ${SECRET_MARKER};`);
});

test("a value hidden inside a quoted argument keeps its closing quote; a search for 'password=' keeps its path", () => {
  expect(hideCommandSecrets("git log --grep 'token=deadbeef1234'").text).toBe("git log --grep 'token=<secret hidden>'");
  expect(hideCommandSecrets("grep -rn 'password: hunter2' tests/").text).toBe("grep -rn 'password: <secret hidden>' tests/");
  expect(hideCommandSecrets("grep -rn \"api_key: abc123def\" docs/").text).toBe("grep -rn \"api_key: <secret hidden>\" docs/");
  const search = hideCommandSecrets("grep -rn password= src/");
  expect(search.text).toBe("grep -rn password= src/");
  expect(search.hidden).toBe(0);
  // Still hidden: a value right after the name, and spaces on both sides of =.
  expect(hideCommandSecrets("export DB_PASSWORD=hunter2x").hidden).toBe(1);
  expect(scrubAssignments("password = hunter2x\n", false).hidden).toBe(1);
  expect(hideCommandSecrets("grep -rn password= ./config").hidden).toBe(0);
  expect(hideCommandSecrets("grep password= -r .").hidden).toBe(0);
});

test("a real value after 'name= ' (one space after =) is still hidden", () => {
  for (const line of ["db = connect(user='app', password= 'Hunter2xyz')", "psycopg2.connect(password= \"Hunter2xyz\")", "DB_PASSWORD= Hunter2xyz"]) {
    const out = scrubPlainSecrets(line, { env: {} }).text;
    expect({ line, leaked: out.includes("Hunter2xyz") }).toEqual({ line, leaked: false });
  }
});

test("the screen's redaction keeps ordinary words after token, secret and password", () => {
  for (const text of ["SyntaxError: Unexpected token u in JSON at position 0", "the secret rotation check passed", "git grep -n password src/",
    "casper_check secrets scrub", "Authorization header is badly formatted", "rename tokenizer to lexer"]) expect(redactPreview(text)).toBe(text);
  expect(redactPreview("mysql --password hunter2 -e x")).toBe("mysql --password <redacted> -e x");
  expect(redactPreview("cli -token abc123 run")).toBe("cli -token <redacted> run");
  expect(redactPreview("password=hunter2 token: abc123")).toBe("password=<redacted> token: <redacted>");
});
