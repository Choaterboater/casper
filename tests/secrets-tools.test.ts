import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Scrubber } from "../src/secrets/netconan";
import { hiddenSecretGate, NOT_RUN_REASON, NOT_WRITTEN_REASON } from "../src/secrets/gate";
import { scrubToolOutput } from "../src/secrets/tool-output";
import { SCRUBBED_TOOLS } from "../src/runtime/pi";
import { fileChangeTool } from "../src/runtime/observation";
import { removeTempDir } from "./support/temp-dir";

const scrubber = new Scrubber({ env: { CASPER_NETCONAN: "off" } });
let root: string; let logins: string;
const MIST = "mist-token-ABCDEF0123456789";
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "casper-secrets-tools-"));
  logins = path.join(root, "network-logins.json");
  await writeFile(logins, JSON.stringify({ mist: { MIST_API_TOKEN: MIST, MIST_HOST: "api.mist.com" } }));
});
afterAll(() => removeTempDir(root));

test("browser page text and lsp results are scrubbed like other tool output", async () => {
  expect([...SCRUBBED_TOOLS]).toEqual(expect.arrayContaining(["browser", "lsp"]));
  const options = { env: { MY_API_TOKEN: "env-secret-0123456789" }, loginFile: "/nonexistent/auth.json", networkLoginFile: logins };
  const page = JSON.stringify({ text: `Token: ${MIST}\nDATABASE_URL=postgres://app:Hunter2x@db/app\nkey env-secret-0123456789`, url: "http://192.0.2.1/" });
  const browser = await scrubToolOutput(scrubber, "browser", { action: "inspect" }, [page], undefined, options);
  for (const value of [MIST, "Hunter2x", "env-secret-0123456789"]) expect(browser!.texts[0]).not.toContain(value);
  expect(JSON.parse(browser!.texts[0]!).url).toBe("http://192.0.2.1/");
  const lsp = JSON.stringify({ diagnostics: [{ message: `Type '"env-secret-0123456789"' is not assignable to type '"placeholder"'.` }] });
  const scrubbed = await scrubToolOutput(scrubber, "lsp", { operation: "diagnostics" }, [lsp], undefined, options);
  expect(scrubbed!.texts[0]).not.toContain("env-secret-0123456789");
  expect(scrubbed!.note).toContain("1 secret hidden");
});

test("the service tool's start command and an lsp rename can't carry the hidden-secret marker", () => {
  expect(hiddenSecretGate("service", { action: "start", command: "echo '<secret hidden>' > a.cfg; node server.js" })).toBe(NOT_RUN_REASON);
  expect(hiddenSecretGate("service", { action: "logs", service: "web", filter: "<secret hidden>" })).toBeUndefined();
  expect(hiddenSecretGate("lsp", { operation: "rename", newName: "<secret hidden>" })).toBe(NOT_WRITTEN_REASON);
  expect(hiddenSecretGate("lsp", { operation: "references", query: "<secret hidden>" })).toBeUndefined();
});

test("an lsp rename counts as a file change for the ask-before-changes gate; other lsp calls don't", () => {
  expect(fileChangeTool("edit", {})).toBe("edit");
  expect(fileChangeTool("write", {})).toBe("write");
  expect(fileChangeTool("lsp", { operation: "rename", newName: "x" })).toBe("lsp rename");
  expect(fileChangeTool("lsp", { operation: "diagnostics" })).toBeUndefined();
  expect(fileChangeTool("bash", { command: "sed -i s/a/b/ x" })).toBeUndefined();
});
