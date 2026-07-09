/**
 * Copy deck for the welcome surface and its Polaroid guide cards, kept as
 * data so tests can hold the voice: fourth-grade reading level, benefits
 * before features, warm, and never an em or en dash.
 */

import type { WelcomeCardId } from "@/lib/welcome/cards";

export const WELCOME_COPY = {
  headlineAdmin: (practiceName: string) =>
    `Welcome to OpenVPM, ${practiceName}!`,
  headlineStaff: (firstName: string) => `Welcome, ${firstName}!`,
  headlineFallback: "Welcome to OpenVPM!",
  subline:
    "Here is what OpenVPM can do for your clinic today. Pick a card and we will show you in about a minute.",
  skip: "Skip for now",
  reopenHint: "You can come back any time from Guides in the sidebar.",
  setupInstead: "Set up my clinic instead",
  doneBadge: "Done",
  firstWin: {
    title: "That was your first win!",
    body: "Ready to make OpenVPM yours? Add your logo, your team, and your real clients.",
    accept: "Make it mine",
    later: "Later",
  },
} as const;

export interface WelcomeCardCopy {
  caption: string;
  sub: string;
  chip: string;
}

export const WELCOME_CARD_COPY: Record<WelcomeCardId, WelcomeCardCopy> = {
  "ask-ai": {
    caption: "Ask the AI about a pet",
    sub: "Stop digging through charts. Just ask.",
    chip: "About 1 minute",
  },
  "your-day": {
    caption: "See your day at a glance",
    sub: "Every visit and every pet on one screen.",
    chip: "About 2 minutes",
  },
  "client-portal": {
    caption: "Give clients their own portal",
    sub: "Pet parents see visits and bills without calling you.",
    chip: "About 1 minute",
  },
  "calendar-feed": {
    caption: "See your schedule in your own calendar",
    sub: "Your clinic's day, right inside Google, Apple, or Outlook.",
    chip: "About 1 minute",
  },
};

/** The animated AI vignette's scripted exchange. */
export const AI_VIGNETTE = {
  question: "Which pets are overdue for vaccines?",
  answer: "Biscuit is 5 days past due for the DHPP shot.",
} as const;
