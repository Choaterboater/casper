/**
 * What an MCP server said about itself: the last lines of its stderr, and plain failure text.
 *
 * Server output is shown to the user only (never to the model), redacted best effort: every known
 * secret value of that server becomes "•••", and redactPreview hides common token shapes.
 *
 * This module never loads the MCP SDK (the manager imports it on the first connection only), so SDK
 * errors are recognised by shape: McpError is "MCP error <code>: …" with a numeric code, and
 * StreamableHTTPError is "Streamable HTTP error: …" with the HTTP status as its code.
 */
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { redactPreview } from "../tui/format";
import { CallClockTimeout, formatDuration, type ClockReason } from "./clock";
import { MissingEnvironmentError } from "./config";

export { MissingEnvironmentError };

export const HIDDEN = "•••";
const MAX_BYTES = 8 * 1024;
const MAX_LINES = 40;
const LINE_CHARS = 200;
const MIN_SECRET = 4;

/** Replace every known secret (4+ chars, longest first) with "•••". */
export function hideSecrets(text: string, secrets: readonly string[] = []): string {
  const known = [...new Set(secrets.filter((value) => typeof value === "string" && value.length >= MIN_SECRET))]
    .sort((a, b) => b.length - a.length);
  for (const secret of known) text = text.split(secret).join(HIDDEN);
  return text;
}

/** Full redaction for one line of server text: secrets, terminal controls, token shapes, then secrets again. */
export function redactServerText(text: string, secrets: readonly string[] = [], maxChars = LINE_CHARS): string {
  const safe = hideSecrets(redactPreview(hideSecrets(text, secrets)), secrets);
  return safe.length > maxChars ? `${safe.slice(0, maxChars - 1)}…` : safe;
}

/**
 * Ring buffer of the last 8 KiB / 40 lines of a stream. Attaching puts the stream in flowing mode,
 * so the pipe always drains and a chatty server never blocks on a full stderr.
 */
export class ServerOutput {
  private readonly lines: string[] = [];
  private bytes = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");
  private stream?: Readable;
  private readonly onData = (chunk: Buffer | string) => this.push(chunk);
  private readonly onError = () => { /* A broken stderr pipe is not a server failure. */ };

  constructor(private readonly maxBytes = MAX_BYTES, private readonly maxLines = MAX_LINES) {}

  attach(stream: Readable | null | undefined): this {
    if (!stream || stream === this.stream) return this;
    this.detach();
    this.stream = stream;
    stream.on("data", this.onData);
    stream.on("error", this.onError);
    stream.resume();
    return this;
  }

  detach(): void {
    const stream = this.stream;
    if (!stream) return;
    this.stream = undefined;
    stream.off("data", this.onData);
    // Keep draining and keep an error listener, so the child never blocks and no error goes unhandled.
    stream.resume();
  }

  push(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const parts = (this.partial + text).split(/\r?\n|\r/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.add(line);
    if (Buffer.byteLength(this.partial) > this.maxBytes) {
      // One endless line: keep its end, marked as cut.
      this.partial = `…${this.partial.slice(-Math.floor(this.maxBytes / 4))}`;
    }
  }

  /** Raw kept lines (including an unfinished last line). Not redacted: never show these directly. */
  raw(): string[] {
    return this.partial ? [...this.lines, this.partial] : [...this.lines];
  }

  clear(): void {
    this.lines.length = 0;
    this.bytes = 0;
    this.partial = "";
    this.decoder = new StringDecoder("utf8");
  }

  /** Last n non-empty lines, redacted and cut to 200 chars each. Safe to show to the user. */
  tail(n = 8, secrets: readonly string[] = []): string[] {
    if (n <= 0) return [];
    return this.raw().filter((line) => line.trim()).slice(-n).map((line) => redactServerText(line, secrets));
  }

  private add(line: string): void {
    const size = Buffer.byteLength(line) + 1;
    if (size > this.maxBytes) line = `…${line.slice(-Math.floor(this.maxBytes / 4))}`;
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line) + 1;
    while (this.lines.length > this.maxLines || (this.bytes > this.maxBytes && this.lines.length > 1)) {
      this.bytes -= Buffer.byteLength(this.lines.shift()!) + 1;
    }
  }
}

export type FailurePhase = "start" | "call";

export interface FailureContext {
  phase: FailurePhase;
  /** Server name, used in model-facing call text. */
  server?: string;
  /** Command of a stdio server, for "Command not found". */
  command?: string;
  /** Resolved secret values of this server, hidden from any server text. */
  secrets?: readonly string[];
  /** Start limit in ms, for "No answer in N s while starting." */
  connectMs?: number;
  /** The start deadline passed. */
  timedOut?: boolean;
  /** The server process ended. exitCode is left out when it is unknown (null/undefined). */
  exited?: boolean;
  exitCode?: number | null;
  /** Call clock state, for call failures. */
  clockReason?: ClockReason;
  idleMs?: number;
  hardMs?: number;
  lastProgress?: string;
  /** The caller (user or task) cancelled the call. */
  cancelled?: boolean;
  /** Extra scrubbing of server text before it is shortened and put into a sentence (model-facing call text). */
  scrub?: (text: string) => string;
}

/** "(exit code N)" or nothing when the code is unknown. */
function exitPart(code: number | null | undefined): string {
  return typeof code === "number" ? ` (exit code ${code})` : "";
}

/** Status text after a ready server went away. */
export function stoppedMessage(exitCode?: number | null): string {
  return `The server stopped${exitPart(exitCode)}. Next task may restart it.`;
}

/** JSON-RPC error codes used by the MCP SDK (sdk types.js ErrorCode). */
const ErrorCode = { ConnectionClosed: -32000, RequestTimeout: -32001, InvalidRequest: -32600 } as const;

type McpError = Error & { code: number };

/** Text of an McpError without the SDK's "MCP error -32602: " prefix. */
function mcpMessage(error: McpError): string {
  // A server built on the SDK sends its own "MCP error N: …" text, which the client wraps again.
  return error.message.replace(/^(?:MCP error -?\d+:\s*)+/, "");
}

function isMcpError(error: unknown): error is McpError {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "number"
    && (error.name === "McpError" || /^MCP error -?\d+:/.test(error.message));
}

function httpError(error: unknown): { status: number; body: string } | undefined {
  const matches = (error instanceof Error && typeof (error as { code?: unknown }).code === "number" && error.message.startsWith("Streamable HTTP error: "));
  if (!matches) return undefined;
  const status = (error as unknown as { code: number }).code;
  const text = (error as Error).message.replace(/^Streamable HTTP error: /, "");
  const body = text.startsWith("Error POSTing to endpoint:") ? text.slice("Error POSTing to endpoint:".length).trim() : text.trim();
  return { status, body };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Where a call failure came from, for deciding whether the connection is still good. */
export type CallErrorKind =
  /** The call never reached the server (the SDK refused it first). */
  | "not-sent"
  /** The server answered with a JSON-RPC error (or its answer failed a client check); the connection is fine. */
  | "server-answered"
  /** Timeout, cancel, closed connection or transport failure: release the connection. */
  | "transport";

export function classifyCallError(error: unknown): CallErrorKind {
  if (!isMcpError(error)) return "transport";
  if (error.code === ErrorCode.RequestTimeout) return "transport";
  if (error.code === ErrorCode.ConnectionClosed && mcpMessage(error) === "Connection closed") return "transport";
  // client/index.js: task-only tools are refused before anything is sent.
  if (error.code === ErrorCode.InvalidRequest && /requires task-based execution/.test(error.message)) return "not-sent";
  return "server-answered";
}

const DO_NOT_RETRY = "It may have run. Do not retry on your own; tell the user.";

/**
 * Plain failure text. phase "start" gives the /mcp status line (user only). phase "call" gives the
 * text the model sees for a failed call; server text in it is redacted and kept short.
 */
export function describeFailure(error: unknown, context: FailureContext): string {
  const secrets = context.secrets ?? [];
  const server = context.server ?? "The server";
  // Scrub each piece of server text on its own, so a hidden value never swallows the sentence around it.
  const serverText = (text: string, maxChars: number) => {
    const redacted = redactServerText(text, secrets, Number.MAX_SAFE_INTEGER);
    const safe = context.scrub ? context.scrub(redacted) : redacted;
    return safe.length > maxChars ? `${safe.slice(0, maxChars - 1)}…` : safe;
  };
  if (error instanceof MissingEnvironmentError) return error.message;
  if (errorCode(error) === "ENOENT") {
    const command = context.command ?? (error as { path?: unknown }).path;
    return typeof command === "string" && command ? `Command not found: ${redactServerText(command, secrets)}` : "Command not found.";
  }
  const http = httpError(error);
  if (http) {
    const body = http.body ? `: ${serverText(http.body.replace(/\s+/g, " "), 300)}` : "";
    // A failed POST of a call may still have been acted on: the model is told not to retry.
    if (context.phase === "call") return `${server} said HTTP ${http.status}${body}. ${DO_NOT_RETRY}`;
    return `The server said HTTP ${http.status}${body || "."}`;
  }

  if (context.phase === "call") {
    const clock = error instanceof CallClockTimeout ? error : undefined;
    const reason = context.clockReason ?? clock?.reason;
    if (reason === "hard") {
      return `${server} was still working after ${formatDuration(context.hardMs ?? clock?.limitMs ?? 0)} and was stopped. ${DO_NOT_RETRY}`;
    }
    if (reason === "idle") {
      const limit = context.idleMs ?? clock?.limitMs ?? 0;
      const progress = context.lastProgress ? ` Last progress: ${serverText(context.lastProgress, 120)}.` : "";
      return `No answer from ${server} in ${formatDuration(limit)}. ${DO_NOT_RETRY}${progress}`;
    }
    if (context.cancelled) return `The call to ${server} was cancelled. It may have run. Do not retry on your own; tell the user.`;
    if (context.exited) return `${server} stopped during the call${exitPart(context.exitCode)}. ${DO_NOT_RETRY}`;
    if (isMcpError(error) && classifyCallError(error) === "server-answered") {
      return `${server} returned an error: ${serverText(mcpMessage(error), 500)}. It may or may not have run.`;
    }
    return `The call to ${server} failed. ${DO_NOT_RETRY}`;
  }

  if (context.exited) return `The server stopped while starting${exitPart(context.exitCode)}.`;
  if (context.timedOut || error instanceof CallClockTimeout || (isMcpError(error) && error.code === ErrorCode.RequestTimeout)) {
    return context.connectMs ? `No answer in ${formatDuration(context.connectMs)} while starting.` : "No answer while starting.";
  }
  if (isMcpError(error)) {
    if (error.code === ErrorCode.ConnectionClosed) return "The server stopped while starting.";
    return `The server returned an error while starting: ${redactServerText(mcpMessage(error), secrets)}`;
  }
  const code = errorCode(error);
  if (code === "EACCES") return "Cannot run the server command (permission denied).";
  if (code === "ECONNREFUSED" || code === "ConnectionRefused") return "Could not reach the server (connection refused).";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Could not find the server address.";
  if (error instanceof Error && error.message) return `Could not start the server: ${redactServerText(error.message, secrets)}`;
  return "Could not start the server.";
}

/** Status lines for /mcp: the failure, then "Last lines from the server:" and each line as "    | …". */
export function failureLines(error: string, output: readonly string[]): string[] {
  if (!output.length) return [error];
  return [error, "Last lines from the server:", ...output.map((line) => `    | ${line}`)];
}
