import { CURRENCY_DIGITS } from "./currencies";

export interface Discount {
  percent?: string;
  amount?: string;
}

export interface Line {
  id: string;
  quantity: string;
  unitPrice: string;
  taxRate?: string;
  discount?: Discount;
  discountable?: boolean;
}

export interface Invoice {
  currency: string;
  taxRate?: string;
  pricesIncludeTax?: boolean;
  discount?: Discount;
  lines: Line[];
}

export interface LineTotals {
  id: string;
  subtotal: string;
  discount: string;
  net: string;
  tax: string;
  total: string;
}

export interface TaxGroup {
  rate: string;
  net: string;
  tax: string;
}

export interface InvoiceTotals {
  lines: LineTotals[];
  subtotal: string;
  discount: string;
  net: string;
  tax: string;
  total: string;
  taxes: TaxGroup[];
}

export interface Issue {
  path: string;
  message: string;
}

export class InvoiceError extends Error {
  issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "InvoiceError";
    this.issues = issues;
  }
}

// ---- decimal-string parsing, all exact bigint arithmetic, no floating point ----

const UNSIGNED = (maxDp: number) => new RegExp(`^(0|[1-9]\\d*)(?:\\.(\\d{1,${maxDp}}))?$`);
const SIGNED = (maxDp: number) => new RegExp(`^(-)?(0|[1-9]\\d*)(?:\\.(\\d{1,${maxDp}}))?$`);

/** Parses a decimal string into an exact integer scaled by 10^maxDp. Rejects malformed text, a leading `+`,
 * whitespace, more than `maxDp` decimal places, and (when `allowNegative` is false) a leading `-`. */
function parseScaled(text: string, maxDp: number, allowNegative: boolean): bigint | null {
  const re = allowNegative ? SIGNED(maxDp) : UNSIGNED(maxDp);
  const match = re.exec(text);
  if (!match) return null;
  if (allowNegative) {
    const negative = match[1] !== undefined;
    const whole = match[2]!;
    const frac = (match[3] ?? "").padEnd(maxDp, "0");
    const magnitude = BigInt(whole + frac);
    return negative ? -magnitude : magnitude;
  }
  const whole = match[1]!;
  const frac = (match[2] ?? "").padEnd(maxDp, "0");
  return BigInt(whole + frac);
}

const PERCENT_DP = 3;
const PERCENT_SCALE = 10n ** BigInt(PERCENT_DP);
const HUNDRED_PERCENT = 100n * PERCENT_SCALE;

/** Parses a percent string (`maxDp` decimal places, sign allowed so out-of-range values are reported as such
 * rather than as a malformed amount) into an integer scaled by 1000 (thousandths of a percent). */
function parsePercentScaled(text: string, maxDp: number): bigint | null {
  const scaled = parseScaled(text, maxDp, true);
  if (scaled === null) return null;
  return scaled * 10n ** BigInt(PERCENT_DP - maxDp);
}

/** Rounds `numerator / denominator` (denominator > 0) to the nearest integer, half to even, on the magnitude,
 * mirrored for a negative numerator. */
function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const twice = remainder * 2n;
  const roundedUp = twice > denominator || (twice === denominator && quotient % 2n === 1n);
  const rounded = roundedUp ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Formats a signed integer number of minor units with exactly `digits` decimal places. A result whose
 * magnitude is zero is always printed without a `-` sign. */
function formatMinor(units: bigint, digits: number): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const text = magnitude.toString().padStart(digits + 1, "0");
  const whole = text.slice(0, text.length - digits);
  const sign = negative && magnitude !== 0n ? "-" : "";
  return digits > 0 ? `${sign}${whole}.${text.slice(-digits)}` : `${sign}${whole}`;
}

/** Formats a thousandths-of-a-percent integer in its shortest decimal form: no trailing zeros, no trailing `.`. */
function formatPercent(milli: bigint): string {
  const whole = milli / PERCENT_SCALE;
  let frac = (milli % PERCENT_SCALE).toString().padStart(PERCENT_DP, "0");
  frac = frac.replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

interface ParsedDiscount {
  /** Own discount, already in the currency's minor units (0 when none or ignored). */
  minor: bigint;
}

function parseDiscount(
  discount: Discount | undefined,
  path: string,
  digits: number,
  subtotalKnown: boolean,
  subtotalMinor: bigint,
  issues: Issue[],
): ParsedDiscount {
  if (!discount) return { minor: 0n };
  const hasPercent = discount.percent !== undefined;
  const hasAmount = discount.amount !== undefined;
  if (hasPercent && hasAmount) {
    issues.push({ path, message: "use percent or amount, not both" });
    return { minor: 0n };
  }
  if (!hasPercent && !hasAmount) return { minor: 0n };
  if (hasPercent) {
    const milli = parsePercentScaled(discount.percent!, 2);
    if (milli === null) {
      issues.push({ path: `${path}.percent`, message: "invalid amount" });
      return { minor: 0n };
    }
    if (milli < 0n || milli > HUNDRED_PERCENT) {
      issues.push({ path: `${path}.percent`, message: "percent out of range" });
      return { minor: 0n };
    }
    if (!subtotalKnown) return { minor: 0n };
    const minor = divRoundHalfEven(subtotalMinor * milli, HUNDRED_PERCENT);
    return { minor };
  }
  // hasAmount
  const minor = parseScaled(discount.amount!, digits, false);
  if (minor === null) {
    issues.push({ path: `${path}.amount`, message: "invalid amount" });
    return { minor: 0n };
  }
  if (subtotalKnown && minor > subtotalMinor) {
    issues.push({ path, message: "exceeds subtotal" });
    return { minor: 0n };
  }
  return { minor };
}

function parseRate(text: string | undefined, path: string, issues: Issue[]): bigint | null {
  if (text === undefined) return null;
  const milli = parsePercentScaled(text, PERCENT_DP);
  if (milli === null) {
    issues.push({ path, message: "invalid amount" });
    return null;
  }
  if (milli < 0n || milli > HUNDRED_PERCENT) {
    issues.push({ path, message: "percent out of range" });
    return null;
  }
  return milli;
}

interface LineWork {
  id: string;
  quantityMinor: bigint | null;
  subtotalMinor: bigint;
  ownDiscountMinor: bigint;
  eligible: boolean;
  rateMilli: bigint;
}

export function totalInvoice(invoice: Invoice): InvoiceTotals {
  const issues: Issue[] = [];
  const digits = CURRENCY_DIGITS[invoice.currency];
  if (digits === undefined) issues.push({ path: "currency", message: `unknown currency ${invoice.currency}` });
  const resolvedDigits = digits ?? 2;

  const invoiceRateMilli = parseRate(invoice.taxRate, "taxRate", issues) ?? 0n;

  // Per-line issues are collected separately so they can be appended after every invoice-level issue
  // (currency, taxRate, discount, lines), regardless of the order code happens to compute them in: the
  // invoice discount's own "exceeds subtotal" check needs the lines' subtotals, which are only known
  // once the lines below have been parsed.
  const lineIssues: Issue[] = [];

  const lineWork: LineWork[] = [];
  invoice.lines.forEach((line, index) => {
    const prefix = `lines[${index}]`;
    const quantityMinor = parseScaled(line.quantity, 3, true);
    if (quantityMinor === null) lineIssues.push({ path: `${prefix}.quantity`, message: "invalid amount" });

    const priceMinor = parseScaled(line.unitPrice, 4, false);
    if (priceMinor === null) lineIssues.push({ path: `${prefix}.unitPrice`, message: "invalid amount" });

    let subtotalMinor = 0n;
    const subtotalKnown = quantityMinor !== null && priceMinor !== null;
    if (subtotalKnown) {
      // quantity is scaled by 10^3, unit price by 10^4: their product is scaled by 10^7. Round that
      // product once to the currency's minor unit; never round the unit price first.
      const product = quantityMinor! * priceMinor!;
      const roundingDivisor = 10n ** BigInt(3 + 4 - resolvedDigits);
      subtotalMinor = divRoundHalfEven(product, roundingDivisor);
    }

    const lineRateMilli = parseRate(line.taxRate, `${prefix}.taxRate`, lineIssues);
    const rateMilli = lineRateMilli ?? invoiceRateMilli;

    const isReturn = quantityMinor !== null && quantityMinor < 0n;
    // A return line's own discount is still validated (malformed/out-of-range/both-fields all still
    // reported) exactly as on any line; only its "exceeds subtotal" check (which needs a sensible,
    // non-negative basis) is skipped and its value is never applied, so subtotalKnown is forced false.
    const parsedDiscount = parseDiscount(
      line.discount,
      `${prefix}.discount`,
      resolvedDigits,
      subtotalKnown && !isReturn,
      subtotalMinor,
      lineIssues,
    );
    const ownDiscountMinor = isReturn ? 0n : parsedDiscount.minor;

    const eligible = line.discountable !== false && quantityMinor !== null && quantityMinor >= 0n;
    lineWork.push({ id: line.id, quantityMinor, subtotalMinor, ownDiscountMinor, eligible, rateMilli });
  });

  // The invoice discount's total is a percent of the eligible lines' amounts after their own
  // discounts (rounded), or a fixed amount; it is then split over those lines in whole minor units
  // by largest remainder, ties to the earlier line, with no further rounding.
  const eligibleBase = lineWork.map((line) => (line.eligible ? line.subtotalMinor - line.ownDiscountMinor : 0n));
  const eligibleBaseSum = eligibleBase.reduce((sum, value) => sum + value, 0n);

  let invoiceDiscountTotal = 0n;
  if (invoice.discount) {
    const parsed = parseDiscount(invoice.discount, "discount", resolvedDigits, true, eligibleBaseSum, issues);
    invoiceDiscountTotal = parsed.minor;
  }

  if (invoice.lines.length === 0) issues.push({ path: "lines", message: "at least one line" });
  issues.push(...lineIssues);

  const invoiceShare = new Array<bigint>(lineWork.length).fill(0n);
  if (invoiceDiscountTotal > 0n && eligibleBaseSum > 0n) {
    const remainders = lineWork.map((line, index) => ({
      index,
      part: (eligibleBase[index]! * invoiceDiscountTotal) / eligibleBaseSum,
      rest: (eligibleBase[index]! * invoiceDiscountTotal) % eligibleBaseSum,
    }));
    for (const { index, part } of remainders) invoiceShare[index] = part;
    let left = invoiceDiscountTotal - remainders.reduce((sum, entry) => sum + entry.part, 0n);
    const order = [...remainders].sort((a, b) => (a.rest === b.rest ? a.index - b.index : b.rest > a.rest ? 1 : -1));
    for (const { index } of order) {
      if (left === 0n) break;
      invoiceShare[index]! += 1n;
      left -= 1n;
    }
  }

  if (issues.length > 0) throw new InvoiceError(issues);

  const computed = lineWork.map((line, index) => {
    const discountMinor = line.ownDiscountMinor + (line.eligible ? invoiceShare[index]! : 0n);
    const netBeforeTax = line.subtotalMinor - discountMinor;
    let netMinor: bigint;
    let taxMinor: bigint;
    if (invoice.pricesIncludeTax) {
      netMinor = divRoundHalfEven(netBeforeTax * HUNDRED_PERCENT, HUNDRED_PERCENT + line.rateMilli);
      taxMinor = netBeforeTax - netMinor;
    } else {
      netMinor = netBeforeTax;
      taxMinor = divRoundHalfEven(netMinor * line.rateMilli, HUNDRED_PERCENT);
    }
    return { id: line.id, rateMilli: line.rateMilli, subtotalMinor: line.subtotalMinor, discountMinor, netMinor, taxMinor };
  });

  const lines: LineTotals[] = computed.map((line) => ({
    id: line.id,
    subtotal: formatMinor(line.subtotalMinor, resolvedDigits),
    discount: formatMinor(line.discountMinor, resolvedDigits),
    net: formatMinor(line.netMinor, resolvedDigits),
    tax: formatMinor(line.taxMinor, resolvedDigits),
    total: formatMinor(line.netMinor + line.taxMinor, resolvedDigits),
  }));

  const sums = { subtotal: 0n, discount: 0n, net: 0n, tax: 0n, total: 0n };
  const byRate = new Map<string, { rateMilli: bigint; net: bigint; tax: bigint }>();
  for (const line of computed) {
    sums.subtotal += line.subtotalMinor;
    sums.discount += line.discountMinor;
    sums.net += line.netMinor;
    sums.tax += line.taxMinor;
    sums.total += line.netMinor + line.taxMinor;
    const key = line.rateMilli.toString();
    const group = byRate.get(key) ?? { rateMilli: line.rateMilli, net: 0n, tax: 0n };
    group.net += line.netMinor;
    group.tax += line.taxMinor;
    byRate.set(key, group);
  }

  const taxes: TaxGroup[] = [...byRate.values()]
    .sort((a, b) => (a.rateMilli < b.rateMilli ? -1 : a.rateMilli > b.rateMilli ? 1 : 0))
    .map((group) => ({
      rate: formatPercent(group.rateMilli),
      net: formatMinor(group.net, resolvedDigits),
      tax: formatMinor(group.tax, resolvedDigits),
    }));

  return {
    lines,
    subtotal: formatMinor(sums.subtotal, resolvedDigits),
    discount: formatMinor(sums.discount, resolvedDigits),
    net: formatMinor(sums.net, resolvedDigits),
    tax: formatMinor(sums.tax, resolvedDigits),
    total: formatMinor(sums.total, resolvedDigits),
    taxes,
  };
}
