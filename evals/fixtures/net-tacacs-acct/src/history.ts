import { isoTime, parseRecord, type AccountingRecord } from "./record";

export interface CommandEntry {
  readonly time: string;
  readonly nas: string;
  readonly port: string;
  readonly remote: string;
  readonly command: string;
  readonly privLevel: number | null;
  readonly elapsedSeconds: number | null;
  readonly status: "completed" | "stop-only" | "no-stop";
}

export interface History {
  readonly users: Record<string, CommandEntry[]>;
  readonly problems: { line: number; reason: string }[];
}

const number = (text: string | undefined) => {
  if (text === undefined || text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

export function commandHistory(text: string, options: { year: number }): History {
  const problems: History["problems"] = [];
  const entries: { user: string; order: number; entry: CommandEntry }[] = [];
  const open = new Map<string, { user: string; order: number; record: AccountingRecord; time: string }>();
  const push = (user: string, order: number, entry: CommandEntry) => entries.push({ user, order, entry });
  const fromStart = (start: { record: AccountingRecord; time: string }, status: CommandEntry["status"], elapsed: number | null): CommandEntry => ({
    time: start.time, nas: start.record.nas, port: start.record.port, remote: start.record.remote,
    command: start.record.attributes.cmd!.replace(/\s*<cr>\s*$/, "").trim(),
    privLevel: number(start.record.attributes["priv-lvl"]), elapsedSeconds: elapsed, status,
  });
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const record = parseRecord(line);
    if (typeof record === "string") { problems.push({ line: index + 1, reason: record }); return; }
    const time = isoTime(record.timestamp, options.year);
    if (!time) { problems.push({ line: index + 1, reason: "impossible date" }); return; }
    if (record.attributes.cmd === undefined || record.flag === "update") return;
    const key = `${record.nas}\u0000${record.attributes.task_id ?? ""}`;
    if (record.flag === "start") {
      const previous = open.get(key);
      if (previous) push(previous.user, previous.order, fromStart(previous, "no-stop", null));
      open.set(key, { user: record.user, order: index, record, time });
      return;
    }
    const start = open.get(key);
    const elapsed = number(record.attributes.elapsed_time);
    if (start) {
      open.delete(key);
      push(start.user, start.order, fromStart(start, "completed", elapsed));
    } else {
      push(record.user, index, { ...fromStart({ record, time }, "stop-only", elapsed) });
    }
  });
  for (const start of open.values()) push(start.user, start.order, fromStart(start, "no-stop", null));
  const users: Record<string, CommandEntry[]> = {};
  entries.sort((left, right) => left.entry.time.localeCompare(right.entry.time) || left.order - right.order);
  for (const { user, entry } of entries) (users[user] ??= []).push(entry);
  return { users, problems };
}
