import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProjectContext } from "../src/project/context";
import type { ProjectModel } from "../src/project/model";
import { COMPOSE_CHECK, COMPOSE_MAX_FILES, composeScope, detectCompose, envSecretValues, findComposeFiles, runComposeCheck } from "../src/verify/compose";
import { autoDetectedChecks } from "../src/verify/migrations-check";
import { planAutoChecks } from "../src/verify/mode";
import { defaultVerifyNames, VerifierRegistry } from "../src/verify/registry";
import { fakeTool, networkFixture, type NetworkFixture } from "./support/network-fakes";
import { removeTempDir } from "./support/temp-dir";

/** Docker Compose files the project has: found from its files, checked with `docker compose config --quiet`. */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function fixture(files: Record<string, string>): Promise<NetworkFixture> {
  const made = await networkFixture();
  cleanups.push(made.cleanup);
  // The real folder (macOS's temp folder is behind a link), as docker and process.cwd() see it.
  const f = { ...made, root: await realpath(made.root) };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
    await writeFile(path.join(f.root, file), text);
  }
  return f;
}

/** A fake docker: records each call's folder and arguments, and fails a file with "imagee" in it the way Compose does. */
const fakeDocker = (f: NetworkFixture, body = "") => fakeTool(f, "docker", `${body}
fs.appendFileSync(path.join(RECORDS, "docker.calls"), JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const file = args[args.indexOf("-f") + 1];
const text = fs.readFileSync(file, "utf8");
if (text.includes("imagee")) { err("validating " + path.join(process.cwd(), file) + ": services.web additional properties 'imagee' not allowed\\n"); process.exit(15); }
`);

const calls = async (f: NetworkFixture) => (await readFile(path.join(f.records, "docker.calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { cwd: string; args: string[] });

const GOOD = "services:\n  web:\n    image: nginx:1.27\n    ports: [\"8080:80\"]\n";
const BAD = "services:\n  web:\n    imagee: nginx:1.27\n";

function model(root: string, compose?: ProjectModel["compose"], named?: ProjectModel["namedChecks"]): ProjectModel {
  return { schemaVersion: 1, project: { name: "lab", root, git: false }, languages: [], frameworks: [], packageManager: null,
    commands: {}, architecture: {}, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z", ...(compose ? { compose } : {}),
    ...(named ? { namedChecks: named } : {}) } as ProjectModel;
}

test("compose files are found at the root and two folders down, never in hidden folders, node_modules or deeper", async () => {
  const f = await fixture({ "compose.yaml": GOOD, "media/docker-compose.yml": GOOD, "stacks/dns/compose.yml": GOOD,
    "stacks/dns/deep/compose.yaml": GOOD, ".git/compose.yaml": GOOD, ".hidden/compose.yaml": GOOD, "node_modules/x/compose.yaml": GOOD,
    "media/compose.override.yaml": GOOD, "notes/compose.txt": "" });
  expect(await findComposeFiles(f.root)).toEqual(["compose.yaml", "media/docker-compose.yml", "stacks/dns/compose.yml"]);
  expect(await detectCompose(f.root, { PATH: f.bin })).toEqual({ files: ["compose.yaml", "media/docker-compose.yml", "stacks/dns/compose.yml"], docker: false });
  await fakeDocker(f);
  expect((await detectCompose(f.root, { PATH: f.path }))?.docker).toBe(true);
  expect(composeScope({ files: ["compose.yaml", "media/docker-compose.yml", "stacks/dns/compose.yml"], docker: true }))
    .toEqual({ inputs: ["compose.yaml", ".env", "media", "stacks/dns"] });
  expect(await detectCompose((await fixture({ "README.md": "" })).root)).toBeUndefined();
});

test(`at most ${COMPOSE_MAX_FILES} files are checked`, async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < COMPOSE_MAX_FILES + 5; i++) files[`stack${String(i).padStart(2, "0")}/compose.yaml`] = GOOD;
  const found = await findComposeFiles((await fixture(files)).root);
  expect(found).toHaveLength(COMPOSE_MAX_FILES);
  expect(found[0]).toBe("stack00/compose.yaml");
});

test("each file is checked with docker compose config --quiet in its own folder, and a valid set passes", async () => {
  const f = await fixture({ "compose.yaml": GOOD, "media/compose.yml": GOOD });
  await fakeDocker(f);
  const result = await runComposeCheck({ root: f.root, timeoutMs: 30_000, env: { ...process.env, PATH: f.path } });
  expect(result).toMatchObject({ name: COMPOSE_CHECK, status: "pass", command: "docker compose config --quiet", label: "2 compose files" });
  const ran = await calls(f);
  expect(ran.map(({ args }) => args)).toEqual([["compose", "-f", "compose.yaml", "config", "--quiet"], ["compose", "-f", "compose.yml", "config", "--quiet"]]);
  expect(ran.map(({ cwd }) => path.relative(f.root, cwd))).toEqual(["", "media"]);
});

test("an invalid file fails with its name and Compose's own error, for the AI to fix", async () => {
  const f = await fixture({ "compose.yaml": GOOD, "media/compose.yaml": BAD, "dns/compose.yaml": BAD });
  await fakeDocker(f);
  const registry = VerifierRegistry.forProject(model(f.root, { files: ["compose.yaml", "dns/compose.yaml", "media/compose.yaml"], docker: true }),
    30_000, undefined, { network: { path: f.path } });
  expect(registry.modelNames()).toContain(COMPOSE_CHECK);
  const [result] = await registry.run([COMPOSE_CHECK]);
  expect(result!.status).toBe("fail");
  expect(result!.repair).toBeUndefined();
  expect(result!.reason).toBe(`dns/compose.yaml is not valid — validating ${path.join(f.root, "dns", "compose.yaml")}: services.web additional properties 'imagee' not allowed (and 1 more)`);
  expect(result!.stderr).toContain("media/compose.yaml:\n  validating ");
  expect(result!.stderr).not.toContain("compose.yaml:\n  validating " + path.join(f.root, "compose.yaml"));
});

test("values from a stack's .env that Compose's error echoes are hidden, a cut-off piece of one too", async () => {
  const f = await fixture({ "media/compose.yaml": BAD, "media/.env": "WIREGUARD_PRIVATE_KEY='Wg0Placeholder0Key0Value='\nTZ=Etc/UTC\nPUID=1000\n" });
  await fakeTool(f, "docker", `err("invalid hostPort: Wg0Placeholder0Key0Value=\\nparsing \\"Wg0Place\\": invalid syntax\\nTZ is Etc/UTC\\n"); process.exit(1);`);
  const result = await runComposeCheck({ root: f.root, timeoutMs: 30_000, env: { ...process.env, PATH: f.path } });
  expect(result.status).toBe("fail");
  expect(`${result.reason}\n${result.stderr}`).not.toContain("Wg0Place");
  expect(result.reason).toBe("media/compose.yaml is not valid — invalid hostPort: <secret hidden>");
  expect(result.stderr).toContain("TZ is Etc/UTC");
  expect(await envSecretValues(path.join(f.root, "media"))).toEqual(["Wg0Placeholder0Key0Value="]);
});

test("no docker on PATH, or docker without compose: the check only skips and says why, never for the AI to fix", async () => {
  const f = await fixture({ "compose.yaml": GOOD });
  const missing = await runComposeCheck({ root: f.root, timeoutMs: 30_000, env: { ...process.env, PATH: f.bin } });
  expect(missing).toMatchObject({ status: "skip", repair: "never", reason: "Docker isn't installed here (no docker on PATH), so the compose files were not checked. Casper doesn't install it" });
  const notFound = model(f.root, { files: ["compose.yaml"], docker: false });
  const registry = VerifierRegistry.forProject(notFound, 30_000, undefined, { network: { path: f.bin } });
  expect(registry.modelNames()).not.toContain(COMPOSE_CHECK);
  expect((await registry.run([COMPOSE_CHECK]))[0]).toMatchObject({ status: "skip", repair: "never" });
  expect(autoDetectedChecks(notFound)).toEqual([]);
  expect(defaultVerifyNames(notFound)).not.toContain(COMPOSE_CHECK);
  await fakeTool(f, "docker", `err("docker: 'compose' is not a docker command.\\nSee 'docker --help'\\n"); process.exit(1);`);
  expect(await runComposeCheck({ root: f.root, timeoutMs: 30_000, env: { ...process.env, PATH: f.path } })).toMatchObject({ status: "skip", repair: "never",
    reason: "Docker Compose isn't installed here (docker has no compose command), so the compose files were not checked. Casper doesn't install it" });
});

test("with docker it runs after a change to a compose file or a stack's folder, and with /verify", () => {
  const found = model("/tmp/lab", { files: ["compose.yaml", "media/compose.yaml"], docker: true });
  expect(defaultVerifyNames(found)).toContain(COMPOSE_CHECK);
  const detected = autoDetectedChecks(found);
  expect(detected).toEqual([{ name: COMPOSE_CHECK, scope: { inputs: ["compose.yaml", ".env", "media"] }, command: "docker compose config --quiet" }]);
  const plan = (changedPaths: string[]) => planAutoChecks({ commands: {}, detected, changedPaths }).run;
  expect(plan(["media/.env"])).toEqual([COMPOSE_CHECK]);
  expect(plan([".env"])).toEqual([COMPOSE_CHECK]);
  expect(plan(["notes/todo.txt"])).toEqual([]);
});

test("the project's own compose check wins, and verification.compose: false turns the found one off", async () => {
  const f = await fixture({ "compose.yaml": GOOD });
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-compose-home-"));
  cleanups.push(() => removeTempDir(home));
  const info = { cwd: f.root, root: f.root, name: "lab", gitBranch: null, isGit: false };
  expect((await loadProjectContext(info, { homeDir: home })).model.compose?.files).toEqual(["compose.yaml"]);
  await mkdir(path.join(f.root, ".casper"));
  await writeFile(path.join(f.root, ".casper/project.yaml"), "verification:\n  compose: false\n");
  expect((await loadProjectContext(info, { homeDir: home })).model.compose).toBeUndefined();
  await writeFile(path.join(f.root, ".casper/project.yaml"), "verification:\n  compose: maybe\n");
  await expect(loadProjectContext(info, { homeDir: home })).rejects.toThrow("verification.compose must be true or false");
  await writeFile(path.join(f.root, ".casper/project.yaml"), "verify:\n  checks:\n    compose: { run: docker compose config -q }\n");
  const own = await loadProjectContext(info, { homeDir: home });
  expect(own.model.compose).toBeUndefined();
  expect(own.model.namedChecks?.compose?.run).toBe("docker compose config -q");
  expect(VerifierRegistry.forProject(model(f.root, { files: ["compose.yaml"], docker: true }, own.model.namedChecks)).command(COMPOSE_CHECK)).toBe("docker compose config -q");
});

const realCompose = spawnSync("docker", ["compose", "version"], { stdio: "ignore", timeout: 15_000 }).status === 0;

test.skipIf(!realCompose)("real docker compose: a valid file passes and an invalid one fails with its name", async () => {
  const f = await fixture({ "good/compose.yaml": GOOD, "good/.env": "TAG=1.27\n" });
  await writeFile(path.join(f.root, "good/compose.yaml"), "services:\n  web:\n    image: nginx:${TAG:?set TAG}\n    ports: [\"8080:80\"]\n");
  expect(await runComposeCheck({ root: f.root, timeoutMs: 60_000 })).toMatchObject({ status: "pass", label: "1 compose file" });
  await mkdir(path.join(f.root, "bad"));
  await writeFile(path.join(f.root, "bad/docker-compose.yml"), BAD);
  const failed = await runComposeCheck({ root: f.root, timeoutMs: 60_000 });
  expect(failed.status).toBe("fail");
  expect(failed.reason).toStartWith("bad/docker-compose.yml is not valid — ");
  expect(failed.reason).toContain("imagee");
  expect(failed.stderr).not.toContain("1.27");
  await writeFile(path.join(f.root, "bad/.env"), "DB_PASSWORD=Placeholder0Pass\n");
  await writeFile(path.join(f.root, "bad/docker-compose.yml"), "services:\n  web:\n    image: nginx\n    ports: [\"${DB_PASSWORD}:80\"]\n");
  const echoed = await runComposeCheck({ root: f.root, timeoutMs: 60_000 });
  expect(echoed.status).toBe("fail");
  expect(`${echoed.reason}\n${echoed.stderr}`).not.toContain("Placeholder0Pass");
}, 120_000);
