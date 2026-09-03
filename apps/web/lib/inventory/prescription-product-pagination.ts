export type PrescriptionProductPageItem = {
  id: string;
};

export type PrescriptionProductPaginationState<
  Product extends PrescriptionProductPageItem,
> = {
  pageOffset: number;
  loadedProducts: Product[];
  resultTotal: number;
  revision: number;
  exhausted: boolean;
  catalogChanged: boolean;
};

export type PrescriptionProductPage<
  Product extends PrescriptionProductPageItem,
> = {
  revision: number;
  offset: number;
  items: Product[];
  total: number;
};

export function createPrescriptionProductPaginationState<
  Product extends PrescriptionProductPageItem,
>(): PrescriptionProductPaginationState<Product> {
  return {
    pageOffset: 0,
    loadedProducts: [],
    resultTotal: 0,
    revision: 0,
    exhausted: false,
    catalogChanged: false,
  };
}

export function resetPrescriptionProductPagination<
  Product extends PrescriptionProductPageItem,
>(
  state: PrescriptionProductPaginationState<Product>,
): PrescriptionProductPaginationState<Product> {
  return {
    pageOffset: 0,
    loadedProducts: [],
    resultTotal: 0,
    revision: state.revision + 1,
    exhausted: false,
    catalogChanged: false,
  };
}

export function mergePrescriptionProductPages<
  Product extends PrescriptionProductPageItem,
>(loadedProducts: Product[], currentPage: Product[]): Product[] {
  const productsById = new Map(
    loadedProducts.map((product) => [product.id, product]),
  );
  for (const product of currentPage) {
    productsById.set(product.id, product);
  }
  return [...productsById.values()];
}

export function advancePrescriptionProductPagination<
  Product extends PrescriptionProductPageItem,
>(
  state: PrescriptionProductPaginationState<Product>,
  page: PrescriptionProductPage<Product>,
): PrescriptionProductPaginationState<Product> {
  // A response belongs to the exact search revision and offset that requested
  // it. This also coalesces duplicate scroll/button events from one render.
  if (page.revision !== state.revision || page.offset !== state.pageOffset) {
    return state;
  }

  if (page.items.length === 0) {
    return {
      ...state,
      resultTotal: state.loadedProducts.length,
      exhausted: true,
      catalogChanged: page.total > state.loadedProducts.length,
    };
  }

  return {
    ...state,
    pageOffset: page.offset + page.items.length,
    loadedProducts: mergePrescriptionProductPages(
      state.loadedProducts,
      page.items,
    ),
    resultTotal: page.total,
    exhausted: false,
    catalogChanged: false,
  };
}
