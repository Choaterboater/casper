export interface CsvOptions {
  delimiter?: string;
  quote?: string;
  header?: boolean;
  trim?: boolean;
  comment?: string;
  columns?: Record<string, "number" | "boolean" | "date">;
}

export interface CsvProblem {
  line: number;
  column: number;
  message: string;
}

export interface CsvResult {
  rows: (string[] | Record<string, unknown>)[];
  problems: CsvProblem[];
}

export function readCsv(_text: string, _options?: CsvOptions): CsvResult {
  throw new Error("not implemented");
}
