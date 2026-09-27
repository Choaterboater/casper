# invoice-totals

Computes an invoice's line and summary totals from decimal-string quantities, prices, discounts and tax rates.

## Conventions

- `totalInvoice` and `InvoiceError` live in `src/invoice.ts`.
- Minor-unit digits per currency live in `src/currencies.ts`; do not change that table.
- Any problem with the input is collected and thrown together as one `InvoiceError`; there are no other throws.
- Tests live in `tests/`. No runtime dependencies.
