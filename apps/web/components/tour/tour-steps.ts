/**
 * Ordered steps for the value walk. Each step optionally navigates to a route
 * and anchors a coachmark to an element marked `data-tour="<anchor>"`. Anchoring
 * the sidebar nav links keeps anchors stable across route changes; steps without
 * an anchor render as a centered card.
 *
 * Voice: simple, fourth-grade, warm, no em dashes. Lead with the value: you own
 * your data and real AI tools are built in.
 */
export interface TourStep {
  id: string;
  /** Route to navigate to before showing this step. */
  route?: string;
  /** `data-tour` value of the element to spotlight. Absent = centered card. */
  anchor?: string;
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    route: "/",
    title: "Welcome to OpenVPM",
    body: "This is your practice. We added a few sample pets so it feels real while you look around.",
  },
  {
    id: "schedule",
    route: "/schedule",
    anchor: "nav-/schedule",
    title: "Your day, at a glance",
    body: "Book visits and check pets in from one simple calendar.",
  },
  {
    id: "records",
    route: "/records",
    anchor: "nav-/records",
    title: "Every pet's full story",
    body: "Notes, shots, meds, and labs all live in one place.",
  },
  {
    id: "billing",
    route: "/billing",
    anchor: "nav-/billing",
    title: "Bill in one click",
    body: "Turn a visit into a bill and take payment online.",
  },
  {
    id: "agent",
    route: "/agent",
    anchor: "nav-/agent",
    title: "Your AI helper",
    body: "Ask it about your pets and your data and it does the work. You will get to try it in a minute.",
  },
  {
    id: "ownership",
    route: "/",
    title: "Your data is yours",
    body: "You own everything here. Export it any time, and connect by API when you are ready.",
  },
  {
    id: "finish",
    route: "/",
    title: "You're all set",
    body: "That was the quick look. Your clinic is ready to go. Your data stays yours, and the AI helper is here whenever you need it.",
  },
];
