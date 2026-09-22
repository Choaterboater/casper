import { PiRuntime } from "../../src/runtime/pi";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "../../src/runtime/types";

const [cwd, mode] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const controller = new AbortController();
const events: RuntimeEvent[] = [];
try {
  const session = await runtime.startReadOnly({
    cwd, signal: controller.signal,
    maxTurns: mode === "turns" || mode === "length" ? 2 : 12,
    maxToolCalls: mode === "calls" ? 3 : 48,
    systemPromptAppend: "Casper read-only adapter acceptance fixture",
  });
  session.subscribe((event) => {
    events.push(event);
    if (mode === "cancel" && event.type === "assistant_text_delta") controller.abort();
  });
  let replaceBlocked = false;
  try { session.setTools?.([]); } catch { replaceBlocked = true; }
  const checkAuth = ModelRuntime.prototype.checkAuth;
  const hasConfiguredAuth = ModelRuntime.prototype.hasConfiguredAuth;
  if (mode === "preflight-cancel") {
    // Casper checks its local snapshot synchronously; expire it before Pi's
    // asynchronous auth preflight, not before Casper authorizes the request.
    queueMicrotask(() => { ModelRuntime.prototype.hasConfiguredAuth = () => false; });
    ModelRuntime.prototype.checkAuth = async function (...args) {
      controller.abort();
      await Promise.resolve();
      return checkAuth.apply(this, args);
    };
  }
  try { await session.prompt("Inspect fixture.txt; report evidence, no changes.").catch(() => {}); }
  finally { ModelRuntime.prototype.checkAuth = checkAuth; ModelRuntime.prototype.hasConfiguredAuth = hasConfiguredAuth; }
  console.log("READONLY_RESULT=" + JSON.stringify({ events, replaceBlocked, cancelled: controller.signal.aborted }));
} finally { await runtime.dispose(); }
