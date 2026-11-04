import manifest from "@/public/screens/manifest.json";
import type { ShotRef } from "@/content/types";

export type Box = [x: number, y: number, w: number, h: number];

export interface CapturedShot {
  file: string;
  width: number;
  height: number;
  targets: Record<string, Box>;
}

const shots = manifest as unknown as Record<string, CapturedShot>;

export function getShot(id: string): CapturedShot | undefined {
  return shots[id];
}

export function shotIds(): string[] {
  return Object.keys(shots);
}

function union(boxes: Box[]): Box {
  const x1 = Math.min(...boxes.map((b) => b[0]));
  const y1 = Math.min(...boxes.map((b) => b[1]));
  const x2 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y2 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x1, y1, x2 - x1, y2 - y1];
}

// Keep zoomed crops close to real size; a popover blown up to fill the page
// is harder to recognize than one shown at its usual size.
const MIN_CROP_WIDTH = 640;

/**
 * Where a callout's number sits: a point in the frame (percent) plus a pixel
 * nudge, so the badge lands just outside the ring instead of on the label.
 */
export interface Badge {
  left: number;
  top: number;
  dx: number;
  dy: number;
}

/** Rings are drawn this far outside the measured box, so they don't touch the label. */
export const RING_OUTSET = 4;
/** Badge diameter (26px) plus the ring's outset. */
const BADGE_SPACE = 30;
/** Narrowest a screenshot is drawn (a phone), so placements work everywhere. */
const MIN_RENDER_WIDTH = 320;

/**
 * Put the badge outside the ring: above-left if there's room, otherwise above,
 * to the left, inside a box that fills the picture, below, or to the right.
 * Room is judged at phone width, where a badge covers the most of the picture.
 */
function placeBadge(left: number, top: number, width: number, height: number, frameAspect: number): Badge {
  const pxX = MIN_RENDER_WIDTH / 100;
  const pxY = MIN_RENDER_WIDTH / frameAspect / 100;
  const room = {
    left: left * pxX,
    top: top * pxY,
    right: (100 - left - width) * pxX,
    bottom: (100 - top - height) * pxY,
  };
  const S = BADGE_SPACE;
  const gap = RING_OUTSET + 2;
  if (room.left >= S && room.top >= S) return { left, top, dx: -S, dy: -S };
  if (room.top >= S) return { left, top, dx: 0, dy: -S };
  if (room.left >= S) return { left, top, dx: -S, dy: 0 };
  // A box that fills most of the picture: its own top-left padding is the
  // emptiest spot, and keeps the badge clear of the callouts around it.
  if (width > 60 && height > 40) return { left, top, dx: 8, dy: 8 };
  if (room.bottom >= S) return { left, top: top + height, dx: 0, dy: gap };
  if (room.right >= S) return { left: left + width, top, dx: gap, dy: 0 };
  return { left, top, dx: 4, dy: 4 };
}

export interface ShotLayout {
  shot: CapturedShot;
  /** Visible region of the screenshot, in screen pixels. */
  frame: Box;
  /** Callout rings, as percentages of the frame. */
  callouts: { n: number; left: number; top: number; width: number; height: number; badge: Badge }[];
  zoomed: boolean;
}

/** Work out the crop and callout positions for a guide screenshot. */
export function layoutShot(ref: ShotRef): ShotLayout | undefined {
  const shot = getShot(ref.id);
  if (!shot) return undefined;

  let frame: Box = [0, 0, shot.width, shot.height];
  const focus = ref.focus ? (Array.isArray(ref.focus) ? ref.focus : [ref.focus]) : [];
  const focusBoxes = focus.map((name) => shot.targets[name]).filter((b): b is Box => Boolean(b));
  if (focusBoxes.length) {
    const pad = ref.pad ?? 24;
    let [x, y, w, h] = union(focusBoxes);
    x -= pad;
    y -= pad;
    w += pad * 2;
    h += pad * 2;
    if (w < MIN_CROP_WIDTH) {
      x -= (MIN_CROP_WIDTH - w) / 2;
      w = MIN_CROP_WIDTH;
    }
    if (ref.aspect) {
      // Grow the shorter side so every card in a row has the same shape.
      if (w / h > ref.aspect) {
        const nh = w / ref.aspect;
        y -= (nh - h) / 2;
        h = nh;
      } else {
        const nw = h * ref.aspect;
        x -= (nw - w) / 2;
        w = nw;
      }
      if (h > shot.height) {
        h = shot.height;
        w = h * ref.aspect;
      }
      // Prefer showing what's below the focus over empty space above the page.
      y = Math.max(0, y);
    }
    x = Math.max(0, Math.min(x, shot.width - w));
    y = Math.max(0, Math.min(y, shot.height - h));
    w = Math.min(w, shot.width - x);
    h = Math.min(h, shot.height - y);
    frame = [x, y, w, h].map(Math.round) as Box;
  }

  const [fx, fy, fw, fh] = frame;
  const callouts = (ref.callouts ?? []).flatMap((name, i) => {
    const box = shot.targets[name];
    if (!box) return [];
    const x1 = Math.max(box[0], fx);
    const y1 = Math.max(box[1], fy);
    const x2 = Math.min(box[0] + box[2], fx + fw);
    const y2 = Math.min(box[1] + box[3], fy + fh);
    if (x2 <= x1 || y2 <= y1) return [];
    const left = ((x1 - fx) / fw) * 100;
    const top = ((y1 - fy) / fh) * 100;
    const width = ((x2 - x1) / fw) * 100;
    const height = ((y2 - y1) / fh) * 100;
    return [{ n: i + 1, left, top, width, height, badge: placeBadge(left, top, width, height, fw / fh) }];
  });

  return { shot, frame, callouts, zoomed: focusBoxes.length > 0 };
}
