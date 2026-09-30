import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { droppedLine, formatModelFinding, MODEL_FINDING_LABEL, reviewMayRead, validateModelFindings } from "../src/security/review";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

test("a model finding is kept only with a real in-repo file:line and a concrete example input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-security-review-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "casper-security-review-out-"));
  temps.push(root, outside);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "server.py"), "import subprocess\n\ndef ping(host):\n    subprocess.run(f'ping {host}', shell=True)\n");
  await writeFile(path.join(outside, "secret.py"), "x = 1\n");
  await symlink(path.join(outside, "secret.py"), path.join(root, "src", "link.py"));
  await symlink(outside, path.join(root, "linked"));
  const good = { file: "src/server.py", line: 4, input: "host = \"8.8.8.8; cat ~/.ssh/id_rsa\"", why: "host goes into a shell command." };
  const { kept, dropped } = await validateModelFindings(root, [
    good,
    { ...good, line: undefined },
    { ...good, line: 99 },
    { ...good, file: "../" + path.basename(outside) + "/secret.py" },
    { ...good, file: path.join(outside, "secret.py") },
    { ...good, file: "src/link.py", line: 1 },
    { ...good, file: "linked/secret.py", line: 1 },
    { ...good, input: "" },
    { ...good, input: "<malicious input>" },
    { ...good, input: "..." },
    { ...good, why: "" },
    "not an object",
  ]);
  // A finding on a line of a file the review was kept from is never shown.
  await writeFile(path.join(root, ".env"), "TOKEN=x\n");
  expect((await validateModelFindings(root, [{ ...good, file: ".env", line: 1 }])).kept).toEqual([]);
  expect(kept).toEqual([good]);
  expect(dropped).toBe(11);
  expect(droppedLine(dropped)).toBe("11 AI findings not shown: no real file:line here or no example input.");
  expect(formatModelFinding(kept[0]!)).toBe(`src/server.py:4  host goes into a shell command. Example input: host = "8.8.8.8; cat ~/.ssh/id_rsa"  ${MODEL_FINDING_LABEL}`);
  expect(MODEL_FINDING_LABEL).toBe("(the AI's opinion, not checked by a tool)");
});

test("the model review may not read .env, keys or files gitleaks flagged", () => {
  for (const file of [".env", ".env.local", "config/.env.example", "certs/server.pem", "id_rsa", "home/id_ed25519", "deploy.key", "secrets.yaml", "prod.tfvars"]) {
    expect(reviewMayRead(file)).toBe(false);
  }
  expect(reviewMayRead("src/server.py")).toBe(true);
  expect(reviewMayRead("src/settings.py", [{ tool: "gitleaks", file: "src/settings.py", line: 3, rule: "generic-api-key", severity: "high", text: "x" }])).toBe(false);
});
