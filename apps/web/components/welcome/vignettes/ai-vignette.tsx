"use client";

import { useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";
import { AI_VIGNETTE } from "../welcome-copy";

/**
 * The animated Polaroid image for the AI card: the question bubble POPS in
 * like a chat bubble, its text types itself out, then the answer bubble
 * pops in with the result. One 9s CSS loop that holds the finished
 * exchange for most of the cycle.
 *
 * Accessibility/perf: `prefers-reduced-motion` renders the final frame
 * statically, and the loop pauses while the card is off screen.
 */

function useInViewport(ref: React.RefObject<Element | null>): boolean {
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
          <span className="ai-vignette-qtext block">{AI_VIGNETTE.question}</span>
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
        /* One 9s cycle: the question bubble POPS in (0-3%), its text types
           (3-26%), the answer bubble pops in with the result (~30%), then
           the finished exchange holds before a soft reset. */
        .ai-vignette-question {
          transform-origin: bottom right;
          animation: ai-vignette-pop-q 9s ease-out infinite;
        }
        .ai-vignette-qtext {
          animation: ai-vignette-type 9s steps(36) infinite;
        }
        .ai-vignette-answer {
          transform-origin: top left;
          animation: ai-vignette-pop-a 9s ease-out infinite;
        }
        .ai-vignette[data-paused] .ai-vignette-question,
        .ai-vignette[data-paused] .ai-vignette-qtext,
        .ai-vignette[data-paused] .ai-vignette-answer {
          animation-play-state: paused;
        }
        @keyframes ai-vignette-pop-q {
          0% { opacity: 0; transform: scale(0.6); }
          1.5% { opacity: 1; transform: scale(1.05); }
          3%, 96% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(1); }
        }
        @keyframes ai-vignette-type {
          0%, 3% { clip-path: inset(0 100% 0 0); }
          26%, 100% { clip-path: inset(0 0 0 0); }
        }
        @keyframes ai-vignette-pop-a {
          0%, 29% { opacity: 0; transform: scale(0.6); }
          31% { opacity: 1; transform: scale(1.05); }
          33%, 96% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .ai-vignette-question,
          .ai-vignette-qtext,
          .ai-vignette-answer {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
