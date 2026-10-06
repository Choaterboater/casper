import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * Checks an SSH signature (`ssh-keygen -Y sign`, the format OpenSSH documents in PROTOCOL.sshsig) without needing
 * ssh-keygen: the release workflow signs SHA256SUMS this way and `casper update` checks it here. Only Ed25519 keys.
 */

/** The namespace every Casper release signature is made for; a signature made for anything else does not count. */
export const RELEASE_NAMESPACE = "casper-release";

const MAGIC = Buffer.from("SSHSIG");
const ED25519 = "ssh-ed25519";

class Reader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  bytes(length: number): Buffer {
    if (this.offset + length > this.data.length) throw new Error("short");
    const out = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  uint32(): number { return this.bytes(4).readUInt32BE(0); }
  string(): Buffer { return this.bytes(this.uint32()); }
  get done(): boolean { return this.offset === this.data.length; }
}

const sshString = (data: Buffer | string) => {
  const body = typeof data === "string" ? Buffer.from(data) : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
};

/** The raw 32-byte Ed25519 key in an OpenSSH public key line, or undefined when the line is not one. */
export function ed25519Key(line: string): Buffer | undefined {
  const [type, blob] = line.trim().split(/\s+/);
  if (type !== ED25519 || !blob) return undefined;
  try {
    const reader = new Reader(Buffer.from(blob, "base64"));
    if (reader.string().toString() !== ED25519) return undefined;
    const key = reader.string();
    return key.length === 32 && reader.done ? Buffer.from(key) : undefined;
  } catch { return undefined; }
}

/** True only when `armored` is a good signature over `message` by `publicKey` for `namespace`. */
export function verifySshSignature(message: Buffer | string, armored: string, publicKey: string, namespace = RELEASE_NAMESPACE): boolean {
  const key = ed25519Key(publicKey);
  if (!key) return false;
  const body = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(armored)?.[1];
  if (!body) return false;
  try {
    const reader = new Reader(Buffer.from(body.replace(/\s+/g, ""), "base64"));
    if (!reader.bytes(6).equals(MAGIC) || reader.uint32() !== 1) return false;
    reader.string(); // the signer's key as the signature names it; only the pinned key is trusted
    const signedFor = reader.string();
    const reserved = reader.string();
    const hash = reader.string().toString();
    const signature = new Reader(reader.string());
    if (!reader.done || signedFor.toString() !== namespace || (hash !== "sha512" && hash !== "sha256")) return false;
    if (signature.string().toString() !== ED25519) return false;
    const raw = signature.string();
    if (raw.length !== 64 || !signature.done) return false;
    const digest = createHash(hash).update(message).digest();
    const signed = Buffer.concat([MAGIC, sshString(signedFor), sshString(reserved), sshString(hash), sshString(digest)]);
    const publicKeyObject = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") }, format: "jwk" });
    return verify(null, signed, publicKeyObject, raw);
  } catch { return false; }
}
