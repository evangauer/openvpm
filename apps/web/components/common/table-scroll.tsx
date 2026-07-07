"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Horizontal-scroll wrapper for wide tables. Shows a right-edge fade while
 * more columns sit off-screen so narrow viewports (tablet) discover that the
 * table scrolls instead of assuming the trailing columns don't exist.
 */
export function TableScroll({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = React.useState(false);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setMoreRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={cn("relative overflow-hidden", className)}>
      <div ref={scrollRef} className="overflow-x-auto">
        {children}
      </div>
      {moreRight ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-card to-transparent"
        />
      ) : null}
    </div>
  );
}
