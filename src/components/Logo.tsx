/**
 * The TrackIt mark: one ring, two stroke weights.
 *
 * The heavy sweep is what has been measured; the hairline completing it is what
 * has not. It is the same geometry every nutrient row draws — a heavy fill
 * against a light track — closed into a circle, so the identity is the
 * interface's smallest unit rather than a metaphor bolted on afterwards.
 *
 * The ring always closes. A gap would read as broken; a weight change reads as
 * deliberate.
 */

// The outer edge is one true circle and the weight grows INWARD. Aligning the
// centrelines instead (the obvious thing) steps the silhouette at both
// junctions, and the mark stops reading as a ring at all — it reads as two arcs
// bolted together. Fixing the outer radius keeps the circle whole and puts the
// entire weight change on the inner edge, where it belongs.
const R = 13.5; // outer radius inside the 32×32 viewBox
const C = 16; // centre
const TOP = -90; // the measured sweep starts at 12 o'clock
const SPLIT = 150; // …and runs 240° clockwise to here

function point(r: number, deg: number): string {
  const a = (deg * Math.PI) / 180;
  const round = (n: number) => +n.toFixed(3);
  return `${round(C + r * Math.cos(a))} ${round(C + r * Math.sin(a))}`;
}

/** An arc whose OUTER edge sits on R, given its stroke width. */
function arc(width: number, from: number, to: number, large: 0 | 1): string {
  const r = +(R - width / 2).toFixed(3);
  return `M ${point(r, from)} A ${r} ${r} 0 ${large} 1 ${point(r, to)}`;
}

/** The two paths, as a plain array so callers can reuse the geometry. */
export function ringPaths(thick: number, thin: number): [string, string] {
  return [
    arc(thick, TOP, SPLIT, 1), // 240° — measured
    arc(thin, SPLIT, TOP + 360, 0), // 120° — not measured
  ];
}

/**
 * Butt caps, not round: a circular arc's butt cap is perpendicular to the
 * tangent, i.e. exactly radial, so both caps land on the same radius line and
 * the width step reads as a crisp shoulder. Round caps bulge past the junction
 * on both arcs and stack into visible lumps.
 */
export default function Logo({ size = 22 }: { size?: number }) {
  // A 1.4 hairline is sub-pixel at 16px, so the ratio tightens as the mark
  // shrinks rather than scaling uniformly.
  const [thick, thin] =
    size <= 18 ? [5.4, 2.4] : size <= 24 ? [4.8, 2] : size <= 34 ? [4.4, 1.7] : [4, 1.4];
  const [measured, unmeasured] = ringPaths(thick, thin);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className="logo"
      role="img"
      aria-label="TrackIt"
      style={{ flex: "none", display: "block" }}
    >
      <path d={measured} fill="none" stroke="currentColor" strokeWidth={thick} strokeLinecap="butt" />
      <path d={unmeasured} fill="none" stroke="currentColor" strokeWidth={thin} strokeLinecap="butt" />
    </svg>
  );
}
