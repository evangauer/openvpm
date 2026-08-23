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
    expect(source).toContain("<TemplateCatalogPicker");
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
      "maxLength={TREATMENT_TEMPLATE_DESCRIPTION_MAX_LENGTH}",
    );
    expect(source).toContain(
      "item.description.trim().length <=\n      TREATMENT_TEMPLATE_ITEM_DESCRIPTION_MAX_LENGTH",
    );
    expect(source).toContain("min={TREATMENT_TEMPLATE_ITEM_QUANTITY_MIN}");
    expect(source).toContain("max={TREATMENT_TEMPLATE_ITEM_QUANTITY_MAX}");
    expect(source).toContain("max={TREATMENT_TEMPLATE_UNIT_PRICE_MAX}");
    expect(source).toContain(
      "disabled={addItems.length >= TREATMENT_TEMPLATE_MAX_ITEMS}",
    );
    expect(source).toContain("const templateItemsToCreate = addItems");
    expect(source).toContain("const canCreateTemplate =");
    expect(source).toContain(
      "templateItemsToCreate.every(isTemplateItemFormValid)",
    );
    expect(source).toContain("disabled={!canCreateTemplate}");
    expect(source).toContain("items: templateItemsToCreate");
  });

  it("links service and product rows through the searchable catalog picker", () => {
    expect(source).toContain("itemId?: string | null");
    expect(source).toContain("const selectTemplateCatalogItem =");
    expect(source).toContain("itemId: catalogItem?.id ?? null");
    expect(source).toContain('description: catalogItem?.name ?? ""');
    expect(source).toContain('defaultUnitPrice: catalogItem?.unitPrice ?? "0"');
    expect(source).toContain("itemId: item.itemId || undefined");
    expect(source).toContain("const hasUnlinkedCatalogRows = addItems.some(");
    expect(source).toContain("!hasUnlinkedCatalogRows");
    expect(source).toContain("excludedIds={addItems");
    expect(source).toContain("candidate.itemType === item.itemType");
    expect(source).toContain("Search for and select an active service");
    expect(source).toContain("item.hasActiveProductLink !== true");
    expect(source).toContain("Missing or archived inventory product");
  });

  it("uses a responsive item grid and labels row removal", () => {
    expect(source).toContain("draftId: number");
    expect(source).toContain("key={item.draftId}");
    expect(source).toContain("nextTemplateItemDraftId.current++");
    expect(source).toContain(
      'className="grid grid-cols-2 items-center gap-2 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]"',
    );
    expect(source).toContain("aria-label={`Remove item ${index + 1}`}");
    expect(source).toContain('className="w-full lg:w-20"');
    expect(source).toContain('className="w-full lg:w-28"');
  });
});
