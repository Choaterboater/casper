import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fakeProgram } from "./fake-program";

/** A temp project, a folder of fake tools, and a place for the fakes to leave records. */
export interface NetworkFixture {
  root: string;
  bin: string;
  records: string;
  /** PATH with only the fakes plus the system folders. */
  path: string;
  home: string;
  tmp: string;
  cleanup(): Promise<void>;
}

/** The system folders a PATH keeps besides the fakes. */
const SYSTEM_PATH = process.platform === "win32" ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];

export async function networkFixture(): Promise<NetworkFixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-network-test-"));
  const root = path.join(base, "project");
  const bin = path.join(base, "bin");
  const records = path.join(base, "records");
  const home = path.join(base, "home");
  const tmp = path.join(base, "tmp");
  for (const folder of [root, bin, records, home, tmp]) await mkdir(folder, { recursive: true });
  return { root, bin, records, home, tmp, path: [bin, ...SYSTEM_PATH].join(path.delimiter), cleanup: () => rm(base, { recursive: true, force: true }) };
}

/**
 * A fake tool in the fixture's bin folder (fake-program.ts). `body` is JavaScript run with the fake's arguments in
 * `args`; it may use RECORDS, the records folder.
 */
export async function fakeTool(fixture: NetworkFixture, name: string, body: string): Promise<string> {
  return fakeProgram(path.join(fixture.bin, name), `const RECORDS = ${JSON.stringify(fixture.records)};\n${body}`);
}

/**
 * Ansible has no Windows build, so on Windows Casper refuses the Ansible checks (WINDOWS_REASON). The fakes stand in
 * for Ansible, so tests of what Casper asks and runs pass this platform: Linux on Windows, the real one elsewhere.
 * Tests of the refusal pass "win32", or run on Windows with no platform.
 */
export const ANSIBLE_PLATFORM: NodeJS.Platform = process.platform === "win32" ? "linux" : process.platform;

/** Records argv (one per line) and the environment of each call to <records>/<name>.argv and .env. */
export const RECORD_CALL = (name: string) => [
  `fs.writeFileSync(path.join(RECORDS, ${JSON.stringify(`${name}.argv`)}), lines(args.length ? args : [""]));`,
  `fs.writeFileSync(path.join(RECORDS, ${JSON.stringify(`${name}.env`)}), lines(Object.entries(process.env).map(([key, value]) => key + "=" + value)));`,
  `fs.writeFileSync(path.join(RECORDS, ${JSON.stringify(`${name}.ran`)}), "");`,
].join("\n");

/** Copies `file` into the records folder as `name`, when it exists. */
export const RECORD_FILE = (file: string, name: string) =>
  `try { fs.copyFileSync(${file}, path.join(RECORDS, ${JSON.stringify(name)})); } catch {}`;

export async function writeProjectFile(fixture: NetworkFixture, relative: string, text: string, mode?: number): Promise<string> {
  const file = path.join(fixture.root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  if (mode !== undefined) await chmod(file, mode);
  return file;
}
