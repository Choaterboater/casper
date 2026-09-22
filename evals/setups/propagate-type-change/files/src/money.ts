/** A plain amount. */
export interface Money {
  readonly amount: number;
}

export function zero(): Money {
  return { amount: 0 };
}

export function add(left: Money, right: Money): Money {
  return { amount: left.amount + right.amount };
}

export function times(money: Money, factor: number): Money {
  return { amount: money.amount * factor };
}

export function format(money: Money): string {
  return money.amount.toFixed(2);
}
