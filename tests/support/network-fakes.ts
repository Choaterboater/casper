import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A temp project, a folder of fake tools, and a place for the fakes to leave records. */
export interface NetworkFixture {
  root: string;
  bin: string;
  records: string;
  /** PATH with only the fakes plus the system folders the fake scripts need. */
  path: string;
  home: string;
  tmp: string;
  cleanup(): Promise<void>;
}

export async function networkFixture(): Promise<NetworkFixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-network-test-"));
  const root = path.join(base, "project");
  const bin = path.join(base, "bin");
  const records = path.join(base, "records");
  const home = path.join(base, "home");
  const tmp = path.join(base, "tmp");
  for (const folder of [root, bin, records, home, tmp]) await mkdir(folder, { recursive: true });
  return { root, bin, records, home, tmp, path: `${bin}:/usr/bin:/bin`, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** A POSIX shell fake. `body` runs with the fake's argv; it may use $RECORDS. */
export async function fakeTool(fixture: NetworkFixture, name: string, body: string): Promise<string> {
  const file = path.join(fixture.bin, name);
  await writeFile(file, `#!/bin/sh\nRECORDS='${fixture.records}'\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/** Records argv (one per line) and the environment of each call to <records>/<name>.argv and .env. */
export const RECORD_CALL = (name: string) =>
  `printf '%s\\n' "$@" > "$RECORDS/${name}.argv"; env > "$RECORDS/${name}.env"; touch "$RECORDS/${name}.ran"`;

export async function writeProjectFile(fixture: NetworkFixture, relative: string, text: string, mode?: number): Promise<string> {
  const file = path.join(fixture.root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  if (mode !== undefined) await chmod(file, mode);
  return file;
}
