/**
 * The OpenVPM brand mark: a paw print. This is the single source for the
 * in-app logo so every surface (sidebar, e-sign / capture headers) renders
 * the same shape. The geometry matches `public/logo.svg` and
 * `public/favicon.svg`. No "use client" so it works in server components too.
 *
 * `PawMark` draws just the paw in `currentColor`; `BrandBadge` is the full
 * lockup (white paw on a teal rounded square) used wherever the brand appears
 * on its own.
 */

export function PawMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="16" rx="4.5" ry="3.5" />
      <ellipse cx="6" cy="9" rx="2" ry="2.5" />
      <ellipse cx="9.5" cy="4.5" rx="1.7" ry="2.2" />
      <ellipse cx="14.5" cy="4.5" rx="1.7" ry="2.2" />
      <ellipse cx="18" cy="9" rx="2" ry="2.5" />
    </svg>
  );
}

/** White paw on the brand teal, rounded square. `size` sets the square. */
export function BrandBadge({
  className,
  pawClassName = "h-4 w-4",
}: {
  className?: string;
  pawClassName?: string;
}) {
  return (
    <div
      className={
        "flex items-center justify-center rounded-lg bg-primary text-primary-foreground " +
        (className ?? "h-8 w-8")
      }
    >
      <PawMark className={pawClassName} />
    </div>
  );
}
