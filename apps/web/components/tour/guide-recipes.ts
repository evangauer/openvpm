/**
 * Named guide recipes: short walkthroughs the welcome surface (and the
 * sidebar Guides entry) can launch through the shared coachmark engine in
 * tour-provider. The classic value tour is the "tour" recipe; the others are
 * the "first win" guides, built at start time from a small context object so
 * routes and copy can use live data (the demo client, the demo patient) and
 * degrade gracefully once demo data is cleared.
 *
 * Voice: simple, fourth-grade, warm, no em dashes. Benefits first.
 */

import type { GuideId } from "@/lib/welcome/cards";
import { GUIDE_SIGNALS } from "./guide-signals";
import { TOUR_STEPS, type TourStep } from "./tour-steps";

export interface GuideStep extends TourStep {
  /**
   * Guide signal that auto-advances past this step (see guide-signals.ts).
   * The Next button still works, so a step never blocks on the signal.
   */
  advanceOn?: string;
}

export interface GuideContext {
  /** Target client for the portal guide (demo client, else first real one). */
  portalClient?: { id: string; firstName: string } | null;
  /** First demo patient's name, e.g. "Biscuit", when demo data is present. */
  demoPatientName?: string | null;
  /** False when the AI agent has no platform key; the guide never blocks. */
  agentConfigured?: boolean;
}

export const AGENT_GUIDE_QUESTION = "Which pets are overdue for vaccines?";

export function buildGuideSteps(
  recipe: GuideId,
  ctx: GuideContext = {}
): GuideStep[] {
  switch (recipe) {
    case "tour":
      return TOUR_STEPS;

    case "ask-ai": {
      const ready = ctx.agentConfigured !== false;
      return [
        {
          id: "ask",
          route: `/agent?ask=${encodeURIComponent(AGENT_GUIDE_QUESTION)}`,
          anchor: "agent-input",
          title: "Ask about a pet",
          body: ready
            ? "Your question is ready to go. Press send and watch the AI check every chart for you."
            : "Your AI helper turns on once your workspace key is set. Here is where you will ask it questions in plain words.",
          advanceOn: ready ? GUIDE_SIGNALS.agentRunSucceeded : undefined,
        },
        {
          id: "done",
          // Spotlight the real answer so the win lands. requiresAnchor lets
          // the guide end quietly if the user never pressed send.
          ...(ready ? { anchor: "agent-reply", requiresAnchor: true } : {}),
          title: "That easy",
          body: "The AI just read your charts so you did not have to. Ask it anything about your clinic, any time.",
        },
      ];
    }

    case "your-day": {
      const patient = ctx.demoPatientName;
      return [
        {
          id: "schedule",
          route: "/schedule",
          anchor: "schedule-calendar",
          title: "Your day sheet",
          body: patient
            ? `Every booked visit lives here. ${patient} is already on today's schedule.`
            : "Every booked visit lives here, day by day. Click any open slot to book one.",
        },
        {
          id: "whiteboard",
          route: "/whiteboard",
          anchor: "whiteboard-board",
          title: "Who is here right now",
          body: "When a pet checks in, the whole team sees it here. No sticky notes, no shouting down the hall.",
        },
        {
          id: "done",
          title: "That is your whole day",
          body: "Front desk to exam room on one screen. Book a visit, check the pet in, and everyone stays in the loop.",
        },
      ];
    }

    case "client-portal": {
      if (!ctx.portalClient) {
        return [
          {
            id: "empty",
            route: "/clients",
            title: "Every client gets a portal",
            body: "Add your first client and they get their own private link right away. Pet parents can see visits and bills without calling you.",
          },
        ];
      }
      const first = ctx.portalClient.firstName;
      return [
        {
          id: "copy",
          route: `/clients/${ctx.portalClient.id}`,
          anchor: "client-portal-link",
          title: "A private link for every client",
          body: `${first} has a private portal link. Copy it here, then share it by text or email.`,
          advanceOn: GUIDE_SIGNALS.portalLinkCopied,
        },
        {
          id: "done",
          title: "Fewer calls for you",
          body: `Open the link to see what ${first} sees: pets, visits, and bills. Clients help themselves, and your phone rings less.`,
        },
      ];
    }

    case "calendar-feed":
      return [
        {
          id: "subscribe",
          route: "/schedule",
          anchor: "calendar-subscribe",
          title: "Your schedule, in your calendar",
          body: "Click this button to get your calendar link. Paste it into Google, Apple, or Outlook and it stays up to date on its own.",
          advanceOn: GUIDE_SIGNALS.calendarUrlCopied,
        },
        {
          id: "done",
          title: "Set it and forget it",
          body: "New visits now show up in your own calendar without any extra work.",
        },
      ];
  }
}
