export const PRACTICE_BACKUP_JSON_MAX_BYTES = 50_000_000;
export const PRACTICE_BACKUP_JSON_SIZE_MESSAGE =
  "Backup JSON restores must be 50 MB or less.";

export function practiceBackupJsonByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function isPracticeBackupJsonSizeValid(
  value: unknown,
  maxBytes = PRACTICE_BACKUP_JSON_MAX_BYTES
): boolean {
  try {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    return (
      typeof json === "string" &&
      practiceBackupJsonByteLength(json) <= maxBytes
    );
  } catch {
    return false;
  }
}
