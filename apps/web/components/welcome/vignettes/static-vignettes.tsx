"use client";

import { CalendarPlus, ClipboardList, Globe, PawPrint } from "lucide-react";

/**
 * Static faux-UI Polaroid images: tiny mock scenes of the real product
 * doing the thing, tinted through the primary token so every clinic sees
 * them in its own brand color. Concrete beats abstract for this audience:
 * "here is literally what you'll see."
 */

/** Mini day sheet: today's schedule with a live visit and a checked-in pet. */
export function DayVignette() {
  return (
    <div
      className="flex h-full w-full flex-col justify-center gap-1.5 bg-gradient-to-br from-orange-50 to-violet-50 p-3"
      aria-label="Example: today's schedule with Biscuit checked in at 9:00"
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <ClipboardList className="h-3 w-3" aria-hidden="true" />
        Today
      </div>
      <div className="flex items-center gap-2">
        <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">
          9:00
        </span>
        <span className="flex flex-1 items-center gap-1.5 rounded-md bg-primary/15 px-2 py-1 text-xs font-medium text-primary">
          <PawPrint className="h-3 w-3" aria-hidden="true" />
          Biscuit · Wellness
          <span className="ml-auto rounded-full bg-white px-1.5 py-0.5 text-[9px] font-semibold text-primary shadow-sm">
            Here
          </span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">
          11:30
        </span>
        <span className="flex-1 rounded-md bg-white px-2 py-1 text-xs text-foreground shadow-sm">
          Luna · Vaccines
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">
          2:00
        </span>
        <span className="flex-1 rounded-md border border-dashed border-border bg-white/60 px-2 py-1 text-xs text-muted-foreground">
          Open slot
        </span>
      </div>
    </div>
  );
}

/** Mini portal: what a pet parent sees from their private link. */
export function PortalVignette() {
  return (
    <div
      className="flex h-full w-full flex-col justify-center gap-2 bg-gradient-to-br from-pink-50 to-emerald-50 p-3"
      aria-label="Example: a pet parent's portal with visits and bills"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary">
          <PawPrint className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div className="leading-tight">
          <p className="text-xs font-semibold">Biscuit</p>
          <p className="text-[10px] text-muted-foreground">
            Jordan&apos;s portal
          </p>
        </div>
        <Globe
          className="ml-auto h-3.5 w-3.5 text-muted-foreground"
          aria-hidden="true"
        />
      </div>
      <div className="flex gap-1.5">
        {["Visits", "Vaccines", "Bills"].map((tab, i) => (
          <span
            key={tab}
            className={
              i === 0
                ? "rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground"
                : "rounded-full bg-white px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm"
            }
          >
            {tab}
          </span>
        ))}
      </div>
      <div className="rounded-md bg-white px-2 py-1.5 text-[11px] leading-4 text-foreground shadow-sm">
        Next visit: Tuesday 9:00
        <span className="mt-0.5 block text-[10px] text-muted-foreground">
          Request a new visit any time
        </span>
      </div>
    </div>
  );
}

/** Mini month calendar with a clinic event landed in it. */
export function CalendarVignette() {
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  return (
    <div
      className="flex h-full w-full flex-col justify-center gap-1.5 bg-gradient-to-br from-emerald-50 to-violet-50 p-3"
      aria-label="Example: the clinic schedule inside your own calendar app"
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <CalendarPlus className="h-3 w-3" aria-hidden="true" />
        Your calendar
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => (
          <span
            key={d}
            className={
              d === 10
                ? "flex h-4 items-center justify-center rounded-sm bg-primary text-[8px] font-semibold text-primary-foreground"
                : "flex h-4 items-center justify-center rounded-sm bg-white text-[8px] text-muted-foreground shadow-sm"
            }
          >
            {d}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5 rounded-md bg-white px-2 py-1 text-[10px] text-foreground shadow-sm">
        <span
          className="h-2 w-2 rounded-full bg-primary"
          aria-hidden="true"
        />
        Biscuit · Wellness · 9:00
      </div>
    </div>
  );
}
