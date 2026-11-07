// The `plan` option an ACP app shows (decision 84): /plan on's switch, so every request gets a plan first. It is an
// option and not a session mode: the modes are the access chip's (decision 82), and planning first is no access level.

import type { CasperApp } from "../app";
import { RpcFailure, RPC, type Json } from "./rpc";

/** The parts of the app the option reads and sets. */
export type PlanHost = Partial<Pick<CasperApp, "planMode">> & { updateFooter?(): void };

/** The `plan` config option, before the access mode. No category: no app's own picker takes it for something else. */
export function planOption(app: PlanHost, hide: (text: string) => string): Json {
  return { id: "plan", name: hide("Plan first"), type: "select", currentValue: app.planMode === true ? "on" : "off",
    options: [{ value: "off", name: hide("Off") },
      { value: "on", name: hide("Plan first"), description: hide("every request gets a plan first; nothing is built until you choose Build") }] };
}

/** Sets /plan on or off as the app picked it; a refused value changes nothing. `write` gets the line, on Casper's
 * transcript (stderr), when it changed. */
export function setPlanOption(app: PlanHost, value: unknown, write: (text: string) => void): void {
  if (value !== "on" && value !== "off") throw new RpcFailure(RPC.invalidParams, "plan takes off or on");
  const on = value === "on";
  if (app.planMode === on) return;
  app.planMode = on;
  app.updateFooter?.();
  write(on ? "[plan] The app set Plan first: every request gets a plan first. /plan off ends it.\n" : "[plan] The app set Plan first off.\n");
}
