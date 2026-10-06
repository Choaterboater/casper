import { createHash, generateKeyPairSync, sign } from "node:crypto";

/**
 * A throwaway release key for tests only, made fresh in memory each run: no private key is ever written to disk or
 * kept in the repository. It signs the way `ssh-keygen -Y sign -n casper-release` does.
 */

const sshString = (data: Buffer | string) => {
  const body = typeof data === "string" ? Buffer.from(data) : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
};

/** `hash` names the hash in the signature; a forged one may name anything (ssh-keygen prints it back). */
export interface TestKey { publicKey: string; sign(message: Buffer | string, namespace?: string, hash?: string): string }

export function testReleaseKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(raw)]);
  return {
    publicKey: `ssh-ed25519 ${blob.toString("base64")}`,
    sign(message, namespace = "casper-release", hash = "sha512") {
      const magic = Buffer.from("SSHSIG");
      const digest = createHash("sha512").update(message).digest();
      const signed = Buffer.concat([magic, sshString(namespace), sshString(""), sshString(hash), sshString(digest)]);
      const signature = Buffer.concat([sshString("ssh-ed25519"), sshString(sign(null, signed, privateKey))]);
      const version = Buffer.alloc(4);
      version.writeUInt32BE(1);
      const body = Buffer.concat([magic, version, sshString(blob), sshString(namespace), sshString(""), sshString(hash), sshString(signature)]);
      const lines = body.toString("base64").match(/.{1,70}/g)!;
      return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
    },
  };
}

/** True when this machine's ssh-keygen can check signatures (OpenSSH 8.1 or newer). */
export function sshKeygenVerifies(): boolean {
  try {
    const probe = Bun.spawnSync(["ssh-keygen", "-Y", "verify"], { stdout: "pipe", stderr: "pipe" });
    return !/option -- Y|illegal option|unknown option/i.test(probe.stderr.toString());
  } catch { return false; }
}
