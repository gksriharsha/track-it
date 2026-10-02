import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { artFor, framesOf } from "../lib/exerciseArt";
import type { LiftArt } from "../lib/exerciseArt";

/**
 * A lift's drawing: its two frames, alternating, the way a flip-book shows a
 * movement (D27).
 *
 * Each frame is an SVG used as a mask over a block of `currentColor`, so the
 * lines take the app's own ink in either theme and nothing here hard-codes a
 * colour. The files are separate assets, fetched from the app's own bundle
 * when first drawn — never from anywhere else.
 *
 * Motion is kept to what it is for:
 * - It plays twice each time the figure comes on screen, then rests on the
 *   start frame. Under five seconds, so it never needs a control to stop it.
 * - It never moves under prefers-reduced-motion; the start frame stands still.
 * - `still` turns it off outright: lists, holds such as the side plank, and
 *   any figure whose close-up is open beside it.
 */
const URLS = import.meta.glob(["../assets/everkinetic/*.svg", "../assets/figures/*.svg"], {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The two frames' URLs, start first; null for a missing file or a hold's halfway. */
function frameUrls(art: LiftArt): [string | null, string | null] {
  const f = framesOf(art);
  return [URLS[`../assets/${f.start}`] ?? null, f.halfway ? URLS[`../assets/${f.halfway}`] ?? null : null];
}

function mask(url: string): CSSProperties {
  return { "--src": `url("${url}")` } as CSSProperties;
}

export default function LiftFigure(p: {
  lift: string;
  /** No animation: the start frame alone. */
  still?: boolean;
  className?: string;
}) {
  const art = artFor(p.lift);
  const ref = useRef<HTMLSpanElement>(null);
  /*
    How many times this figure has come on screen. It keys the frames, so each
    arrival remounts them and the two plays start again from the start frame;
    0 means it has not been seen yet and nothing plays.
  */
  const [arrivals, setArrivals] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || p.still || typeof IntersectionObserver === "undefined") return;
    let shown = false;
    const io = new IntersectionObserver(
      (entries) => {
        // The newest entry: a batch can hold an exit and a re-entry together.
        const now = entries[entries.length - 1].isIntersecting;
        if (now && !shown) setArrivals((n) => n + 1);
        shown = now;
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [p.still, art?.id]);

  if (!art) return null;
  const [a, b] = frameUrls(art);
  if (!a || (!b && !art.still)) return null;
  // A hold drawn for TrackIt has no second frame to play, whatever `still` says.
  const moving = !p.still && !art.still && b !== null && arrivals > 0;

  return (
    <span
      ref={ref}
      className={["figure", moving ? "" : "figure--still", p.className ?? ""].filter(Boolean).join(" ")}
      role="img"
      aria-label={`Drawing of ${p.lift}`}
    >
      <span key={`a${arrivals}`} className="figure__frame figure__frame--a" style={mask(a)} />
      {moving && <span key={`b${arrivals}`} className="figure__frame figure__frame--b" style={mask(b)} />}
    </span>
  );
}

/**
 * The close-up: both frames side by side, named, standing still.
 *
 * The second frame is the turn of the rep — the bottom of a squat, the top of a
 * curl — so it is "Halfway", not "Finish": every rep ends where it started. A
 * hold has no halfway; showing its other frame would show the hips dipping that
 * `still` exists to hide, so a hold shows its one held frame.
 */
export function LiftFrames(p: { lift: string }) {
  const art = artFor(p.lift);
  if (!art) return null;
  const [a, b] = frameUrls(art);
  if (!a) return null;
  const shown: [string, string][] = art.still || !b ? [["Held", a]] : [["Start", a], ["Halfway", b]];
  return (
    <span className="frames">
      {shown.map(([label, url]) => (
        <span className="frames__one" key={label}>
          <span className="figure figure--still figure--lg" role="img" aria-label={`${p.lift}, ${label.toLowerCase()}`}>
            <span className="figure__frame figure__frame--a" style={mask(url)} />
          </span>
          <span className="frames__label" aria-hidden>{label}</span>
        </span>
      ))}
    </span>
  );
}
