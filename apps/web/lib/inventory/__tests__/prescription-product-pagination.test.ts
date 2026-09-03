import { describe, expect, it } from "vitest";
import {
  advancePrescriptionProductPagination,
  createPrescriptionProductPaginationState,
  mergePrescriptionProductPages,
  resetPrescriptionProductPagination,
} from "../prescription-product-pagination";

type Product = { id: string; name: string };

function products(start: number, count: number): Product[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `product-${start + index}`,
    name: "Same display name",
  }));
}

describe("prescription product pagination", () => {
  it("coalesces duplicate requests while advancing through more than one page", () => {
    const initial = createPrescriptionProductPaginationState<Product>();
    const firstPage = {
      revision: initial.revision,
      offset: 0,
      items: products(0, 50),
      total: 60,
    };

    const afterFirstPage = advancePrescriptionProductPagination(
      initial,
      firstPage,
    );
    const afterDuplicateEvent = advancePrescriptionProductPagination(
      afterFirstPage,
      firstPage,
    );

    expect(afterFirstPage.pageOffset).toBe(50);
    expect(afterFirstPage.loadedProducts).toHaveLength(50);
    expect(afterDuplicateEvent).toBe(afterFirstPage);

    const afterFinalPage = advancePrescriptionProductPagination(
      afterFirstPage,
      {
        revision: afterFirstPage.revision,
        offset: 50,
        items: products(50, 10),
        total: 60,
      },
    );

    expect(afterFinalPage.pageOffset).toBe(60);
    expect(afterFinalPage.loadedProducts.map((product) => product.id)).toEqual(
      products(0, 60).map((product) => product.id),
    );
  });

  it("rejects a stale page after search reset, even when both use offset zero", () => {
    const initial = createPrescriptionProductPaginationState<Product>();
    const reset = resetPrescriptionProductPagination(initial);
    const stalePage = advancePrescriptionProductPagination(reset, {
      revision: initial.revision,
      offset: 0,
      items: products(0, 50),
      total: 50,
    });

    expect(reset.revision).toBe(1);
    expect(stalePage).toBe(reset);
    expect(stalePage.loadedProducts).toEqual([]);
  });

  it("deduplicates product IDs while preserving the complete page order", () => {
    const merged = mergePrescriptionProductPages(products(0, 50), [
      { id: "product-49", name: "Updated name" },
      ...products(50, 10),
    ]);

    expect(merged).toHaveLength(60);
    expect(merged[49]).toEqual({ id: "product-49", name: "Updated name" });
    expect(merged.at(-1)?.id).toBe("product-59");
  });

  it("terminates an inconsistent empty page and allows a clean refresh", () => {
    const initial = createPrescriptionProductPaginationState<Product>();
    const afterFirstPage = advancePrescriptionProductPagination(initial, {
      revision: initial.revision,
      offset: 0,
      items: products(0, 50),
      total: 60,
    });
    const emptyPage = advancePrescriptionProductPagination(afterFirstPage, {
      revision: afterFirstPage.revision,
      offset: 50,
      items: [],
      total: 60,
    });

    expect(emptyPage.pageOffset).toBe(50);
    expect(emptyPage.loadedProducts).toHaveLength(50);
    expect(emptyPage.resultTotal).toBe(50);
    expect(emptyPage.exhausted).toBe(true);
    expect(emptyPage.catalogChanged).toBe(true);

    const refreshed = resetPrescriptionProductPagination(emptyPage);
    expect(refreshed.pageOffset).toBe(0);
    expect(refreshed.loadedProducts).toEqual([]);
    expect(refreshed.exhausted).toBe(false);
    expect(refreshed.catalogChanged).toBe(false);
  });

  it("does not advance an out-of-order page", () => {
    const initial = createPrescriptionProductPaginationState<Product>();

    expect(
      advancePrescriptionProductPagination(initial, {
        revision: initial.revision,
        offset: 50,
        items: products(50, 10),
        total: 60,
      }),
    ).toBe(initial);
  });
});
