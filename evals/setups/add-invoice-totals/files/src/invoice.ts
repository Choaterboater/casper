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

export function totalInvoice(_invoice: Invoice): InvoiceTotals {
  void CURRENCY_DIGITS;
  throw new Error("not implemented");
}
