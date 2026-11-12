export const TRACKING_USAGE_KEYS = [
  "clients", "patients", "appointments", "soapNotes", "invoices", "files",
  "captureSessions", "aiRuns", "sms",
] as const;

export interface PracticeTracking {
  practiceId: string;
  businessName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  emailVerifiedAt: string | null;
  registeredAt: string;
  billingStatus: string;
  trialEndsAt: string | null;
  acquisition: { signupSource: string | null; medium: string | null; campaign: string | null };
  usage: Record<(typeof TRACKING_USAGE_KEYS)[number], number>;
  lastActionAt: string | null;
  activeDays7: number;
  activeDays30: number;
  actions: { label: string; count: number; lastAt: string }[];
}

export interface TrackingCursor { createdAt: string; practiceId: string }

export function engagementFor(p: PracticeTracking, now = new Date()): string {
  if (!p.lastActionAt) return "No recorded product actions";
  if (now.getTime() - new Date(p.lastActionAt).getTime() > 7 * 86400000)
    return "No recorded actions in 7 days";
  if (p.usage.clients === 0 && p.usage.patients === 0)
    return "Exploring sample data";
  return p.activeDays7 >= 2 ? "Returning use with own records" : "Own records added";
}
