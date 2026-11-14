"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { Pin, PinOff, Search, X } from "lucide-react";
import type { NavigationItem } from "@/lib/navigation";
import type { SidebarLayout } from "@/lib/sidebar-pins";
import { cn } from "@/lib/utils";

export function SidebarTools({
  children,
  open,
  onOpenChange,
  items,
  pinned,
  layout,
  onLayoutChange,
  onTogglePin,
  onNavigate,
}: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: NavigationItem[];
  pinned: string[];
  layout: SidebarLayout;
  onLayoutChange: (layout: SidebarLayout) => void;
  onTogglePin: (href: string) => void;
  onNavigate?: () => void;
}) {
  const [query, setQuery] = useState("");
  const terms = query.trim().toLocaleLowerCase().split(/\s+/);
  const filtered = items.filter((item) => {
    const text = `${item.label} ${item.description}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const navigate = () => {
    onOpenChange(false);
    onNavigate?.();
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (value) setQuery("");
      }}
    >
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[101] flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-background p-4 shadow-xl sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="font-heading text-xl font-semibold">
                Tools
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                Open a tool or pin it for focused navigation.
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="rounded-md p-2 text-muted-foreground hover:bg-accent"
              aria-label="Close tools"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <fieldset className="mt-4 shrink-0">
            <legend className="mb-2 text-xs font-medium text-muted-foreground">
              Sidebar layout
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  [
                    "full",
                    "Full navigation",
                    "All tabs in their familiar order",
                  ],
                  [
                    "focused",
                    "Focused navigation",
                    "Six core tabs plus your pinned tools",
                  ],
                ] as const
              ).map(([value, label, description]) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-lg border p-3 focus-within:ring-2 focus-within:ring-ring",
                    layout === value
                      ? "border-primary bg-primary/5"
                      : "border-border",
                  )}
                >
                  <input
                    type="radio"
                    name="sidebar-layout"
                    value={value}
                    checked={layout === value}
                    onChange={() => onLayoutChange(value)}
                    aria-label={label}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      {description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="my-4 flex shrink-0 items-center gap-2 rounded-md border border-input px-3 focus-within:ring-2 focus-within:ring-ring">
            <Search
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="sr-only">Search tools</span>
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none"
              placeholder="Search tools…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <ul
            className="min-h-0 flex-1 space-y-1 overflow-y-auto"
            aria-label="Available tools"
          >
            {filtered.map((item) => {
              const isPinned = pinned.includes(item.href);
              const content = (
                <>
                  <span className="rounded-lg bg-primary/10 p-2.5 text-primary">
                    <item.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {item.label}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {item.description}
                    </span>
                  </span>
                </>
              );
              const props = {
                className:
                  "flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 hover:bg-accent",
                onClick: navigate,
                "aria-label": `Open ${item.label}`,
              };
              return (
                <li
                  key={item.href}
                  className="flex items-center gap-2 rounded-lg border border-transparent p-1 hover:border-border"
                >
                  {item.href.startsWith("/offline/") ? (
                    <a href={item.href} {...props}>
                      {content}
                    </a>
                  ) : (
                    <Link href={item.href} {...props}>
                      {content}
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => onTogglePin(item.href)}
                    aria-pressed={isPinned}
                    aria-label={`${isPinned ? "Unpin" : "Pin"} ${item.label}`}
                    title={`${isPinned ? "Unpin" : "Pin"} ${item.label}`}
                    className={cn(
                      "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border",
                      isPinned
                        ? "border-primary/20 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {isPinned ? (
                      <PinOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Pin className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {!filtered.length && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No tools match your search.
            </p>
          )}
          <p className="mt-4 shrink-0 border-t pt-3 text-xs text-muted-foreground">
            Switch layouts anytime. Your layout and pins are saved for this
            account in this browser.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
