import {
  DEMO_DISCLOSURE_FOLLOWUP_V2,
  DEMO_DISCLOSURE_USEFUL_V3,
} from "@/lib/growth/demo-disclosure";

const HOUR_MS = 60 * 60 * 1000;

export const DEMO_FOLLOWUP_ENABLED_ENV = "DEMO_FOLLOWUP_ENABLED";
export const DEMO_FOLLOWUP_ROLLOUT_AT_ENV = "DEMO_FOLLOWUP_ROLLOUT_AT";
export const DEMO_FOLLOWUP_SEQUENCE = "demo-followup";
export const DEMO_FOLLOWUP_VERSION = "v1";

export type DemoFollowupStep = 1 | 2 | 3 | 4;

/**
 * Step 1 is the "what did you think?" note every demo visitor was told to
 * expect. Steps 2-4 go only to visitors who saw the follow-up disclosure.
 */
export const DEMO_FOLLOWUP_SCHEDULE: ReadonlyArray<{
  step: DemoFollowupStep;
  afterHours: number;
}> = [
  { step: 1, afterHours: 3 },
  { step: 2, afterHours: 48 },
  { step: 3, afterHours: 120 },
  { step: 4, afterHours: 216 },
];

export const DEMO_FOLLOWUP_MAX_EMAILS = DEMO_FOLLOWUP_SCHEDULE.length;
export const DEMO_FOLLOWUP_MIN_GAP_HOURS = 20;
export const DEMO_FOLLOWUP_MAX_AGE_HOURS = 21 * 24;
/** Below this many distinct tools, the visit was too brief for a full run. */
export const DEMO_FOLLOWUP_ENGAGED_TOOL_COUNT = 2;

export type DemoFollowupConfig =
  | { enabled: false; reason: "disabled" | "rollout_at_invalid" }
  | { enabled: true; rolloutAt: Date };

/** Default-off, prospective-only: only leads first seen after rollout. */
export function demoFollowupConfig(): DemoFollowupConfig {
  if (process.env[DEMO_FOLLOWUP_ENABLED_ENV]?.trim().toLowerCase() !== "true") {
    return { enabled: false, reason: "disabled" };
  }
  const rolloutAt = new Date(
    process.env[DEMO_FOLLOWUP_ROLLOUT_AT_ENV]?.trim() ?? "",
  );
  if (Number.isNaN(rolloutAt.getTime())) {
    return { enabled: false, reason: "rollout_at_invalid" };
  }
  return { enabled: true, rolloutAt };
}

export function demoFollowupDedupeKey(
  leadId: string,
  step: DemoFollowupStep,
): string {
  return `lead:${DEMO_FOLLOWUP_SEQUENCE}:${DEMO_FOLLOWUP_VERSION}:${leadId}:${step}`;
}

/**
 * How many emails this lead may receive. Leads who saw only the one-email
 * disclosure get one. Leads who barely used the demo get two, so an address
 * typed into the gate by someone else never receives the full run.
 */
export function demoFollowupMaxEmails(input: {
  disclosureVersion: string;
  toolCount: number;
}): number {
  if (
    input.disclosureVersion !== DEMO_DISCLOSURE_FOLLOWUP_V2 &&
    input.disclosureVersion !== DEMO_DISCLOSURE_USEFUL_V3
  )
    return 1;
  return input.toolCount >= DEMO_FOLLOWUP_ENGAGED_TOOL_COUNT
    ? DEMO_FOLLOWUP_MAX_EMAILS
    : 2;
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function demoFollowupStepDue(input: {
  now: Date;
  firstSeenAt: Date | string;
  existingEmailCount: number;
  lastEmailAt: Date | string | null;
  maxEmails: number;
}): DemoFollowupStep | null {
  const firstSeenAt = validDate(input.firstSeenAt);
  if (!firstSeenAt) return null;
  const ageMs = input.now.getTime() - firstSeenAt.getTime();
  if (ageMs > DEMO_FOLLOWUP_MAX_AGE_HOURS * HOUR_MS) return null;
  if (input.existingEmailCount >= input.maxEmails) return null;

  const next = DEMO_FOLLOWUP_SCHEDULE[input.existingEmailCount];
  if (!next || ageMs < next.afterHours * HOUR_MS) return null;

  const lastEmailAt = validDate(input.lastEmailAt);
  if (
    lastEmailAt &&
    input.now.getTime() - lastEmailAt.getTime() <
      DEMO_FOLLOWUP_MIN_GAP_HOURS * HOUR_MS
  ) {
    return null;
  }
  return next.step;
}

export interface DemoToolCopy {
  /** Short name, e.g. "the day board". */
  name: string;
  /** One sentence on what it does for a clinic. */
  pitch: string;
}

/** Copy for the first product tool a visitor opened: what they came to see. */
export const DEMO_TOOL_COPY: Record<string, DemoToolCopy> = {
  ask_ai: {
    name: "the AI assistant",
    pitch:
      "It drafts SOAP notes, summarizes a patient's history, and answers questions about your own records, so the team spends less time typing.",
  },
  day_board: {
    name: "the day board",
    pitch:
      "Your whole day on one screen: who's checked in, who's waiting, and which room each patient is in.",
  },
  whiteboard: {
    name: "the treatment whiteboard",
    pitch:
      "Hospitalized and in-clinic patients with their treatments due, so nothing gets missed between shifts.",
  },
  client_portal: {
    name: "the client portal",
    pitch:
      "Pet owners see reminders, records, and invoices themselves, which means fewer calls to the front desk.",
  },
  patients: {
    name: "patient records",
    pitch:
      "Every visit, vaccine, and lab result for a pet in one timeline your whole team can read.",
  },
  clients: {
    name: "client records",
    pitch:
      "Owners, their pets, balances, and communication history together, ready at check-in.",
  },
  records: {
    name: "medical records",
    pitch:
      "Structured SOAP notes and templates that keep records consistent across doctors.",
  },
  billing: {
    name: "billing and checkout",
    pitch:
      "Charges flow from the visit to the invoice, so checkout takes seconds instead of re-entering everything.",
  },
  inbox: {
    name: "the shared inbox",
    pitch: "Client messages in one place the whole front desk can work from.",
  },
  inventory: {
    name: "inventory",
    pitch:
      "Stock that updates as items are used in visits, with alerts before you run out.",
  },
  reports: {
    name: "reports",
    pitch:
      "Revenue, visits, and production numbers without exporting to a spreadsheet.",
  },
};

export function demoToolCopy(
  tool: string | null | undefined,
): DemoToolCopy | null {
  return tool ? (DEMO_TOOL_COPY[tool] ?? null) : null;
}
