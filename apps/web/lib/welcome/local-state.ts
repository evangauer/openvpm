/**
 * Per-user welcome + guide progress, stored in localStorage.
 *
 * Why localStorage and not the server: the users table has no per-user prefs
 * column, and the tRPC layer blocks ALL mutations for the viewer role, so a
 * server write would silently fail for viewers. Welcome-seen is low stakes
 * (re-showing once per device is fine, and guides are re-entrant from the
 * sidebar). Upgrade path if this ever needs to roam: a users.ui_state jsonb
 * column plus a protectedProcedure that also allows viewers.
 */

import type { GuideId } from "./cards";

const KEY_PREFIX = "ovpm.welcome.v1.";

export interface WelcomeLocalState {
  /** ISO timestamp of the first time this user saw (or skipped) the welcome. */
  seenAt?: string;
  guides?: Partial<Record<GuideId, "completed">>;
  /** ISO timestamp of the one-time setup offer shown after the last guide. */
  setupOfferedAt?: string;
}

function storageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export function readWelcomeState(
  userId: string | null | undefined
): WelcomeLocalState {
  if (!userId || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as WelcomeLocalState;
  } catch {
    return {};
  }
}

function writeWelcomeState(userId: string, state: WelcomeLocalState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch {
    // Storage full or blocked; the welcome may show again on this device.
  }
}

export function markWelcomeSeen(userId: string | null | undefined): void {
  if (!userId) return;
  const state = readWelcomeState(userId);
  if (state.seenAt) return;
  writeWelcomeState(userId, { ...state, seenAt: new Date().toISOString() });
}

export function markGuideCompleted(
  userId: string | null | undefined,
  guide: GuideId
): void {
  if (!userId) return;
  const state = readWelcomeState(userId);
  writeWelcomeState(userId, {
    ...state,
    guides: { ...state.guides, [guide]: "completed" },
  });
}

export function markSetupOffered(userId: string | null | undefined): void {
  if (!userId) return;
  const state = readWelcomeState(userId);
  if (state.setupOfferedAt) return;
  writeWelcomeState(userId, {
    ...state,
    setupOfferedAt: new Date().toISOString(),
  });
}

export function isGuideCompleted(
  userId: string | null | undefined,
  guide: GuideId
): boolean {
  return readWelcomeState(userId).guides?.[guide] === "completed";
}
