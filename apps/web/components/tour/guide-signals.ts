/**
 * One-way signals from product code into an active guide. A page that
 * completes a guide-relevant action (an agent run succeeds, a portal link is
 * copied) emits a named signal; the tour provider auto-advances any active
 * guide step that declared it via `advanceOn`. Emissions are no-ops when no
 * guide is listening, so call sites stay one-liners with zero coupling.
 */

export const GUIDE_SIGNAL_EVENT = "ovpm:guide-signal";

export const GUIDE_SIGNALS = {
  agentRunSucceeded: "agent-run-succeeded",
  portalLinkCopied: "portal-link-copied",
  calendarUrlCopied: "calendar-url-copied",
} as const;

export type GuideSignal = (typeof GUIDE_SIGNALS)[keyof typeof GUIDE_SIGNALS];

export function emitGuideSignal(name: GuideSignal): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(GUIDE_SIGNAL_EVENT, { detail: { name } })
  );
}

export function guideSignalName(event: Event): string | null {
  const detail = (event as CustomEvent<{ name?: unknown }>).detail;
  return typeof detail?.name === "string" ? detail.name : null;
}

/**
 * Fired by the tour provider when a named guide finishes its last step.
 * The welcome surface listens to offer the next move (another card, or
 * the Make-it-yours wizard after an admin's first win).
 */
export const GUIDE_COMPLETED_EVENT = "ovpm:guide-completed";

export function emitGuideCompleted(recipe: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(GUIDE_COMPLETED_EVENT, { detail: { recipe } })
  );
}

export function guideCompletedRecipe(event: Event): string | null {
  const detail = (event as CustomEvent<{ recipe?: unknown }>).detail;
  return typeof detail?.recipe === "string" ? detail.recipe : null;
}
