"use client";

import type { WelcomeCardId } from "@/lib/welcome/cards";

/**
 * The "imagery" Polaroid variant: a warm scenic backdrop fills the frame
 * and the faux-UI vignette floats over it as a small chip, so the card
 * reads photo-first while still showing the real product.
 *
 * The scenes are original in-code art (soft gradient washes + organic
 * shapes + a paw motif), so the open-source repo carries no third-party
 * image licensing. To try real photography instead, drop CC0 files into
 * public/welcome/ and swap the backdrop for an <img>; record each file's
 * source and license in public/welcome/LICENSE.md.
 */

const SCENES: Record<
  WelcomeCardId,
  { from: string; via: string; to: string; blob: string; blob2: string }
> = {
  "ask-ai": {
    from: "#ede9fe", // violet wash for the AI moment
    via: "#fdf2f8",
    to: "#d1fae5",
    blob: "#c4b5fd",
    blob2: "#a7f3d0",
  },
  "your-day": {
    from: "#ffedd5", // morning light for the day sheet
    via: "#fef3c7",
    to: "#fce7f3",
    blob: "#fdba74",
    blob2: "#f9a8d4",
  },
  "client-portal": {
    from: "#fce7f3", // soft pink for the pet-parent moment
    via: "#f5f3ff",
    to: "#e0f2fe",
    blob: "#f9a8d4",
    blob2: "#bae6fd",
  },
  "calendar-feed": {
    from: "#d1fae5", // fresh green for set-and-forget
    via: "#ecfdf5",
    to: "#ede9fe",
    blob: "#6ee7b7",
    blob2: "#c4b5fd",
  },
};

export function ImageryBackdrop({ card }: { card: WelcomeCardId }) {
  const scene = SCENES[card];
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0"
      style={{
        background: `linear-gradient(140deg, ${scene.from} 0%, ${scene.via} 55%, ${scene.to} 100%)`,
      }}
    >
      <svg
        viewBox="0 0 200 150"
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full"
      >
        <circle cx="168" cy="18" r="52" fill={scene.blob} opacity="0.45" />
        <circle cx="22" cy="138" r="64" fill={scene.blob2} opacity="0.5" />
        <circle cx="120" cy="128" r="26" fill="#ffffff" opacity="0.35" />
        {/* Paw motif, echoing the sidebar PawMark */}
        <g fill="#ffffff" opacity="0.65" transform="translate(28 26) scale(1.5)">
          <ellipse cx="12" cy="16" rx="4.5" ry="3.5" />
          <ellipse cx="6" cy="9" rx="2" ry="2.5" />
          <ellipse cx="9.5" cy="4.5" rx="1.7" ry="2.2" />
          <ellipse cx="14.5" cy="4.5" rx="1.7" ry="2.2" />
          <ellipse cx="18" cy="9" rx="2" ry="2.5" />
        </g>
      </svg>
    </div>
  );
}
