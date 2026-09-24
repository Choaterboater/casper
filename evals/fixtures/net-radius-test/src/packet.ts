import { createHash, randomBytes } from "node:crypto";

export const Code = { AccessRequest: 1, AccessAccept: 2, AccessReject: 3, AccessChallenge: 11 } as const;
export const Attribute = { UserName: 1, UserPassword: 2, ReplyMessage: 18, VendorSpecific: 26, NasIdentifier: 32 } as const;

export interface RawAttribute {
  readonly type: number;
  readonly value: Buffer;
}

export interface Packet {
  readonly code: number;
  readonly identifier: number;
  readonly authenticator: Buffer;
  readonly attributes: readonly RawAttribute[];
  /** The attribute bytes exactly as received, for authenticator checks. */
  readonly attributeBytes: Buffer;
}

export const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();

/** RFC 2865 §5.2 User-Password hiding. */
export function hidePassword(password: string, secret: string, requestAuthenticator: Buffer): Buffer {
  const plain = Buffer.from(password, "utf8");
  if (plain.length > 128) throw new Error("Password longer than 128 bytes");
  const padded = Buffer.alloc(Math.max(16, Math.ceil(plain.length / 16) * 16));
  plain.copy(padded);
  const result = Buffer.alloc(padded.length);
  let previous = requestAuthenticator;
  for (let offset = 0; offset < padded.length; offset += 16) {
    const key = md5(Buffer.from(secret, "utf8"), previous);
    for (let index = 0; index < 16; index++) result[offset + index] = padded[offset + index]! ^ key[index]!;
    previous = result.subarray(offset, offset + 16);
  }
  return result;
}

export function encodeAttributes(attributes: readonly RawAttribute[]): Buffer {
  return Buffer.concat(attributes.map(({ type, value }) => {
    if (value.length > 253) throw new Error(`Attribute ${type} is too long`);
    return Buffer.concat([Buffer.from([type, value.length + 2]), value]);
  }));
}

export function encodePacket(code: number, identifier: number, authenticator: Buffer, attributes: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = code;
  header[1] = identifier;
  header.writeUInt16BE(20 + attributes.length, 2);
  return Buffer.concat([header, authenticator, attributes]);
}

export interface AccessRequest {
  readonly packet: Buffer;
  readonly identifier: number;
  readonly authenticator: Buffer;
}

export function encodeAccessRequest(options: { username: string; password: string; secret: string; nasIdentifier?: string; identifier?: number }): AccessRequest {
  const identifier = options.identifier ?? randomBytes(1)[0]!;
  const authenticator = randomBytes(16);
  const attributes = encodeAttributes([
    { type: Attribute.UserName, value: Buffer.from(options.username, "utf8") },
    { type: Attribute.UserPassword, value: hidePassword(options.password, options.secret, authenticator) },
    { type: Attribute.NasIdentifier, value: Buffer.from(options.nasIdentifier ?? "radtest", "utf8") },
  ]);
  return { packet: encodePacket(Code.AccessRequest, identifier, authenticator, attributes), identifier, authenticator };
}

/** Parse a packet; null when it is malformed (bad length or attribute framing). */
export function decodePacket(data: Buffer): Packet | null {
  if (data.length < 20) return null;
  const length = data.readUInt16BE(2);
  if (length < 20 || length > data.length) return null;
  const attributeBytes = data.subarray(20, length);
  const attributes: RawAttribute[] = [];
  for (let offset = 0; offset < attributeBytes.length;) {
    const type = attributeBytes[offset]!;
    const size = attributeBytes[offset + 1];
    if (size === undefined || size < 2 || offset + size > attributeBytes.length) return null;
    attributes.push({ type, value: attributeBytes.subarray(offset + 2, offset + size) });
    offset += size;
  }
  return { code: data[0]!, identifier: data[1]!, authenticator: data.subarray(4, 20), attributes, attributeBytes };
}
