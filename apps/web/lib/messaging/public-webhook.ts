import { normalizeAppBaseUrl } from "@/lib/app-url";

const LOCAL_WEBHOOK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

/** Build the canonical Telnyx callback only from a publicly routable HTTPS origin. */
export function publicTelnyxWebhookUrl(rawBase: unknown): string | null {
  const normalized = normalizeAppBaseUrl(rawBase);
  if (!normalized) return null;

  const baseUrl = new URL(normalized);
  const hostname = baseUrl.hostname.toLowerCase();
  if (
    baseUrl.protocol !== "https:" ||
    LOCAL_WEBHOOK_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".local")
  ) {
    return null;
  }

  return new URL("/api/webhooks/telnyx", baseUrl).toString();
}
