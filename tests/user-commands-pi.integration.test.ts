import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { answer, cleanUpAfterEach, cli, fixture } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();

test("real Pi: /hello world reaches the model as your command's text; a read-only helper never expands one", async () => {
  const f = await fixture(() => answer("USER_COMMAND_DONE"));
  const home = path.dirname(path.dirname(f.agent));
  await mkdir(path.join(home, ".casper/commands"), { recursive: true });
  await writeFile(path.join(home, ".casper/commands/hello.md"), "---\ndescription: Say hello\n---\nEXPANDED_HELLO to $1\n");
  // Pi's own folder for prompt templates in Casper's store counts too.
  await mkdir(path.join(f.agent, "prompts"), { recursive: true });
  await writeFile(path.join(f.agent, "prompts/scout.md"), "EXPANDED_SCOUT $@\n");

  const typed = await f.run([cli, "--no-verify", "/hello world"]);
  expect({ exit: typed.exit, stderr: typed.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(typed.stdout).toContain("USER_COMMAND_DONE");
  expect(JSON.stringify(f.payloads[0]?.messages)).toContain("EXPANDED_HELLO to world");

  const pi = await f.run([cli, "--no-verify", "/scout the docs"]);
  expect({ exit: pi.exit, stderr: pi.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.stringify(f.payloads[1]?.messages)).toContain("EXPANDED_SCOUT the docs");

  // A read-only helper is given text, never a command: its goal goes as written.
  const helper = await f.run([cli, "/delegate", "explorer", "/hello world"]);
  expect({ exit: helper.exit, stderr: helper.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(f.payloads).toHaveLength(3);
  expect(JSON.stringify(f.payloads[2]?.messages)).toContain("/hello world");
  expect(JSON.stringify(f.payloads[2]?.messages)).not.toContain("EXPANDED_HELLO");
}, childTestLimit(3));
