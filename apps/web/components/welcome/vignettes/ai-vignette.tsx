"use client";

import { useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";
import { AI_VIGNETTE } from "../welcome-copy";

/**
 * The animated Polaroid image for the AI card: the question types itself
 * out, then the answer bubble arrives. Pure CSS keyframes on an 9s loop
 * that holds the finished exchange for most of the cycle.
 *
 * Accessibility/perf: `prefers-reduced-motion` renders the final frame
 * statically, and the loop pauses while the card is off screen.
 */

function useInViewport(ref: React.RefObject<Element>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting ?? true),
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

export function AiVignette() {
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInViewport(rootRef);

  return (
    <div
      ref={rootRef}
      data-paused={inView ? undefined : ""}
      className="ai-vignette flex h-full w-full flex-col justify-center gap-2 bg-gradient-to-br from-violet-50 to-emerald-50 p-3"
      aria-label={`Example: you ask "${AI_VIGNETTE.question}" and the AI answers "${AI_VIGNETTE.answer}"`}
    >
      <div className="flex justify-end">
        <span className="ai-vignette-question max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-left text-xs leading-5 text-primary-foreground">
          {AI_VIGNETTE.question}
        </span>
      </div>
      <div className="ai-vignette-answer flex items-start gap-1.5">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-primary shadow-sm">
          <Bot className="h-3 w-3" aria-hidden="true" />
        </span>
        <span className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white px-3 py-1.5 text-xs leading-5 text-foreground shadow-sm">
          {AI_VIGNETTE.answer}
        </span>
      </div>

      <style>{`
        /* One 9s cycle: type the question (0-25%), answer lands (~31%),
           hold the finished exchange, then reset. steps() gives the
           character-by-character feel without needing a monospace font. */
        .ai-vignette-question {
          clip-path: inset(0 0 0 0);
          animation: ai-vignette-type 9s steps(36) infinite;
        }
        .ai-vignette-answer {
          opacity: 1;
          transform: none;
          animation: ai-vignette-arrive 9s ease-out infinite;
        }
        .ai-vignette[data-paused] .ai-vignette-question,
        .ai-vignette[data-paused] .ai-vignette-answer {
          animation-play-state: paused;
        }
        @keyframes ai-vignette-type {
          0% {
            clip-path: inset(0 100% 0 0);
          }
          25% {
            clip-path: inset(0 0 0 0);
          }
          96% {
            clip-path: inset(0 0 0 0);
            opacity: 1;
          }
          100% {
            clip-path: inset(0 0 0 0);
            opacity: 0;
          }
        }
        @keyframes ai-vignette-arrive {
          0%,
          28% {
            opacity: 0;
            transform: translateY(6px);
          }
          34% {
            opacity: 1;
            transform: none;
          }
          96% {
            opacity: 1;
            transform: none;
          }
          100% {
            opacity: 0;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .ai-vignette-question,
          .ai-vignette-answer {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
