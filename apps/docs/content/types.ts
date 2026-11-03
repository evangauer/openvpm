/**
 * The shape of every page on the help site. Guides, training plans, and
 * screen tours are plain typed data so the tests can check that links,
 * screenshots, and callouts all point at something real.
 *
 * Body text supports a small inline markup:
 *   [[Save]]           a button or label in OpenVPM
 *   **bold**           emphasis
 *   [text](/guides/x)  a link
 *   ((2))              a numbered callout on the step's screenshot
 */

export type TeamId = "front-desk" | "clinical-team" | "practice-administration";

export type CategoryId =
  | "start-here"
  | "front-desk"
  | "clinical-care"
  | "checkout"
  | "client-care"
  | "administration";

/** One per item in the OpenVPM sidebar. */
export type AreaId =
  | "dashboard"
  | "patients"
  | "clients"
  | "schedule"
  | "records"
  | "lab-inbox"
  | "billing"
  | "inventory"
  | "inbox"
  | "recalls"
  | "care-reminders"
  | "imported-history"
  | "whiteboard"
  | "agent"
  | "controlled-substances"
  | "reports"
  | "settings";

export interface ShotRef {
  /** Screenshot id from capture/shots.ts. */
  id: string;
  /** Zoom into this named target (or several, framed together). */
  focus?: string | string[];
  /** Extra space around the focus, in screen pixels. */
  pad?: number;
  /** Force a width/height ratio for the visible area (e.g. card thumbnails). */
  aspect?: number;
  /** Named targets to ring and number, in order. */
  callouts?: string[];
  caption?: string;
  alt: string;
}

export interface Step {
  id: string;
  title: string;
  body: string[];
  tip?: string;
  /** Something that matters for safety, money, or records. */
  important?: string;
  shot?: ShotRef;
}

export interface Guide {
  slug: string;
  title: string;
  summary: string;
  category: CategoryId;
  /** The screen this guide mostly happens on. */
  area: AreaId;
  audience: string;
  minutes: number;
  before?: string;
  steps: Step[];
  /** Show the appointment status path after the steps. */
  statusFlow?: boolean;
  faq?: [question: string, answer: string][];
  next?: string;
  /** Words people search for that aren't in the title. */
  keywords?: string[];
}

export interface Training {
  id: TeamId;
  title: string;
  shortTitle: string;
  summary: string;
  sections: { title: string; guides: string[] }[];
}

export interface ScreenTour {
  area: AreaId;
  title: string;
  /** Label in the OpenVPM sidebar. */
  navLabel: string;
  summary: string;
  shot: ShotRef;
  /** One entry per callout on the shot, in the same order. */
  legend: { title: string; body: string }[];
  tasks: string[];
  goodToKnow?: string[];
  keywords?: string[];
}
