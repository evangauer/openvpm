/**
 * Pure derivation of which welcome guide cards a user can see. Kept free of
 * React so the role matrix is unit-testable.
 *
 * "tour" is the classic value tour (admin-only, persisted server-side); the
 * other guides are the welcome walkthroughs, open to every staff role. The
 * AI guide is the exception: the agent itself is admin + veterinarian only
 * (agentProcedure), so the card hides for roles that could never run it.
 */

export type GuideId =
  | "tour"
  | "ask-ai"
  | "your-day"
  | "client-portal"
  | "calendar-feed";

/** Cards shown on the welcome surface, in display order. */
export type WelcomeCardId = Exclude<GuideId, "tour">;

export function canRunAgentGuideRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

export function visibleWelcomeCards(opts: {
  role?: string | null;
}): WelcomeCardId[] {
  const cards: WelcomeCardId[] = [];
  if (canRunAgentGuideRole(opts.role)) {
    cards.push("ask-ai");
  }
  cards.push("your-day", "client-portal", "calendar-feed");
  return cards;
}
