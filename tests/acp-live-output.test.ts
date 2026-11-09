import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { liveLines } from "../src/acp/tool-content";
import { hider, UpdateMapper } from "../src/acp/updates";
import { loadConfiguration, readAcpLiveOutputSetting } from "../src/config/load";
import type { RuntimeEvent } from "../src/runtime/types";
import { scrubPlainSecrets } from "../src/secrets/files";
import { scrubText } from "../src/secrets/scrub";
import { fileTextHoldsSecret, liveOutputHoldsSecret } from "../src/secrets/tool-output";
import { forgetTypedSecrets, rememberTypedSecret } from "../src/secrets/typed";
import { ARMOR_LINES, HIDE_LEAKS, LIVE_LEAKS, LIVE_LEAKS_2, TYPED_TWO_LINES } from "./fixtures/live-leaks";
import { removeTempDir } from "./support/temp-dir";

// A running command's latest lines in an ACP app (decision 98).
const CWD = path.resolve("/work/project");
/** Casper's rules, without any login file or environment of the machine running the tests. */
const NO_LOGINS = { loginFile: path.join(CWD, "no-such-auth.json"), env: {} };
const SECRET = "lab-pass-4417-quartz";

/** The mapper as `casper acp` makes it (src/acp/session.ts): `values` are the ones the session hides, `configs` is
 * /secrets files. */
function mapper(options: { values?: string[]; live?: () => boolean; netconan?: () => boolean; env?: Record<string, string>; configs?: false } = {}) {
  return new UpdateMapper(hider(() => options.values ?? []), { cwd: () => CWD, holdsSecret: (file, text) => fileTextHoldsSecret(file, text, NO_LOGINS),
    values: () => options.values ?? [],
    liveHoldsSecret: (text, cut, before) => liveOutputHoldsSecret(text, { ...NO_LOGINS, ...(options.env ? { env: options.env } : {}),
      ...(options.configs === false ? { configs: false } : {}), cut, before }), liveOutput: options.live ?? (() => true), netconan: options.netconan ?? (() => false) });
}
const start = (id: string, command: string, toolName = "bash"): RuntimeEvent => ({ type: "tool_start", toolName, toolCallId: id, input: { command }, args: { command } });
const progress = (id: string, text: string, toolName = "bash", cut = false): RuntimeEvent => ({ type: "tool_progress", toolName, toolCallId: id, text, ...(cut ? { cut: true as const } : {}) });
const end = (id: string, text: string): RuntimeEvent => ({ type: "tool_end", toolName: "bash", toolCallId: id, isError: false, display: { text, truncated: false, exitCode: 0 } });

test("a running bash step's progress is one in_progress tool_call_update: fenced whole lines, a known secret hidden, _meta.casper.live", () => {
  const m = mapper({ values: [SECRET] });
  const [started] = m.runtime(start("call-1", "./build.sh"));
  const updates = m.runtime(progress("call-1", `ld half line\nstep 1 ok\nsigned in with ${SECRET}\nstep 2 runn`, "bash", true));
  expect(updates).toEqual([{ sessionUpdate: "tool_call_update", toolCallId: started!.toolCallId, status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: "```text\nstep 1 ok\nsigned in with <secret hidden>\n```" } }], _meta: { casper: { live: true } } }]);
  // The same lines again send nothing; new ones replace them; the end comes as before.
  expect(m.runtime(progress("call-1", `step 1 ok\nsigned in with ${SECRET}\nstep 2 runn`))).toEqual([]);
  const next = m.runtime(progress("call-1", "step 2 running\n"));
  expect(next).toHaveLength(1);
  expect(next).toMatchObject([{ content: [{ content: { text: "```text\nstep 2 running\n```" } }] }]);
  expect(m.runtime(end("call-1", "done\n"))).toMatchObject([{ sessionUpdate: "tool_call_update", status: "completed" }]);
});

test("whole lines only: a first line the runtime cut and a last line still being written are left out", () => {
  expect(liveLines("one\ntwo\nthr", false)).toEqual({ before: "", lines: "one\ntwo\n", pending: "" });
  expect(liveLines("ne\ntwo\nthree\nok\n", true)).toEqual({ before: "ne\n", lines: "two\nthree\nok\n", pending: "" });
  expect(liveLines("no line ends yet", false).lines).toBe("");
  expect(liveLines("cut and unfinished", true).lines).toBe("");
  // A truncated mark in view, Casper's own or one the command printed: the card starts below it and the line after it,
  // which may be cut; the check reads the output above as it is.
  expect(liveLines("head\nhalf\n[...output truncated...]\nalf\ntail end\n", false)).toEqual({ before: "head\nhalf\n[...output truncated...]\nalf\n", lines: "tail end\n", pending: "" });
  // A last run of lines shaped like a key's body waits for the line after it: a key's END with no BEGIN, still to come,
  // would hide them all. A blank line or any other line after them lets them out.
  expect(liveLines("key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nAbCd2026\n", false)).toEqual({ before: "", lines: "key follows\n", pending: "cZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nAbCd2026\n" });
  // A plain word is no key line or secret: it shows at once, and so do the lines above it, unless a line like a key's
  // is right above it (a key wrapped short may end with one).
  expect(liveLines("first\n", false).lines).toBe("first\n");
  expect(liveLines("awx\nQkab\n", true)).toEqual({ before: "awx\n", lines: "", pending: "Qkab\n" });
  expect(liveLines("Done\nnext step\n", false).lines).toBe("Done\nnext step\n");
  expect(liveLines("first\nDone\nPASS\n", false)).toEqual({ before: "", lines: "first\n", pending: "Done\nPASS\n" });
  expect(liveLines("cZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nDone\n", false).lines).toBe("");
  expect(liveLines("key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nDone\nnext step\n", false).lines).toBe("key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nDone\nnext step\n");
  expect(liveLines("Hunter2Pass\n\n", false).lines).toBe("Hunter2Pass\n\n");
  expect(liveLines("Hunter2Pass\n", false)).toEqual({ before: "", lines: "", pending: "Hunter2Pass\n" });
  // The card shows the last 2,000 characters' whole lines; the output above them is kept for the check.
  const long = Array.from({ length: 300 }, (_, at) => `line ${at}`).join("\n") + "\n";
  const { before, lines } = liveLines(long, false);
  expect(before + lines).toBe(long);
  expect(lines.length).toBeLessThanOrEqual(2000);
  expect(lines.startsWith("line ")).toBe(true);
  expect(before.endsWith("\n")).toBe(true);
});

test("an unknown or finished step, and a step that is not a shell, send nothing", () => {
  const m = mapper();
  expect(m.runtime(progress("nobody", "hello\n"))).toEqual([]);
  m.runtime(start("call-2", "echo hello"));
  m.runtime(end("call-2", "hello\n"));
  expect(m.runtime(progress("call-2", "hello\n"))).toEqual([]);
  m.runtime({ type: "tool_start", toolName: "read", toolCallId: "call-3", input: { path: "notes.txt" }, args: { path: "notes.txt" } });
  expect(m.runtime(progress("call-3", "hello\n", "read"))).toEqual([]);
});

test("while netconan is in use, or with acp_live_output off, nothing goes out; a PowerShell step streams too", () => {
  let netconan = true;
  let live = true;
  const m = mapper({ netconan: () => netconan, live: () => live });
  m.runtime(start("call-4", "Get-ChildItem", "powershell"));
  expect(m.runtime(progress("call-4", "a.txt\n", "powershell"))).toEqual([]);
  netconan = false;
  live = false;
  expect(m.runtime(progress("call-4", "a.txt\n", "powershell"))).toEqual([]);
  live = true;
  expect(m.runtime(progress("call-4", "a.txt\n", "powershell"))).toMatchObject([{ status: "in_progress", _meta: { casper: { live: true } } }]);
});

test("lines that hold what the final scrub would hide are not sent, and that step sends no more until it ends", () => {
  const m = mapper();
  m.runtime(start("call-5", "cat deploy/key"));
  // A key's body with no BEGIN or END around it: the BEGIN line scrolled out of the last 2,000 characters.
  const body = Array.from({ length: 3 }, () => "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun").join("\n");
  expect(m.runtime(progress("call-5", `${body}\n`))).toEqual([]);
  expect(m.runtime(progress("call-5", "plain words after it\n"))).toEqual([]);
  expect(m.runtime(end("call-5", "done\n"))).toMatchObject([{ status: "completed" }]);
  // A secret-looking assignment and a device config line are held back too.
  const n = mapper();
  n.runtime(start("call-6", "env"));
  expect(n.runtime(progress("call-6", "PATH=/usr/bin\nAPI_TOKEN=abcdef0123456789abcdef\n"))).toEqual([]);
  n.runtime(start("call-7", "./show-config"));
  expect(n.runtime(progress("call-7", "hostname sw1\nsnmp-server community FixtureComm RO\n"))).toEqual([]);
});

test("the check reads the output above the lines shown: a key's short last line is held when its long lines are above them", () => {
  const key = Array.from({ length: 3 }, () => "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun").join("\n");
  const filler = `${"step ok ".repeat(250).slice(0, 1990)}\n`;
  // The last 2,000 characters start with the key's last line, "AbCdQ0==": shown alone after a cut, it is too short to hold.
  const text = `${key}\nAbCdQ0==\n${filler}`;
  expect(liveLines(text, false).lines).toBe(`AbCdQ0==\n${filler}`);
  expect(liveOutputHoldsSecret(`AbCdQ0==\n${filler}`, { ...NO_LOGINS, cut: true })).toBe(false);
  const m = mapper();
  m.runtime(start("call-16", "./show-key-then-build"));
  expect(m.runtime(progress("call-16", text))).toEqual([]);
});

test("lines that start below the line a rule needs (a server block, a Junos snmp block, a table header) are not sent", () => {
  const m = mapper();
  m.runtime(start("call-10", "ssh switch show running-config"));
  // The `radius server` line scrolled out of the last 2,000 characters: the key line alone is still a key.
  expect(m.runtime(progress("call-10", "ess ipv4 192.0.2.10 auth-port 1812\n key FixtureRadKey99\n!\n", "bash", true))).toEqual([]);
  m.runtime(start("call-11", "ssh router show configuration"));
  expect(m.runtime(progress("call-11", "ion snmp\n    community FixtureComm {\n        authorization read-only;\n", "bash", true))).toEqual([]);
  m.runtime(start("call-12", "./list-accounts"));
  expect(m.runtime(progress("call-12", "pha | x |\n| alice | Fixture-Pw-1 |\n| bob | Fixture-Pw-2 |\n", "bash", true))).toEqual([]);
  m.runtime(start("call-13", "pveum user token add root@pam ci"));
  expect(m.runtime(progress("call-13", "x\n├──────┼──────┤\n│ value │ 0b5c7d1e-2f3a-4b6c-8d9e-0f1a2b3c4d5e │\n", "bash", true))).toEqual([]);
  // The whole output's scrub hides each of them, with the line that set the rule up.
  expect(scrubText("radius server ISE\n address ipv4 192.0.2.10 auth-port 1812\n key FixtureRadKey99\n").hidden).toBe(1);
  expect(scrubText("snmp {\n    community FixtureComm {\n        authorization read-only;\n    }\n}\n").hidden).toBe(1);
  expect(scrubPlainSecrets("| user | password |\n|---|---|\n| alice | Fixture-Pw-1 |\n").hidden).toBe(1);
  // A cut window of plain lines, a tree and a table whose header is in view still go out.
  m.runtime(start("call-14", "tree src"));
  expect(m.runtime(progress("call-14", "rc\n├── app.ts\n└── util.ts\n", "bash", true))).toHaveLength(1);
  m.runtime(start("call-15", "./report"));
  expect(m.runtime(progress("call-15", "ne\nresults:\n| test | time |\n| sum | 4 ms |\n", "bash", true))).toHaveLength(1);
});

test("a step whose start hid its command sends nothing while it runs", () => {
  const m = mapper({ values: [SECRET] });
  // The session's hiding changes this command: the value the person owns is in it.
  m.runtime(start("call-8", `./login.sh ${SECRET}`));
  expect(m.runtime(progress("call-8", "logged in\n"))).toEqual([]);
  // The command rules changed this one before Casper kept it.
  m.runtime({ type: "tool_start", toolName: "bash", toolCallId: "call-9", input: { command: "curl -u admin:<secret hidden> http://192.0.2.10" },
    args: { command: "curl -u admin:hunter2-long http://192.0.2.10" } });
  expect(m.runtime(progress("call-9", "ok\n"))).toEqual([]);
});

test("liveOutputHoldsSecret: plain output holds none; a key, a config line and a secret assignment do", () => {
  expect(liveOutputHoldsSecret("tests/a.test.ts:\n(pass) sum adds\n", NO_LOGINS)).toBe(false);
  expect(liveOutputHoldsSecret("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n", NO_LOGINS)).toBe(true);
  expect(liveOutputHoldsSecret("snmp-server community FixtureComm RO\n", NO_LOGINS)).toBe(true);
  // The device rules run with /secrets files off too: a key's BEGIN out of view turns them on in the final output.
  expect(liveOutputHoldsSecret("snmp-server community FixtureComm RO\n", { ...NO_LOGINS, configs: false })).toBe(true);
  expect(liveOutputHoldsSecret("API_TOKEN=abcdef0123456789abcdef\n", { ...NO_LOGINS, configs: false })).toBe(true);
  // A table cut from its header holds one only after a break: the window's start when cut, or a truncated mark.
  expect(liveOutputHoldsSecret("| alice | Fixture-Pw-1 |\n", { ...NO_LOGINS, cut: true })).toBe(true);
  expect(liveOutputHoldsSecret("head\n[...output truncated...]\n| alice | Fixture-Pw-1 |\n", NO_LOGINS)).toBe(true);
  expect(liveOutputHoldsSecret("| name | age |\n| alice | 30 |\n", NO_LOGINS)).toBe(false);
});

test("liveOutputHoldsSecret: a cut window may start inside a key whose BEGIN is gone and whose END is not out yet", () => {
  // After a break the strict scrub starts as though inside a key's body: a key-body line of 20 or more characters (an id
  // of capitals and digits from 27), a PGP checksum line, or a PEM or PGP header line. The final output hides every line
  // between BEGIN and END.
  for (const text of ["b3BlbnNzaC1rZXktdjEAAAA\n", "=AbCd\n", "MIIEpAIBAAKCAQEAsecret1\nMIIEpAIBAAKCAQEAsecret2\n", "src/v2\n=AbCd\n",
    "   12\tMIIEpAIBAAKCAQEAsecret1\n", "certs/key.pem-3-MIIEpAIBAAKCAQEAsecret1\n", "Xy+w/AbCdEfGhIjKlMnOp\n", "0123456789abcdef0123456789abcdef\n",
    "abcdefghijklmnopqrstuvwxyz0123\n", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123\n", "Proc-Type: 4,ENCRYPTED\n", "DEK-Info: AES-128-CBC,0123456789ABCDEF\n"]) {
    expect([text, liveOutputHoldsSecret(text, { ...NO_LOGINS, cut: true })]).toEqual([text, true]);
    expect([text, liveOutputHoldsSecret(`head\n[...output truncated...]\n${text}`, NO_LOGINS)]).toEqual([text, true]);
  }
  // Anywhere, not cut too, such a line of 40 or more characters (a key file's line, as the final scrub reads one).
  const line = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun";
  expect(liveOutputHoldsSecret(`Building\n${line}\n`, NO_LOGINS)).toBe(true);
  // Not cut, a shorter one is no key: the window starts where the output does, so a key's BEGIN would be in it.
  expect(liveOutputHoldsSecret("MIIEpAIBAAKCAQEAsecret1\n", NO_LOGINS)).toBe(false);
  // A plain word, a path, a short line, a short hash and an id of capitals and digits (a ULID's 26) start no key, even
  // right after a cut.
  for (const text of ["Done\n", "PASS\n", "src/app\nsrc/acp\n", "AbCdEfGh\nXyZ+w9==\n",
    "6895a928\n", "4f2a9c1d8e7b\n", "01ARZ3NDEKTSV4RRFFQ69G5FAV\n"]) {
    expect([text, liveOutputHoldsSecret(text, { ...NO_LOGINS, cut: true })]).toEqual([text, false]);
  }
  // Held, cut or not: a line of 40 or more base64 characters (a 40-character commit hash too). The final scrub hides
  // such a line when any line of the whole output names a key file (certs/key.pem:1:), and that line may be gone or
  // not out yet. Held after a cut: a long path, which may be a key's body line.
  for (const text of ["6895a92823bdea3bae42d941bad35eebdb5e8ceb\n", "6895A92823BDEA3BAE42D941bad35eebdb5e8ceb\n"]) {
    for (const cut of [false, true]) expect([text, cut, liveOutputHoldsSecret(text, { ...NO_LOGINS, cut })]).toEqual([text, cut, true]);
  }
  for (const text of ["src/Features/Auth2/Views\n", "src/Api/RoutesAndHandlers\n"]) {
    expect(liveOutputHoldsSecret(text, { ...NO_LOGINS, cut: true })).toBe(true);
    expect(liveOutputHoldsSecret(text, NO_LOGINS)).toBe(false);
  }
});

test("the last reviews' leaks: the live lines that hold a value the final scrub hides are not sent", () => {
  const sent: string[] = [];
  for (const leak of [...LIVE_LEAKS, ...LIVE_LEAKS_2]) {
    const m = mapper(leak.env ? { env: leak.env } : {});
    m.runtime(start("call-leak", "./run.sh"));
    const shown = JSON.stringify(m.runtime(progress("call-leak", leak.text ?? leak.full, "bash", leak.cut === true)));
    if (leak.secrets.some((secret) => shown.includes(JSON.stringify(secret).slice(1, -1)))) sent.push(leak.case);
  }
  expect([LIVE_LEAKS.length, LIVE_LEAKS_2.length]).toEqual([12, 15]);
  expect(sent).toEqual([]);
});

test("lines the session's hiding hides in the end's output, read whole, and not alone, are not sent", () => {
  const sent: string[] = [];
  for (const leak of HIDE_LEAKS) {
    const m = mapper({ ...(leak.values ? { values: leak.values } : {}), ...(leak.configs === false ? { configs: false as const } : {}), ...(leak.env ? { env: leak.env } : {}) });
    m.runtime(start("call-hide", "./run.sh"));
    const shown = JSON.stringify(m.runtime(progress("call-hide", leak.text ?? leak.full)));
    if (leak.secrets.some((secret) => shown.includes(JSON.stringify(secret).slice(1, -1)))) sent.push(leak.case);
    // The end shows the output whole, with each value hidden.
    const [done] = m.runtime(end("call-hide", leak.full));
    for (const secret of leak.secrets) expect([leak.case, secret, JSON.stringify(done).includes(secret)]).toEqual([leak.case, secret, false]);
  }
  expect(HIDE_LEAKS).toHaveLength(10);
  expect(sent).toEqual([]);
  // A value the hiding finds on its own line still goes out hidden, as before.
  const m = mapper({ values: [SECRET] });
  m.runtime(start("call-hide-2", "./run.sh"));
  expect(m.runtime(progress("call-hide-2", `step 1\nsigned in with ${SECRET}\nAuthorization: Bearer <redacted>\npassword: x\nnext\n`))).toMatchObject([{ status: "in_progress" }]);
});

test("the same lines as plain text: a certificate's armor on a line with a community, a server key or a hash", () => {
  for (const [full] of ARMOR_LINES) {
    for (const cut of [false, true]) expect([full, cut, liveOutputHoldsSecret(full, { ...NO_LOGINS, cut })]).toEqual([full, cut, true]);
  }
});

test("a typed secret of two lines holds its first line while its second is not out yet", () => {
  rememberTypedSecret(TYPED_TWO_LINES.value);
  try {
    const m = mapper({ values: [TYPED_TWO_LINES.value] });
    m.runtime(start("call-typed", "./run.sh"));
    expect(m.runtime(progress("call-typed", TYPED_TWO_LINES.text))).toEqual([]);
    // A line of the value elsewhere, not next to the rest of it, is not part of it.
    expect(liveOutputHoldsSecret("a\nline-two-xyz is a branch\n", NO_LOGINS)).toBe(false);
    expect(liveOutputHoldsSecret("hunter2-line-one\nnot the second line\n", NO_LOGINS)).toBe(false);
  } finally { forgetTypedSecrets(); }
});

/** Ordinary output a running command prints: each must still stream. */
const ORDINARY: Record<string, string> = {
  "a build log": "$ bun run build\n[1/4] Resolving packages...\n[2/4] Fetching packages...\n[3/4] Linking dependencies...\n"
    + "[4/4] Building fresh packages...\nBundled 412 modules in 183ms\n\n  index.js  1.42 MB  (entry point)\n\nDone in 2.31s.\n",
  "test runner output": "tests/math.test.ts:\n(pass) sum > adds two numbers [0.12ms]\n(pass) sum > adds negatives [0.03ms]\n"
    + "(fail) divide > by zero throws [1.20ms]\n\n 2 pass\n 1 fail\n 14 expect() calls\nRan 3 tests across 1 file. [41.00ms]\n"
    + "============================= test session starts ==============================\ncollected 12 items\n\n"
    + "tests/test_api.py ......F.....                                          [100%]\nFAILED tests/test_api.py::test_login - AssertionError\n",
  "a tree listing": ".\n├── README.md\n├── package.json\n├── src\n│   ├── app.ts\n│   └── util\n│       ├── strings.ts\n│       └── v2\n"
    + "└── tests\n    └── app.test.ts\n\n5 directories, 5 files\n.\n|-- src\n|   |-- app.ts\n|   `-- util\n`-- tests\n",
  "git log output": "commit 6895a92823bdea3bae42d941bad35eebdb5e8ceb\nAuthor: Example Dev <dev@example.com>\nDate:   Mon Nov 9 07:23:32 2026 -0600\n\n"
    + "    Fix the parser's empty-line case\n\ncommit 19e391bb0d5c4f0e8a7b6c5d4e3f2a1b0c9d8e7f\nAuthor: Example Dev <dev@example.com>\n"
    + "Date:   Sun Nov 8 18:02:11 2026 -0600\n\n    Add the v2 reader\n\n6895a928 Fix the parser's empty-line case\n19e391bb Add the v2 reader\n",
  "git diff output": "diff --git a/src/app.ts b/src/app.ts\nindex 55e5df11..e576a65c 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,4 +1,5 @@\n"
    + " import path from \"node:path\";\n+import os from \"node:os\";\n \n export function main() {\n-  return 1;\n+  return 2;\n }\n",
  "folder names with digits": "$ ls -1\nv2\nv10\ne2e\nes2020\nbuild2\nutf8\n$ find . -type d\n./src/v2\n./tests/e2e\n./packages/es2020\n./lib/utf8/v3\n",
  // A 40-character hash alone on its line (git rev-list) is held: see the cut-window test above.
  "commit and container ids": "$ git log --format=%h\n6895a928\n19e391bb\n96e21ed1\n3f76b49d\n$ docker ps -aq\n"
    + "4f2a9c1d8e7b\nb7e3a0c95d12\n0a1b2c3d4e5f\n$ docker images -q --no-trunc\nsha256:2b1f8e9c7d6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c\n",
  "ULIDs and uppercase ids": "01ARZ3NDEKTSV4RRFFQ69G5FAV\n01HZY8Q6W3K2M9N7P5R4T1V0XB\nREQ-2026-11-09-0042\nORDER4417XQ\nBUILD20261109A\n",
  "a plain table": "NAME                  READY   STATUS    RESTARTS   AGE\nweb-7d4b9c6f5-abcde   1/1     Running   0          3d\n"
    + "db-0                  1/1     Running   1          12d\nCONTAINER ID   IMAGE          COMMAND                  STATUS\n"
    + "4f2a9c1d8e7b   nginx:1.27     \"/docker-entrypoint.…\"   Up 2 hours\n",
};

/**
 * Whether a cut window shows an ASCII tree's line two levels deep (`|   |-- app.ts`) before a line with no bar (its
 * first line, maybe a line's end, aside): that line may be a Markdown row with no last bar whose header is gone, and
 * under `| a | password` the final scrub hides the text after its last bar.
 */
function deepTreeAfterCut(window: string[]): boolean {
  for (const [at, line] of window.entries()) {
    if (/^\|[^|]*\|\s*\S/.test(line)) return true;
    if (at > 0 && !line.includes("|")) return false;
  }
  return false;
}

test("ordinary output still streams: every window of a build log, test runs, a tree, git log and diff, folder names, ids and hashes, and a plain table", () => {
  let deep = 0;
  for (const [kind, text] of Object.entries(ORDINARY)) {
    const lines = text.split("\n");
    for (let start = 0; start < lines.length; start++) {
      for (let end = start + 1; end <= lines.length; end++) {
        const window = lines.slice(start, end).join("\n");
        if (!window.trim()) continue;
        // After a cut, an ASCII tree's lines two levels deep hold (decision 98): its header may be out of view.
        const held = start > 0 && deepTreeAfterCut(lines.slice(start, end));
        if (held) deep++;
        expect([kind, start > 0, window, liveOutputHoldsSecret(window, { ...NO_LOGINS, cut: start > 0 })]).toEqual([kind, start > 0, window, held]);
        // As the app's card reads it: after the lines above it.
        const before = start ? `${lines.slice(0, start).join("\n")}\n` : "";
        expect([kind, "after its lines", window, liveOutputHoldsSecret(window, { ...NO_LOGINS, before })]).toEqual([kind, "after its lines", window, false]);
      }
    }
  }
  expect(deep).toBe(12);
});

test("ordinary output streams through the mapper as it grows, with the session hiding values, and never stops", () => {
  for (const [kind, text] of Object.entries(ORDINARY)) {
    const m = mapper({ values: [SECRET, "two-line-value-one\ntwo-line-value-two"] });
    m.runtime(start("call-ordinary", "./run.sh"));
    const lines = text.split("\n");
    for (let at = 1; at <= lines.length; at++) m.runtime(progress("call-ordinary", lines.slice(0, at).join("\n")));
    // A last line after them all goes out with them: the step was never held. (A list of ids alone waits for it: each
    // is shaped like a key's body line, and not a plain word.)
    const [last] = m.runtime(progress("call-ordinary", `${text}end of output\n`));
    expect([kind, JSON.stringify(last ?? null).includes("end of output")]).toEqual([kind, true]);
  }
});

test("acp_live_output is read from the user file only, on by default, and refused in a project or profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-acp-live-"));
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await mkdir(path.join(home, ".casper/profiles/default"), { recursive: true });
    await mkdir(path.join(project, ".casper"), { recursive: true });
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpLiveOutput).toBeUndefined();
    expect(await readAcpLiveOutputSetting(home)).toBe("on");
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_live_output: false\n");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpLiveOutput).toBe("off");
    expect(await readAcpLiveOutputSetting(home)).toBe("off");
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_live_output: on\n");
    expect(await readAcpLiveOutputSetting(home)).toBe("on");
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_live_output: sometimes\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_live_output must be");
    // A file Casper can't read gives off: the output still comes when the command ends.
    expect(await readAcpLiveOutputSetting(home)).toBe("off");
    await writeFile(path.join(home, ".casper/config.yaml"), "");
    await writeFile(path.join(project, ".casper/project.yaml"), "acp_live_output: off\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_live_output is a user setting");
    await writeFile(path.join(project, ".casper/project.yaml"), "");
    await writeFile(path.join(home, ".casper/profiles/default/config.yaml"), "acp_live_output: off\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_live_output is set in ~/.casper/config.yaml only");
    expect(await readAcpLiveOutputSetting(home)).toBe("on");
  } finally { await removeTempDir(root); }
});
