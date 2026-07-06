export const CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH = 255;
export const CONTROLLED_SUBSTANCE_UNIT_MAX_LENGTH = 32;
export const CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH = 64;
export const CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH = 2000;
export const CONTROLLED_SUBSTANCE_QUANTITY_MIN = 0.001;
export const CONTROLLED_SUBSTANCE_QUANTITY_MAX = 9999999.999;
export const CONTROLLED_SUBSTANCE_QUANTITY_STEP = 0.001;
export const CONTROLLED_SUBSTANCE_QUANTITY_PATTERN =
  /^\d{1,7}(?:\.\d{1,3})?$/;

export function isControlledSubstanceQuantityInputValid(
  value: string
): boolean {
  const trimmed = value.trim();
  const quantity = Number(trimmed);
  return (
    CONTROLLED_SUBSTANCE_QUANTITY_PATTERN.test(trimmed) &&
    Number.isFinite(quantity) &&
    quantity > 0 &&
    quantity <= CONTROLLED_SUBSTANCE_QUANTITY_MAX
  );
}

export function isControlledSubstanceRequiredTextInputValid(
  value: string,
  maxLength: number
): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

export function isControlledSubstanceOptionalTextInputValid(
  value: string,
  maxLength: number
): boolean {
  return value.trim().length <= maxLength;
}
