"use client";

import { useState } from "react";
import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const PRESETS = ["#0d9488", "#16a34a", "#f97316", "#db2777"];

function isHex(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

/**
 * Accent color picker: four brand presets plus a custom swatch that opens a
 * native color picker + hex input (the "click the blank swatch, paste a hex"
 * pattern). Shared by the Settings branding section and the onboarding journey.
 */
export function AccentColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (hex: string) => void;
  disabled?: boolean;
}) {
  const current = (value ?? "").toLowerCase();
  const customActive = !!current && !PRESETS.includes(current);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(customActive ? current : "#0d9488");

  return (
    <div className="flex items-center gap-2.5">
      {PRESETS.map((c) => {
        const active = current === c;
        return (
          <button
            key={c}
            type="button"
            aria-label={`Use accent color ${c}`}
            disabled={disabled}
            onClick={() => onChange(c)}
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full border-2 transition-transform disabled:opacity-50",
              active
                ? "scale-110 border-foreground"
                : "border-transparent hover:scale-105"
            )}
            style={{ backgroundColor: c }}
          >
            {active ? <Check className="h-4 w-4 text-white" /> : null}
          </button>
        );
      })}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Custom accent color"
            disabled={disabled}
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full border-2 transition-transform disabled:opacity-50",
              customActive
                ? "scale-110 border-foreground"
                : "border-dashed border-muted-foreground/40 hover:scale-105"
            )}
            style={customActive ? { backgroundColor: current } : undefined}
          >
            {customActive ? (
              <Check className="h-4 w-4 text-white" />
            ) : (
              <Plus className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56">
          <p className="text-sm font-medium">Custom accent</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pick a color or paste a hex code.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="color"
              value={isHex(draft) ? draft : "#0d9488"}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Color picker"
              className="h-9 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
            />
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="#0d9488"
              maxLength={7}
              className="h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <Button
            size="sm"
            className="mt-3 w-full"
            disabled={!isHex(draft) || disabled}
            onClick={() => {
              onChange(draft.toLowerCase());
              setOpen(false);
            }}
          >
            Apply color
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
