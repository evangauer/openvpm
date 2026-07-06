import { isValidClinicalDateInput } from "@/lib/records/date-input";

export const INVENTORY_PRODUCT_NAME_MAX_LENGTH = 255;
export const INVENTORY_PRODUCT_SKU_MAX_LENGTH = 64;
export const INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH = 128;
export const INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH = 64;
export const INVENTORY_PRODUCT_SEARCH_MAX_LENGTH = 120;
export const INVENTORY_MONEY_AMOUNT_MIN = 0;
export const INVENTORY_MONEY_AMOUNT_MAX_CENTS = 9_999_999_999;
export const INVENTORY_MONEY_AMOUNT_MAX = 99999999.99;
export const INVENTORY_MONEY_AMOUNT_PATTERN = /^\d{1,8}(?:\.\d{1,2})?$/;
export const INVENTORY_STOCK_QUANTITY_MIN = 0;
export const INVENTORY_STOCK_QUANTITY_MAX = 2_147_483_647;
export const INVENTORY_ADJUSTMENT_QUANTITY_MIN = 1;
export const INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH = 500;
export const INVENTORY_SUPPLIER_NAME_MAX_LENGTH = 255;
export const INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH = 255;
export const INVENTORY_SUPPLIER_PHONE_MAX_LENGTH = 32;
export const INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH = 500;
export const INVENTORY_SUPPLIER_NOTES_MAX_LENGTH = 2000;

function moneyInputToCents(value: string): number {
  return Math.round(Number(value.trim()) * 100);
}

export function isInventoryCurrencyAmountInputValid(value: string): boolean {
  const trimmed = value.trim();
  return (
    INVENTORY_MONEY_AMOUNT_PATTERN.test(trimmed) &&
    moneyInputToCents(trimmed) <= INVENTORY_MONEY_AMOUNT_MAX_CENTS
  );
}

export function isInventoryOptionalCurrencyAmountInputValid(
  value: string
): boolean {
  return value.trim().length === 0 || isInventoryCurrencyAmountInputValid(value);
}

export function isInventoryNonnegativeIntegerInputValid(
  value: number
): boolean {
  return (
    Number.isInteger(value) &&
    value >= INVENTORY_STOCK_QUANTITY_MIN &&
    value <= INVENTORY_STOCK_QUANTITY_MAX
  );
}

export function isInventoryPositiveIntegerInputValid(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= INVENTORY_ADJUSTMENT_QUANTITY_MIN &&
    value <= INVENTORY_STOCK_QUANTITY_MAX
  );
}

export function isInventoryRequiredTextInputValid(
  value: string,
  maxLength: number
): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

export function isInventoryOptionalTextInputValid(
  value: string,
  maxLength: number
): boolean {
  return value.trim().length <= maxLength;
}

export function isInventoryOptionalEmailInputValid(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    (trimmed.length <= INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
  );
}

export function isInventoryOptionalExpirationDateInputValid(
  value: string
): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || isValidClinicalDateInput(trimmed);
}
