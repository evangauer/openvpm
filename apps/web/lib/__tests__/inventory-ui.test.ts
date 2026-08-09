import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INVENTORY_ADJUSTMENT_QUANTITY_MIN,
  INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH,
  INVENTORY_MONEY_AMOUNT_MAX,
  INVENTORY_MONEY_AMOUNT_MIN,
  INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH,
  INVENTORY_PRODUCT_NAME_MAX_LENGTH,
  INVENTORY_PRODUCT_SEARCH_MAX_LENGTH,
  INVENTORY_PRODUCT_SKU_MAX_LENGTH,
  INVENTORY_STOCK_QUANTITY_MAX,
  INVENTORY_STOCK_QUANTITY_MIN,
  INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH,
  INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH,
  INVENTORY_SUPPLIER_NAME_MAX_LENGTH,
  INVENTORY_SUPPLIER_NOTES_MAX_LENGTH,
  INVENTORY_SUPPLIER_PHONE_MAX_LENGTH,
  isInventoryCurrencyAmountInputValid,
  isInventoryNonnegativeIntegerInputValid,
  isInventoryOptionalCurrencyAmountInputValid,
  isInventoryOptionalEmailInputValid,
  isInventoryOptionalExpirationDateInputValid,
  isInventoryRequiredTextInputValid,
} from "../inventory/policy";

describe("inventory product form UX", () => {
  const source = readFileSync("app/(dashboard)/inventory/page.tsx", "utf8");
  const routerSource = readFileSync("server/routers/inventory.ts", "utf8");

  it("keeps product create and edit fields aligned to shared policy", () => {
    expect(INVENTORY_PRODUCT_NAME_MAX_LENGTH).toBe(255);
    expect(INVENTORY_PRODUCT_SKU_MAX_LENGTH).toBe(64);
    expect(INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH).toBe(64);
    expect(INVENTORY_MONEY_AMOUNT_MIN).toBe(0);
    expect(INVENTORY_MONEY_AMOUNT_MAX).toBe(99999999.99);
    expect(INVENTORY_STOCK_QUANTITY_MIN).toBe(0);
    expect(INVENTORY_STOCK_QUANTITY_MAX).toBe(2147483647);
    expect(isInventoryCurrencyAmountInputValid("12.50")).toBe(true);
    expect(isInventoryCurrencyAmountInputValid("12.345")).toBe(false);
    expect(isInventoryCurrencyAmountInputValid("100000000")).toBe(false);
    expect(isInventoryOptionalCurrencyAmountInputValid("")).toBe(true);
    expect(isInventoryNonnegativeIntegerInputValid(0)).toBe(true);
    expect(isInventoryNonnegativeIntegerInputValid(1.5)).toBe(false);
    expect(isInventoryOptionalExpirationDateInputValid("")).toBe(true);
    expect(isInventoryOptionalExpirationDateInputValid("2027-01-31")).toBe(
      true
    );
    expect(isInventoryOptionalExpirationDateInputValid("2027-02-31")).toBe(
      false
    );
    expect(isInventoryRequiredTextInputValid(" Carprofen ", 255)).toBe(true);
    expect(isInventoryRequiredTextInputValid(" ", 255)).toBe(false);
    expect(source).toContain("maxLength={INVENTORY_PRODUCT_NAME_MAX_LENGTH}");
    expect(source).toContain("maxLength={INVENTORY_PRODUCT_SKU_MAX_LENGTH}");
    expect(source).toContain(
      "maxLength={INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH}"
    );
    expect(source).toContain("min={INVENTORY_MONEY_AMOUNT_MIN}");
    expect(source).toContain("max={INVENTORY_MONEY_AMOUNT_MAX}");
    expect(source).toContain("min={INVENTORY_STOCK_QUANTITY_MIN}");
    expect(source).toContain("max={INVENTORY_STOCK_QUANTITY_MAX}");
    expect(source).toContain("const canSubmit =");
    expect(source).toContain("const canSave =");
    expect(source).toContain("isInventoryCurrencyAmountInputValid");
    expect(source).toContain("isInventoryOptionalCurrencyAmountInputValid");
    expect(source).toContain("isInventoryNonnegativeIntegerInputValid");
    expect(source).toContain("isInventoryOptionalExpirationDateInputValid");
    expect(source).toContain("formatDateOnly(product.expirationDate)");
    expect(source).toContain(
      'import { formatClinicalDate } from "@/lib/records/clinical-dates"'
    );
    expect(source).toContain('return formatClinicalDate(value, "UTC", value)');
    expect(source).not.toContain("new Date(product.expirationDate)");
    expect(source).not.toContain("new Date(year, month - 1, day)");
    expect(source).not.toContain("toLocaleDateString()");
    expect(source).toContain("name: form.name.trim()");
    expect(source).toContain("sku: trimmedOrUndefined(form.sku)");
    expect(source).toContain("unitPrice: form.unitPrice.trim()");
    expect(source).toContain("taxable: form.taxable");
    expect(source).toContain('type="checkbox"');
    expect(source).toContain('product.taxable ? "Taxable" : "Not taxable"');
    expect(source).toContain("lotNumber: trimmedOrUndefined(form.lotNumber)");
    expect(source).toContain(
      "expirationDate: trimmedOrUndefined(form.expirationDate)"
    );
    expect(source).toContain("expirationDate: trimmedOrNull(form.expirationDate)");
    expect(source).toContain("disabled={!canSubmit || createMutation.isPending}");
    expect(source).toContain("disabled={!canSave || updateMutation.isPending}");
  });

  it("keeps stock adjustment controls aligned to shared policy", () => {
    expect(INVENTORY_ADJUSTMENT_QUANTITY_MIN).toBe(1);
    expect(INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH).toBe(500);
    expect(source).toContain("productStockQuantity");
    expect(source).toContain("const maxAddition = Math.max");
    expect(source).toContain("const canAddStock =");
    expect(source).toContain("const canRemoveStock =");
    expect(source).toContain("qty <= maxAddition");
    expect(source).toContain("qty <= productStockQuantity");
    expect(source).toContain("min={INVENTORY_ADJUSTMENT_QUANTITY_MIN}");
    expect(source).toContain("max={INVENTORY_STOCK_QUANTITY_MAX}");
    expect(source).toContain(
      "maxLength={INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH}"
    );
    expect(source).toContain("disabled={!canAddStock}");
    expect(source).toContain("disabled={!canRemoveStock}");
    expect(source).not.toContain("disabled={adjustMutation.isPending || !reason.trim()}");
  });

  it("keeps supplier and search controls aligned to shared policy", () => {
    expect(INVENTORY_PRODUCT_SEARCH_MAX_LENGTH).toBe(120);
    expect(INVENTORY_SUPPLIER_NAME_MAX_LENGTH).toBe(255);
    expect(INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH).toBe(255);
    expect(INVENTORY_SUPPLIER_PHONE_MAX_LENGTH).toBe(32);
    expect(INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH).toBe(500);
    expect(INVENTORY_SUPPLIER_NOTES_MAX_LENGTH).toBe(2000);
    expect(isInventoryOptionalEmailInputValid("orders@example.com")).toBe(true);
    expect(isInventoryOptionalEmailInputValid("not-email")).toBe(false);
    expect(source).toContain("const searchFilter = search.trim()");
    expect(source).toContain("search: searchFilter || undefined");
    expect(source).toContain("maxLength={INVENTORY_PRODUCT_SEARCH_MAX_LENGTH}");
    expect(source).toContain("maxLength={INVENTORY_SUPPLIER_NAME_MAX_LENGTH}");
    expect(source).toContain("maxLength={INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH}");
    expect(source).toContain("maxLength={INVENTORY_SUPPLIER_PHONE_MAX_LENGTH}");
    expect(source).toContain(
      "maxLength={INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH}"
    );
    expect(source).toContain("maxLength={INVENTORY_SUPPLIER_NOTES_MAX_LENGTH}");
    expect(source).toContain("isInventoryOptionalEmailInputValid");
    expect(source).toContain("contactEmail: trimmedOrUndefined(form.contactEmail)?.toLowerCase()");
    expect(source).toContain("phone: trimmedOrUndefined(form.phone)");
    expect(source).toContain("address: trimmedOrUndefined(form.address)");
    expect(source).toContain("notes: trimmedOrUndefined(form.notes)");
  });

  it("supports bounded inline supplier editing", () => {
    expect(source).toContain("function EditSupplierRow");
    expect(source).toContain("trpc.inventory.updateSupplier.useMutation");
    expect(source).toContain("Supplier updated");
    expect(source).toContain("const [editingSupplierId");
    expect(source).toContain("setEditingSupplierId(supplier.id)");
    expect(source).toContain("notes: trimmedOrNull(form.notes)");
    expect(source).toContain(
      "contactEmail: contactEmail ? contactEmail.toLowerCase() : null"
    );
    expect(source).toContain("title={supplier.notes ?? undefined}");
    expect(source).toContain("disabled={!canSave || updateMutation.isPending}");
  });

  it("keeps viewer access read-only for inventory writes", () => {
    expect(source).toContain('import { useSession } from "next-auth/react"');
    expect(source).toContain(
      "function canManageInventoryRole(role?: string | null): boolean"
    );
    expect(source).toContain('role === "admin"');
    expect(source).toContain('role === "veterinarian"');
    expect(source).toContain('role === "technician"');
    expect(source).toContain('role === "front_desk"');
    expect(source).toContain("const { data: session } = useSession()");
    expect(source).toContain(
      "const canManageInventory = canManageInventoryRole(session?.user?.role)"
    );
    expect(source).toContain("{canManageInventory && (");
    expect(source).toContain("{canManageInventory && showAddProduct && (");
    expect(source).toContain("canManageInventory && editingId === product.id");
    expect(source).toContain("{canManageInventory ? (");
    expect(source).toContain("Read-only");
    expect(source).toContain("{canManageInventory && showAddSupplier && (");
    expect(source).toContain("canManageInventory &&\n                      editingSupplierId === supplier.id");
    expect(source).toContain("canManageInventory\n                  ? {");
    expect(routerSource).toContain("const inventoryManagerProcedure =");
    expect(routerSource).toContain(
      'requireRole("admin", "veterinarian", "technician", "front_desk")'
    );
    expect(routerSource).toContain("create: inventoryManagerProcedure");
    expect(routerSource).toContain("update: inventoryManagerProcedure");
    expect(routerSource).toContain("adjustStock: inventoryManagerProcedure");
    expect(routerSource).toContain("createSupplier: inventoryManagerProcedure");
    expect(routerSource).toContain("updateSupplier: inventoryManagerProcedure");
  });
});
