import { boundedObservation, NotExecutedError } from "../capabilities/result";
import type { RuntimeTool } from "../runtime/types";
import { formatTerminalJSON } from "../tui/json";
import { DEFAULT_WEB, type WebSettings } from "../config/load";
import { webGuidance, type WebLookup } from "./lookup";
import { PROVIDER_LABELS } from "./providers";

/** The /status line: "on (DuckDuckGo) · /settings turns it off". */
export function webStatusLine(settings: WebSettings = DEFAULT_WEB): string {
  return settings.enabled
    ? `on (${PROVIDER_LABELS[settings.provider]}) · /settings turns it off`
    : "off (/settings turns it on)";
}

/** web_search and web_fetch. Both only read, never ask, and run in parallel with other reads. */
export function webTools(lookup: WebLookup, lifetime?: AbortSignal): RuntimeTool[] {
  const signal = (call?: AbortSignal) => {
    const signals = [lifetime, call].filter((entry): entry is AbortSignal => Boolean(entry));
    return signals.length ? AbortSignal.any(signals) : undefined;
  };
  // A failure may carry the server's own words (a header, a TLS name): hidden secrets and the untrusted label, as results get.
  const failed = (error: unknown, fallback: string) => {
    const message = lookup.hideSecrets((error instanceof Error ? error.message : fallback).slice(0, 1024));
    return { isError: true, text: formatTerminalJSON(error instanceof NotExecutedError ? { error: message } : { error: message, guidance: webGuidance() }) };
  };
  // The page text is cut until the whole result fits the observation budget, so it arrives as text, not a cut-off preview.
  const fits = (result: unknown) => "data" in (JSON.parse(boundedObservation(result, "Web page")) as object);
  return [
    {
      name: "web_search",
      description: `Search the web (${lookup.providerLabel}) for current docs, versions, products and error messages. Returns up to 8 results with title, url and snippet; read one with web_fetch. Plain search words only: a query holding a secret is refused. ${webGuidance()}`,
      inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: {
        query: { type: "string", maxLength: 400 }, count: { type: "integer", minimum: 1, maximum: 8 },
      } },
      async execute(args, call) {
        try { return { text: boundedObservation(await lookup.search(args.query, args.count, signal(call)), "Web search") }; }
        catch (error) { return failed(error, "Web search failed"); }
      },
    },
    {
      name: "web_fetch",
      description: `Read one public web page (https; http is upgraded) as plain text, up to 12 KB (a longer page is cut, with a marker). Private, local and cloud-metadata addresses, other ports and non-text files are refused; an address holding a secret is never sent. ${webGuidance()}`,
      inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", maxLength: 2048 } } },
      async execute(args, call) {
        try { return { text: boundedObservation(await lookup.fetch(args.url, signal(call), fits), "Web page") }; }
        catch (error) { return failed(error, "Web fetch failed"); }
      },
    },
  ];
}
