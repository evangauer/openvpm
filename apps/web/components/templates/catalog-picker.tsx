"use client";

import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronsUpDown, Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { TEMPLATE_CATALOG_SEARCH_MAX_LENGTH } from "@/lib/templates/catalog-search";

export type TemplateCatalogItem = {
  id: string;
  itemType: "service" | "product";
  name: string;
  code: string | null;
  category: string | null;
  unitPrice: string;
};

export function TemplateCatalogPicker({
  itemType,
  value,
  selectedLabel,
  excludedIds,
  onSelect,
  formatPrice,
}: {
  itemType: "service" | "product";
  value: string | null;
  selectedLabel: string;
  excludedIds: string[];
  onSelect: (item: TemplateCatalogItem | null) => void;
  formatPrice: (price: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const queryIsStale = query !== deferredQuery;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const catalogQuery = trpc.templates.searchCatalog.useQuery(
    { itemType, search: deferredQuery },
    { enabled: open },
  );
  const excluded = useMemo(() => new Set(excludedIds), [excludedIds]);
  const results = useMemo(
    () =>
      (catalogQuery.data ?? []).filter(
        (item) => item.id === value || !excluded.has(item.id),
      ),
    [catalogQuery.data, excluded, value],
  );
  const activeOption =
    !queryIsStale && !catalogQuery.isFetching && !catalogQuery.error
      ? results[highlight]
      : undefined;
  const activeOptionId = activeOption
    ? `${listboxId}-option-${activeOption.id}`
    : undefined;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [deferredQuery, itemType, open]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (item: TemplateCatalogItem) => {
    onSelect(item);
    close();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      setHighlight((current) =>
        Math.min(current + 1, Math.max(results.length - 1, 0)),
      );
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      setHighlight((current) => Math.max(current - 1, 0));
      event.preventDefault();
    } else if (event.key === "Enter") {
      if (activeOption) choose(activeOption);
      event.preventDefault();
    } else if (event.key === "Escape") {
      close();
      event.preventDefault();
    }
  };

  const label = itemType === "service" ? "service" : "inventory product";

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        className={cn(
          "flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm",
          !value && "text-muted-foreground",
        )}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
            setOpen(true);
            setTimeout(() => inputRef.current?.focus(), 0);
            event.preventDefault();
          }
        }}
      >
        <span className="truncate">
          {value ? selectedLabel : `Search ${label}s...`}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0" />
      </button>

      {open ? (
        <div className="absolute z-40 mt-1 w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-popover shadow-lg">
          <div className="flex min-h-11 items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              role="combobox"
              aria-label={`Search ${label}s`}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={activeOptionId}
              maxLength={TEMPLATE_CATALOG_SEARCH_MAX_LENGTH}
              value={query}
              placeholder={`Search ${label} name, code, or category`}
              className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                className="rounded p-2 text-muted-foreground hover:bg-accent"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          {value ? (
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 border-b border-border px-3 text-left text-sm text-muted-foreground hover:bg-accent"
              onClick={() => {
                onSelect(null);
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <X className="h-4 w-4" /> Clear selected {label}
            </button>
          ) : null}

          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={`Available ${label}s`}
            aria-busy={queryIsStale || catalogQuery.isFetching}
            className="max-h-72 overflow-y-auto p-1"
          >
            {queryIsStale || catalogQuery.isFetching ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching...
              </div>
            ) : catalogQuery.error ? (
              <div role="alert" className="px-3 py-6 text-sm text-destructive">
                Catalog search failed. Edit the query to retry.
              </div>
            ) : results.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No active {label}s match &quot;{query.trim()}&quot;.
              </p>
            ) : (
              results.map((item, index) => (
                <button
                  key={item.id}
                  id={`${listboxId}-option-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={item.id === value}
                  data-index={index}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm",
                    index === highlight && "bg-accent",
                  )}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => choose(item)}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center",
                      item.id === value ? "text-primary" : "text-transparent",
                    )}
                  >
                    <Check className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {item.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[item.code, item.category].filter(Boolean).join(" · ") ||
                        "No code or category"}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatPrice(item.unitPrice)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
