"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, BookOpen, CornerDownLeft, Monitor, Search as SearchIcon, X } from "lucide-react";
import { buildIndex, search, type SearchEntry } from "@/lib/search";

const OPEN_EVENT = "openvpm-help:search";

export function openSearch(query = "") {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: query }));
}

export function SearchButton({ variant = "header", placeholder }: { variant?: "header" | "hero"; placeholder?: string }) {
  return (
    <button type="button" className={variant === "hero" ? "hero-search" : "search-trigger"} onClick={() => openSearch()}>
      <SearchIcon className={variant === "hero" ? "h-5 w-5 text-primary" : "icon"} aria-hidden="true" />
      <span className={variant === "hero" ? "flex-1 truncate" : "sr-only flex-1 truncate md:not-sr-only"}>{placeholder ?? "Search guides"}</span>
      <kbd className="hidden md:inline">/</kbd>
    </button>
  );
}

export function SearchChip({ query }: { query: string }) {
  return (
    <button type="button" className="chip" onClick={() => openSearch(query)}>
      {query}
    </button>
  );
}

const suggestions = ["Take a payment", "Book a recurring visit", "Record a vaccine", "Refund an invoice", "Invite a teammate"];

export function SearchDialog({ entries }: { entries: SearchEntry[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const index = useMemo(() => buildIndex(entries), [entries]);
  const hits = useMemo(() => search(index, query), [index, query]);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    function onOpen(event: Event) {
      setQuery((event as CustomEvent<string>).detail ?? "");
      setActive(0);
      setOpen(true);
    }
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const typing = target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        setActive(0);
        setOpen(true);
      }
    }
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  if (!open) return null;

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (event.key === "Enter" && hits[active]) {
      event.preventDefault();
      go(hits[active].entry.href);
    }
  }

  return (
    <div className="search-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="Search the guides" onKeyDown={onKeyDown}>
        <div className="search-input-row">
          <SearchIcon className="h-5 w-5 text-primary" aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="What do you need to do?"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={listId}
            aria-activedescendant={hits[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
          />
          <button type="button" onClick={close} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close search">
            <X className="icon" />
          </button>
        </div>
        <div className="search-results">
          {query.trim() === "" ? (
            <div className="p-2">
              <p className="px-1 pb-2 text-xs font-semibold text-muted-foreground">Try</p>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button key={s} type="button" className="chip" onClick={() => setQuery(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : hits.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing matches “{query}” yet. Try fewer words, or email{" "}
              <a className="text-link" href="mailto:hello@openvpm.com">
                hello@openvpm.com
              </a>{" "}
              and we&apos;ll help.
            </p>
          ) : (
            <ul id={listId} role="listbox" aria-label="Results">
              {hits.map((hit, i) => {
                const Icon = hit.entry.section === "Screen" ? Monitor : BookOpen;
                return (
                  <li
                    key={hit.entry.href}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className="search-result cursor-pointer"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(hit.entry.href)}
                  >
                    <span className="icon-tile mt-0.5">
                      <Icon className="icon" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-[color:var(--ink)]">{hit.entry.title}</span>
                      <small className="truncate">
                        {hit.entry.section} · {hit.entry.summary}
                      </small>
                    </span>
                    {i === active ? (
                      <CornerDownLeft className="icon mt-2 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ArrowRight className="icon mt-2 text-transparent" aria-hidden="true" />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
