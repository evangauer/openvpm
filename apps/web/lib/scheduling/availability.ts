import { overlaps } from "./conflicts";

/**
 * Pure open-slot generation. Given a working window, a slot length, and the
 * busy intervals (existing appointments), produce the free slots a new
 * appointment of that length could occupy. No I/O.
 */

export interface BusyInterval {
  startTime: Date;
  endTime: Date;
}

export interface OpenSlot {
  start: Date;
  end: Date;
}

export interface AvailabilityWindow {
  start: Date;
  end: Date;
}

export function findOpenSlots(opts: {
  dayStart: Date;
  dayEnd: Date;
  slotMinutes: number;
  /** Candidate start cadence; defaults to slotMinutes (non-overlapping slots). */
  stepMinutes?: number;
  busy: BusyInterval[];
}): OpenSlot[] {
  const { dayStart, dayEnd, slotMinutes, busy } = opts;
  if (slotMinutes <= 0) throw new Error("slotMinutes must be positive.");
  const step =
    (opts.stepMinutes && opts.stepMinutes > 0
      ? opts.stepMinutes
      : slotMinutes) * 60_000;
  const slotMs = slotMinutes * 60_000;

  const slots: OpenSlot[] = [];
  for (let t = dayStart.getTime(); t + slotMs <= dayEnd.getTime(); t += step) {
    const start = new Date(t);
    const end = new Date(t + slotMs);
    const blocked = busy.some((b) =>
      overlaps(start, end, b.startTime, b.endTime),
    );
    if (!blocked) slots.push({ start, end });
  }
  return slots;
}

/**
 * Merge overlapping or touching working windows. Provider coverage can overlap
 * when multiple clinicians work at once; callers need one stable set of
 * candidate windows rather than duplicate slots.
 */
export function mergeAvailabilityWindows(
  windows: AvailabilityWindow[],
): AvailabilityWindow[] {
  const ordered = windows
    .filter((window) => window.start < window.end)
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  const merged: AvailabilityWindow[] = [];
  for (const window of ordered) {
    const previous = merged.at(-1);
    if (!previous || window.start.getTime() > previous.end.getTime()) {
      merged.push({ start: window.start, end: window.end });
      continue;
    }
    if (window.end > previous.end) previous.end = window.end;
  }
  return merged;
}

/** Generate open slots across one or more working windows. */
export function findOpenSlotsAcrossWindows(opts: {
  windows: AvailabilityWindow[];
  slotMinutes: number;
  stepMinutes?: number;
  busy: BusyInterval[];
}): OpenSlot[] {
  return mergeAvailabilityWindows(opts.windows).flatMap((window) =>
    findOpenSlots({
      dayStart: window.start,
      dayEnd: window.end,
      slotMinutes: opts.slotMinutes,
      stepMinutes: opts.stepMinutes,
      busy: opts.busy,
    }),
  );
}

export function intersectAvailabilityWindows(
  windows: AvailabilityWindow[],
  bounds: AvailabilityWindow,
): AvailabilityWindow[] {
  return mergeAvailabilityWindows(windows)
    .map((window) => ({
      start: window.start > bounds.start ? window.start : bounds.start,
      end: window.end < bounds.end ? window.end : bounds.end,
    }))
    .filter((window) => window.start < window.end);
}

export function slotFitsAvailability(
  slot: AvailabilityWindow,
  windows: AvailabilityWindow[],
): boolean {
  return mergeAvailabilityWindows(windows).some(
    (window) => slot.start >= window.start && slot.end <= window.end,
  );
}
