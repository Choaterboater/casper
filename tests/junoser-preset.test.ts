import { afterEach, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { formatNetworkCheckLine, JUNOSER_NOTE, networkResultForModel, repairClass, repairNote, runNetworkCheck } from "../src/network/checks";
import type { NetworkCheckSpec } from "../src/network/spec";
import { fakeTool, networkFixture, RECORD_CALL, writeProjectFile, type NetworkFixture } from "./support/network-fakes";

let fixture: NetworkFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

const spec: NetworkCheckSpec = { kind: "offline", preset: "junoser", files: ["configs/"], after: "each-change" };
const context = (f: NetworkFixture) => ({ root: f.root, path: f.path, tmpRoot: f.tmp, realHome: f.home });
const HASH = "$6$abcdefgh$Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFy";

async function setup(body: string) {
  fixture = await networkFixture();
  await writeProjectFile(fixture, "configs/r1.set", `set system host-name r1\nset system root-authentication encrypted-password "${HASH}"\nset foo\n`);
  await fakeTool(fixture, "junoser", `${RECORD_CALL("junoser")}\n${body}`);
  return fixture;
}

test("a Junoser complaint is a failure that names the line and says it may be newer syntax", async () => {
  const f = await setup(`echo "Invalid syntax:  set foo" >&2; exit 1`);
  const result = await runNetworkCheck("junoser", spec, context(f));
  expect(result.status).toBe("fail");
  expect(result.stderr).toContain("Invalid syntax:  set foo");
  expect(result.reason).toBe("Junoser could not read configs/r1.set: set foo (it may be newer syntax)");
  expect(repairClass(result)).toBe("repairable");
  expect(repairNote(result)).toBe(JUNOSER_NOTE);
  expect(formatNetworkCheckLine(result)).toStartWith("✗ junoser  junoser -c configs/r1.set  (Junoser could not read");
  const argv = (await readFile(path.join(f.records, "junoser.argv"), "utf8")).trim().split("\n");
  expect(argv[0]).toBe("-c");
  expect(argv[1]).toEndWith(path.join("configs", "r1.set"));
});

test("Junoser output is scrubbed before the casper_check text: a root password hash shows <secret hidden>", async () => {
  const f = await setup(`cat "$2"; echo "Invalid syntax:  set foo" >&2; exit 1`);
  const result = await runNetworkCheck("junoser", spec, context(f));
  const forModel = JSON.stringify(networkResultForModel(result));
  expect(result.stdout).not.toContain(HASH);
  expect(forModel).not.toContain(HASH);
  expect(result.stdout).toContain("<secret hidden>");
  expect(forModel).toContain(JUNOSER_NOTE);
});

test("clean files pass, and a missing junoser reads not run with the gem line", async () => {
  const f = await setup("exit 0");
  expect((await runNetworkCheck("junoser", spec, context(f))).status).toBe("pass");
  const missing = await runNetworkCheck("junoser", spec, { ...context(f), path: path.join(f.root, "configs") });
  expect(formatNetworkCheckLine(missing)).toBe("– junoser  not run: junoser is not installed (gem install junoser)");
  expect(repairClass(missing)).toBe("never");
});

test("a config file linked from outside the project is not read", async () => {
  const f = await setup("exit 0");
  const { symlink, writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.join(path.dirname(f.root), "outside"), { recursive: true });
  await writeFile(path.join(path.dirname(f.root), "outside", "secret.conf"), "x");
  await symlink(path.join(path.dirname(f.root), "outside", "secret.conf"), path.join(f.root, "linked.conf"));
  const result = await runNetworkCheck("junoser", { ...spec, files: ["linked.conf"] }, context(f));
  expect(result).toMatchObject({ status: "skip", notRun: "input" });
  expect(await stat(path.join(f.records, "junoser.ran")).then(() => true, () => false)).toBe(false);
});

test("yanglint checks data against the declared models, as arguments, and reads not run when the models are missing", async () => {
  const f = await setup("exit 0");
  await fakeTool(f, "yanglint", `${RECORD_CALL("yanglint")}\necho "libyang[0]: Invalid value \\"abc\\" of \\"vlan-id\\"." >&2; exit 1`);
  await writeProjectFile(f, "yang/openconfig-vlan.yang", "module openconfig-vlan {}\n");
  await writeProjectFile(f, "data/vlans.json", "{}\n");
  const yang: NetworkCheckSpec = { kind: "offline", preset: "yanglint", models: ["yang"], modules: ["yang/openconfig-vlan.yang"], files: ["data/vlans.json"] };
  const result = await runNetworkCheck("aoscx-yang", yang, context(f));
  expect(result.status).toBe("fail");
  expect(result.command).toBe("yanglint -t config -p yang yang/openconfig-vlan.yang data/vlans.json");
  const argv = (await readFile(path.join(f.records, "yanglint.argv"), "utf8")).trim().split("\n");
  expect(argv.slice(0, 3)).toEqual(["-t", "config", "-p"]);
  const missing = await runNetworkCheck("aoscx-yang", { ...yang, models: ["models/10.17"] }, context(f));
  expect(missing).toMatchObject({ status: "skip", notRun: "input" });
  expect(missing.reason).toContain("aruba/aoscx-yang");
});
