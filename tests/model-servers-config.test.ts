import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { addModelServer, removeModelServer } from "../src/config/model-servers";
import { needsSymlinks } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/** modelServers in ~/.casper/config.yaml: the servers you added in /model. Yours only, never a project's or a profile's;
 * a bad entry is skipped with a warning, never a reason Casper won't start; Casper writes it keeping the rest. */

let root = "";
const previous = process.env.CASPER_PROFILE;
beforeEach(async () => { delete process.env.CASPER_PROFILE; root = await mkdtemp(path.join(os.tmpdir(), "casper-model-servers-config-")); });
afterEach(async () => {
  if (previous === undefined) delete process.env.CASPER_PROFILE; else process.env.CASPER_PROFILE = previous;
  await removeTempDir(root);
});
const home = () => path.join(root, "home");
const repo = () => path.join(root, "repo");
const config = () => path.join(home(), ".casper/config.yaml");
const write = (file: string, text: string) => Bun.write(file, text);
const load = () => loadConfiguration({ homeDir: home(), projectRoot: repo() });

test("your servers load from ~/.casper/config.yaml, with no unknown-key warning", async () => {
  await write(config(), "modelServers:\n  - name: ollama-myserver\n    address: http://192.0.2.10:11434\n    kind: ollama\n  - name: vllm-gpu\n    address: https://models.example.com/v1\n    kind: vllm\n");
  await write(path.join(repo(), ".casper/project.yaml"), "project:\n  name: demo\n");
  const loaded = await load();
  expect(loaded.modelServers).toEqual([
    { name: "ollama-myserver", address: "http://192.0.2.10:11434", kind: "ollama" },
    { name: "vllm-gpu", address: "https://models.example.com", kind: "vllm" },
  ]);
  expect(loaded.warnings.join("\n")).not.toContain("modelServers");
});

test("a bad entry is skipped with a warning; Casper still starts, and a key in the file is never used", async () => {
  await write(config(), [
    "modelServers:",
    "  - name: ollama-ok", "    address: 192.0.2.10", "    kind: ollama",
    "  - name: openai", "    address: 192.0.2.11", "    kind: openai",
    "  - name: sglang-box", "    address: 192.0.2.12", "    kind: sglang",
    "  - name: with-key", "    address: 192.0.2.13", "    kind: vllm", "    key: token-abc123",
    "  - name: with-login", "    address: http://u:p@192.0.2.14:8000", "    kind: vllm",
    "  - name: ollama-ok", "    address: 192.0.2.15", "    kind: ollama",
    "  - just a string",
    "",
  ].join("\n"));
  const loaded = await load();
  expect(loaded.modelServers).toEqual([{ name: "ollama-ok", address: "http://192.0.2.10:11434", kind: "ollama" }]);
  const warnings = loaded.warnings.join("\n");
  expect(warnings).toContain("modelServers[1] (openai) skipped: openai is already a provider's name");
  expect(warnings).toContain("modelServers[2] (kind sglang) skipped");
  expect(warnings).toContain("modelServers[3] skipped: keys don't go in config.yaml");
  expect(warnings).toContain("modelServers[4] (with-login) skipped: Leave the name and password out");
  expect(warnings).toContain("modelServers[5] (ollama-ok) skipped: ollama-ok is already taken");
  expect(warnings).toContain("modelServers[6] skipped");
  expect(warnings).not.toContain("token-abc123");
});

test("only a value that isn't a list stops the load", async () => {
  await write(config(), "modelServers: ollama\n");
  await expect(load()).rejects.toThrow("modelServers must be a list");
});

test("a project can't add a model server; a profile's list is ignored, with a warning", async () => {
  await write(path.join(repo(), ".casper/project.yaml"), "modelServers:\n  - name: ollama-evil\n    address: 192.0.2.66\n    kind: ollama\n");
  await expect(load()).rejects.toThrow("modelServers is your own setting (~/.casper/config.yaml); a project cannot add model servers");
  await write(path.join(repo(), ".casper/project.yaml"), "profile: lab\n");
  await write(path.join(home(), ".casper/profiles/lab/config.yaml"), "modelServers:\n  - name: ollama-lab\n    address: 192.0.2.67\n    kind: ollama\n");
  const loaded = await load();
  expect(loaded.modelServers).toBeUndefined();
  expect(loaded.warnings.join("\n")).toContain("modelServers is kept in ~/.casper/config.yaml only; this profile's list is ignored");
});

test("adding and forgetting keep every other setting, comment and entry", async () => {
  await write(config(), "# my settings\nweb: off # quiet\n");
  await addModelServer(home(), { name: "ollama-myserver", address: "http://192.0.2.10:11434", kind: "ollama" });
  await addModelServer(home(), { name: "llama-cpp-box", address: "http://192.0.2.11:8080", kind: "llama.cpp" });
  let text = await readFile(config(), "utf8");
  expect(text).toContain("# my settings");
  expect(text).toContain("web: off # quiet");
  expect((await load()).modelServers?.map((server) => server.name)).toEqual(["ollama-myserver", "llama-cpp-box"]);
  await removeModelServer(home(), "ollama-myserver");
  text = await readFile(config(), "utf8");
  expect(text).toContain("web: off # quiet");
  expect((await load()).modelServers?.map((server) => server.name)).toEqual(["llama-cpp-box"]);
  await removeModelServer(home(), "llama-cpp-box");
  expect(await readFile(config(), "utf8")).not.toContain("modelServers");
  await expect(addModelServer(home(), { name: "openrouter", address: "http://192.0.2.12:8000", kind: "vllm" })).rejects.toThrow("already a provider's name");
  // An entry skipped at load (a typo) and its comment stay as you wrote them when another server is added or forgotten.
  await write(config(), "modelServers:\n  # the den box\n  - name: den-box\n    address: 192.0.2.20\n    kind: Ollama\n");
  await addModelServer(home(), { name: "ollama-myserver", address: "http://192.0.2.10:11434", kind: "ollama" });
  await removeModelServer(home(), "ollama-myserver");
  text = await readFile(config(), "utf8");
  expect(text).toContain("# the den box");
  expect(text).toContain("kind: Ollama");
});

needsSymlinks("a config.yaml that is a link is never changed", async () => {
  const elsewhere = path.join(root, "elsewhere.yaml");
  await writeFile(elsewhere, "web: off\n");
  await mkdir(path.dirname(config()), { recursive: true });
  await symlink(elsewhere, config());
  await expect(addModelServer(home(), { name: "ollama-myserver", address: "http://192.0.2.10:11434", kind: "ollama" })).rejects.toThrow("not a plain file");
  expect(await readFile(elsewhere, "utf8")).toBe("web: off\n");
});
