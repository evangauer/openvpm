"use client";

import { useState, useMemo } from "react";
import { useSession } from "next-auth/react";
import {
  Search,
  Package,
  Plus,
  Minus,
  Pencil,
  Truck,
  X,
  Check,
  AlertTriangle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useCurrencyFormatter } from "@/lib/locale/useCurrency";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/empty-state";
import { TableScroll } from "@/components/common/table-scroll";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { formatClinicalDate } from "@/lib/records/clinical-dates";
import {
  INVENTORY_ADJUSTMENT_QUANTITY_MIN,
  INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH,
  INVENTORY_MONEY_AMOUNT_MAX,
  INVENTORY_MONEY_AMOUNT_MIN,
  INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH,
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
  isInventoryOptionalTextInputValid,
  isInventoryPositiveIntegerInputValid,
  isInventoryRequiredTextInputValid,
} from "@/lib/inventory/policy";

const CATEGORIES = [
  { label: "All Categories", value: "" },
  { label: "Medication", value: "medication" },
  { label: "Preventive", value: "preventive" },
  { label: "Supplement", value: "supplement" },
  { label: "Food", value: "food" },
  { label: "Supply", value: "supply" },
] as const;

const ALERT_FILTERS = [
  { label: "All", value: "all" },
  { label: "Needs Attention", value: "attention" },
  { label: "Low Stock", value: "low_stock" },
  { label: "Expired", value: "expired" },
  { label: "Expiring Soon", value: "expiring_soon" },
] as const;

type AlertFilter = (typeof ALERT_FILTERS)[number]["value"];

function stockBadge(status: string) {
  if (status === "out") {
    return { label: "Out", className: "bg-red-100 text-red-700" };
  }
  if (status === "low") {
    return { label: "Low Stock", className: "bg-amber-100 text-amber-700" };
  }
  return { label: "In Stock", className: "bg-green-100 text-green-700" };
}

function expirationBadge(status: string) {
  if (status === "expired") {
    return { label: "Expired", className: "bg-red-100 text-red-700" };
  }
  if (status === "expiring_soon") {
    return { label: "Expiring Soon", className: "bg-orange-100 text-orange-700" };
  }
  return null;
}

const trimmedOrUndefined = (value: string) => value.trim() || undefined;
const trimmedOrNull = (value: string) => value.trim() || null;

function canManageInventoryRole(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "front_desk"
  );
}

function formatDateOnly(value: string): string {
  if (!isInventoryOptionalExpirationDateInputValid(value)) {
    return value;
  }
  return formatClinicalDate(value, "UTC", value);
}

// --- Add Product Form ---

function AddProductForm({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const createMutation = trpc.inventory.create.useMutation({
    onSuccess: () => {
      utils.inventory.list.invalidate();
      onClose();
      toast.success("Product added");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [form, setForm] = useState({
    name: "",
    sku: "",
    category: "",
    unitPrice: "",
    taxable: true,
    costPrice: "",
    stockQuantity: 0,
    reorderPoint: 10,
    lotNumber: "",
    expirationDate: "",
  });

  const canSubmit =
    isInventoryRequiredTextInputValid(
      form.name,
      INVENTORY_PRODUCT_NAME_MAX_LENGTH
    ) &&
    isInventoryOptionalTextInputValid(
      form.sku,
      INVENTORY_PRODUCT_SKU_MAX_LENGTH
    ) &&
    isInventoryOptionalTextInputValid(
      form.category,
      INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH
    ) &&
    isInventoryCurrencyAmountInputValid(form.unitPrice) &&
    isInventoryOptionalCurrencyAmountInputValid(form.costPrice) &&
    isInventoryNonnegativeIntegerInputValid(form.stockQuantity) &&
    isInventoryNonnegativeIntegerInputValid(form.reorderPoint) &&
    isInventoryOptionalTextInputValid(
      form.lotNumber,
      INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH
    ) &&
    isInventoryOptionalExpirationDateInputValid(form.expirationDate);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    createMutation.mutate({
      name: form.name.trim(),
      sku: trimmedOrUndefined(form.sku),
      category: trimmedOrUndefined(form.category),
      unitPrice: form.unitPrice.trim(),
      taxable: form.taxable,
      costPrice: trimmedOrUndefined(form.costPrice),
      stockQuantity: form.stockQuantity,
      reorderPoint: form.reorderPoint,
      lotNumber: trimmedOrUndefined(form.lotNumber),
      expirationDate: trimmedOrUndefined(form.expirationDate),
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 rounded-lg border border-border bg-card p-4 space-y-3"
    >
      <h3 className="font-medium text-sm">Add Product</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Input
          placeholder="Name *"
          value={form.name}
          maxLength={INVENTORY_PRODUCT_NAME_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <Input
          placeholder="SKU"
          value={form.sku}
          maxLength={INVENTORY_PRODUCT_SKU_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, sku: e.target.value })}
        />
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">Category</option>
          {CATEGORIES.slice(1).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <Input
          type="number"
          min={INVENTORY_MONEY_AMOUNT_MIN}
          max={INVENTORY_MONEY_AMOUNT_MAX}
          step="0.01"
          placeholder="Unit Price *"
          value={form.unitPrice}
          onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
          required
        />
        <label className="flex h-10 items-center gap-2 rounded-md border border-input px-3 text-sm">
          <input
            type="checkbox"
            checked={form.taxable}
            onChange={(event) =>
              setForm({ ...form, taxable: event.target.checked })
            }
          />
          Taxable
        </label>
        <Input
          type="number"
          min={INVENTORY_MONEY_AMOUNT_MIN}
          max={INVENTORY_MONEY_AMOUNT_MAX}
          step="0.01"
          placeholder="Cost Price"
          value={form.costPrice}
          onChange={(e) => setForm({ ...form, costPrice: e.target.value })}
        />
        <Input
          type="number"
          min={INVENTORY_STOCK_QUANTITY_MIN}
          max={INVENTORY_STOCK_QUANTITY_MAX}
          step={1}
          placeholder="Stock Qty"
          value={form.stockQuantity}
          onChange={(e) =>
            setForm({ ...form, stockQuantity: parseInt(e.target.value) || 0 })
          }
        />
        <Input
          type="number"
          min={INVENTORY_STOCK_QUANTITY_MIN}
          max={INVENTORY_STOCK_QUANTITY_MAX}
          step={1}
          placeholder="Reorder Point"
          value={form.reorderPoint}
          onChange={(e) =>
            setForm({ ...form, reorderPoint: parseInt(e.target.value) || 0 })
          }
        />
        <Input
          placeholder="Lot Number"
          value={form.lotNumber}
          maxLength={INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, lotNumber: e.target.value })}
        />
        <Input
          type="date"
          placeholder="Expiration Date"
          value={form.expirationDate}
          aria-invalid={
            !isInventoryOptionalExpirationDateInputValid(form.expirationDate) ||
            undefined
          }
          onChange={(e) =>
            setForm({ ...form, expirationDate: e.target.value })
          }
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit || createMutation.isPending}
        >
          {createMutation.isPending ? "Adding..." : "Add Product"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {createMutation.error && (
        <p className="text-sm text-destructive">
          {createMutation.error.message}
        </p>
      )}
    </form>
  );
}

// --- Edit Product Form ---

function EditProductRow({
  product,
  onClose,
}: {
  product: {
    id: string;
    name: string;
    sku: string | null;
    category: string | null;
    unitPrice: string;
    taxable: boolean;
    costPrice: string | null;
    stockQuantity: number;
    reorderPoint: number | null;
    lotNumber: string | null;
    expirationDate: string | null;
  };
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const updateMutation = trpc.inventory.update.useMutation({
    onSuccess: () => {
      utils.inventory.list.invalidate();
      onClose();
      toast.success("Product updated");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [form, setForm] = useState({
    name: product.name,
    sku: product.sku ?? "",
    category: product.category ?? "",
    unitPrice: product.unitPrice,
    taxable: product.taxable,
    costPrice: product.costPrice ?? "",
    reorderPoint: product.reorderPoint ?? 10,
    lotNumber: product.lotNumber ?? "",
    expirationDate: product.expirationDate ?? "",
  });

  const canSave =
    isInventoryRequiredTextInputValid(
      form.name,
      INVENTORY_PRODUCT_NAME_MAX_LENGTH
    ) &&
    isInventoryOptionalTextInputValid(
      form.sku,
      INVENTORY_PRODUCT_SKU_MAX_LENGTH
    ) &&
    isInventoryOptionalTextInputValid(
      form.category,
      INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH
    ) &&
    isInventoryCurrencyAmountInputValid(form.unitPrice) &&
    isInventoryOptionalCurrencyAmountInputValid(form.costPrice) &&
    isInventoryNonnegativeIntegerInputValid(form.reorderPoint) &&
    isInventoryOptionalTextInputValid(
      form.lotNumber,
      INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH
    ) &&
    isInventoryOptionalExpirationDateInputValid(form.expirationDate);

  const handleSave = () => {
    if (!canSave) return;
    updateMutation.mutate({
      id: product.id,
      name: form.name.trim(),
      sku: trimmedOrUndefined(form.sku),
      category: trimmedOrUndefined(form.category),
      unitPrice: form.unitPrice.trim(),
      taxable: form.taxable,
      costPrice: trimmedOrUndefined(form.costPrice),
      reorderPoint: form.reorderPoint,
      lotNumber: trimmedOrUndefined(form.lotNumber),
      expirationDate: trimmedOrNull(form.expirationDate),
    });
  };

  return (
    <tr className="border-b border-border bg-muted/20">
      <td className="px-4 py-2">
        <Input
          value={form.name}
          maxLength={INVENTORY_PRODUCT_NAME_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="h-8 text-sm"
        />
      </td>
      <td className="px-4 py-2">
        <Input
          value={form.sku}
          maxLength={INVENTORY_PRODUCT_SKU_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, sku: e.target.value })}
          className="h-8 text-sm"
        />
      </td>
      <td className="px-4 py-2">
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          className="h-8 rounded-md border border-input bg-background px-2 py-1 text-sm w-full"
        >
          <option value="">--</option>
          {CATEGORIES.slice(1).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </td>
      <td className="px-4 py-2">
        <Input
          type="number"
          min={INVENTORY_MONEY_AMOUNT_MIN}
          max={INVENTORY_MONEY_AMOUNT_MAX}
          step="0.01"
          value={form.unitPrice}
          onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
          className="h-8 text-sm text-right"
        />
      </td>
      <td className="px-4 py-2">
        <label className="flex items-center justify-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={form.taxable}
            onChange={(event) =>
              setForm({ ...form, taxable: event.target.checked })
            }
          />
          Taxable
        </label>
      </td>
      <td className="px-4 py-2">
        <Input
          type="number"
          min={INVENTORY_MONEY_AMOUNT_MIN}
          max={INVENTORY_MONEY_AMOUNT_MAX}
          step="0.01"
          value={form.costPrice}
          onChange={(e) => setForm({ ...form, costPrice: e.target.value })}
          className="h-8 text-sm text-right"
        />
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {product.stockQuantity}
      </td>
      <td className="px-4 py-2">
        <Input
          type="number"
          min={INVENTORY_STOCK_QUANTITY_MIN}
          max={INVENTORY_STOCK_QUANTITY_MAX}
          step={1}
          value={form.reorderPoint}
          onChange={(e) =>
            setForm({ ...form, reorderPoint: parseInt(e.target.value) || 0 })
          }
          className="h-8 text-sm text-right w-20"
        />
      </td>
      <td className="px-4 py-2">
        <div className="space-y-1">
          <Input
            value={form.lotNumber}
            maxLength={INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH}
            onChange={(e) => setForm({ ...form, lotNumber: e.target.value })}
            className="h-8 text-sm"
            placeholder="Lot"
          />
          <Input
            type="date"
            value={form.expirationDate}
            aria-invalid={
              !isInventoryOptionalExpirationDateInputValid(
                form.expirationDate
              ) || undefined
            }
            onChange={(e) =>
              setForm({ ...form, expirationDate: e.target.value })
            }
            className="h-8 text-sm"
          />
        </div>
      </td>
      <td className="px-4 py-2" />
      <td className="px-4 py-2">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={handleSave}
            disabled={!canSave || updateMutation.isPending}
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

// --- Stock Adjust Popover ---

function StockAdjustPopover({
  productId,
  productName,
  productStockQuantity,
  onClose,
}: {
  productId: string;
  productName: string;
  productStockQuantity: number;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const adjustMutation = trpc.inventory.adjustStock.useMutation({
    onSuccess: () => {
      utils.inventory.list.invalidate();
      onClose();
      toast.success("Stock adjusted");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const maxAddition = Math.max(
    0,
    INVENTORY_STOCK_QUANTITY_MAX - productStockQuantity
  );
  const hasValidAdjustmentReason = isInventoryRequiredTextInputValid(
    reason,
    INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH
  );
  const hasValidAdjustmentQuantity = isInventoryPositiveIntegerInputValid(qty);
  const canAddStock =
    hasValidAdjustmentQuantity &&
    qty <= maxAddition &&
    hasValidAdjustmentReason &&
    !adjustMutation.isPending;
  const canRemoveStock =
    hasValidAdjustmentQuantity &&
    qty <= productStockQuantity &&
    hasValidAdjustmentReason &&
    !adjustMutation.isPending;

  const handleAdjust = (direction: 1 | -1) => {
    if (direction === 1 ? !canAddStock : !canRemoveStock) return;
    adjustMutation.mutate({
      id: productId,
      adjustment: qty * direction,
      reason: reason.trim(),
    });
  };

  return (
    <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-card p-3 shadow-lg">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        Adjust stock: {productName}
      </p>
      <Input
        type="number"
        min={INVENTORY_ADJUSTMENT_QUANTITY_MIN}
        max={INVENTORY_STOCK_QUANTITY_MAX}
        step={1}
        value={qty}
        onChange={(e) => {
          const next = parseInt(e.target.value, 10);
          setQty(
            Number.isFinite(next)
              ? Math.min(
                  INVENTORY_STOCK_QUANTITY_MAX,
                  Math.max(INVENTORY_ADJUSTMENT_QUANTITY_MIN, next)
                )
              : INVENTORY_ADJUSTMENT_QUANTITY_MIN
          );
        }}
        className="h-8 text-sm mb-2"
        placeholder="Quantity"
      />
      <Input
        value={reason}
        maxLength={INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH}
        onChange={(e) => setReason(e.target.value)}
        className="h-8 text-sm mb-2"
        placeholder="Reason *"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 h-7 text-xs"
          onClick={() => handleAdjust(1)}
          disabled={!canAddStock}
        >
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 h-7 text-xs"
          onClick={() => handleAdjust(-1)}
          disabled={!canRemoveStock}
        >
          <Minus className="h-3 w-3 mr-1" /> Remove
        </Button>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="mt-2 w-full h-7 text-xs"
        onClick={onClose}
      >
        Cancel
      </Button>
      {adjustMutation.error && (
        <p className="text-xs text-destructive mt-1">
          {adjustMutation.error.message}
        </p>
      )}
    </div>
  );
}

// --- Add Supplier Form ---

function AddSupplierForm({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const createMutation = trpc.inventory.createSupplier.useMutation({
    onSuccess: () => {
      utils.inventory.listSuppliers.invalidate();
      onClose();
      toast.success("Supplier added");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [form, setForm] = useState({
    name: "",
    contactEmail: "",
    phone: "",
    address: "",
    notes: "",
  });

  const canSubmit =
    isInventoryRequiredTextInputValid(
      form.name,
      INVENTORY_SUPPLIER_NAME_MAX_LENGTH
    ) &&
    isInventoryOptionalEmailInputValid(form.contactEmail) &&
    isInventoryOptionalTextInputValid(
      form.phone,
      INVENTORY_SUPPLIER_PHONE_MAX_LENGTH
    ) &&
    isInventoryOptionalTextInputValid(
      form.address,
      INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH
    ) &&
    isInventoryOptionalTextInputValid(
      form.notes,
      INVENTORY_SUPPLIER_NOTES_MAX_LENGTH
    );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    createMutation.mutate({
      name: form.name.trim(),
      contactEmail: trimmedOrUndefined(form.contactEmail)?.toLowerCase(),
      phone: trimmedOrUndefined(form.phone),
      address: trimmedOrUndefined(form.address),
      notes: trimmedOrUndefined(form.notes),
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 rounded-lg border border-border bg-card p-4 space-y-3"
    >
      <h3 className="font-medium text-sm">Add Supplier</h3>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Input
          placeholder="Name *"
          value={form.name}
          maxLength={INVENTORY_SUPPLIER_NAME_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <Input
          placeholder="Email"
          type="email"
          value={form.contactEmail}
          maxLength={INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
        />
        <Input
          placeholder="Phone"
          value={form.phone}
          maxLength={INVENTORY_SUPPLIER_PHONE_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
        <Input
          placeholder="Address"
          value={form.address}
          maxLength={INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
          className="col-span-2"
        />
        <Input
          placeholder="Notes"
          value={form.notes}
          maxLength={INVENTORY_SUPPLIER_NOTES_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit || createMutation.isPending}
        >
          {createMutation.isPending ? "Adding..." : "Add Supplier"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {createMutation.error && (
        <p className="text-sm text-destructive">
          {createMutation.error.message}
        </p>
      )}
    </form>
  );
}

// --- Edit Supplier Form ---

function EditSupplierRow({
  supplier,
  onClose,
}: {
  supplier: {
    id: string;
    name: string;
    contactEmail: string | null;
    phone: string | null;
    address: string | null;
    notes: string | null;
  };
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const updateMutation = trpc.inventory.updateSupplier.useMutation({
    onSuccess: () => {
      utils.inventory.listSuppliers.invalidate();
      onClose();
      toast.success("Supplier updated");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const [form, setForm] = useState({
    name: supplier.name,
    contactEmail: supplier.contactEmail ?? "",
    phone: supplier.phone ?? "",
    address: supplier.address ?? "",
    notes: supplier.notes ?? "",
  });

  const canSave =
    isInventoryRequiredTextInputValid(
      form.name,
      INVENTORY_SUPPLIER_NAME_MAX_LENGTH
    ) &&
    isInventoryOptionalEmailInputValid(form.contactEmail) &&
    isInventoryOptionalTextInputValid(
      form.phone,
      INVENTORY_SUPPLIER_PHONE_MAX_LENGTH
    ) &&
    isInventoryOptionalTextInputValid(
      form.address,
      INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH
    ) &&
    isInventoryOptionalTextInputValid(
      form.notes,
      INVENTORY_SUPPLIER_NOTES_MAX_LENGTH
    );

  const handleSave = () => {
    if (!canSave) return;
    const contactEmail = trimmedOrNull(form.contactEmail);
    updateMutation.mutate({
      id: supplier.id,
      name: form.name.trim(),
      contactEmail: contactEmail ? contactEmail.toLowerCase() : null,
      phone: trimmedOrNull(form.phone),
      address: trimmedOrNull(form.address),
      notes: trimmedOrNull(form.notes),
    });
  };

  return (
    <tr className="border-b border-border bg-muted/20">
      <td className="px-4 py-2">
        <Input
          value={form.name}
          maxLength={INVENTORY_SUPPLIER_NAME_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="h-8 text-sm"
        />
      </td>
      <td className="px-4 py-2">
        <Input
          type="email"
          value={form.contactEmail}
          maxLength={INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH}
          onChange={(e) =>
            setForm({ ...form, contactEmail: e.target.value })
          }
          className="h-8 text-sm"
        />
      </td>
      <td className="px-4 py-2">
        <Input
          value={form.phone}
          maxLength={INVENTORY_SUPPLIER_PHONE_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          className="h-8 text-sm"
        />
      </td>
      <td className="px-4 py-2">
        <Input
          value={form.address}
          maxLength={INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
          className="h-8 text-sm"
        />
      </td>
      <td className="px-4 py-2">
        <Input
          value={form.notes}
          maxLength={INVENTORY_SUPPLIER_NOTES_MAX_LENGTH}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          className="h-8 text-sm"
        />
      </td>
      <td className="px-4 py-2">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={handleSave}
            disabled={!canSave || updateMutation.isPending}
            title="Save supplier"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onClose}
            title="Cancel"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {updateMutation.error && (
          <p className="mt-1 text-xs text-destructive">
            {updateMutation.error.message}
          </p>
        )}
      </td>
    </tr>
  );
}

// --- Main Page ---

export default function InventoryPage() {
  const { data: session } = useSession();
  const formatCurrency = useCurrencyFormatter();
  const [tab, setTab] = useState<"products" | "suppliers">("products");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [alertFilter, setAlertFilter] = useState<AlertFilter>("all");
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSupplierId, setEditingSupplierId] = useState<string | null>(
    null
  );
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const searchFilter = search.trim();
  const canManageInventory = canManageInventoryRole(session?.user?.role);

  const productsQuery = trpc.inventory.list.useQuery(
    {
      search: searchFilter || undefined,
      category: category || undefined,
      alert: alertFilter,
      limit: 100,
      offset: 0,
    },
    { enabled: tab === "products" }
  );

  const suppliersQuery = trpc.inventory.listSuppliers.useQuery(undefined, {
    enabled: tab === "suppliers",
  });
  const productsMissing =
    tab === "products" &&
    !productsQuery.isLoading &&
    !productsQuery.error &&
    !productsQuery.data;
  const suppliersMissing =
    tab === "suppliers" &&
    !suppliersQuery.isLoading &&
    !suppliersQuery.error &&
    !suppliersQuery.data;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold">Inventory</h2>
          <p className="text-sm text-muted-foreground">
            Products, stock management, and suppliers
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-4 flex gap-1 border-b border-border">
        <button
          onClick={() => setTab("products")}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
            tab === "products"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <Package className="h-4 w-4" />
          Products
        </button>
        <button
          onClick={() => setTab("suppliers")}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
            tab === "suppliers"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <Truck className="h-4 w-4" />
          Suppliers
        </button>
      </div>

      {/* Products Tab */}
      {tab === "products" && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3 sm:gap-4">
            <div className="relative w-full min-w-48 flex-1 sm:max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name or SKU..."
                value={search}
                maxLength={INVENTORY_PRODUCT_SEARCH_MAX_LENGTH}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {CATEGORIES.map((cat) => (
                <option key={cat.value} value={cat.value}>
                  {cat.label}
                </option>
              ))}
            </select>
            <select
              value={alertFilter}
              onChange={(e) => setAlertFilter(e.target.value as AlertFilter)}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {ALERT_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
            {productsQuery.data && (
              <p className="text-sm text-muted-foreground">
                {productsQuery.data.total} product
                {productsQuery.data.total !== 1 ? "s" : ""}
              </p>
            )}
            {canManageInventory && (
              <Button
                size="sm"
                onClick={() => setShowAddProduct(true)}
                className="ml-auto"
              >
                <Plus className="h-4 w-4 mr-1" /> Add Product
              </Button>
            )}
          </div>

          {canManageInventory && showAddProduct && (
            <AddProductForm onClose={() => setShowAddProduct(false)} />
          )}

          {productsQuery.data && (
            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              <button
                type="button"
                onClick={() => setAlertFilter("attention")}
                className={cn(
                  "rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/40",
                  alertFilter === "attention" && "border-primary bg-primary/5"
                )}
              >
                <span className="flex items-center gap-2 text-muted-foreground">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  Needs attention
                </span>
                <span className="mt-1 block text-xl font-semibold">
                  {productsQuery.data.alertCounts.attention}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAlertFilter("low_stock")}
                className={cn(
                  "rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/40",
                  alertFilter === "low_stock" && "border-primary bg-primary/5"
                )}
              >
                <span className="text-muted-foreground">Low stock</span>
                <span className="mt-1 block text-xl font-semibold">
                  {productsQuery.data.alertCounts.lowStock}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAlertFilter("expired")}
                className={cn(
                  "rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/40",
                  alertFilter === "expired" && "border-primary bg-primary/5"
                )}
              >
                <span className="text-muted-foreground">Expired</span>
                <span className="mt-1 block text-xl font-semibold">
                  {productsQuery.data.alertCounts.expired}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAlertFilter("expiring_soon")}
                className={cn(
                  "rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/40",
                  alertFilter === "expiring_soon" &&
                    "border-primary bg-primary/5"
                )}
              >
                <span className="text-muted-foreground">Expiring soon</span>
                <span className="mt-1 block text-xl font-semibold">
                  {productsQuery.data.alertCounts.expiringSoon}
                </span>
              </button>
            </div>
          )}

          {productsQuery.error || productsMissing ? (
            <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
              {productsQuery.error?.message ??
                "Unable to load inventory products. Please retry."}
            </div>
          ) : productsQuery.isLoading ? (
            <div className="mt-6 text-center text-muted-foreground">
              Loading...
            </div>
          ) : productsQuery.data && productsQuery.data.items.length > 0 ? (
            <TableScroll className="mt-4 rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      SKU
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Category
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                      Unit Price
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Tax
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                      Cost
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                      Stock
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                      Reorder Pt
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Lot / Expiry
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {productsQuery.data.items.map((product) => {
                    if (canManageInventory && editingId === product.id) {
                      return (
                        <EditProductRow
                          key={product.id}
                          product={product}
                          onClose={() => setEditingId(null)}
                        />
                      );
                    }

                    const stock = stockBadge(product.stockStatus);
                    const expiration = expirationBadge(
                      product.expirationStatus
                    );

                    return (
                      <tr
                        key={product.id}
                        className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-3 font-medium">
                          {product.name}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {product.sku || "\u2014"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground capitalize">
                          {product.category || "\u2014"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatCurrency(product.unitPrice)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {product.taxable ? "Taxable" : "Not taxable"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                          {product.costPrice
                            ? formatCurrency(product.costPrice)
                            : "\u2014"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {product.stockQuantity}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                          {product.reorderPoint ?? "\u2014"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          <span className="block">
                            {product.lotNumber
                              ? `Lot ${product.lotNumber}`
                              : "\u2014"}
                          </span>
                          {product.expirationDate && (
                            <span className="block text-xs">
                              Exp {formatDateOnly(product.expirationDate)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            <span
                              className={cn(
                                "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
                                stock.className
                              )}
                            >
                              {stock.label}
                            </span>
                            {expiration && (
                              <span
                                className={cn(
                                  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                                  expiration.className
                                )}
                              >
                                {expiration.label}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {canManageInventory ? (
                            <div className="relative flex gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                onClick={() => setEditingId(product.id)}
                                title="Edit"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                onClick={() =>
                                  setAdjustingId(
                                    adjustingId === product.id
                                      ? null
                                      : product.id
                                  )
                                }
                                title="Adjust Stock"
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </Button>
                              {adjustingId === product.id && (
                                <StockAdjustPopover
                                  productId={product.id}
                                  productName={product.name}
                                  productStockQuantity={product.stockQuantity}
                                  onClose={() => setAdjustingId(null)}
                                />
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Read-only
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          ) : (
            <EmptyState
              className="mt-6"
              icon={Package}
              title={
                alertFilter !== "all"
                  ? "No products match this alert filter"
                  : search || category
                    ? "No products match your filters"
                    : "No products yet"
              }
              description={
                alertFilter !== "all"
                  ? "Clear the alert filter to see all inventory items."
                  : search || category
                    ? "Clear the search or category filter to broaden the list."
                    : "Add medications, supplies, food, and other inventory before dispensing or invoicing stock-backed items."
              }
              action={
                canManageInventory &&
                alertFilter === "all" &&
                !search &&
                !category
                  ? {
                      label: "Add first product",
                      onClick: () => setShowAddProduct(true),
                      icon: Plus,
                    }
                  : undefined
              }
            />
          )}
        </>
      )}

      {/* Suppliers Tab */}
      {tab === "suppliers" && (
        <>
          <div className="mt-4 flex items-center justify-between">
            {suppliersQuery.data && (
              <p className="text-sm text-muted-foreground">
                {suppliersQuery.data.length} supplier
                {suppliersQuery.data.length !== 1 ? "s" : ""}
              </p>
            )}
            {canManageInventory && (
              <Button
                size="sm"
                onClick={() => setShowAddSupplier(true)}
                className="ml-auto"
              >
                <Plus className="h-4 w-4 mr-1" /> Add Supplier
              </Button>
            )}
          </div>

          {canManageInventory && showAddSupplier && (
            <AddSupplierForm onClose={() => setShowAddSupplier(false)} />
          )}

          {suppliersQuery.error || suppliersMissing ? (
            <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
              {suppliersQuery.error?.message ??
                "Unable to load inventory suppliers. Please retry."}
            </div>
          ) : suppliersQuery.isLoading ? (
            <div className="mt-6 text-center text-muted-foreground">
              Loading...
            </div>
          ) : suppliersQuery.data && suppliersQuery.data.length > 0 ? (
            <TableScroll className="mt-4 rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Email
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Phone
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Address
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Notes
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {suppliersQuery.data.map((supplier) => {
                    if (
                      canManageInventory &&
                      editingSupplierId === supplier.id
                    ) {
                      return (
                        <EditSupplierRow
                          key={supplier.id}
                          supplier={supplier}
                          onClose={() => setEditingSupplierId(null)}
                        />
                      );
                    }

                    return (
                      <tr
                        key={supplier.id}
                        className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-3 font-medium">
                          {supplier.name}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {supplier.contactEmail || "\u2014"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {supplier.phone || "\u2014"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {supplier.address || "\u2014"}
                        </td>
                        <td
                          className="max-w-xs truncate px-4 py-3 text-muted-foreground"
                          title={supplier.notes ?? undefined}
                        >
                          {supplier.notes || "\u2014"}
                        </td>
                        <td className="px-4 py-3">
                          {canManageInventory ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              onClick={() => setEditingSupplierId(supplier.id)}
                              title="Edit supplier"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Read-only
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          ) : (
            <EmptyState
              className="mt-6"
              icon={Truck}
              title="No suppliers yet"
              description="Add supplier contact details so reorder workflows have the right vendor information at hand."
              action={
                canManageInventory
                  ? {
                      label: "Add first supplier",
                      onClick: () => setShowAddSupplier(true),
                      icon: Plus,
                    }
                  : undefined
              }
            />
          )}
        </>
      )}
    </div>
  );
}
