import { PiRuntime } from "../../src/runtime/pi";
import type { PromptCacheSetting } from "../../src/runtime/cache";

const [cwd, cache] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
let text = "";
try {
  const session = await runtime.start({ cwd, tools: [], ...(cache ? { cache: cache as PromptCacheSetting } : {}) });
  session.subscribe(event => { if (event.type === "assistant_text_delta") text += event.delta; });
  await session.prompt("Say hello.");
  console.log("CACHE_RESULT=" + JSON.stringify({ text }));
} finally { await runtime.dispose(); }
