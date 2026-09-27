export class CronError extends Error {
  constructor(message: string, readonly field: "minute" | "hour" | "day" | "month" | "weekday" | "year" | null) {
    super(message);
    this.name = "CronError";
  }
}

type FieldName = "minute" | "hour" | "day" | "month" | "weekday" | "year";

type DaySpec = { type: "any" } | { type: "last" } | { type: "set"; values: Set<number> };
type WeekdaySpec = { type: "any" } | { type: "lastWeekday"; weekday: number } | { type: "set"; values: Set<number> };

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  day: DaySpec;
  month: Set<number>;
  weekday: WeekdaySpec;
  year: Set<number> | null;
}

const FIELD_BOUNDS: Record<FieldName, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  day: [1, 31],
  month: [1, 12],
  weekday: [0, 7],
  year: [1970, 2199],
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const WEEKDAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

function fieldError(field: FieldName, message: string): CronError {
  return new CronError(`${field}: ${message}`, field);
}

function parseValue(token: string, field: FieldName): number {
  let n: number | undefined;
  if (field === "month") n = MONTH_NAMES[token.toLowerCase()];
  else if (field === "weekday") n = WEEKDAY_NAMES[token.toLowerCase()];
  if (n === undefined) {
    if (!/^[0-9]+$/.test(token)) throw fieldError(field, `invalid token "${token}"`);
    n = Number(token);
  }
  const [min, max] = FIELD_BOUNDS[field];
  if (n < min || n > max) throw fieldError(field, `${n} out of range ${min}-${max}`);
  return n;
}

function addValue(target: Set<number>, value: number, field: FieldName): void {
  target.add(field === "weekday" && value === 7 ? 0 : value);
}

/** Generic list/range/step parser shared by every field, including the plain-set case of day and weekday. */
function parseGenericSet(text: string, field: FieldName): Set<number> {
  const [min, max] = FIELD_BOUNDS[field];
  const result = new Set<number>();
  for (const item of text.split(",")) {
    let base = item;
    let stepText: string | null = null;
    const slash = item.indexOf("/");
    if (slash !== -1) {
      base = item.slice(0, slash);
      stepText = item.slice(slash + 1);
    }
    let step = 1;
    if (stepText !== null) {
      if (!/^[0-9]+$/.test(stepText) || Number(stepText) === 0) throw fieldError(field, "invalid step");
      step = Number(stepText);
    }
    let start: number;
    let end: number;
    const dash = base.indexOf("-");
    if (base === "*") {
      start = min;
      end = max;
    } else if (dash > 0) {
      start = parseValue(base.slice(0, dash), field);
      end = parseValue(base.slice(dash + 1), field);
    } else if (stepText !== null) {
      start = parseValue(base, field);
      end = max;
    } else {
      addValue(result, parseValue(base, field), field);
      continue;
    }
    if (start <= end) {
      for (let v = start; v <= end; v += step) addValue(result, v, field);
    } else {
      for (let v = start; v <= max; v += step) addValue(result, v, field);
      for (let v = min; v <= end; v += step) addValue(result, v, field);
    }
  }
  return result;
}

function parseDayField(text: string): DaySpec {
  if (text === "*" || text === "?") return { type: "any" };
  if (text === "L") return { type: "last" };
  const items = text.split(",");
  if (items.length > 1 && items.includes("L")) throw fieldError("day", `invalid token "${text}"`);
  return { type: "set", values: parseGenericSet(text, "day") };
}

function parseWeekdayField(text: string): WeekdaySpec {
  if (text === "*" || text === "?") return { type: "any" };
  const items = text.split(",");
  const isLastForm = (item: string) => item.length > 1 && item.endsWith("L");
  if (items.length > 1 && items.some(isLastForm)) throw fieldError("weekday", `invalid token "${text}"`);
  if (items.length === 1 && isLastForm(items[0]!)) {
    const w = parseValue(items[0]!.slice(0, -1), "weekday");
    return { type: "lastWeekday", weekday: w === 7 ? 0 : w };
  }
  return { type: "set", values: parseGenericSet(text, "weekday") };
}

function parseFieldsExpression(trimmed: string): ParsedCron {
  const parts = trimmed.split(/[ \t]+/);
  if (parts.length !== 5 && parts.length !== 6) throw new CronError(`expected 5 or 6 fields, got ${parts.length}`, null);
  const [minuteText, hourText, dayText, monthText, weekdayText, yearText] = parts;
  return {
    minute: parseGenericSet(minuteText!, "minute"),
    hour: parseGenericSet(hourText!, "hour"),
    day: parseDayField(dayText!),
    month: parseGenericSet(monthText!, "month"),
    weekday: parseWeekdayField(weekdayText!),
    year: yearText !== undefined ? parseGenericSet(yearText, "year") : null,
  };
}

function parseExpression(expression: string): ParsedCron {
  const trimmed = expression.trim();
  if (trimmed.startsWith("@")) {
    const expanded = MACROS[trimmed];
    if (expanded === undefined) throw new CronError(`unknown macro ${trimmed}`, null);
    return parseFieldsExpression(expanded);
  }
  return parseFieldsExpression(trimmed);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayMatches(parsed: ParsedCron, year: number, month: number, day: number): boolean {
  const dim = daysInMonth(year, month);
  const dayRestricted = parsed.day.type !== "any";
  const weekdayRestricted = parsed.weekday.type !== "any";
  let dayOk = true;
  if (parsed.day.type === "last") dayOk = day === dim;
  else if (parsed.day.type === "set") dayOk = parsed.day.values.has(day);
  let weekdayOk = true;
  if (parsed.weekday.type !== "any") {
    const actualWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (parsed.weekday.type === "lastWeekday") weekdayOk = actualWeekday === parsed.weekday.weekday && day + 7 > dim;
    else weekdayOk = parsed.weekday.values.has(actualWeekday);
  }
  if (dayRestricted && weekdayRestricted) return dayOk && weekdayOk;
  if (dayRestricted) return dayOk;
  if (weekdayRestricted) return weekdayOk;
  return true;
}

function findNext(parsed: ParsedCron, after: Date): Date {
  const startFloor = Date.UTC(
    after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), after.getUTCHours(), after.getUTCMinutes(),
  );
  const start = startFloor + 60_000;
  const afterYear = after.getUTCFullYear();
  const hours = [...parsed.hour].sort((a, b) => a - b);
  const minutes = [...parsed.minute].sort((a, b) => a - b);

  let candidateYears: number[];
  let limitInstant: number | null = null;
  if (parsed.year) {
    const startYear = new Date(start).getUTCFullYear();
    candidateYears = [...parsed.year].filter((y) => y >= startYear).sort((a, b) => a - b);
    if ([...parsed.year].every((y) => y < afterYear) || candidateYears.length === 0) throw new CronError("never runs", null);
  } else {
    limitInstant = Date.UTC(afterYear + 8, after.getUTCMonth(), after.getUTCDate(), after.getUTCHours(), after.getUTCMinutes());
    const startYear = new Date(start).getUTCFullYear();
    candidateYears = [];
    for (let y = startYear; y <= afterYear + 8; y++) candidateYears.push(y);
  }

  for (const year of candidateYears) {
    for (let month = 1; month <= 12; month++) {
      if (!parsed.month.has(month)) continue;
      const dim = daysInMonth(year, month);
      for (let day = 1; day <= dim; day++) {
        if (!dayMatches(parsed, year, month, day)) continue;
        for (const hour of hours) {
          for (const minute of minutes) {
            const candidate = Date.UTC(year, month - 1, day, hour, minute);
            if (candidate < start) continue;
            if (limitInstant !== null && candidate > limitInstant) throw new CronError("never runs", null);
            return new Date(candidate);
          }
        }
      }
    }
  }
  throw new CronError("never runs", null);
}

function assertValidAfter(after: Date): void {
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) throw new RangeError("invalid after");
}

export function nextRun(expression: string, after: Date): Date {
  assertValidAfter(after);
  const parsed = parseExpression(expression);
  return findNext(parsed, after);
}

export function nextRuns(expression: string, after: Date, count: number): Date[] {
  assertValidAfter(after);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new RangeError("invalid count");
  const parsed = parseExpression(expression);
  const results: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = findNext(parsed, cursor);
    results.push(next);
    cursor = next;
  }
  return results;
}
