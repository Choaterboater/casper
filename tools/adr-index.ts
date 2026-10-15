import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Discover decisions rather than committing a shared index in every feature PR. Historical anchors stay put. */
export async function decisions(root = path.resolve(import.meta.dir, "..")): Promise<Array<{ file: string; text: string }>> {
  const dir = path.join(root, "docs/adr/0002");
  const files = (await readdir(dir)).filter(file => /^\d{2,}-[a-z0-9-]+\.md$/.test(file)).sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
  return Promise.all(files.map(async file => ({ file, text: await readFile(path.join(dir, file), "utf8") })));
}

export async function deliberateChoices(root = path.resolve(import.meta.dir, "..")): Promise<string> {
  return [await readFile(path.join(root, "docs/adr/0002-deliberate-choices.md"), "utf8"),
    ...(await decisions(root)).map(entry => entry.text)].join("\n\n");
}

if (import.meta.main) {
  console.log("Historical decisions 1–12: docs/adr/0002-deliberate-choices.md\n");
  for (const { file, text } of await decisions()) console.log(`- [${text.split("\n")[0]!.replace(/^# /, "")}](docs/adr/0002/${file})`);
}
