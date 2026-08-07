"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ServicePickerService {
  id: string;
  name: string;
  category?: string | null;
  defaultPrice: string;
}

/**
 * Type-ahead service picker for charge capture. Front-desk speed is the whole
 * game (see the PIMS research in the ledger): one search box over the whole
 * service list, prefix matches ranked first, category and price visible on
 * every row, and a full keyboard flow (arrows + Enter, Escape closes).
 * Replaces the plain <select>, which stops scaling past a few dozen services.
 */
export function ServicePicker({
  services,
  value,
  onSelect,
  disabled,
  formatPrice,
}: {
  services: ServicePickerService[];
  value: string;
  onSelect: (serviceId: string) => void;
  disabled?: boolean;
  formatPrice?: (price: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = services.find((s) => s.id === value) ?? null;

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return services;
    const starts: ServicePickerService[] = [];
    const contains: ServicePickerService[] = [];
    for (const s of services) {
      const name = s.name.toLowerCase();
      const category = s.category?.toLowerCase() ?? "";
      if (name.startsWith(q)) starts.push(s);
      else if (name.includes(q) || category.includes(q)) contains.push(s);
    }
    return [...starts, ...contains];
  }, [services, query]);

  // Close on any click outside the control.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  // Keep the highlighted row in view while arrowing through results.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${highlight}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function choose(service: ServicePickerService) {
    onSelect(service.id);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
      setOpen(true);
      event.preventDefault();
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown") {
      setHighlight((h) => Math.min(h + 1, results.length - 1));
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      setHighlight((h) => Math.max(h - 1, 0));
      event.preventDefault();
    } else if (event.key === "Enter") {
      const service = results[highlight];
      if (service) choose(service);
      event.preventDefault();
    } else if (event.key === "Escape") {
      setOpen(false);
      setQuery("");
      event.preventDefault();
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((v) => !v);
          // Focus lands in the search box so typing starts immediately.
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm",
          "disabled:cursor-not-allowed disabled:opacity-50",
          !selected && "text-muted-foreground"
        )}
      >
        <span className="truncate">
          {selected ? selected.name : "Search services..."}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[320px] rounded-md border border-border bg-popover shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Type a service name..."
              aria-label="Search services"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {results.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No services match &quot;{query}&quot;.
              </p>
            ) : (
              results.map((service, index) => (
                <button
                  key={service.id}
                  type="button"
                  role="option"
                  aria-selected={service.id === value}
                  data-index={index}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => choose(service)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm",
                    index === highlight && "bg-accent"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center",
                      service.id === value ? "text-primary" : "text-transparent"
                    )}
                  >
                    <Check className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {service.name}
                  </span>
                  {service.category ? (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {service.category}
                    </span>
                  ) : null}
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatPrice
                      ? formatPrice(service.defaultPrice)
                      : `$${service.defaultPrice}`}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
