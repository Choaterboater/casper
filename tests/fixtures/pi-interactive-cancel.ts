import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../../src/runtime/pi";

const runtime = new PiRuntime();
try {
  const session = await runtime.start({ cwd: process.cwd() });
  const controller = new AbortController();
  const checkAuth = ModelRuntime.prototype.checkAuth;
  const hasConfiguredAuth = ModelRuntime.prototype.hasConfiguredAuth;
  // Pass Casper's local selection guard, then force Pi's awaited auth preflight.
  // This models availability changing between the host check and SDK acceptance.
  let snapshots = 0;
  ModelRuntime.prototype.hasConfiguredAuth = function (...args) {
    return snapshots++ === 0 ? hasConfiguredAuth.apply(this, args) : false;
  };
  ModelRuntime.prototype.checkAuth = async function (...args) {
    controller.abort();
    await Bun.sleep(20);
    return checkAuth.apply(this, args);
  };
  try { await session.prompt("CANCELLED_REQUEST_MUST_NOT_REACH_PROVIDER", controller.signal).catch(() => {}); }
  finally {
    ModelRuntime.prototype.checkAuth = checkAuth;
    ModelRuntime.prototype.hasConfiguredAuth = hasConfiguredAuth;
  }
  console.log("CANCELLED=" + controller.signal.aborted);
  await session.prompt("AFTER_CANCEL_SESSION_STILL_USABLE");
} finally { await runtime.dispose(); }
