/** RFC 4180: quote a field containing a comma, quote, CR or LF; double embedded quotes. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function csvRow(values: readonly string[]): string {
  return values.map(csvField).join(",");
}
