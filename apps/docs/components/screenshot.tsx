import type { ShotRef } from "@/content/types";
import { layoutShot, RING_OUTSET } from "@/lib/shots";

/**
 * A real OpenVPM screen, optionally zoomed into one area, with numbered
 * rings that match the ((n)) references in the step text.
 */
export function Screenshot({ shot, browser = false, priority = false }: { shot: ShotRef; browser?: boolean; priority?: boolean }) {
  const layout = layoutShot(shot);
  if (!layout) return null;
  const { frame, callouts, shot: captured } = layout;
  const [fx, fy, fw, fh] = frame;

  return (
    <figure className="shot">
      <div className="shot-card">
        {browser && (
          <div className="shot-chrome" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        )}
        <div className="shot-frame" style={{ aspectRatio: `${fw} / ${fh}` }}>
          <img
            src={`/screens/${captured.file}`}
            alt={shot.alt}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            style={{
              width: `${(captured.width / fw) * 100}%`,
              left: `${(-fx / fw) * 100}%`,
              top: `${(-fy / fh) * 100}%`,
            }}
          />
          {callouts.map((c) => (
            <span
              key={`ring-${c.n}`}
              className="shot-ring"
              style={{
                left: `calc(${c.left}% - ${RING_OUTSET}px)`,
                top: `calc(${c.top}% - ${RING_OUTSET}px)`,
                width: `calc(${c.width}% + ${RING_OUTSET * 2}px)`,
                height: `calc(${c.height}% + ${RING_OUTSET * 2}px)`,
              }}
              aria-hidden="true"
            />
          ))}
          {/* Numbers sit outside their rings and stay inside the picture. */}
          {callouts.map((c) => (
            <span
              key={`dot-${c.n}`}
              className="shot-dot"
              style={{
                left: `clamp(2px, calc(${c.badge.left}% + ${c.badge.dx}px), calc(100% - 28px))`,
                top: `clamp(2px, calc(${c.badge.top}% + ${c.badge.dy}px), calc(100% - 28px))`,
              }}
              aria-hidden="true"
            >
              {c.n}
            </span>
          ))}
        </div>
      </div>
      {shot.caption && <figcaption>{shot.caption}</figcaption>}
    </figure>
  );
}
