import { readFile } from "node:fs/promises";
import { PiRuntime } from "../../src/runtime/pi";

const [cwd, mode] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
let enabled = mode !== "off";
let runtime = new PiRuntime();
try {
  let session = await runtime.start({ cwd, localModels: false, systemPromptAppend: "History projection fixture", hideToolOutput: () => enabled });
  await session.prompt("Start the synthetic task.");
  const mark = session.conversationMark!();
  for (let n = 0; n < 9; n++) await session.prompt("Continue.");
  const info = session.getSessionInfo!();
  const raw = await readFile(info.sessionFile, "utf8");
  enabled = false;
  await session.prompt("Continue with hiding off.");
  for (let n = 0; n < 4; n++) await session.prompt("Continue while off.");
  const fork = await session.forkSession!({ cwd, name: "fixture fork" });
  await session.prompt("Continue in the fork.");
  await session.switchSession!({ cwd, sessionFile: info.sessionFile });
  await session.prompt("Continue after resume.");
  // Reconstruct the runtime too: masks are saved branch data, not a process-only cache.
  await runtime.dispose();
  runtime = new PiRuntime();
  session = await runtime.start({ cwd, localModels: false, systemPromptAppend: "History projection fixture", hideToolOutput: () => enabled });
  await session.switchSession!({ cwd, sessionFile: info.sessionFile });
  await session.prompt("Continue after restart.");
  const rewound = await session.rewindTo!(mark, session.conversationMark!());
  await session.prompt("Continue after rewind.");
  console.log("HISTORY_RESULT=" + JSON.stringify({ rawHasOriginal: raw.includes("SYNTHETIC_HISTORY_LINE"),
    rawHasMasks: raw.includes("casper.tool-history"), forked: fork.sessionId !== info.sessionId, rewound }));
} finally { await runtime.dispose(); }
