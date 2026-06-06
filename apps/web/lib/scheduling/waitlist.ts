/**
 * Pure waitlist matching. When an appointment is cancelled and a slot frees up,
 * a clinic wants to know who on the waitlist fits — so the pet gets seen sooner
 * and the slot doesn't go to waste. No I/O.
 */

export interface WaitlistEntry {
  id: string;
  status: string;
  typeId: string | null;
  /** Date window the client is available within (YYYY-MM-DD), null = any. */
  preferredFrom: string | null;
  preferredTo: string | null;
  createdAt: Date;
}

export interface OpenSlot {
  /** Date of the freed slot, YYYY-MM-DD. */
  date: string;
  /** Appointment type of the freed slot, if any. */
  typeId?: string | null;
}

/**
 * Return waiting entries that fit the freed slot, oldest request first (FIFO,
 * fair). An entry matches when it is still waiting, its type preference is
 * unset or equals the slot's type, and the slot date falls within its
 * preferred window (open-ended if a bound is null).
 */
export function matchWaitlist(
  entries: WaitlistEntry[],
  slot: OpenSlot
): WaitlistEntry[] {
  return entries
    .filter((e) => {
      if (e.status !== "waiting") return false;
      if (e.typeId && slot.typeId && e.typeId !== slot.typeId) return false;
      if (e.preferredFrom && slot.date < e.preferredFrom) return false;
      if (e.preferredTo && slot.date > e.preferredTo) return false;
      return true;
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
