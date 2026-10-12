/** make_picture for the session: offered when Pictures the AI makes is on and something can make one (codex signed in
 * with a ChatGPT plan, or an OpenRouter sign-in). Looked for only when the task wants a picture; codex is asked once. */

import path from "node:path";
import type { CasperApp } from "../app";
import { openNoFollow } from "../platform/files";
import { codexSignedIn, findCodex } from "../pictures/codex";
import { pictureTool } from "../pictures/tool";
import type { RuntimeTool } from "../runtime/types";
import { terminalText } from "../tui/format";
import { ownSecretValues } from "./network-host";
import { appAgentDir, observeEdit } from "./runtime-start";

export async function pictureToolFor(app: CasperApp, wanted: boolean): Promise<RuntimeTool | undefined> {
  if (app.projectContext?.pictures === false) return undefined;
  if (app.pictureTool) return app.pictureTool;
  if (!wanted) return undefined;
  const env = app.pictureSeams?.env ?? process.env;
  const codex = () => app.codexForPictures ??= (async () => {
    const file = findCodex(env);
    return file && await codexSignedIn(file, { env }) ? file : undefined;
  })().catch(() => undefined);
  if (!await codex() && !await signedIn(app, "openrouter", env)
    && !(app.projectContext?.pictureModels?.length && await signedIn(app, "openai", env))) return undefined;
  app.pictureTool = pictureTool({
    root: () => app.activeWorkspaceRoot(),
    request: () => app.lastTaskRequest ?? "",
    sources: {
      codex,
      codexOptions: { env },
      key: async (provider) => await app.session?.providerKey?.(provider),
      get models() { return app.projectContext?.pictureModels ?? []; },
      ...(app.pictureSeams?.fetch ? { fetch: app.pictureSeams.fetch } : {}),
      ...(app.pictureSeams?.urls ? { urls: app.pictureSeams.urls } : {}),
    },
    secrets: () => ownSecretValues(app),
    record: (usage) => app.observations.recordModelCall(usage),
    saved: (file) => observeEdit(app, file),
    shrink: { env },
    background: app.pendingPictures,
  });
  return app.pictureTool;
}

/** The runtime's answer once it runs; before the first task starts it, the key variable or a saved sign-in. */
async function signedIn(app: CasperApp, provider: "openrouter" | "openai", env: NodeJS.ProcessEnv): Promise<boolean> {
  if (app.session?.signedIn) return app.session.signedIn(provider);
  if (env[provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY"]) return true;
  try {
    const file = await openNoFollow(path.join(appAgentDir(app), "auth.json"));
    try {
      if ((await file.stat()).size > 1024 * 1024) return false;
      const saved: unknown = JSON.parse((await file.readFile("utf8")) || "{}");
      return Boolean(saved && typeof saved === "object" && Object.hasOwn(saved, provider));
    } finally { await file.close(); }
  } catch { return false; }
}

/** The end of a request's turn: every picture still being made is finished before the checks run. A failure no tool
 * call was told about is shown, and goes to the model with its next tool result or request. */
export async function settlePictures(app: CasperApp, signal = app.commandAbort?.signal): Promise<void> {
  for (const failure of await app.pendingPictures.settle(signal)) app.output.write(`[picture] ${terminalText(failure)}\n`);
}
