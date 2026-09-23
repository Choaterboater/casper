import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runEvalTask } from "../../evals/runner";

const home = process.argv[2];
const tmp = process.env.TMPDIR;
if (!home || !tmp) throw new Error("missing home or TMPDIR");

let factories = 0;
let thrown = "";
try {
  await runEvalTask({
    id: "missing-fixture",
    fixture: "does-not-exist",
    prompt: "Repair the missing fixture without leaving harness-owned temporary directories.",
    verify: [{ name: "unused", argv: ["unused", "unused"] }],
    candidatePaths: ["src"],
    initialVerification: "fail",
    acceptance: { noEdits: true },
  }, {
    repoRoot: path.resolve(import.meta.dir, "../.."),
    autoVerify: false,
    runtimeFactory: () => {
      factories += 1;
      throw new Error("runtime must not start");
    },
  });
} catch (error) {
  thrown = error instanceof Error ? error.message : String(error);
}

let callerThrown = "";
try {
  await runEvalTask({
    id: "missing-fixture-caller-home",
    fixture: "does-not-exist",
    prompt: "Repair the missing fixture without deleting the caller-supplied home.",
    verify: [{ name: "unused", argv: ["unused", "unused"] }],
    candidatePaths: ["src"],
    initialVerification: "fail",
    acceptance: { noEdits: true },
  }, {
    repoRoot: path.resolve(import.meta.dir, "../.."),
    homeDir: home,
    autoVerify: false,
    runtimeFactory: () => {
      factories += 1;
      throw new Error("runtime must not start");
    },
  });
} catch (error) {
  callerThrown = error instanceof Error ? error.message : String(error);
}

const left = await readdir(tmp);
const keep = await readFile(path.join(home, "keep.txt"), "utf8");
console.log(JSON.stringify({ thrown, callerThrown, left, factories, keep }));
