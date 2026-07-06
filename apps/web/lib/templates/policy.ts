export const TREATMENT_TEMPLATE_NAME_MAX_LENGTH = 255;
export const TREATMENT_TEMPLATE_DESCRIPTION_MAX_LENGTH = 2000;
export const TREATMENT_TEMPLATE_CATEGORY_MAX_LENGTH = 128;
export const TREATMENT_TEMPLATE_ITEM_DESCRIPTION_MAX_LENGTH = 500;
export const TREATMENT_TEMPLATE_MAX_ITEMS = 200;
export const TREATMENT_TEMPLATE_ITEM_QUANTITY_MIN = 1;
export const TREATMENT_TEMPLATE_ITEM_QUANTITY_MAX = 10000;
export const TREATMENT_TEMPLATE_ITEM_SORT_ORDER_MIN = 0;
export const TREATMENT_TEMPLATE_ITEM_SORT_ORDER_MAX = 10000;
export const TREATMENT_TEMPLATE_MAX_MONEY_CENTS = 9_999_999_999;
export const TREATMENT_TEMPLATE_UNIT_PRICE_MAX = 99999999.99;
export const TREATMENT_TEMPLATE_UNIT_PRICE_PATTERN = /^\d{1,8}(?:\.\d{1,2})?$/;

function moneyInputToCents(value: string): number {
  return Math.round(Number(value.trim()) * 100);
}

export function isTreatmentTemplateQuantityValid(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= TREATMENT_TEMPLATE_ITEM_QUANTITY_MIN &&
    value <= TREATMENT_TEMPLATE_ITEM_QUANTITY_MAX
  );
}

export function isTreatmentTemplateUnitPriceInputValid(value: string): boolean {
  if (!TREATMENT_TEMPLATE_UNIT_PRICE_PATTERN.test(value.trim())) return false;
  return moneyInputToCents(value) <= TREATMENT_TEMPLATE_MAX_MONEY_CENTS;
}

export function isTreatmentTemplateItemTotalValid(
  unitPrice: string,
  quantity: number
): boolean {
  return (
    isTreatmentTemplateUnitPriceInputValid(unitPrice) &&
    isTreatmentTemplateQuantityValid(quantity) &&
    moneyInputToCents(unitPrice) * quantity <= TREATMENT_TEMPLATE_MAX_MONEY_CENTS
  );
}
