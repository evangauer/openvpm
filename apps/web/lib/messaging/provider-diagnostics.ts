const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const PHONE_OR_TAX_ID =
  /(?<![A-Za-z0-9])(?:\+?\d[\d().\s-]{7,}\d)(?![A-Za-z0-9])/g;
const LONG_PROVIDER_TOKEN = /\b[A-Za-z0-9_-]{20,}\b/g;

/** Sanitize untrusted provider text before it is persisted or logged. */
export function sanitizeProviderDiagnostic(
  value: unknown,
  maxLength = 300,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(EMAIL, "[redacted email]")
    .replace(UUID, "[redacted id]")
    .replace(PHONE_OR_TAX_ID, "[redacted number]")
    .replace(LONG_PROVIDER_TOKEN, "[redacted id]")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, Math.max(1, maxLength));
}

/** Build an actionable diagnostic from allowlisted provider fields only. */
export function providerHttpErrorDiagnostic(
  provider: string,
  status: number,
  payload: unknown,
): string {
  const errors = Array.isArray((payload as { errors?: unknown } | null)?.errors)
    ? ((payload as { errors: unknown[] }).errors ?? [])
    : [];
  const safeParts = errors
    .slice(0, 3)
    .map((entry) => {
      const row = entry as { code?: unknown; title?: unknown };
      const code = sanitizeProviderDiagnostic(row.code, 64);
      const title = sanitizeProviderDiagnostic(row.title, 120);
      return [code ? `code ${code}` : null, title].filter(Boolean).join(": ");
    })
    .filter(Boolean);
  return `${provider} request failed (${status})${
    safeParts.length > 0 ? `: ${safeParts.join("; ")}` : ""
  }`;
}
