import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isConfigFile, riskyBaseline, riskyLinesIn } from "../src/network/risky-receipt";
import { formatReceipt, formatTaskResult, type TaskResult } from "../src/task/result";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

test("dangerous lines in the config files a task changed are listed with their reasons; other files are not read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-risky-"));
  dirs.push(root);
  await mkdir(path.join(root, "configs"), { recursive: true });
  await writeFile(path.join(root, "configs/sw1.cfg"), "hostname sw1\ninterface 1/1/1\n  description reload me later\n  shutdown\nno shutdown\nreload\n");
  await writeFile(path.join(root, "r1.set"), "set system host-name r1\nset interfaces ge-0/0/0 disable\n");
  await writeFile(path.join(root, "notes.md"), "reload\n");
  await writeFile(path.join(root, "unchanged.cfg"), "reload\n");
  const found = await riskyLinesIn(root, ["configs/sw1.cfg", "r1.set", "notes.md", "gone.cfg"]);
  expect(found).toEqual([
    { file: "configs/sw1.cfg", line: 4, text: "shutdown", reason: "shuts it down" },
    { file: "configs/sw1.cfg", line: 6, text: "reload", reason: "reboots the switch" },
    { file: "r1.set", line: 2, text: "set interfaces ge-0/0/0 disable", reason: "disables the interface" },
  ]);
});

test("the receipt shows them as a report line, never a pass or a fail", () => {
  const task = { riskyLines: [{ file: "configs/sw1.cfg", line: 6, text: "reload", reason: "reboots the switch" }] } as unknown as TaskResult;
  expect(formatTaskResult(task)).toContain("configs/sw1.cfg:6 reload (reboots the switch)");
  expect(formatReceipt(task)).toContain("• Risky config lines (not a check): configs/sw1.cfg:6 reload — reboots the switch");
});

test("review: only risky lines the task added are listed; comments never count; more than 20 says how many more", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-risky-"));
  dirs.push(root);
  await mkdir(path.join(root, "configs"), { recursive: true });
  // Before the task: unused ports already shut (normal hardening).
  await writeFile(path.join(root, "configs/sw1.cfg"), "interface 1/1/20\n  shutdown\ninterface 1/1/21\n  shutdown\n");
  const baseline = await riskyBaseline(root, ["configs/sw1.cfg"]);
  // The task adds one more shutdown, a reload, and two comments.
  await writeFile(path.join(root, "configs/sw1.cfg"), "! shutdown unused ports\ninterface 1/1/20\n  shutdown\ninterface 1/1/21\n  shutdown\ninterface 1/1/22\n  shutdown\n# graceful shutdown timeout\nreload\n");
  const found = await riskyLinesIn(root, ["configs/sw1.cfg"], baseline);
  expect(found.map((risky) => `${risky.line} ${risky.text}`)).toEqual(["7 shutdown", "9 reload"]);

  await writeFile(path.join(root, "configs/many.cfg"), "reload\n".repeat(25));
  const many = await riskyLinesIn(root, ["configs/many.cfg"], new Map());
  expect(many).toHaveLength(20);
  expect(many.more).toBe(5);
});

test("the usual network config files are read: backups as .txt, Jinja templates, and config, backups, oxidized and templates folders", () => {
  for (const file of [
    "configs/sw1.cfg", "r1.set", "lab/core.conf", "configs/notes", "config/sw1.txt", "backups/2026-10-01/core-sw1.txt", "backup/sw1.txt",
    "oxidized/core-sw1", "oxidized/output/sw1.txt", "templates/access-switch.j2", "roles/aoscx/templates/base.jinja", "templates/edge.jinja2",
  ]) expect(isConfigFile(file)).toBe(true);
  for (const file of ["notes.txt", "docs/README.txt", "src/templates/page.html", "templates/README.md", "requirements.txt", "web/page.j2.html"]) {
    expect(isConfigFile(file)).toBe(false);
  }
});
