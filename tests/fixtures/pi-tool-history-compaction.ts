import { readFile } from "node:fs/promises";
import { PiRuntime } from "../../src/runtime/pi";
import { TOOL_HISTORY_ENTRY } from "../../src/runtime/tool-history";

const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
let runtime = new PiRuntime();
try {
  let session = await runtime.start({ cwd, localModels: false, systemPromptAppend: "Compaction fixture" });
  await session.prompt("Start the task.");
  for (let n = 0; n < 9; n++) await session.prompt("Continue.");
  await session.compact!();
  for (let n = 0; n < 8; n++) await session.prompt("Continue.");
  const info = session.getSessionInfo!();
  const checkpoints = async () => (await readFile(info.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "custom" && entry.customType === TOOL_HISTORY_ENTRY).map((entry) => entry.data);
  const before = await checkpoints();
  await runtime.dispose(); runtime = new PiRuntime();
  session = await runtime.start({ cwd, localModels: false, systemPromptAppend: "Compaction fixture" });
  await session.switchSession!({ cwd, sessionFile: info.sessionFile });
  await session.prompt("Continue after restart.");
  console.log("COMPACTION_RESULT=" + JSON.stringify({ before, after: await checkpoints() }));
} finally { await runtime.dispose(); }
