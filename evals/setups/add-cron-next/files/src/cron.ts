export class CronError extends Error {
  constructor(message: string, readonly field: "minute" | "hour" | "day" | "month" | "weekday" | "year" | null) {
    super(message);
    this.name = "CronError";
  }
}

export function nextRun(_expression: string, _after: Date): Date {
  throw new Error("not implemented");
}

export function nextRuns(_expression: string, _after: Date, _count: number): Date[] {
  throw new Error("not implemented");
}
