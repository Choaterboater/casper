export interface CsvOptions {
  /** One character; default ",". Must differ from the quote character, "\n" and "\r". */
  readonly delimiter?: string;
  /** One character; default '"'. Must differ from the delimiter, "\n" and "\r". */
  readonly quote?: string;
  /** When true, the first non-skipped row names the columns and later rows are objects. Default false. */
  readonly header?: boolean;
  /** When true, spaces and tabs around an unquoted field are removed. Default false. */
  readonly trim?: boolean;
  /** A line whose first character matches this is skipped entirely. */
  readonly comment?: string;
  /** Column name -> conversion. Requires header: true. */
  readonly columns?: Record<string, "number" | "boolean" | "date">;
}

export interface CsvProblem {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface CsvResult {
  readonly rows: (string[] | Record<string, unknown>)[];
  readonly problems: CsvProblem[];
}

const NUMBER_RE = /^-?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WS_LEAD_TRAIL = /^[ \t]+|[ \t]+$/g;
const WS_TRAIL = /[ \t]+$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidDate(raw: string): boolean {
  const match = DATE_RE.exec(raw);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

function buildHeaderNames(rawFields: readonly string[]): string[] {
  const trimmed = rawFields.map((field) => field.replace(WS_LEAD_TRAIL, ""));
  const named = trimmed.map((name, index) => (name === "" ? `column${index + 1}` : name));
  const seen = new Map<string, number>();
  const result: string[] = [];
  for (const name of named) {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    result.push(count === 0 ? name : `${name}_${count + 1}`);
  }
  return result;
}

interface Position {
  readonly line: number;
  readonly column: number;
}

export function readCsv(text: string, options: CsvOptions = {}): CsvResult {
  const delimiter = options.delimiter ?? ",";
  const quote = options.quote ?? "\"";
  const header = options.header ?? false;
  const trim = options.trim ?? false;
  const comment = options.comment;
  const columns = options.columns;

  if (delimiter.length !== 1 || delimiter === quote || delimiter === "\n" || delimiter === "\r") {
    throw new RangeError("invalid delimiter");
  }
  if (quote.length !== 1 || quote === delimiter || quote === "\n" || quote === "\r") {
    throw new RangeError("invalid quote");
  }
  if (columns !== undefined && header !== true) {
    throw new RangeError("columns requires header");
  }

  let source = text;
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

  let pos = 0;
  let line = 1;
  let col = 1;
  const length = source.length;

  /** Consumes one logical unit: "\r\n" or "\n" as a single terminator (advancing the line), or one
   * ordinary character (including a lone "\r", which is data, not a terminator). Returns what was consumed. */
  function advance(): string {
    const ch = source[pos]!;
    if (ch === "\r" && source[pos + 1] === "\n") {
      pos += 2;
      line += 1;
      col = 1;
      return "\r\n";
    }
    if (ch === "\n") {
      pos += 1;
      line += 1;
      col = 1;
      return "\n";
    }
    pos += 1;
    col += 1;
    return ch;
  }

  function atTerminatorOrDelimiter(): boolean {
    if (pos >= length) return true;
    const ch = source[pos];
    if (ch === delimiter) return true;
    if (ch === "\n") return true;
    if (ch === "\r" && source[pos + 1] === "\n") return true;
    return false;
  }

  const problems: CsvProblem[] = [];
  const rows: (string[] | Record<string, unknown>)[] = [];
  let headerNames: string[] | null = null;

  while (pos < length) {
    // Find the end of the next physical line (without consuming) to test for blank/comment lines.
    let lookahead = pos;
    while (lookahead < length && !(source[lookahead] === "\n" || (source[lookahead] === "\r" && source[lookahead + 1] === "\n"))) {
      lookahead++;
    }
    const lineContent = source.slice(pos, lookahead);
    const isBlank = /^[ \t]*$/.test(lineContent);
    const isComment = comment !== undefined && lineContent.length > 0 && lineContent[0] === comment;
    if (isBlank || isComment) {
      while (pos < lookahead) advance();
      if (pos < length) advance();
      continue;
    }

    const rowLine = line;
    const fields: string[] = [];
    const fieldPositions: Position[] = [];
    let rowDropped = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const fieldStart: Position = { line, column: col };
      if (trim) {
        while (pos < length && (source[pos] === " " || source[pos] === "\t")) advance();
      }

      const isQuoted = pos < length && source[pos] === quote;
      let value: string;

      if (isQuoted) {
        const openPos: Position = { line, column: col };
        advance(); // opening quote
        let buffer = "";
        let closed = false;
        while (pos < length) {
          const ch = source[pos];
          if (ch === quote) {
            if (source[pos + 1] === quote) {
              buffer += quote;
              advance();
              advance();
              continue;
            }
            advance(); // closing quote
            closed = true;
            break;
          }
          if (ch === "\\") {
            const next = source[pos + 1];
            if (next === quote) {
              buffer += quote;
              advance();
              advance();
              continue;
            }
            if (next === "\\") {
              buffer += "\\";
              advance();
              advance();
              continue;
            }
            buffer += "\\";
            advance();
            continue;
          }
          buffer += advance();
        }
        if (!closed) {
          problems.push({ line: openPos.line, column: openPos.column, message: "unterminated quote" });
          rowDropped = true;
          break;
        }
        if (trim) {
          while (pos < length && (source[pos] === " " || source[pos] === "\t")) advance();
        }
        let trailing = "";
        let trailingStart: Position | null = null;
        while (!atTerminatorOrDelimiter()) {
          if (trailingStart === null) trailingStart = { line, column: col };
          trailing += advance();
        }
        if (trailing !== "") {
          problems.push({ line: trailingStart!.line, column: trailingStart!.column, message: "text after closing quote" });
        }
        value = buffer;
      } else {
        let buffer = "";
        while (!atTerminatorOrDelimiter()) buffer += advance();
        if (trim) buffer = buffer.replace(WS_TRAIL, "");
        value = buffer;
      }

      fields.push(value);
      fieldPositions.push(fieldStart);

      if (pos < length && source[pos] === delimiter) {
        advance();
        continue;
      }
      if (pos < length) advance(); // row terminator
      break;
    }

    if (rowDropped) continue;

    if (header && headerNames === null) {
      headerNames = buildHeaderNames(fields);
      if (columns) {
        const known = new Set(headerNames);
        for (const name of Object.keys(columns)) {
          if (!known.has(name)) {
            problems.push({ line: rowLine, column: 1, message: `unknown column ${name}` });
          }
        }
      }
      continue;
    }

    if (header && headerNames !== null) {
      if (fields.length > headerNames.length) {
        const extra = fieldPositions[headerNames.length]!;
        problems.push({ line: extra.line, column: extra.column, message: "too many fields" });
      }
      const record: Record<string, unknown> = {};
      for (let i = 0; i < headerNames.length; i++) {
        record[headerNames[i]!] = i < fields.length ? fields[i]! : null;
      }
      if (columns) {
        for (const [name, type] of Object.entries(columns)) {
          const index = headerNames.indexOf(name);
          if (index === -1 || index >= fields.length) continue;
          const raw = fields[index]!;
          if (raw === "") {
            record[name] = null;
            continue;
          }
          const at = fieldPositions[index]!;
          if (type === "number") {
            if (NUMBER_RE.test(raw)) record[name] = Number(raw.replace(/_/g, ""));
            else problems.push({ line: at.line, column: at.column, message: `not a number in column ${name}` });
          } else if (type === "boolean") {
            const lower = raw.toLowerCase();
            if (lower === "true" || lower === "yes" || lower === "1") record[name] = true;
            else if (lower === "false" || lower === "no" || lower === "0") record[name] = false;
            else problems.push({ line: at.line, column: at.column, message: `not a boolean in column ${name}` });
          } else if (type === "date") {
            if (!isValidDate(raw)) problems.push({ line: at.line, column: at.column, message: `not a date in column ${name}` });
          }
        }
      }
      rows.push(record);
      continue;
    }

    rows.push(fields);
  }

  problems.sort((a, b) => (a.line - b.line) || (a.column - b.column));
  return { rows, problems };
}
