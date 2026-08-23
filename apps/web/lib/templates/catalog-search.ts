export const TEMPLATE_CATALOG_SEARCH_MAX_LENGTH = 120;
export const TEMPLATE_CATALOG_RESULT_LIMIT = 20;

export function escapeTemplateCatalogLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function hasDuplicateTemplateCatalogItems(
  items: Array<{ itemType: "service" | "product"; itemId?: string | null }>,
): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.itemId) continue;
    const key = `${item.itemType}:${item.itemId}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
