import { PiRuntime } from "../../src/runtime/pi";

/** Eight requests of about 3,000 tokens each on the loopback model, and the context estimate after each. */
const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
try {
  const session = await runtime.start({ cwd, localModels: false });
  const percents: Array<number | null> = [];
  for (let turn = 0; turn < 8; turn++) {
    await session.prompt(`Request ${turn}: ${Array.from({ length: 1500 }, (_, n) => `word${(n * 7919 + turn) % 997}`).join(" ")}`);
    const percent = session.getUsage!().context?.percent;
    percents.push(percent == null ? null : Math.round(percent));
  }
  console.log("SMALL_WINDOW_RESULT=" + JSON.stringify({ percents }));
} finally { await runtime.dispose(); }
