/** Pictures over HTTP: OpenRouter's images endpoint (Pi's own image call goes through chat completions, which the
 * free image model does not answer) and OpenAI's, each with the user's own key. */

import { openRouterAttribution } from "../runtime/openrouter-attribution";
import { imageType, MAX_PICTURE_BYTES, type PictureFormat } from "./format";

export const OPENROUTER_IMAGES = "https://openrouter.ai/api/v1/images";
export const OPENAI_IMAGES = "https://api.openai.com/v1/images/generations";
const TIMEOUT_MS = 180_000;

export interface HttpPicture { bytes: Uint8Array; tokens: number; /** Dollars, when the service reported them. */ cost?: number }

export interface HttpPictureRequest {
  url: string;
  key: string;
  model: string;
  prompt: string;
  format: PictureFormat;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** One picture from an OpenAI-style images endpoint (OpenRouter's /images or OpenAI's /images/generations). */
export async function httpPicture(request: HttpPictureRequest): Promise<HttpPicture | { failed: string }> {
  const openRouter = new URL(request.url).hostname === "openrouter.ai";
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(request.signal ? [request.signal] : [])]);
  let response: Response;
  try {
    response = await (request.fetch ?? fetch)(request.url, { method: "POST", signal, redirect: "error",
      headers: { authorization: `Bearer ${request.key}`, "content-type": "application/json", ...(openRouter ? openRouterAttribution() : {}) },
      body: JSON.stringify({ model: request.model, prompt: request.prompt, n: 1, output_format: request.format }) });
  } catch (error) {
    return { failed: request.signal?.aborted ? "cancelled" : (error as Error)?.name === "TimeoutError" ? "took longer than 180 s" : "could not reach the service" };
  }
  const text = await response.text().catch(() => "");
  let body: { data?: Array<{ b64_json?: unknown }>; usage?: { cost?: unknown; total_tokens?: unknown }; error?: { message?: unknown } } = {};
  try { body = JSON.parse(text) as typeof body; } catch { /* reported below */ }
  if (!response.ok) {
    const said = typeof body.error?.message === "string" ? `: ${body.error.message.split(request.key).join("…").replace(/\s+/g, " ").slice(0, 200)}` : "";
    const why = response.status === 402 ? "needs credits" : response.status === 429 ? "limit reached for now" : response.status === 401 ? "the sign-in was refused" : `answered ${response.status}`;
    return { failed: `${why}${said}` };
  }
  const encoded = body.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || encoded.length > MAX_PICTURE_BYTES * 1.4) return { failed: "sent no picture" };
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (!imageType(bytes)) return { failed: "sent something that is not a picture" };
  const tokens = typeof body.usage?.total_tokens === "number" && Number.isFinite(body.usage.total_tokens) ? body.usage.total_tokens : 0;
  const cost = typeof body.usage?.cost === "number" && Number.isFinite(body.usage.cost) && body.usage.cost >= 0 ? body.usage.cost : undefined;
  return { bytes, tokens, ...(cost !== undefined ? { cost } : {}) };
}
