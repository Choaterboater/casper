import { expect, test } from "bun:test";
import { cleanPaste, looksRandom, pastedSecrets } from "../src/secrets/pasted";
import { scrubPlainSecrets } from "../src/secrets/files";
import { checkPastedSecrets, removePastedSecrets } from "../src/app/pasted-secrets";

/** A Cloudflare tunnel token's shape (base64 of {"a":…,"t":…,"s":…}); made up, never a real one. */
const TOKEN = "eyJhIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJ0IjoiMTExMTExMTEtMjIyMi0zMzMzLTQ0NDQtNTU1NTU1NTU1NTU1IiwicyI6IlpXWmhhMlZ6WldOeVpYUT0ifQ==";
const RUN = "docker run -d cloudflare/cloudflared:latest tunnel --no-autoupdate run --token";

test("the scrubber hides a tunnel token with no name in front, a whole JWT, and the rest of a token a paste split with a space", () => {
  expect(scrubPlainSecrets(`here ${TOKEN} there`).text).toBe("here <secret hidden> there");
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  expect(scrubPlainSecrets(`Authorization: Bearer ${jwt}`).text).not.toContain("dozjg");
  // Letters typed into the middle of it, then a space: both halves go.
  const garbled = `${RUN} ${TOKEN.slice(0, 40)}asdkjh ${TOKEN.slice(40)}`;
  expect(scrubPlainSecrets(garbled).text).toBe(`${RUN} <secret hidden> <secret hidden>`);
  // On its own line after the flag.
  expect(scrubPlainSecrets(`user@nas ~ % ${RUN}\n${TOKEN}`).text).toBe(`user@nas ~ % ${RUN}\n<secret hidden>`);
});

test("a paste: a token the terminal wrapped onto the next line is found by its random look", () => {
  const wrapped = `${RUN} ${TOKEN.slice(0, 60)}\n${TOKEN.slice(60)}`;
  const cleaned = cleanPaste(wrapped);
  expect(cleaned.text).toBe(`${RUN} <secret hidden>\n<secret hidden>`);
  expect(cleaned.hidden).toBe(2);
});

test("hashes, paths, public keys, npm integrity, temp folders and long names are not secrets", () => {
  for (const text of [
    "commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    "sha256:9b2a1c0d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b",
    "/usr/local/lib/node_modules/some-package-name/dist/index.js",
    "/var/folders/ab/c1d2efgh34ijk5l_mnopq67r0000gn/T/casper-test-Xy12Ab/home",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@laptop",
    "\"integrity\": \"sha512-Q3P7mQq5fN0zXx2kD9q1rU5b1a4mJYk2m3wQvF0nLz0b3o8sX9C9tqGJ7VwY2nKpFZ1lJm5sD6YbN8rQ0Ue2Wg==\"",
    "export function aVeryLongFunctionNameForTheParserThatHandles2Things() {}",
    "This folder holds 64 projects (alpha, beta, gamma-c3, gamma-b3 and 60 more).",
  ]) expect([text, cleanPaste(text).hidden]).toEqual([text, 0]);
  expect(looksRandom("Zx9Qm2Lk7Vb4Np1Rt6Yw3Hs8Jd5Fg0Ca2Ue7Io4")).toBe(true);
});

test("only pasted pieces are read, and the line and its pastes come back with the secret removed", () => {
  const screen = `user@nas ~ % ls\nREADME.md\nuser@nas ~ % ${RUN} ${TOKEN}\nUnable to find image`;
  const typed = "the token TUNNEL_TOKEN=typed-by-me-123 is fine; ";
  const found = pastedSecrets(`${typed}${screen}`, [screen])!;
  expect(found.hidden).toBe(1);
  expect(found.text).toBe(`${typed}user@nas ~ % ls\nREADME.md\nuser@nas ~ % ${RUN} <secret hidden>\nUnable to find image`);
  expect(found.pasted).toEqual([found.text.slice(typed.length)]);
  expect(found.from).toEqual([screen]);
  expect(found.preview).toEqual([`user@nas ~ % ${RUN} <secret hidden>`]);
  expect(pastedSecrets(`${typed}ls -la`, ["ls -la"])).toBeUndefined();
  expect(pastedSecrets(typed, [])).toBeUndefined();
});

test("a run that can't ask, and a line typed during a task, have the secret removed, with one line that says so", async () => {
  const said: string[] = [];
  const app = { interactive: false, closing: false, terminal: { canAsk: false }, output: { write: (text: string) => { said.push(text); } } } as never;
  const paste = `${RUN} ${TOKEN}`;
  expect(await checkPastedSecrets(app, `look: ${paste}`, [paste])).toEqual({ line: `look: ${RUN} <secret hidden>`, pasted: [`${RUN} <secret hidden>`] });
  expect(removePastedSecrets(app, `and ${paste}`, [paste])).toEqual({ line: `and ${RUN} <secret hidden>`, pasted: [`${RUN} <secret hidden>`] });
  expect(said).toEqual(Array(2).fill("[paste] Removed a secret from what you pasted; the AI gets <secret hidden> in its place.\n"));
});
