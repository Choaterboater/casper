export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogRecord {
  /** 1-based line number where the record starts. */
  readonly line: number;
  readonly time: string;
  readonly level: Level;
  /** The `msg` value, or null when absent. Continuation lines are appended with `\n`. */
  readonly message: string | null;
  /** `latency_ms` as a number, or null when absent or not a non-negative number. */
  readonly latencyMs: number | null;
  /** Every other key, as strings. Later duplicates win. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface LogProblem {
  readonly line: number;
  readonly reason: string;
}

export interface ParsedLog {
  readonly records: readonly LogRecord[];
  readonly problems: readonly LogProblem[];
}
