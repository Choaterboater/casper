import { expect, test } from "bun:test";
import { decodePacket, encodeAccessRequest } from "../src/packet";
import { revealPassword } from "./mock-radius";

test("an Access-Request carries the user, a hidden password and a NAS-Identifier", () => {
  const request = encodeAccessRequest({ username: "alice", password: "a password longer than sixteen bytes", secret: "testing123", identifier: 7 });
  const packet = decodePacket(request.packet)!;
  expect(packet.code).toBe(1);
  expect(packet.identifier).toBe(7);
  expect(packet.attributes.map((attribute) => attribute.type)).toEqual([1, 2, 32]);
  expect(packet.attributes[0]!.value.toString()).toBe("alice");
  expect(packet.attributes[1]!.value.length).toBe(48);
  expect(revealPassword(packet.attributes[1]!.value, "testing123", request.authenticator)).toBe("a password longer than sixteen bytes");
});

test("malformed packets decode to null", () => {
  expect(decodePacket(Buffer.alloc(10))).toBeNull();
  const bad = Buffer.alloc(22);
  bad.writeUInt16BE(22, 2);
  bad[20] = 1;
  bad[21] = 9;
  expect(decodePacket(bad)).toBeNull();
});
