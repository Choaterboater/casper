import { expect, test } from "bun:test";
import { SECRET_RULES } from "../src/secrets/patterns";
import { SECRET_MARKER, scrubText } from "../src/secrets/scrub";
import { scrubPlainSecrets } from "../src/secrets/files";

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
