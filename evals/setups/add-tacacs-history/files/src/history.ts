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

export function commandHistory(text: string, options: { year: number }): History {
  throw new Error("commandHistory is not implemented yet");
}
