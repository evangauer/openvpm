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
