import { expect, test } from "bun:test";
import { checkLock, readLock, readTemplates, templateHash } from "../scripts/pack-templates";

test("every template's files match templates/VERSIONS.json at its version (bump the version, then --lock)", async () => {
  const templates = await readTemplates();
  const lock = await readLock();
  expect(checkLock(templates, lock).problems).toEqual([]);
  for (const template of templates) {
    expect(lock[template.manifest.id]).toEqual({ version: template.manifest.version, sha256: templateHash(template) });
  }
});

test("a changed file without a version bump is caught; a bump is recorded by --lock", async () => {
  const [first] = await readTemplates();
  const lock = { [first!.manifest.id]: { version: first!.manifest.version, sha256: templateHash(first!) } };
  const changed = { ...first!, files: { ...first!.files, "README.md": `${first!.files["README.md"]}\nchanged\n` } };
  const stale = checkLock([changed], lock);
  expect(stale.problems).toEqual([`templates/${first!.manifest.id} changed but its version is still ${first!.manifest.version}: bump "version" in template.json, then run with --lock`]);
  expect(stale.next).toEqual(lock);

  const bumped = { ...changed, manifest: { ...changed.manifest, version: changed.manifest.version + 1 } };
  const result = checkLock([bumped], lock);
  expect(result.problems[0]).toContain("run with --lock");
  expect(result.next[first!.manifest.id]).toEqual({ version: first!.manifest.version + 1, sha256: templateHash(bumped) });
});

test("a lock entry with no template folder is reported", () => {
  expect(checkLock([], { gone: { version: 1, sha256: "x" } }).problems).toEqual(["templates/VERSIONS.json lists gone, which has no folder"]);
});
