import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("template catalog picker UI", () => {
  const source = readFileSync(
    "components/templates/catalog-picker.tsx",
    "utf8",
  );

  it("supports query editing, clearing, and bounded server re-search", () => {
    expect(source).toContain("trpc.templates.searchCatalog.useQuery");
    expect(source).toContain("useDeferredValue(query)");
    expect(source).toContain("maxLength={TEMPLATE_CATALOG_SEARCH_MAX_LENGTH}");
    expect(source).toContain('aria-label="Clear search"');
    expect(source).toContain("Clear selected {label}");
    expect(source).toContain("onSelect(null)");
  });

  it("supports keyboard and touch-sized listbox selection", () => {
    expect(source).toContain('event.key === "ArrowDown"');
    expect(source).toContain('event.key === "ArrowUp"');
    expect(source).toContain('event.key === "Enter"');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
    expect(source).toContain('role="combobox"');
    expect(source).toContain("aria-activedescendant={activeOptionId}");
    expect(source).toContain("min-h-11");
    expect(source).toContain("calc(100vw-2rem)");
  });

  it("does not select results while a deferred query is stale or fetching", () => {
    expect(source).toContain("const queryIsStale = query !== deferredQuery");
    expect(source).toContain(
      "!queryIsStale && !catalogQuery.isFetching && !catalogQuery.error",
    );
    expect(source).toContain("if (activeOption) choose(activeOption)");
    expect(source).toContain("queryIsStale || catalogQuery.isFetching");
  });

  it("filters catalog ids already selected in another row", () => {
    expect(source).toContain("new Set(excludedIds)");
    expect(source).toContain("item.id === value || !excluded.has(item.id)");
  });
});
