#!/usr/bin/env bun
// Pins the public half of the Casper release key in Casper and both installers, in one step:
//   bun scripts/release-key.ts ~/casper-release-key.pub
// docs/RELEASE.md ("The release key") has the whole one-time setup. Only the public half ever goes here.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ed25519Key } from "../src/update/signature";

const PLACES = [
  { file: "src/update/release-key.ts", line: /^export const RELEASE_KEY = "[^"]*";$/m, write: (key: string) => `export const RELEASE_KEY = "${key}";` },
  { file: "scripts/install.sh", line: /^RELEASE_KEY='[^']*'$/m, write: (key: string) => `RELEASE_KEY='${key}'` },
  { file: "scripts/install.ps1", line: /^\$ReleaseKey = '[^']*'$/m, write: (key: string) => `$ReleaseKey = '${key}'` },
];

/** Writes `publicKey` (an OpenSSH ssh-ed25519 line; a comment is dropped) into every place under `root`. */
export async function pinReleaseKey(root: string, publicKey: string): Promise<string> {
  const [type, blob] = publicKey.trim().split(/\s+/);
  if (!ed25519Key(publicKey) || publicKey.includes("PRIVATE KEY")) {
    throw new Error("That is not an ssh-ed25519 public key. Give the .pub file that ssh-keygen -t ed25519 made.");
  }
  const key = `${type} ${blob}`;
  for (const place of PLACES) {
    const file = path.join(root, place.file);
    const text = await readFile(file, "utf8");
    if (!place.line.test(text)) throw new Error(`No release key line in ${place.file}`);
    await writeFile(file, text.replace(place.line, place.write(key)));
  }
  return key;
}

if (import.meta.main) {
  const source = process.argv[2];
  if (!source) {
    process.stderr.write("Usage: bun scripts/release-key.ts <key.pub>\n");
    process.exit(2);
  }
  try {
    const key = await pinReleaseKey(path.resolve(import.meta.dir, ".."), await readFile(source, "utf8"));
    process.stdout.write(`Pinned ${key.slice(0, 32)}… in ${PLACES.map((place) => place.file).join(", ")}. Run bun run test, then commit.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
