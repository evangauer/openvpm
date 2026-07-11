/**
 * Ordered steps for the value walk. Each step optionally navigates to a route
 * and anchors a coachmark to an element marked `data-tour="<anchor>"`. Anchoring
 * the sidebar nav links keeps anchors stable across route changes; steps without
 * an anchor render as a centered card.
 *
 * The tour is context-aware: when the workspace has sample data we walk into a
 * real chart and a real bill instead of pointing at empty tabs, and the finale
 * is the AI helper answering a real question. Voice: simple, fourth-grade,
 * warm, no em dashes. Lead with the value: you own your data and real AI tools
 * are built in.
 */
import { GUIDE_SIGNALS } from "./guide-signals";

export interface TourStep {
  id: string;
  /** Route to navigate to before showing this step. */
  route?: string;
  /** `data-tour` value of the element to spotlight. Absent = centered card. */
  anchor?: string;
  /**
   * Only visit this step while its anchor is in the DOM; Next and Back pass
   * over it otherwise (e.g. the AI reply beat when nothing was ever sent).
   */
  requiresAnchor?: boolean;
  title: string;
  body: string;
  /** Guide signal that auto-advances past this step (never blocks Next). */
  advanceOn?: string;
}

export const AGENT_TOUR_QUESTION = "Which pets are overdue for vaccines?";

export interface TourContext {
  /** First demo patient's name, e.g. "Biscuit", when demo data is present. */
  demoPatientName?: string | null;
  /** First demo patient's id, for walking into a real chart. */
  demoPatientId?: string | null;
  /** A live sample invoice id, for walking into a real bill. */
  demoInvoiceId?: string | null;
  /** False when the AI agent has no platform key; the tour never blocks. */
  agentConfigured?: boolean;
}

export function buildTourSteps(ctx: TourContext = {}): TourStep[] {
  const patientName = ctx.demoPatientName ?? null;
  const agentReady = ctx.agentConfigured ?? false;

  const steps: TourStep[] = [
    {
      id: "welcome",
      route: "/",
      title: "Welcome to OpenVPM",
      body: "This is your practice. We added a few sample pets so it feels real while you look around.",
    },
    {
      id: "schedule",
      route: "/schedule",
      anchor: "schedule-calendar",
      title: "Your day, at a glance",
      body: patientName
        ? `Every visit lives here. ${patientName} is already booked, so you can see a real day. Click any open slot to book a visit.`
        : "Book visits and check pets in from one simple calendar. Click any open slot to book a visit.",
    },
  ];

  if (ctx.demoPatientId) {
    steps.push({
      id: "patient-chart",
      route: `/patients/${ctx.demoPatientId}`,
      title: "Every pet's full story",
      body: `This is ${patientName ?? "a sample pet"}'s chart. Notes, shots, meds, and labs all live on one page. The tabs go deeper when you need them.`,
    });
  } else {
    steps.push({
      id: "records",
      route: "/records",
      anchor: "nav-/records",
      title: "Every pet's full story",
      body: "Notes, shots, meds, and labs all live in one place.",
    });
  }

  if (ctx.demoInvoiceId) {
    steps.push({
      id: "invoice",
      route: `/billing?expand=${ctx.demoInvoiceId}`,
      anchor: "invoice-detail",
      title: "Bill in one click",
      body: "Here is a real bill, already itemized. A visit becomes a bill in one click, and clients can pay online.",
    });
  } else {
    steps.push({
      id: "billing",
      route: "/billing",
      anchor: "nav-/billing",
      title: "Bill in one click",
      body: "Turn a visit into a bill and take payment online.",
    });
  }

  steps.push({
    id: "inbox",
    route: "/inbox",
    anchor: "inbox-list",
    title: "Talk to clients, all in one place",
    body: "Text clients from your own number, or send and receive email, right here. We added a few messages so you can see how it feels.",
  });

  steps.push({
    id: "agent",
    route: `/agent?ask=${encodeURIComponent(AGENT_TOUR_QUESTION)}`,
    anchor: "agent-input",
    title: "Now meet your AI helper",
    body: agentReady
      ? "We typed a real question for you. Press send and watch it check every chart in seconds."
      : "Ask about your pets and your data in plain words, right here. Your AI helper turns on once your workspace key is set.",
    advanceOn: agentReady ? GUIDE_SIGNALS.agentRunSucceeded : undefined,
  });

  // The payoff beat: stay on the answer and spotlight it. Without this the
  // finish step navigated home the moment the reply landed, so nobody ever
  // read what the AI wrote.
  if (agentReady) {
    steps.push({
      id: "agent-reply",
      anchor: "agent-reply",
      requiresAnchor: true,
      title: "There is your answer",
      body: "The AI read your charts and answered in plain words. Take a moment and read it. You can ask anything like this, any time.",
    });
  }

  steps.push({
    id: "finish",
    route: "/",
    title: "You're all set",
    body: "That was your clinic: the day sheet, the charts, the bills, and your AI helper. Your data is always yours. Export it any time.",
  });

  return steps;
}

/** Context-free steps, used for prefetch fallbacks and tests. */
export const TOUR_STEPS: TourStep[] = buildTourSteps();
