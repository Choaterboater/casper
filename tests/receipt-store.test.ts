import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RECEIPTS_KEPT, ReceiptStore, type StoredReceipt } from "../src/task/receipts";
import { needsPosixModes } from "./support/platform";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function store() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-receipts-"));
  roots.push(root);
  return new ReceiptStore(root);
}
const receipt = (request: string): Omit<StoredReceipt, "n" | "schemaVersion"> => ({ createdAt: "2026-09-29T14:02:00.000Z", kind: "task", request,
  root: "/p", sessionId: null, conversation: null, undo: null, task: { execution: "completed", changedPaths: [] } });

test("receipts get the next number, read back, list newest first, and change in place", async () => {
  const receipts = await store();
  expect(await receipts.add(receipt("first"))).toBe(1);
  expect(await receipts.add(receipt("second"))).toBe(2);
  expect(await receipts.get(1)).toMatchObject({ n: 1, request: "first", schemaVersion: 1 });
  expect(await receipts.get(9)).toBe("missing");
  expect((await receipts.list()).map((entry) => entry.n)).toEqual([2, 1]);
  expect((await receipts.latest((entry) => entry.request === "first"))?.n).toBe(1);
  await receipts.update(2, (entry) => ({ ...entry, request: "changed" }));
  expect(await receipts.get(2)).toMatchObject({ request: "changed" });
});

test("a damaged receipt reads as unreadable and never throws", async () => {
  const receipts = await store();
  await receipts.add(receipt("first"));
  await writeFile(path.join(receipts.directory, "1.json"), "{ not json");
  expect(await receipts.get(1)).toBe("unreadable");
  expect(await receipts.latest()).toBeUndefined();
});

test(`only the newest ${RECEIPTS_KEPT} receipts are kept`, async () => {
  const receipts = await store();
  for (let index = 0; index < RECEIPTS_KEPT + 2; index++) await receipts.add(receipt(`r${index}`));
  const names = await readdir(receipts.directory);
  expect(names).toHaveLength(RECEIPTS_KEPT);
  expect(names).not.toContain("1.json");
  expect(names).not.toContain("2.json");
});

needsPosixModes("receipts are private: the folder is 0700 and each file 0600", async () => {
  const receipts = await store();
  await receipts.add(receipt("first"));
  expect((await stat(receipts.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(path.join(receipts.directory, "1.json"))).mode & 0o777).toBe(0o600);
});
