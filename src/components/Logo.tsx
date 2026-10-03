/**
 * The TrackIt mark: the T in two tiles.
 *
 * Archivo's own T, at the wide, heavy setting the app gives a period's figures
 * (wdth 125, wght 800), split into two tiles a hairline apart with the corners
 * the app's tiles have — rounder at the ends of a run, tighter where two meet —
 * the way Today draws a meal's foods, each its own tile. The user chose it in
 * round four of the look picker (October 2026), and the app's icon is the same
 * T in white on teal: see design/logo.
 *
 * It replaced a ring of two weights, a heavy sweep and a hairline completing
 * it, which read as a ring two-thirds full: a picture of filling toward a goal,
 * the one thing this app is not.
 */

// Archivo at wdth 125, wght 800, in its own units: a T 688 tall, its bar 799
// wide and 164 deep, its stem 204 wide. The icon's drawing uses the same four.
const T_H = 688;
const BAR_W = 799;
const BAR_H = 164;
const STEM_W = 204;

const n = (v: number) => +v.toFixed(3);

/**
 * The bar and the stem as two paths, `height` tall, centred on (cx, cy), with
 * `gap` between them. `outer` rounds the corners at the ends of the run — all
 * four of the bar's and the foot of the stem — and `inner` the two where the
 * stem meets the bar.
 */
export function tilePaths(
  height: number,
  gap: number,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
): [string, string] {
  const s = height / T_H;
  const w = BAR_W * s;
  const h = BAR_H * s;
  const sw = STEM_W * s;
  const sh = height - h - gap;
  const x0 = cx - w / 2;
  const y0 = cy - height / 2;
  const R = outer;
  const r = inner;
  const bar =
    `M${n(x0 + R)} ${n(y0)}h${n(w - 2 * R)}a${R} ${R} 0 0 1 ${R} ${R}v${n(h - 2 * R)}` +
    `a${R} ${R} 0 0 1 ${-R} ${R}h${n(-(w - 2 * R))}a${R} ${R} 0 0 1 ${-R} ${-R}v${n(-(h - 2 * R))}` +
    `a${R} ${R} 0 0 1 ${R} ${-R}z`;
  const sx = cx - sw / 2;
  const sy = y0 + h + gap;
  const stem =
    `M${n(sx + r)} ${n(sy)}h${n(sw - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${n(sh - r - R)}` +
    `a${R} ${R} 0 0 1 ${-R} ${R}h${n(-(sw - 2 * R))}a${R} ${R} 0 0 1 ${-R} ${-R}v${n(-(sh - r - R))}` +
    `a${r} ${r} 0 0 1 ${r} ${-r}z`;
  return [bar, stem];
}

export default function Logo({ size = 22 }: { size?: number }) {
  // The hairline is held near a device pixel and a quarter, in the 32-unit
  // grid, so it neither closes up at 16 px nor gapes at 64.
  const gap = Math.max(1.2, (1.25 * 32) / size);
  const [bar, stem] = tilePaths(26, gap, 16, 16, 2.1, 0.7);

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
      <path d={bar} fill="currentColor" />
      <path d={stem} fill="currentColor" />
    </svg>
  );
}
