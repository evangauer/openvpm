import { z } from "zod";
import { isLabReferenceInputValid } from "./lab-policy";
import { isValidClinicalDateInput } from "./date-input";

export { isValidClinicalDateInput } from "./date-input";

function pluralizeDecimal(scale: number) {
  return scale === 1 ? "decimal place" : "decimal places";
}

export function clinicalDateInput(label: string) {
  return z.string().refine(isValidClinicalDateInput, {
    message: `${label} must be a valid YYYY-MM-DD date.`,
  });
}

export function clinicalTextInput(label: string, max: number) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be at most ${max} characters.`);
}

export function optionalClinicalTextInput(label: string, max: number) {
  return z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .optional();
}

export function compareClinicalDateInputs(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function hasMaxDecimalPlaces(value: number, scale: number): boolean {
  if (!Number.isFinite(value)) return false;
  const fixed = value.toFixed(scale);
  return Number(fixed) === value;
}

export function clinicalDecimalInput(
  label: string,
  options: {
    min?: number;
    max?: number;
    positive?: boolean;
    scale: number;
  }
) {
  let schema = z.number().finite();
  if (options.positive) {
    schema = schema.positive();
  } else if (options.min !== undefined) {
    schema = schema.min(options.min);
  }
  if (options.max !== undefined) {
    schema = schema.max(options.max);
  }
  return schema.refine((value) => hasMaxDecimalPlaces(value, options.scale), {
    message: `${label} must have at most ${options.scale} ${pluralizeDecimal(options.scale)}.`,
  });
}

export function isValidLabReferenceInput(value: string): boolean {
  return isLabReferenceInputValid(value);
}

export function labReferenceInput(label: string) {
  return z.string().trim().refine(isValidLabReferenceInput, {
    message:
      `${label} must be numeric with up to 7 digits and 3 decimal places.`,
  });
}

export function isOrderedLabReferenceRange(
  low: string | undefined,
  high: string | undefined
): boolean {
  if (low === undefined || high === undefined) return true;
  return Number(low) <= Number(high);
}
