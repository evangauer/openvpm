export const CLIENT_ERROR_SOURCES = [
  "app-error",
  "global-error",
  "react-error-boundary",
] as const;

export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

export const CLIENT_ERROR_FAMILIES = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "AggregateError",
  "DOMException",
] as const;

export type ClientErrorFamily = (typeof CLIENT_ERROR_FAMILIES)[number];

const CLIENT_ERROR_FAMILY_SET = new Set<string>(CLIENT_ERROR_FAMILIES);
const SAFE_DIGEST_RE = /^[A-Za-z0-9._-]{1,120}$/;

const STATIC_ROUTES = new Set([
  "/",
  "/accept-invite",
  "/admin",
  "/agent",
  "/api-docs",
  "/api-docs/ai",
  "/billing",
  "/billing/new",
  "/clients",
  "/clients/new",
  "/controlled-substances",
  "/forgot-password",
  "/inbox",
  "/inventory",
  "/lab-results",
  "/legal/privacy",
  "/legal/terms",
  "/login",
  "/onboarding",
  "/patients",
  "/patients/duplicates",
  "/patients/new",
  "/recalls",
  "/records",
  "/register",
  "/reports",
  "/reset-password",
  "/schedule",
  "/settings",
  "/verify-email",
  "/whiteboard",
]);

const DYNAMIC_ROUTES: Array<[RegExp, string]> = [
  [/^\/book\/[^/]+$/, "/book/:slug"],
  [/^\/capture\/[^/]+$/, "/capture/:token"],
  [/^\/clients\/[^/]+\/edit$/, "/clients/:id/edit"],
  [/^\/clients\/[^/]+$/, "/clients/:id"],
  [/^\/encounters\/[^/]+$/, "/encounters/:id"],
  [/^\/patients\/[^/]+\/edit$/, "/patients/:id/edit"],
  [/^\/patients\/[^/]+$/, "/patients/:id"],
  [/^\/portal\/[^/]+\/appointments$/, "/portal/:token/appointments"],
  [/^\/portal\/[^/]+\/book$/, "/portal/:token/book"],
  [/^\/portal\/[^/]+\/invoices$/, "/portal/:token/invoices"],
  [/^\/portal\/[^/]+\/messages$/, "/portal/:token/messages"],
  [/^\/portal\/[^/]+\/pets\/[^/]+$/, "/portal/:token/pets/:id"],
  [/^\/portal\/[^/]+$/, "/portal/:token"],
  [/^\/records\/new-soap\/[^/]+$/, "/records/new-soap/:id"],
  [/^\/records\/replace-soap\/[^/]+$/, "/records/replace-soap/:id"],
  [/^\/sign\/[^/]+$/, "/sign/:token"],
  [/^\/sms\/[^/]+\/opt-in$/, "/sms/:id/opt-in"],
  [/^\/sms\/[^/]+\/privacy$/, "/sms/:id/privacy"],
  [/^\/sms\/[^/]+\/terms$/, "/sms/:id/terms"],
  [/^\/sms\/[^/]+$/, "/sms/:id"],
];

export function classifyClientError(error: Error): ClientErrorFamily {
  return CLIENT_ERROR_FAMILY_SET.has(error.name)
    ? (error.name as ClientErrorFamily)
    : "Error";
}

export function sanitizeClientErrorDigest(
  digest: string | null | undefined
): string | null {
  return digest && SAFE_DIGEST_RE.test(digest) ? digest : null;
}

export function sanitizeClientErrorPath(
  input: string | null | undefined
): string | null {
  if (!input) return null;

  let pathname: string;
  try {
    pathname = new URL(input, "https://openvpm.local").pathname;
  } catch {
    return "/other";
  }

  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  if (STATIC_ROUTES.has(pathname)) return pathname;

  for (const [pattern, template] of DYNAMIC_ROUTES) {
    if (pattern.test(pathname)) return template;
  }

  return "/other";
}
