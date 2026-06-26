/**
 * Email design tokens, mirrored from the marketing site (openvpm.com):
 * teal-600 brand, DM Sans headings / Inter body, clean white cards on a soft
 * slate page. Kept as plain values so every template stays consistent.
 */
export const theme = {
  // Brand
  brand: "#0d9488", // teal-600
  brandDark: "#0f766e", // teal-700
  brandTint: "#f0fdfa", // teal-50
  brandTintBorder: "#ccfbf1", // teal-100

  // Text
  text: "#0f172a", // slate-900
  muted: "#475569", // slate-600
  subtle: "#64748b", // slate-500
  faint: "#94a3b8", // slate-400

  // Surfaces
  page: "#f1f5f9", // slate-100
  card: "#ffffff",
  border: "#e2e8f0", // slate-200

  // Semantic tints (for InfoCard tones)
  successTint: "#f0fdf4",
  successBorder: "#bbf7d0",
  successText: "#15803d",
  warningTint: "#fffbeb",
  warningBorder: "#fde68a",
  warningText: "#b45309",
  dangerTint: "#fef2f2",
  dangerBorder: "#fecaca",
  dangerText: "#b91c1c",

  // Shape & type
  radius: 8,
  radiusLg: 16,
  fontBody:
    "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontHeading:
    "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
} as const;
