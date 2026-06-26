import { cn } from "@/lib/utils";

interface ProgressProps {
  /** Completion percentage, 0–100. Clamped. */
  value: number;
  className?: string;
  indicatorClassName?: string;
}

/**
 * A minimal, dependency-free progress bar. Shared by the activation checklist,
 * onboarding journey, and tour so they stop hand-rolling their own bars.
 */
export function Progress({ value, className, indicatorClassName }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "h-2 w-full overflow-hidden rounded-full bg-muted",
        className
      )}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-700 ease-out",
          indicatorClassName
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
