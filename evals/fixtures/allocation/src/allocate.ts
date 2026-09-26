import { MINOR_DIGITS } from "./currencies";

const AMOUNT = /^(-)?(\d+)(?:\.(\d+))?$/;

function digitsOf(currency: string): number {
  if (!Object.prototype.hasOwnProperty.call(MINOR_DIGITS, currency)) throw new RangeError(`unknown currency ${currency}`);
  return MINOR_DIGITS[currency]!;
}

function parse(amount: string, digits: number): bigint {
  const match = AMOUNT.exec(amount);
  if (!match) throw new RangeError(`not an amount: ${amount}`);
  const fraction = match[3] ?? "";
  if (fraction.length > digits) throw new RangeError(`${amount} has more than ${digits} decimal places`);
  const units = BigInt(match[2]! + fraction.padEnd(digits, "0"));
  return match[1] ? -units : units;
}

function format(units: bigint, digits: number): string {
  const negative = units < 0n;
  const text = (negative ? -units : units).toString().padStart(digits + 1, "0");
  const whole = text.slice(0, text.length - digits);
  return `${negative ? "-" : ""}${whole}${digits > 0 ? `.${text.slice(-digits)}` : ""}`;
}

/** Splits `amount` into one part per ratio. Parts add up to `amount` exactly; leftover minor units go to
 * the largest remainders first, ties to the earlier ratio; a negative amount mirrors the positive split. */
export function allocate(amount: string, currency: string, ratios: readonly number[]): string[] {
  const digits = digitsOf(currency);
  if (ratios.length === 0) throw new RangeError("at least one ratio is required");
  for (const ratio of ratios) if (!Number.isSafeInteger(ratio) || ratio <= 0) throw new RangeError(`ratio ${ratio} is not a positive integer`);
  const total = parse(amount, digits);
  const magnitude = total < 0n ? -total : total;
  const weights = ratios.map(BigInt);
  const sum = weights.reduce((a, b) => a + b, 0n);
  const parts = weights.map((weight) => (magnitude * weight) / sum);
  const remainders = weights.map((weight, index) => ({ index, rest: (magnitude * weight) % sum }));
  let left = magnitude - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (const { index } of remainders) {
    if (left === 0n) break;
    parts[index]! += 1n;
    left -= 1n;
  }
  return parts.map((part) => format(total < 0n ? -part : part, digits));
}
