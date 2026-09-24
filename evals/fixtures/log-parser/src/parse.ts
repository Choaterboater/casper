import type { Level, LogProblem, LogRecord, ParsedLog } from "./types";

const HEAD = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) (DEBUG|INFO|WARN|ERROR)(?: (.*))?$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

type Pairs = { pairs: [string, string][] } | { error: string };

/** Split `key=value key="quoted \"value\""` into pairs, or explain why it cannot. */
function pairs(text: string): Pairs {
  const result: [string, string][] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === " ") { index++; continue; }
    const equals = text.indexOf("=", index);
    if (equals < 0) return { error: `expected key=value at column ${index + 1}` };
    const key = text.slice(index, equals);
    if (!KEY.test(key)) return { error: `invalid key ${JSON.stringify(key)}` };
    index = equals + 1;
    let value = "";
    if (text[index] === '"') {
      index++;
      let closed = false;
      while (index < text.length) {
        const character = text[index]!;
        if (character === "\\" && (text[index + 1] === '"' || text[index + 1] === "\\")) { value += text[index + 1]; index += 2; continue; }
        if (character === '"') { closed = true; index++; break; }
        value += character;
        index++;
      }
      if (!closed) return { error: `unterminated quote in ${key}` };
      if (index < text.length && text[index] !== " ") return { error: `unexpected text after ${key}` };
    } else {
      const end = text.indexOf(" ", index);
      value = text.slice(index, end < 0 ? text.length : end);
      if (value.includes('"')) return { error: `stray quote in ${key}` };
      index = end < 0 ? text.length : end;
    }
    result.push([key, value]);
  }
  return { pairs: result };
}

function validTime(time: string): boolean {
  const parsed = new Date(time);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === time.slice(0, 19);
}

export function parseLog(text: string): ParsedLog {
  const records: LogRecord[] = [];
  const problems: LogProblem[] = [];
  let current: { line: number; time: string; level: Level; message: string | null; latencyMs: number | null; fields: Record<string, string> } | undefined;
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return;
    if (/^\s/.test(raw)) {
      if (!current) { problems.push({ line, reason: "continuation without a record" }); return; }
      current.message = current.message === null ? raw.trimStart() : `${current.message}\n${raw.trimStart()}`;
      return;
    }
    current = undefined;
    const head = HEAD.exec(raw);
    if (!head) { problems.push({ line, reason: "missing timestamp or level" }); return; }
    if (!validTime(head[1]!)) { problems.push({ line, reason: "invalid timestamp" }); return; }
    const parsed = pairs(head[3] ?? "");
    if ("error" in parsed) { problems.push({ line, reason: parsed.error }); return; }
    const record = { line, time: head[1]!, level: head[2] as Level, message: null as string | null, latencyMs: null as number | null, fields: {} as Record<string, string> };
    for (const [key, value] of parsed.pairs) {
      if (key === "msg") record.message = value;
      else if (key === "latency_ms") {
        const number = Number(value);
        record.latencyMs = value !== "" && Number.isFinite(number) && number >= 0 ? number : null;
      } else record.fields[key] = value;
    }
    records.push(record);
    current = record;
  });
  return { records, problems };
}
