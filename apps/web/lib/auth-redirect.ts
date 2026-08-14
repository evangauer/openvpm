const AUTH_ROUTES = ["/login", "/register", "/verify-email"];

/** Keep post-auth redirects same-origin and out of authentication loops. */
export function safeAuthNextPath(
  value: string | null | undefined,
  fallback: string,
): string {
  if (
    !value ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]/.test(value)
  ) {
    return fallback;
  }

  try {
    const base = "https://app.openvpm.invalid";
    const parsed = new URL(value, base);
    if (parsed.origin !== base) return fallback;
    if (AUTH_ROUTES.some((route) => parsed.pathname.startsWith(route))) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
