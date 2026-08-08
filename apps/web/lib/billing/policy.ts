import { moneyToCents } from "./invoice-balance";

export const BILLING_INVOICE_LINE_DESCRIPTION_MAX_LENGTH = 500;
export const BILLING_INVOICE_MAX_ITEMS = 200;
export const BILLING_INVOICE_LINE_QUANTITY_MIN = 1;
export const BILLING_INVOICE_LINE_QUANTITY_MAX = 10000;
export const BILLING_MAX_MONEY_CENTS = 9_999_999_999;
export const BILLING_UNIT_PRICE_MAX = 99999999.99;
export const BILLING_PAYMENT_AMOUNT_MIN = 0.01;
export const BILLING_CURRENCY_AMOUNT_PATTERN = /^\d{1,8}(?:\.\d{1,2})?$/;
export const BILLING_NOTES_MAX_LENGTH = 2000;
export const BILLING_INVOICE_SEARCH_MAX_LENGTH = 120;
export const BILLING_ADJUSTMENT_REASON_MAX_LENGTH = 500;
export const BILLING_SERVICE_NAME_MAX_LENGTH = 255;
export const BILLING_SERVICE_CODE_MAX_LENGTH = 32;
export const BILLING_SERVICE_CATEGORY_MAX_LENGTH = 128;

export function isBillingInvoiceLineQuantityValid(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= BILLING_INVOICE_LINE_QUANTITY_MIN &&
    value <= BILLING_INVOICE_LINE_QUANTITY_MAX
  );
}

export function isBillingCurrencyAmountInputValid(value: string): boolean {
  const trimmed = value.trim();
  return (
    BILLING_CURRENCY_AMOUNT_PATTERN.test(trimmed) &&
    moneyToCents(trimmed) <= BILLING_MAX_MONEY_CENTS
  );
}

export function isBillingServicePriceInputValid(value: string): boolean {
  return isBillingCurrencyAmountInputValid(value);
}

export function isBillingPositiveAmountInputValid(value: string): boolean {
  return (
    isBillingCurrencyAmountInputValid(value) && moneyToCents(value.trim()) > 0
  );
}

export function isBillingAmountWithinBalance(
  value: string,
  balance: string | number | null | undefined
): boolean {
  return (
    isBillingPositiveAmountInputValid(value) &&
    moneyToCents(value.trim()) <= moneyToCents(balance)
  );
}

export function isBillingInvoiceLineTotalValid(
  unitPrice: string,
  quantity: number
): boolean {
  return (
    isBillingCurrencyAmountInputValid(unitPrice) &&
    isBillingInvoiceLineQuantityValid(quantity) &&
    moneyToCents(unitPrice.trim()) * quantity <= BILLING_MAX_MONEY_CENTS
  );
}

export function isBillingInvoiceSubtotalValid(
  items: Array<{ quantity: number; unitPrice: string }>
): boolean {
  return (
    items.reduce(
      (sum, item) => sum + moneyToCents(item.unitPrice.trim()) * item.quantity,
      0
    ) <= BILLING_MAX_MONEY_CENTS
  );
}
