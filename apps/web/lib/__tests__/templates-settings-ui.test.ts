import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isTreatmentTemplateItemTotalValid,
  isTreatmentTemplateQuantityValid,
  isTreatmentTemplateUnitPriceInputValid,
  TREATMENT_TEMPLATE_DESCRIPTION_MAX_LENGTH,
  TREATMENT_TEMPLATE_ITEM_DESCRIPTION_MAX_LENGTH,
  TREATMENT_TEMPLATE_ITEM_QUANTITY_MAX,
  TREATMENT_TEMPLATE_ITEM_QUANTITY_MIN,
  TREATMENT_TEMPLATE_MAX_ITEMS,
  TREATMENT_TEMPLATE_NAME_MAX_LENGTH,
  TREATMENT_TEMPLATE_UNIT_PRICE_MAX,
} from "../templates/policy";

describe("treatment template settings UI", () => {
  const source = readFileSync("app/(dashboard)/settings/page.tsx", "utf8");

  it("keeps treatment template setup reachable from Settings", () => {
    expect(source).toContain('"templates"');
    expect(source).toContain("Templates");
    expect(source).toContain("trpc.templates.create.useMutation");
    expect(source).toContain("trpc.templates.getById.useQuery");
    expect(source).toContain("trpc.templates.listProducts.useQuery");
  });

  it("keeps template create controls aligned to shared policy", () => {
    expect(TREATMENT_TEMPLATE_NAME_MAX_LENGTH).toBe(255);
    expect(TREATMENT_TEMPLATE_DESCRIPTION_MAX_LENGTH).toBe(2000);
    expect(TREATMENT_TEMPLATE_ITEM_DESCRIPTION_MAX_LENGTH).toBe(500);
    expect(TREATMENT_TEMPLATE_ITEM_QUANTITY_MIN).toBe(1);
    expect(TREATMENT_TEMPLATE_ITEM_QUANTITY_MAX).toBe(10000);
    expect(TREATMENT_TEMPLATE_MAX_ITEMS).toBe(200);
    expect(TREATMENT_TEMPLATE_UNIT_PRICE_MAX).toBe(99999999.99);
    expect(isTreatmentTemplateQuantityValid(1)).toBe(true);
    expect(isTreatmentTemplateQuantityValid(0)).toBe(false);
    expect(isTreatmentTemplateUnitPriceInputValid("75.00")).toBe(true);
    expect(isTreatmentTemplateUnitPriceInputValid("75.123")).toBe(false);
    expect(isTreatmentTemplateUnitPriceInputValid("100000000")).toBe(false);
    expect(isTreatmentTemplateItemTotalValid("75.00", 2)).toBe(true);
    expect(isTreatmentTemplateItemTotalValid("99999999.99", 2)).toBe(false);
    expect(source).toContain("maxLength={TREATMENT_TEMPLATE_NAME_MAX_LENGTH}");
    expect(source).toContain(
      "maxLength={TREATMENT_TEMPLATE_DESCRIPTION_MAX_LENGTH}"
    );
    expect(source).toContain(
      "maxLength={TREATMENT_TEMPLATE_ITEM_DESCRIPTION_MAX_LENGTH}"
    );
    expect(source).toContain("min={TREATMENT_TEMPLATE_ITEM_QUANTITY_MIN}");
    expect(source).toContain("max={TREATMENT_TEMPLATE_ITEM_QUANTITY_MAX}");
    expect(source).toContain("max={TREATMENT_TEMPLATE_UNIT_PRICE_MAX}");
    expect(source).toContain(
      "disabled={addItems.length >= TREATMENT_TEMPLATE_MAX_ITEMS}"
    );
    expect(source).toContain("const templateItemsToCreate = addItems");
    expect(source).toContain("const canCreateTemplate =");
    expect(source).toContain(
      "templateItemsToCreate.every(isTemplateItemFormValid)"
    );
    expect(source).toContain("disabled={!canCreateTemplate}");
    expect(source).toContain("items: templateItemsToCreate");
  });

  it("links product template rows to inventory and fails closed without the catalog", () => {
    expect(source).toContain("itemId?: string | null");
    expect(source).toContain("const selectTemplateProduct =");
    expect(source).toContain("itemId: product?.id ?? null");
    expect(source).toContain("description: product?.name ?? \"\"");
    expect(source).toContain("defaultUnitPrice: product?.unitPrice ?? \"0\"");
    expect(source).toContain("itemId: item.itemId || undefined");
    expect(source).toContain(
      'item.itemType !== "product" ||\n      hasActiveTemplateProductLink(item.itemId)',
    );
    expect(source).toContain("const hasUnlinkedProductRows = addItems.some(");
    expect(source).toContain("const activeTemplateProductIds = new Set(");
    expect(source).toContain("const hasActiveTemplateProductLink =");
    expect(source).toContain("const hasStaleProductRows = addItems.some(");
    expect(source).toContain("!hasActiveTemplateProductLink(item.itemId)");
    expect(source).toContain("!hasUnlinkedProductRows");
    expect(source).toContain("!templateProductCatalogUnavailable");
    expect(source).toContain("Inventory products could not load");
    expect(source).toContain("onClick={() => void refetchTemplateProducts()}");
    expect(source).toContain('aria-invalid={');
    expect(source).toContain('role="alert"');
    expect(source).toContain("selected inventory product is no longer active");
    expect(source).toContain("item.hasActiveProductLink !== true");
    expect(source).toContain("Missing or archived inventory product");
  });
});
