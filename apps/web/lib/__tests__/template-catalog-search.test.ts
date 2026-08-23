import { describe, expect, it } from "vitest";
import {
  escapeTemplateCatalogLike,
  hasDuplicateTemplateCatalogItems,
  TEMPLATE_CATALOG_RESULT_LIMIT,
  TEMPLATE_CATALOG_SEARCH_MAX_LENGTH,
} from "../templates/catalog-search";

describe("template catalog search policy", () => {
  it("escapes SQL wildcard characters as literal input", () => {
    expect(escapeTemplateCatalogLike("100%_care\\kit")).toBe(
      "100\\%\\_care\\\\kit",
    );
  });

  it("keeps the catalog query and response bounded", () => {
    expect(TEMPLATE_CATALOG_SEARCH_MAX_LENGTH).toBe(120);
    expect(TEMPLATE_CATALOG_RESULT_LIMIT).toBe(20);
  });

  it("detects duplicate linked rows by item type and id", () => {
    expect(
      hasDuplicateTemplateCatalogItems([
        { itemType: "service", itemId: "same" },
        { itemType: "service", itemId: "same" },
      ]),
    ).toBe(true);
    expect(
      hasDuplicateTemplateCatalogItems([
        { itemType: "service", itemId: "same" },
        { itemType: "product", itemId: "same" },
        { itemType: "service" },
      ]),
    ).toBe(false);
  });
});
