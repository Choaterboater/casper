export class InvalidMacError extends Error {
  constructor(readonly input: string) {
    super(`Invalid MAC address: ${input}`);
    this.name = "InvalidMacError";
  }
}

const FORMS = [/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i, /^([0-9a-f]{2}-){5}[0-9a-f]{2}$/i, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i];

export function normalizeMac(input: string): string {
  const text = input.trim();
  if (!FORMS.some((form) => form.test(text))) throw new InvalidMacError(input);
  return text.replace(/[.:-]/g, "").toLowerCase().match(/../g)!.join(":");
}
