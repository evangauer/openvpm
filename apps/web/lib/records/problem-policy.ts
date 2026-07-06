export const PROBLEM_DESCRIPTION_MAX_LENGTH = 500;
export const PROBLEM_STATUSES = ["active", "resolved", "chronic"] as const;

const DATE_INPUT_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export function isProblemRequiredTextInputValid(
  value: string,
  maxLength: number
): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

export function isProblemDateInputValid(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    DATE_INPUT_RE.test(value) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function isProblemOptionalDateInputValid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || isProblemDateInputValid(trimmed);
}
