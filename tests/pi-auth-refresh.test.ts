import { expect, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiModels } from "../src/runtime/pi-models";

for (const available of [false, true]) {
  test(`auth refresh reports success only when the provider is available (${available})`, async () => {
    const catalog = {
      refresh: async () => ({ aborted: false, errors: new Map() }),
      hasConfiguredAuth: () => available,
    } as unknown as ModelRuntime;
    const models = new PiModels(catalog, "/unused", "/unused");
    models.invalidateAuth("claude-subscription");
    expect(await models.refreshAuth("claude-subscription", new AbortController().signal)).toBe(available);
    expect(models.signedIn("claude-subscription")).toBe(available);
  });
}
