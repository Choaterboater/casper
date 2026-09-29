import { PiRuntime } from "../../src/runtime/pi";

/** A real Pi conversation with no model: mark it, add a task's message, rewind. Prints what the branch holds. */
const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Expected a cwd argument");
const runtime = new PiRuntime();
try {
  const session = await runtime.start({ cwd });
  if (!session.appendContext || !session.conversationMark || !session.rewindTo) throw new Error("Pi rewind is unavailable");
  const empty = session.conversationMark();
  await session.appendContext("BEFORE");
  const mark = session.conversationMark();
  await session.appendContext("TASK");
  const leaf = session.conversationMark();
  const moved = await session.rewindTo(mark, "not-the-leaf");
  const rewound = await session.rewindTo(mark, leaf);
  const afterMark = session.conversationMark();
  const branch = (session as unknown as { runtime: { session: { sessionManager: { getBranch(): Array<{ type: string; content?: unknown }> } } } })
    .runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message").map((entry) => entry.content);
  // Two turns back: from after TASK2 to the start mark, past BEFORE.
  await session.appendContext("TASK2");
  const twoBack = await session.rewindTo(empty, session.conversationMark());
  console.log(JSON.stringify({ moved, rewound, same: afterMark === mark, branch, twoBack, backAtStart: session.conversationMark() === empty }));
} finally {
  await runtime.dispose();
}
