export function escapeClientSearchValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function clientSearchContainsPattern(value: string): string {
  return `%${escapeClientSearchValue(value)}%`;
}
