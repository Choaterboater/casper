/** make_picture: one picture for the project, from what the user already has. In order: their ChatGPT plan through
 * their own Codex CLI, then a free OpenRouter model (or the models in their own pictures.models). Nothing paid runs on
 * its own: a model the call names is used only when the user's own request names it or their pictures.models lists it
 * (checked here, not left to the model). When nothing makes a picture, the result says so and the model draws SVG. */

import path from "node:path";
import { NotExecutedError } from "../capabilities/result";
import { writeProjectFile } from "../platform/files";
import { isOutside } from "../platform/inside";
import type { RuntimeTool } from "../runtime/types";
import { holdsSecret } from "../secrets/refuse";
import { formatTerminalJSON } from "../tui/json";
import { codexPicture, type CodexOptions } from "./codex";
import { EXTENSIONS, formatOf, imageType, type PictureFormat } from "./format";
import { httpPicture, OPENAI_IMAGES, OPENROUTER_IMAGES } from "./http";
import type { PendingPictures } from "./pending";
import { webSize, type ShrinkOptions } from "./shrink";

/** Free on OpenRouter's images endpoint (its own limits: about 20 a minute, 50 a day without credits bought). */
export const FREE_PICTURE_MODEL = "inclusionai/ming-image-0.1-design";
const CODEX = "ChatGPT plan (Codex)";

export interface PictureSources {
  /** The codex program when it is signed in with a ChatGPT plan (checked once per session), else undefined. */
  codex(signal?: AbortSignal): Promise<string | undefined>;
  codexOptions?: CodexOptions;
  /** The user's own key for openrouter or openai, read when a call needs it; never shown. */
  key(provider: "openrouter" | "openai"): Promise<string | undefined>;
  /** pictures.models in the user's own config: tried after Codex in place of the free model. */
  models: readonly string[];
  fetch?: typeof fetch;
  urls?: { openrouter?: string; openai?: string };
}

export interface MadePicture { bytes: Uint8Array; source: string; tokens: number; /** Dollars; null when not reported. */ cost: number | null }

/** The picture from the first source that makes one, and why each one before it did not. A named model is the only
 * one tried. */
export async function makePicture(request: { prompt: string; format: PictureFormat; model?: string }, sources: PictureSources,
  signal?: AbortSignal): Promise<{ picture?: MadePicture; tried: string[] }> {
  const tried: string[] = [];
  if (request.model) {
    const made = await byModel(request.model, request, sources, signal);
    return "failed" in made ? { tried: [`${request.model}: ${made.failed}`] } : { picture: made, tried };
  }
  const codex = await sources.codex(signal);
  if (codex) {
    const made = await codexPicture(codex, request.prompt, sources.codexOptions, signal);
    if ("bytes" in made) return { picture: { bytes: made.bytes, source: CODEX, tokens: 0, cost: 0 }, tried };
    tried.push(`${CODEX}: ${made.failed}`);
  }
  for (const model of sources.models.length ? sources.models : [FREE_PICTURE_MODEL]) {
    if (signal?.aborted) break;
    const made = await byModel(model, request, sources, signal);
    if (!("failed" in made)) return { picture: made, tried };
    tried.push(`${model}: ${made.failed}`);
  }
  return { tried };
}

/** A gpt-image model goes to OpenAI with your OpenAI key when you have one; every other model goes to OpenRouter. */
async function byModel(model: string, request: { prompt: string; format: PictureFormat }, sources: PictureSources,
  signal?: AbortSignal): Promise<MadePicture | { failed: string }> {
  const bare = model.replace(/^openai\//i, "");
  const openai = /^gpt-image/i.test(bare) ? await sources.key("openai") : undefined;
  const key = openai ?? await sources.key("openrouter");
  if (!key) return { failed: "needs an OpenRouter sign-in (/login openrouter)" };
  const id = openai ? bare : /^gpt-image/i.test(model) ? `openai/${bare}` : model;
  const made = await httpPicture({ url: openai ? sources.urls?.openai ?? OPENAI_IMAGES : sources.urls?.openrouter ?? OPENROUTER_IMAGES,
    key, model: id, prompt: request.prompt, format: request.format, ...(sources.fetch ? { fetch: sources.fetch } : {}), ...(signal ? { signal } : {}) });
  if ("failed" in made) return made;
  const cost = made.cost ?? (id === FREE_PICTURE_MODEL ? 0 : null);
  return { bytes: made.bytes, source: openai ? `OpenAI ${id}` : `OpenRouter ${id}`, tokens: made.tokens, cost };
}

/** Words in a model id that do not tell one model from another. */
const GENERIC = new Set(["image", "images", "preview", "pro", "dev", "fast", "max", "mini", "lite", "beta", "alpha", "edit", "design",
  "model", "gpt", "flash", "turbo", "ultra", "plus", "latest", "openai"]);
const words = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** Whether a model id the call names may run: it is the free model, listed in the user's own pictures.models, or the
 * user's request names it (the id, or its distinctive name such as "flux", "gpt image" or "nano banana"). */
export function modelAllowed(model: string, request: string, configured: readonly string[]): boolean {
  const id = model.toLowerCase();
  if (id === FREE_PICTURE_MODEL || configured.some((listed) => listed.toLowerCase() === id)) return true;
  const said = words(request);
  const bare = id.slice(id.indexOf("/") + 1);
  const names = [id, bare, ...(/^gpt-image/.test(bare) ? ["gpt image"] : []), ...(/^gemini.*image/.test(bare) ? ["nano banana"] : []),
    ...bare.split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && /[a-z]/.test(word) && !GENERIC.has(word)).slice(0, 1)];
  return names.some((name) => said.includes(words(name)));
}

export interface PictureToolOptions {
  root: () => string;
  /** The user's own request for this task: a model the call names must be named there (or in pictures.models). */
  request?: () => string;
  sources: PictureSources;
  /** Casper's own secret values: a description holding one is never sent. */
  secrets: () => readonly string[];
  /** The task's spend: every picture is recorded, $0 ones too; null when the service did not say. */
  record: (usage: { tokens: number; estimatedCost: number } | null) => void;
  /** A picture was written to this absolute path. */
  saved?: (file: string) => void;
  /** How a picture over web size is shrunk (tests point it at fakes). */
  shrink?: ShrinkOptions;
  /** Made in the background: the call returns the path at once, and what would touch the file waits for it. */
  background?: PendingPictures;
}

export const BACKGROUND_NOTE = "generating in the background; it will be there before you read or use it";

/** The project path to save to: inside the project, never under .git, with a picture extension: .jpg unless .png,
 * .webp or .svg (saved as .png) was asked for or the picture is to be transparent. `keepPng`: a shrunk copy stays PNG. */
export function picturePath(root: string, requested: string | undefined, prompt: string): { relative: string; format: PictureFormat; keepPng: boolean } {
  const transparent = /\btransparen/i.test(prompt);
  const fallback = `assets/${prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "picture"}`;
  const relative = path.relative(root, path.resolve(root, (requested?.trim() || fallback).replace(/\.svg$/i, ".png")));
  if (!relative || isOutside(relative) || relative.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) {
    throw new NotExecutedError("the path is outside the project", "Give a path inside the project, such as assets/hero.png.");
  }
  const format = formatOf(relative) ?? (transparent ? "png" : undefined);
  if (format) return { relative: formatOf(relative) ? relative : `${relative}.png`, format, keepPng: format === "png" || transparent };
  return { relative: `${relative}.jpg`, format: "jpeg", keepPng: false };
}

export function pictureTool(options: PictureToolOptions): RuntimeTool {
  return {
    name: "make_picture",
    description: "Make one picture (photo, illustration, hero image) and save it in the project. Uses the user's ChatGPT plan through Codex, else a free model; never a paid one on its own. Returns the path at once; if it fails, draw SVG. Set model only when the user named an image model; it may cost money.",
    inputSchema: { type: "object", additionalProperties: false, required: ["prompt"], properties: {
      prompt: { type: "string", maxLength: 2000, description: "What the picture shows: subject, style, light, colors." },
      path: { type: "string", maxLength: 300, description: "Project path, e.g. assets/hero.jpg (.png for transparency)." },
      model: { type: "string", maxLength: 120, description: "OpenRouter or gpt-image model id, only when the user named one." },
    } },
    async execute(args, signal) {
      try {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) throw new NotExecutedError("no prompt", "Say what the picture shows.");
        const asked = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
        if (asked && !/^[a-z0-9][\w.-]*(?:\/[\w.:-]+)?$/i.test(asked)) throw new NotExecutedError("that is not a model id", "Use an id such as vendor/model-name.");
        const model = asked && modelAllowed(asked, options.request?.() ?? "", options.sources.models) ? asked : undefined;
        const ignored = asked && !model ? { model: `${asked} was not used: a paid model runs only when the user names it or lists it in pictures.models.` } : {};
        if (holdsSecret(prompt, { values: options.secrets() })) throw new NotExecutedError("the prompt holds a secret", "Casper never sends secrets out. Describe the picture without it.");
        const root = options.root();
        const target = picturePath(root, typeof args.path === "string" ? args.path : undefined, prompt);
        const make = async (signal?: AbortSignal) => {
          const { picture, tried } = await makePicture({ prompt, format: target.format, ...(model ? { model } : {}) }, options.sources, signal);
          if (!picture) return { failed: `No picture was made${tried.length ? ` (${tried.join("; ")})` : ""}.`,
            next: model ? "Tell the user why; do not try another paid model unless they ask." : "Draw the art as inline SVG instead." };
          options.record(picture.cost === null ? null : { tokens: picture.tokens, estimatedCost: picture.cost });
          const web = await webSize(picture.bytes, target.keepPng, options.shrink, signal);
          const actual = imageType(web.bytes)!;
          // In the background the path was already promised: the file keeps it (browsers read a picture by its bytes).
          const relative = actual === target.format || options.background ? target.relative : target.relative.replace(/\.[a-z]+$/i, EXTENSIONS[actual]);
          await writeProjectFile(root, relative, web.bytes, { mode: "replace" });
          options.saved?.(path.join(root, relative));
          return { saved: relative.split(path.sep).join("/"), bytes: web.bytes.length, source: picture.source,
            cost: picture.cost === null ? "not reported" : `$${picture.cost.toFixed(picture.cost && picture.cost < 0.01 ? 4 : 2)}`, ...(web.note ? { note: web.note } : {}) };
        };
        const shown = target.relative.split(path.sep).join("/");
        if (options.background) {
          options.background.start(path.join(root, target.relative), shown, async (later) => {
            const made = await make(later);
            if ("failed" in made) throw new Error(`${made.failed} ${made.next}`);
          });
          return { text: formatTerminalJSON({ saving: shown, note: BACKGROUND_NOTE, ...ignored }) };
        }
        const made = await make(signal);
        if ("failed" in made) return { isError: true, text: formatTerminalJSON({ error: made.failed, next: made.next, ...ignored }) };
        return { text: formatTerminalJSON({ ...made, ...ignored }) };
      } catch (error) {
        const message = error instanceof NotExecutedError ? error.message : `Not saved: ${(error as Error)?.message ?? String(error)}`.slice(0, 400);
        return { isError: true, text: formatTerminalJSON({ error: message }) };
      }
    },
  };
}
