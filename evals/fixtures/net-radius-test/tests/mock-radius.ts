/** A scripted UDP RADIUS server. Each reply is computed with the server's own secret, as a real one would. */
import dgram from "node:dgram";
import { Code, decodePacket, encodeAttributes, encodePacket, md5, type Packet, type RawAttribute } from "../src/packet";

export type Script = (request: Packet, password: string, attempt: number) =>
  | { code: number; attributes?: RawAttribute[]; identifier?: number; secret?: string }[]
  | null;

/** RFC 2865 §5.2 in reverse, as the server does it. */
export function revealPassword(hidden: Buffer, secret: string, requestAuthenticator: Buffer): string {
  const plain = Buffer.alloc(hidden.length);
  let previous = requestAuthenticator;
  for (let offset = 0; offset < hidden.length; offset += 16) {
    const key = md5(Buffer.from(secret), previous);
    for (let index = 0; index < 16; index++) plain[offset + index] = hidden[offset + index]! ^ key[index]!;
    previous = hidden.subarray(offset, offset + 16);
  }
  return plain.toString("utf8").replace(/\0+$/, "");
}

export const vsa = (vendor: number, ...subs: [number, string][]): RawAttribute => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(vendor);
  return { type: 26, value: Buffer.concat([head, ...subs.map(([type, text]) => Buffer.concat([Buffer.from([type, Buffer.byteLength(text) + 2]), Buffer.from(text)]))]) };
};
export const text = (type: number, value: string): RawAttribute => ({ type, value: Buffer.from(value) });

export async function startMockRadius(secret: string, script: Script) {
  const socket = dgram.createSocket("udp4");
  const requests: Packet[] = [];
  const attempts = new Map<string, number>();
  socket.on("message", (data, remote) => {
    const request = decodePacket(data);
    if (!request || request.code !== Code.AccessRequest) return;
    requests.push(request);
    const key = `${request.identifier}:${request.authenticator.toString("hex")}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const hidden = request.attributes.find((attribute) => attribute.type === 2)?.value ?? Buffer.alloc(16);
    const replies = script(request, revealPassword(hidden, secret, request.authenticator), attempt) ?? [];
    for (const reply of replies) {
      const attributes = encodeAttributes(reply.attributes ?? []);
      const identifier = reply.identifier ?? request.identifier;
      const unsigned = encodePacket(reply.code, identifier, request.authenticator, attributes);
      const authenticator = md5(unsigned.subarray(0, 4), request.authenticator, attributes, Buffer.from(reply.secret ?? secret));
      socket.send(encodePacket(reply.code, identifier, authenticator, attributes), remote.port, remote.address);
    }
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { port: socket.address().port, requests, close: () => socket.close() };
}
