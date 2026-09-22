/** An amount in a named currency. Amounts in different currencies never mix. */
export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export function zero(currency: string): Money {
  return { amount: 0, currency };
}

export function add(left: Money, right: Money): Money {
  if (left.currency !== right.currency) throw new Error(`Currency mismatch: ${left.currency} vs ${right.currency}`);
  return { amount: left.amount + right.amount, currency: left.currency };
}

export function times(money: Money, factor: number): Money {
  return { amount: money.amount * factor, currency: money.currency };
}

export function format(money: Money): string {
  return `${money.amount.toFixed(2)} ${money.currency}`;
}
