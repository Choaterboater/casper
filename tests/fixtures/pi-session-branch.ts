import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../../src/runtime/pi";

const [mainCwd, branchCwd] = process.argv.slice(2);
if (!mainCwd || !branchCwd) throw new Error("Expected main and branch cwd arguments");

const runtime = new PiRuntime();
try {
  const session = await runtime.start({ cwd: mainCwd });
  if (!session.getSessionInfo || !session.forkSession || !session.switchSession || !session.appendContext) {
    throw new Error("Pi runtime session branching interface is unavailable");
  }
  await session.appendContext("MAIN_CONTEXT");
  const main = session.getSessionInfo();
  const branch = await session.forkSession({ cwd: branchCwd, name: "experiment", context: "BRANCH_CONTEXT" });
  const opened = SessionManager.open(branch.sessionFile);
  const customMessages = opened.getEntries().filter((entry) => entry.type === "custom_message");
  const switched = await session.switchSession({ cwd: main.cwd, sessionFile: main.sessionFile, context: "RETURN_CONTEXT" });
  console.log(JSON.stringify({
    main,
    branch,
    switched,
    branchName: opened.getSessionName(),
    customMessages: customMessages.map((entry) => entry.type === "custom_message" ? entry.content : undefined),
  }));
} finally {
  await runtime.dispose();
}
