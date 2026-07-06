export const IMPORT_MAX_ROWS = 10_000;
export const IMPORT_CSV_MAX_BYTES = 5_000_000;

export function csvByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function isImportCsvSizeValid(value: string): boolean {
  return csvByteLength(value) <= IMPORT_CSV_MAX_BYTES;
}
