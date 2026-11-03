import type { ShotRef } from "@/content/types";
import { layoutShot } from "@/lib/shots";

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
              key={c.n}
              className="shot-ring"
              style={{ left: `${c.left}%`, top: `${c.top}%`, width: `${c.width}%`, height: `${c.height}%` }}
              aria-hidden="true"
            >
              <span className="shot-dot">{c.n}</span>
            </span>
          ))}
        </div>
      </div>
      {shot.caption && <figcaption>{shot.caption}</figcaption>}
    </figure>
  );
}
