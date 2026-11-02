import { expect, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { pickerCatalog } from "../src/runtime/pi-model-picker";

/**
 * The engine's registerProvider starts its own offline re-read of every provider's list (`void this.refresh({ allowNetwork:
 * false })`). When that re-read reaches its provider reset after /model's network refresh has begun, it supersedes the
 * network refresh without an error: /model said "Model catalogs refreshed." and the new models never showed. The CI
 * flake in pi-picker-coupling.test.ts line 705 (1/30 on macOS) was this race. This engine stand-in makes the offline
 * re-read slow, so the race happens every time.
 */
function engine() {
  let generation = 0;
  const models = new Set<string>(["openai-codex/gpt-6"]);
  const fake = {
    registered: [] as string[],
    async refresh(options: { allowNetwork?: boolean } = {}) {
      if (options.allowNetwork === false) {
        await Bun.sleep(80); // ModelConfig.load, then the reset that supersedes every provider's refresh.
        generation++;
        return { aborted: false, errors: new Map() };
      }
      const mine = ++generation;
      await Bun.sleep(150); // the network fetch
      if (generation === mine) models.add("openai-codex/gpt-9-fixture"); // superseded: dropped, with no error
      return { aborted: false, errors: new Map() };
    },
    registerProvider(id: string) { fake.registered.push(id); void fake.refresh({ allowNetwork: false }); },
    getAvailableSnapshot: () => [...models].map((ref) => ({ provider: ref.split("/")[0]!, id: ref.split("/")[1]!, name: ref })),
    getError: () => undefined,
  };
  return fake;
}

test("a provider registered just before /model's network refresh can't drop it: the new models arrive", async () => {
  const runtime = engine();
  const catalog = pickerCatalog(runtime as unknown as ModelRuntime, async () => { runtime.registerProvider("fixture-local"); return []; });
  await (catalog as unknown as { refreshLocal(): Promise<string[]> }).refreshLocal();
  await catalog.refresh({});
  expect(runtime.getAvailableSnapshot().map((model) => model.id)).toContain("gpt-9-fixture");
});

test("a provider registered while the network refresh runs makes it read again once", async () => {
  const runtime = engine();
  const catalog = pickerCatalog(runtime as unknown as ModelRuntime);
  const refreshing = catalog.refresh({});
  await Bun.sleep(20);
  runtime.registerProvider("fixture-local");
  await refreshing;
  expect(runtime.getAvailableSnapshot().map((model) => model.id)).toContain("gpt-9-fixture");
});
