"use client";

import { useEffect, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react";
import { Command } from "cmdk";
import type { AppRouter } from "@/server/routers/_app";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type PrescriptionInventoryProduct =
  RouterOutputs["inventory"]["list"]["items"][number];

const SEARCH_DEBOUNCE_MS = 200;
const RESULT_LIMIT = 50;

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);

  return debounced;
}

export function PrescriptionInventoryProductPicker({
  value,
  selectedProduct,
  onChange,
}: {
  value: string;
  selectedProduct: PrescriptionInventoryProduct | null;
  onChange: (product: PrescriptionInventoryProduct | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const normalizedSearch = debouncedSearch.trim();
  const products = trpc.inventory.list.useQuery(
    {
      search: normalizedSearch || undefined,
      limit: RESULT_LIMIT,
      offset: 0,
    },
    { enabled: open },
  );

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) setSearch("");
  }

  function selectProduct(product: PrescriptionInventoryProduct | null) {
    onChange(product);
    changeOpen(false);
  }

  const visibleProducts = products.data?.items ?? [];
  const total = products.data?.total ?? 0;

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Inventory item"
          className="h-10 w-full justify-between px-3 font-normal"
        >
          <span
            className={cn(
              "truncate",
              !selectedProduct && "text-muted-foreground",
            )}
          >
            {selectedProduct?.name ?? "Not dispensed from inventory"}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter={false}>
          <div className="flex items-center border-b border-border px-3">
            {products.isFetching ? (
              <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <Command.Input
              value={search}
              onValueChange={setSearch}
              autoFocus
              placeholder="Search inventory by name or SKU..."
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="max-h-64 overflow-y-auto p-1">
            <Command.Item
              value="not-dispensed-from-inventory"
              onSelect={() => selectProduct(null)}
              className="flex cursor-pointer items-center rounded-sm px-2 py-2 text-sm aria-selected:bg-accent"
            >
              <Check
                className={cn(
                  "mr-2 h-4 w-4",
                  value ? "opacity-0" : "opacity-100",
                )}
              />
              Not dispensed from inventory
            </Command.Item>
            {products.error ? (
              <div className="px-2 py-4 text-center text-sm text-destructive">
                <p>Inventory unavailable. Please retry.</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void products.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {!products.error &&
            !products.isLoading &&
            visibleProducts.length === 0 ? (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                No inventory items found.
              </div>
            ) : null}
            {!products.error
              ? visibleProducts.map((product) => (
                  <Command.Item
                    key={product.id}
                    value={product.id}
                    onSelect={() => selectProduct(product)}
                    className="flex cursor-pointer items-start rounded-sm px-2 py-2 text-sm aria-selected:bg-accent"
                  >
                    <Check
                      className={cn(
                        "mr-2 mt-0.5 h-4 w-4 shrink-0",
                        value === product.id ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{product.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {product.stockQuantity} units on hand ·{" "}
                        {product.unitPrice} each
                        {product.sku ? ` · SKU ${product.sku}` : ""}
                      </span>
                    </span>
                  </Command.Item>
                ))
              : null}
          </Command.List>
          {!products.error && total > visibleProducts.length ? (
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              Showing {visibleProducts.length} of {total} matches. Type more to
              narrow the list.
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
