import type { BeforeSend } from "@vercel/analytics";

const CAPABILITY_PATH_PATTERN = /^\/(?:capture|sign)(?:\/|$)/;

/**
 * Capability URLs are credentials. Drop every analytics event emitted while a
 * visitor is on one of those pages so the raw token never leaves the browser.
 */
export const filterVercelAnalyticsEvent: BeforeSend = (event) => {
  try {
    const pathname = new URL(event.url, "https://analytics.invalid").pathname;
    return CAPABILITY_PATH_PATTERN.test(pathname) ? null : event;
  } catch {
    // An unparseable URL is not useful analytics and may contain a credential.
    return null;
  }
};
