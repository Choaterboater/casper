import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/** /skills trust <id> shows the skill and asks 1 No · 2 Trust it: no copied sha256. */

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

async function session(commands: string[], answers: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-trust-ask-"));
  dirs.push(root);
  const project = path.join(root, "project"), homeDir = path.join(root, "home");
  await mkdir(path.join(project, ".casper/skills/deploy"), { recursive: true });
  await mkdir(homeDir);
  await writeFile(path.join(project, ".casper/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Deploy steps.\n---\nDEPLOY_BODY");
  const input = new PassThrough();
  let output = "";
  const pending = [...commands];
  const app = new CasperApp({
    runtimeFactory: () => { throw new Error("no model in this test"); }, input, sessionHomeDir: homeDir,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(`${(pending.shift() ?? "/exit").replace("<id>", output.match(/deploy@[a-f0-9]+/)?.[0] ?? "")}\n`));
      if (/Type [\d, ]*\d or \d: $/.test(text)) queueMicrotask(() => input.write(`${answers.shift() ?? "1"}\n`));
    } },
  });
  try { await app.runInteractive(project); } finally { await app.close(); }
  return output;
}

test("/skills trust <id> shows the skill and its fingerprint, then 1 No · 2 Trust it; 1 trusts nothing", async () => {
  const declined = await session(["/skills", "/skills trust <id>", "/skills"], ["1"]);
  expect(declined).toContain("DEPLOY_BODY");
  expect(declined).toContain("Trust deploy as shown?\n  1 No\n  2 Trust it\n");
  expect(declined).toContain("[skills] Not trusted.");
  expect(declined.slice(declined.lastIndexOf("deploy@"))).toContain("untrusted");
});

test("2 trusts exactly what was shown", async () => {
  const output = await session(["/skills", "/skills trust <id>", "/skills"], ["2"]);
  expect(output).toContain("Trusted reviewed content for deploy@");
  expect(output.slice(output.lastIndexOf("deploy@"))).not.toContain("untrusted");
});
