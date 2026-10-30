import { afterEach, expect, test } from "bun:test";
import { addsSecret, credentialShaped, realSecrets } from "../src/secrets/files";
import { forgetTypedSecrets, rememberTypedSecret } from "../src/secrets/typed";
import { hideCommandSecrets } from "../src/secrets/files";
import { observationInput } from "../src/runtime/observation";
import { formatReceipt } from "../src/task/result";
import { TaskObservations } from "../src/task/observations";

/**
 * A token-intake form and its tests (the shapes of a real session): code full of token, csrf and password, made-up test
 * values and a README with placeholders. The receipt said "A secret was written into" all five files and "change it",
 * with no real secret in any of them. Hiding stays as it was; only a real secret is reported.
 */

afterEach(() => forgetTypedSecrets());

const FORM = `from flask import Flask, request, render_template_string
import secrets, pathlib

SECRETS = pathlib.Path("secrets")
TOKEN_FILE = SECRETS / "cloudflare_api_token"

@app.post("/")
def save():
    token = request.form.get("token", "").strip()
    csrf_token = request.form.get("csrf_token")
    if not token:
        return render_template_string(PAGE, error="token is required")
    TOKEN_FILE.write_text(token)
    return "saved"

PAGE = """<input type="password" name="token" placeholder="Cloudflare API token">"""
`;
const TESTS = `FAKE_TOKEN = "fake-token-123"

class TokenFormTests(unittest.TestCase):
    def test_null_origin_is_allowed_only_with_csrf(self):
        self.assertEqual(post(token="abc", origin="null").status, 403)

    def test_0_rejects_a_token_with_spaces_or_newlines_in_it(self):
        self.client.post_token_form(token="a b")

def test_rejects_an_empty_token_and_keeps_the_form_on_the_page(client):
    resp = client.post("/", data={"token": "", "csrf_token": csrf})

def test_saves_a_token_of_forty_characters_into_the_secrets_folder(client, tmp_path):
    data = {"password": "hunter22", "token": "x" * 40, "tunnel_token": "abcdefghijklmnopqrstuvwxyz0123456789ABCD"}
`;
const README = `# Cloudflare tunnel setup

1. Run \`python token_form.py --token YOUR_TOKEN\`, or open the form.
2. CLOUDFLARE_API_TOKEN=your-api-token-here
- **Token:** the tunnel token from the dashboard

| Field | Token |
|---|---|
| name | value1 |
`;

test("a token form, its tests and a README with placeholders: hidden as before, but no secret is reported", () => {
  for (const [file, text] of [["cloudflared/token_form.py", FORM], ["cloudflared/api_token_form.py", FORM], ["cloudflared/test_setup.py", TESTS],
    ["cloudflared/test_api_setup.py", TESTS], ["cloudflared/README.md", README]] as const) {
    expect([file, addsSecret(file, "", text, {})]).toEqual([file, undefined]);
  }
  // What Casper shows still hides every value behind a secret name.
  expect(hideCommandSecrets("python token_form.py --token YOUR_TOKEN", {}).hidden).toBe(1);
});

test("a real secret is reported with its line and kind, never its value; in a test file only one Casper knows", () => {
  const token = "Zq8vN2kLm4Rt7Yw1Xc5Bp9Hd3Fg6Js0Ae2Ku8Lo";
  expect(addsSecret("cloudflared/config.py", "", `import os\n\nCF_API_TOKEN = "${token}"\n`, {})).toEqual({ line: 3, kind: "a token or key" });
  expect(addsSecret("cloudflared/config.py", "", `ssh_password = "Tr0ub4dor&3-horse"\n`, {})).toEqual({ line: 1, kind: "a password" });
  expect(addsSecret("deploy/key.txt", "", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n", {}))
    .toEqual({ line: 1, kind: "a private key" });
  // A test file's made-up key is not reported, but a secret from your own environment is, wherever it lands.
  expect(addsSecret("cloudflared/test_setup.py", "", `TOKEN = "${token}"\n`, {})).toBeUndefined();
  expect(addsSecret("cloudflared/test_setup.py", "", `TOKEN = "${token}"\n`, { CLOUDFLARE_API_TOKEN: token })).toEqual({ line: 1, kind: "a secret from your environment" });
});

test("what makes a value credential shaped, and what doesn't", () => {
  for (const value of ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlX3ZhbHVl",
    "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", "9f8e7d6c5b4a39281706f5e4d3c2b1a0", "Zq8vN2kLm4Rt7Yw1Xc5Bp9Hd3Fg6Js0Ae2Ku8Lo"]) expect([value, credentialShaped(value)]).toEqual([value, true]);
  for (const value of ["fake-token-123", "your-api-token-here", "YOUR_TOKEN", "the", "hunter22", "x".repeat(40), "<token>", "changeme",
    "test_rejects_an_empty_token_and_keeps_the_form_on_the_page", "test_0_saves_a_token_into_the_secrets_folder", "abcdefghijklmnopqrstuvwxyz",
    // The long runs in the real test files: test names (42–55 characters), CamelCase names, attribute paths.
    "test_null_origin_is_allowed_only_with_csrf", "test_1_api_token_form_keeps_the_csrf_cookie_between_posts", "TestNullOriginIsAllowed2023",
    "self.client.post_token_form", "settings.CLOUDFLARE_API_TOKEN_FILE", "__test_token_form_v2__"]) {
    expect([value, credentialShaped(value)]).toEqual([value, false]);
  }
});

test("a command: hidden either way, but 'change it' only for a real secret, with its kind", () => {
  const placeholder = observationInput({ command: "python token_form.py --token YOUR_TOKEN" });
  expect(placeholder.command).toBe("python token_form.py --token <secret hidden>");
  expect(placeholder.secretHidden).toBeUndefined();
  const real = observationInput({ command: "curl -H 'Authorization: Bearer Zq8vN2kLm4Rt7Yw1Xc5Bp9Hd3Fg6Js0Ae2Ku8Lo' https://api.cloudflare.com" });
  expect(real.secretHidden).toBe(true);
  // A short password typed into Casper's own box is one Casper knows: always real.
  rememberTypedSecret("pw7");
  expect(realSecrets("sshpass -p pw7 ssh nas uptime")).toEqual([{ line: 1, kind: "a secret you typed" }]);
  const observations = new TaskObservations();
  observations.observeToolEnd({ type: "tool_end", toolName: "bash", toolCallId: "a", input: placeholder, isError: false }, {});
  expect(formatReceipt({ execution: "completed", ...observations.snapshot([]) })).not.toContain("A secret");
  observations.observeToolEnd({ type: "tool_end", toolName: "bash", toolCallId: "b", input: real, isError: false }, {});
  expect(formatReceipt({ execution: "completed", ...observations.snapshot([]) })).toContain("⚠ A secret (a token or key) appeared in a command; change it after this task.");
});

test("the receipt names each file with the line and kind of its secret", () => {
  const observations = new TaskObservations();
  observations.observeToolEnd({ type: "tool_end", toolName: "write", toolCallId: "w", isError: false,
    input: { path: "cloudflared/config.py", secretWritten: "cloudflared/config.py", secretWhere: "line 3, a token or key" } }, {});
  expect(formatReceipt({ execution: "completed", ...observations.snapshot(["cloudflared/config.py"]) }))
    .toContain("– A secret was written into cloudflared/config.py (line 3, a token or key) (not shown). Keep secrets in an env file or a secrets store.");
});
