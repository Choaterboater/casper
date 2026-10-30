import { expect, test } from "bun:test";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { richApp } from "./support/app";
import { withEnv } from "./support/env";

const OFFER = "Casper can set up its network server";

function recordingRuntime(prompts: string[]): AgentRuntime {
  return {
    async start(options): Promise<RuntimeSession> {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: options.cwd, isStreaming: false }),
        subscribe: () => () => {}, abort: async () => {}, setTools: () => {},
        prompt: async (text: string) => { prompts.push(text); },
      };
    },
    async dispose() {},
  };
}

/** A pasted terminal screen that names Mist and an access point: context, not what the person asked. */
const SCREEN = [
  "user@nas ~ % docker logs mist-exporter | tail -3",
  "level=info msg=\"polled Mist org 02-site sites=4 access points=12\"",
  "level=info msg=\"juniper mist api ok\"",
].join("\n");

test("only typed words bring up the network-server offer: a pasted screen naming Mist or a Wi-Fi word does not", () => withEnv({ TERM: "xterm-256color" }, async () => {
  const prompts: string[] = [];
  const f = await richApp(() => recordingRuntime(prompts), {
    networkSeams: { releases: { fetch: async () => Response.json([]) } },
  });
  try {
    await f.until(screen => screen.includes("idle"));
    f.input.write(`\x1b[200~${SCREEN}\x1b[201~ why does this keep restarting\r`);
    await f.until(() => prompts.length === 1);
    expect(prompts[0]).toContain("juniper mist api ok");
    f.input.write("set up a cloudflare tunnel in docker on my NAS for home assistant, wifi devices on my network\r");
    await f.until(() => prompts.length === 2);
    expect(f.screen()).not.toContain(OFFER);
    // A product name the person typed still does.
    f.input.write("list the Mist APs at Branch-12\r");
    await f.until(screen => screen.includes(OFFER));
  } finally { await f.close(); }
}), 30_000);
