/**
 * Funnel analytics helpers for demo → signup attribution.
 *
 * Event names are stable contracts for Vercel Web Analytics custom events and
 * the Monday conversion digest. Keep values short, snake_case, and free of PHI.
 */

import { ACQUISITION_VALUE_MAX_LENGTH } from "@/lib/acquisition";

export const FUNNEL_EVENTS = {
  demoLand: "demo_land",
  demoGateViewed: "demo_gate_viewed",
  demoGateSubmitted: "demo_gate_submitted",
  demoRoleSelected: "demo_role_selected",
  demoToolOpened: "demo_tool_opened",
  demoCtaStartClinic: "demo_cta_start_clinic",
  signupLand: "signup_land",
} as const;

export type FunnelEventName =
  (typeof FUNNEL_EVENTS)[keyof typeof FUNNEL_EVENTS];

/** Stable tool ids used in picker / demo path mapping / UTMs. */
export type FunnelToolId =
  | "ask_ai"
  | "day_board"
  | "whiteboard"
  | "client_portal"
  | "patients"
  | "clients"
  | "records"
  | "billing"
  | "inbox"
  | "inventory"
  | "reports"
  | "settings"
  | "dashboard"
  | "other";

const PATH_TOOL_MAP: Array<{ prefix: string; tool: FunnelToolId }> = [
  { prefix: "/agent", tool: "ask_ai" },
  { prefix: "/schedule", tool: "day_board" },
  { prefix: "/whiteboard", tool: "whiteboard" },
  { prefix: "/portal", tool: "client_portal" },
  { prefix: "/patients", tool: "patients" },
  { prefix: "/clients", tool: "clients" },
  { prefix: "/records", tool: "records" },
  { prefix: "/billing", tool: "billing" },
  { prefix: "/inbox", tool: "inbox" },
  { prefix: "/inventory", tool: "inventory" },
  { prefix: "/reports", tool: "reports" },
  { prefix: "/settings", tool: "settings" },
  { prefix: "/", tool: "dashboard" },
];

export function funnelToolFromPath(pathname: string): FunnelToolId {
  const path = pathname.split("?")[0] || "/";
  for (const { prefix, tool } of PATH_TOOL_MAP) {
    if (prefix === "/") {
      if (path === "/" || path === "") return tool;
      continue;
    }
    if (path === prefix || path.startsWith(`${prefix}/`)) return tool;
  }
  return "other";
}

function cleanParam(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > ACQUISITION_VALUE_MAX_LENGTH) return undefined;
  return /^[a-zA-Z0-9._:/-]+$/.test(trimmed) ? trimmed : undefined;
}

export type CloudSignupUrlOptions = {
  /** Absolute app origin (e.g. https://app.openvpm.com). Empty → relative /register. */
  appOrigin?: string | null;
  tool?: FunnelToolId | string | null;
  source?: string;
  medium?: string;
  campaign?: string;
};

/**
 * Build the Cloud register URL with acquisition params the signup API accepts.
 * Demo CTAs should always go through this so UTMs land on practice.settings.acquisition.
 */
export function buildCloudSignupUrl(opts: CloudSignupUrlOptions = {}): string {
  const params = new URLSearchParams();
  params.set("intent", "cloud");
  const source = cleanParam(opts.source) ?? "demo";
  const medium = cleanParam(opts.medium) ?? "product";
  const campaign =
    cleanParam(opts.campaign) ??
    cleanParam(opts.tool ? `demo_${opts.tool}` : "demo_cta") ??
    "demo_cta";
  params.set("source", source);
  params.set("utm_source", source);
  params.set("utm_medium", medium);
  params.set("utm_campaign", campaign);

  const path = `/register?${params.toString()}`;
  const origin = opts.appOrigin?.trim().replace(/\/$/, "");
  if (!origin) return path;
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
}

export function cloudSignupAppOrigin(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

export function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE?.trim() === "true";
}
