import type { BeforeSend } from "@vercel/analytics";

const CAPABILITY_PATH_PATTERN = /^\/(?:capture|sign)(?:\/|$)/;
const SENSITIVE_QUERY_PARAMETERS = ["checkout_attribution"] as const;

export function sanitizeAnalyticsUrl(value: string): string | null {
  try {
    const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
    const url = new URL(value, "https://analytics.invalid");
    for (const parameter of SENSITIVE_QUERY_PARAMETERS) {
      url.searchParams.delete(parameter);
    }
    if (isAbsolute) return url.toString();
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/**
 * Capability URLs are credentials. Drop every analytics event emitted while a
 * visitor is on one of those pages so the raw token never leaves the browser.
 */
export const filterVercelAnalyticsEvent: BeforeSend = (event) => {
  try {
    const pathname = new URL(event.url, "https://analytics.invalid").pathname;
    if (CAPABILITY_PATH_PATTERN.test(pathname)) return null;
    const sanitizedUrl = sanitizeAnalyticsUrl(event.url);
    if (!sanitizedUrl) return null;
    return sanitizedUrl === event.url ? event : { ...event, url: sanitizedUrl };
  } catch {
    // An unparseable URL is not useful analytics and may contain a credential.
    return null;
  }
};
