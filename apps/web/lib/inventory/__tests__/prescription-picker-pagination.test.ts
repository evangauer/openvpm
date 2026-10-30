import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  advancePrescriptionProductPagination,
  createPrescriptionProductPaginationState,
} from "../prescription-product-pagination";

// Execute the component's actual event handler with controlled query snapshots.
// This covers scroll events independently of the disabled Load more button.
const source = readFileSync(
  new URL("../../../components/records/prescription-inventory-product-picker.tsx", import.meta.url),
  "utf8",
);
const start = source.indexOf("  function loadNextPage() {");
const end = source.indexOf("  function refreshProducts()", start);
if (start < 0 || end < 0) throw new Error("Pagination handler not found");
const handler = source.slice(start, end);

function scroll(overrides: Record<string, unknown> = {}) {
  let state = createPrescriptionProductPaginationState<{ id: string }>();
  const initial = state;
  const items = Array.from({ length: 50 }, (_, index) => ({ id: `synthetic-${index}` }));
  runInNewContext(`${handler}; loadNextPage();`, {
    open: true,
    searchSettled: true,
    products: { data: { items, total: 60 }, isFetching: false, error: null },
    hasMore: true,
    revision: state.revision,
    pageOffset: 0,
    advancePrescriptionProductPagination,
    setPagination: (update: (current: typeof state) => typeof state) => { state = update(state); },
    ...overrides,
  });
  return { state, initial };
}

describe("prescription picker scroll pagination", () => {
  it.each([
    ["search still debouncing", { searchSettled: false }],
    ["picker closed", { open: false }],
    ["failed query retaining old data", { products: { data: { items: [{ id: "stale" }], total: 60 }, error: new Error("offline"), isFetching: false } }],
    ["query in flight", { products: { data: { items: [{ id: "stale" }], total: 60 }, isFetching: true } }],
    ["no page", { products: { data: undefined, isFetching: false } }],
    ["no more products", { hasMore: false }],
  ])("preserves pagination when %s", (_label, overrides) => {
    const { state, initial } = scroll(overrides as Record<string, unknown>);
    expect(state).toBe(initial);
    expect(state.loadedProducts).toEqual([]);
    expect(state.pageOffset).toBe(0);
  });

  it("advances an open settled successful search", () => {
    const { state } = scroll();
    expect(state.loadedProducts).toHaveLength(50);
    expect(state.pageOffset).toBe(50);
    expect(state.loadedProducts[0].id).toBe("synthetic-0");
  });
});
