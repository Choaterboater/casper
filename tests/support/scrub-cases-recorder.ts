import { appendFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isOutside } from "../../src/platform/inside";

// A preload only `bun tests/support/scrub-cases.ts` gives `bun test`: every final output scrub writes its texts, and the
// environment values, logins and typed secrets it hid with, to a file in SCRUB_CASES_RECORD. A Bun child a test spawns
// (fixtures/pi-scrub.ts) calls recordScrubInput itself. Without that variable it does nothing.

const out = process.env.SCRUB_CASES_RECORD;
const marker = Symbol.for("casper.scrub-cases-recorder");
const scope = globalThis as { [marker]?: true };
const NAME = "scrubToolOutput";

if (out && !scope[marker]) {
  scope[marker] = true;
  Bun.plugin({
    name: "scrub-cases-recorder",
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]secrets[\\/]tool-output\.ts$/ }, async ({ path: file }) => {
        const source = await Bun.file(file).text();
        const head = `export async function ${NAME}(`;
        if (!source.includes(head)) throw new Error(`scrub-cases recorder: ${file} no longer defines ${NAME}`);
        return { loader: "ts", contents: `${source.replace(head, `async function recorded_${NAME}(`)}
import { recordScrubInput as recordScrubInput_ } from ${JSON.stringify(import.meta.path)};
export async function ${NAME}(...args: Parameters<typeof recorded_${NAME}>) { recordScrubInput_(args[3], args[5]); return recorded_${NAME}(...args); }
` };
      });
    },
  });
}

/** Logins only from a test's own files under the temporary folder, never a real one. */
function fixtureLogins(file: unknown, network: boolean): string[] {
  if (typeof file !== "string" || isOutside(path.relative(os.tmpdir(), file))) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const values: string[] = [];
    const walk = (value: unknown, key: string, depth: number) => {
      if (typeof value === "string") { if (network ? value.length >= 4 && /(?:TOKEN|SECRET|CLIENT_ID)$/.test(key) : value.length >= 16 && !/\s/.test(value)) values.push(value); }
      else if (value && typeof value === "object" && depth < 6) for (const [name, inner] of Object.entries(value)) walk(inner, name, depth + 1);
    };
    walk(data, "", 0);
    return values;
  } catch { return []; }
}

export function recordScrubInput(texts: unknown, options: unknown): void {
  if (!out || !Array.isArray(texts)) return;
  const given = (options ?? {}) as { env?: Record<string, string | undefined>; loginFile?: unknown; networkLoginFile?: unknown };
  // Only an environment the test gave, never this process's own.
  const env = Object.fromEntries(Object.entries(given.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  // The typed secrets module is the one the scrub itself reads.
  const typed = (require("../../src/secrets/typed") as typeof import("../../src/secrets/typed")).typedSecretValues();
  const entry = { texts: texts.filter((text) => typeof text === "string"), env, typed,
    values: [...fixtureLogins(given.loginFile, false), ...fixtureLogins(given.networkLoginFile, true)] };
  appendFileSync(path.join(out, `${process.pid}.jsonl`), `${JSON.stringify(entry)}\n`);
}
