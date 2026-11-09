import { PiRuntime } from "../../src/runtime/pi";

const [cwd, mode] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
try {
  const session = await runtime.start({ cwd, localModels: false, systemPromptAppend: "Follow-up fixture", hideToolOutput: () => true });
  await session.prompt("Start the synthetic build.");
  for (let n = 0; n < 5; n++) await session.prompt("Continue.");
  // The round Casper starts itself (a review); plain mode sends the same text as an ordinary prompt.
  await session.prompt("Casper review round.", undefined, { request: "Start the synthetic build.", followUp: mode !== "plain" });
  await session.prompt("Continue after the review.");
  console.log("FOLLOW_UP_RESULT=done");
} finally { await runtime.dispose(); }
