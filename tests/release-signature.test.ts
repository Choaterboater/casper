import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pinReleaseKey } from "../scripts/release-key";
import { RELEASE_KEY } from "../src/update/release-key";
import { ed25519Key, verifySshSignature } from "../src/update/signature";
import { sshKeygenVerifies, testReleaseKey } from "./support/release-signing";

const repoRoot = path.resolve(import.meta.dir, "..");
const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
const SUMS = `${"a".repeat(64)}  casper-linux-x64\n${"b".repeat(64)}  install.sh\n`;

test("a good signature checks out; a changed list, another key, another namespace or junk does not", () => {
  const key = testReleaseKey(), other = testReleaseKey();
  const signature = key.sign(SUMS);
  expect(verifySshSignature(SUMS, signature, key.publicKey)).toBe(true);
  expect(verifySshSignature(Buffer.from(SUMS), signature, `${key.publicKey} a comment`)).toBe(true);
  expect(verifySshSignature(SUMS.replace("a", "c"), signature, key.publicKey)).toBe(false);
  expect(verifySshSignature(SUMS, signature, other.publicKey)).toBe(false);
  expect(verifySshSignature(SUMS, key.sign(SUMS, "file"), key.publicKey)).toBe(false);
  expect(verifySshSignature(SUMS, "junk", key.publicKey)).toBe(false);
  expect(verifySshSignature(SUMS, "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n", key.publicKey)).toBe(false);
  expect(verifySshSignature(SUMS, signature, "")).toBe(false);
  expect(verifySshSignature(SUMS, signature, "ssh-rsa AAAAB3NzaC1yc2E=")).toBe(false);
});

test("an OpenSSH public key line gives its 32-byte key; anything else gives nothing", () => {
  expect(ed25519Key(testReleaseKey().publicKey)?.length).toBe(32);
  expect(ed25519Key("ssh-ed25519 not-base64!")).toBeUndefined();
  expect(ed25519Key("")).toBeUndefined();
});

test.skipIf(!sshKeygenVerifies())("signatures agree with ssh-keygen both ways", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-sig-"));
  temps.push(dir);
  const sums = path.join(dir, "SHA256SUMS");
  await writeFile(sums, SUMS);
  // The test helper's signature passes ssh-keygen's own check.
  const key = testReleaseKey();
  await writeFile(path.join(dir, "allowed"), `casper-release ${key.publicKey}\n`);
  await writeFile(`${sums}.sig`, key.sign(SUMS));
  const checked = Bun.spawnSync(["ssh-keygen", "-Y", "verify", "-f", path.join(dir, "allowed"), "-I", "casper-release", "-n", "casper-release", "-s", `${sums}.sig`],
    { stdin: Bun.file(sums), stdout: "pipe", stderr: "pipe" });
  expect(checked.exitCode).toBe(0);
  // A signature ssh-keygen makes (a throwaway key in a temp folder) passes Casper's check. ssh-keygen keeps an existing .sig.
  await rm(`${sums}.sig`);
  const made = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", path.join(dir, "key")], { stdout: "pipe", stderr: "pipe" });
  expect(made.exitCode).toBe(0);
  const signed = Bun.spawnSync(["ssh-keygen", "-Y", "sign", "-q", "-f", path.join(dir, "key"), "-n", "casper-release", sums], { stdout: "pipe", stderr: "pipe" });
  expect(signed.exitCode).toBe(0);
  const publicKey = await readFile(path.join(dir, "key.pub"), "utf8");
  expect(verifySshSignature(SUMS, await readFile(`${sums}.sig`, "utf8"), publicKey)).toBe(true);
  expect(verifySshSignature(`${SUMS}x`, await readFile(`${sums}.sig`, "utf8"), publicKey)).toBe(false);
});

test("Casper and both installers pin the same release key", async () => {
  const shell = await readFile(path.join(repoRoot, "scripts/install.sh"), "utf8");
  const powershell = await readFile(path.join(repoRoot, "scripts/install.ps1"), "utf8");
  expect(shell.match(/^RELEASE_KEY='([^']*)'$/m)?.[1]).toBe(RELEASE_KEY);
  expect(powershell.match(/^\$ReleaseKey = '([^']*)'$/m)?.[1]).toBe(RELEASE_KEY);
  if (RELEASE_KEY) expect(ed25519Key(RELEASE_KEY)).toBeDefined();
});

test("scripts/release-key.ts pins one public key in all three places and refuses anything else", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-pin-"));
  temps.push(root);
  for (const file of ["src/update/release-key.ts", "scripts/install.sh", "scripts/install.ps1"]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), await readFile(path.join(repoRoot, file), "utf8"));
  }
  const key = testReleaseKey();
  expect(await pinReleaseKey(root, `${key.publicKey} owner@laptop\n`)).toBe(key.publicKey);
  expect(await readFile(path.join(root, "src/update/release-key.ts"), "utf8")).toContain(`export const RELEASE_KEY = "${key.publicKey}";`);
  expect(await readFile(path.join(root, "scripts/install.sh"), "utf8")).toContain(`\nRELEASE_KEY='${key.publicKey}'\n`);
  expect(await readFile(path.join(root, "scripts/install.ps1"), "utf8")).toContain(`\n$ReleaseKey = '${key.publicKey}'\n`);
  // A second run replaces the key rather than adding one.
  const next = testReleaseKey();
  await pinReleaseKey(root, next.publicKey);
  expect(await readFile(path.join(root, "scripts/install.sh"), "utf8")).not.toContain(key.publicKey);
  await expect(pinReleaseKey(root, "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n")).rejects.toThrow("not an ssh-ed25519 public key");
  await expect(pinReleaseKey(root, "ssh-rsa AAAAB3NzaC1yc2E=")).rejects.toThrow("not an ssh-ed25519 public key");
});
