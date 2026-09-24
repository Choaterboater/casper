export interface AccountingRecord {
  /** `Mon DD HH:MM:SS` exactly as logged. */
  readonly timestamp: string;
  readonly nas: string;
  readonly user: string;
  readonly port: string;
  readonly remote: string;
  readonly flag: "start" | "stop" | "update";
  readonly attributes: Readonly<Record<string, string>>;
}

const TIMESTAMP = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d\d):(\d\d):(\d\d)$/;

export function parseRecord(line: string): AccountingRecord | string {
  const fields = line.replace(/\r$/, "").split("\t");
  if (fields.length < 6) return "expected at least 6 tab-separated fields";
  const [timestamp, nas, user, port, remote, flag, ...pairs] = fields as [string, string, string, string, string, string, ...string[]];
  if (!TIMESTAMP.test(timestamp)) return `invalid timestamp ${JSON.stringify(timestamp)}`;
  if (flag !== "start" && flag !== "stop" && flag !== "update") return `invalid flag ${JSON.stringify(flag)}`;
  if (!user) return "missing user";
  const attributes: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals < 1) return `invalid attribute ${JSON.stringify(pair)}`;
    attributes[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return { timestamp, nas, user, port, remote, flag, attributes };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Jan  5 10:00:01` in `year` → `2026-01-05T10:00:01Z`; null for an impossible date. */
export function isoTime(timestamp: string, year: number): string | null {
  const match = TIMESTAMP.exec(timestamp);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!);
  const day = Number(match[2]!.trim());
  const date = new Date(Date.UTC(year, month, day, Number(match[3]), Number(match[4]), Number(match[5])));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day || Number(match[3]) > 23 || Number(match[4]) > 59 || Number(match[5]) > 59) return null;
  return date.toISOString().replace(".000Z", "Z");
}
