// Preloaded (node --import) into the seed run and the app server while
// capturing guide screenshots. It moves the clock to a fixed time of day
// (today, mid-morning) and makes Math.random repeatable, so every capture
// shows the same clinic morning: visits underway, patients on the
// whiteboard, and the same sample records.
//
// Only the time of day is pinned. The date stays real because browsers
// expire session cookies on real time, so a past date signs you straight
// back out. Time keeps moving from the pinned start. Never load this in
// production.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

// Repeatable randomness is only safe in a throwaway capture setup, so this
// refuses to load unless asked for by name.
if (process.env.DOCS_CAPTURE !== "1") {
  throw new Error("capture/clock.mjs makes randomness predictable. Set DOCS_CAPTURE=1 to load it, and only for a screenshot capture.");
}

const RealDate = Date;
const [hours, minutes] = (process.env.DOCS_CAPTURE_TIME ?? "10:20").split(":").map(Number);
const pinned = new RealDate();
pinned.setHours(hours, minutes, 0, 0);
const offset = pinned.getTime() - RealDate.now();

class CaptureDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }
  static now() {
    return RealDate.now() + offset;
  }
}
// Next's server bundles don't see statics through the subclass chain.
CaptureDate.parse = RealDate.parse;
CaptureDate.UTC = RealDate.UTC;
globalThis.Date = CaptureDate;

// mulberry32: small, fast, and good enough for picking sample data.
let seed = Number(process.env.DOCS_CAPTURE_SEED ?? 20260902) >>> 0;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// The seed also draws from crypto.randomInt for some sample values.
crypto.randomInt = (min, max) => {
  if (max === undefined) [min, max] = [0, min];
  return min + Math.floor(Math.random() * (max - min));
};
syncBuiltinESMExports();
