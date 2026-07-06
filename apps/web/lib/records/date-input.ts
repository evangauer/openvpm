const DATE_INPUT_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidClinicalDateInput(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    DATE_INPUT_RE.test(value) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
