/** Currency formatting used by every receipt and report. */
export function formatCurrency(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(cents));
  const units = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  return `${sign}${currency} ${units}.${remainder}`;
}
