// Invoice balances, capture, fees, and refunds currently use hundredths of a
// currency unit. Only the existing two-decimal clinic currencies have been
// verified through that lifecycle. JPY must not reach Stripe with a x100 amount.
const SUPPORTED_INVOICE_CARD_CURRENCIES = new Set([
  "usd", "gbp", "eur", "cad", "aud",
]);

export function supportsInvoiceCardCurrency(currency?: string | null): boolean {
  return SUPPORTED_INVOICE_CARD_CURRENCIES.has((currency ?? "usd").toLowerCase());
}

export const UNSUPPORTED_INVOICE_CARD_CURRENCY_MESSAGE =
  "Card payments are not available for this invoice currency. Collect payment outside OpenVPM and record it manually.";
