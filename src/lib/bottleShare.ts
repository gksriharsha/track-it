/**
 * Part of a bottle, judged by eye: how a share set on the water sheet's slider
 * reads, and what it comes to.
 *
 * The slider runs from an empty bottle to a full one, the way the user asked
 * for it, and where it is left is how much of the bottle was drunk. A bottle
 * partway through and a refill only partly finished read the same way, as a
 * share of what the bottle holds. Nothing here is a scale reading, and the
 * entry it writes says so ("part of a bottle, not weighed").
 */
import type { Bottle } from "../types.ts";

/** Where a tap puts the slider, in percent of the bottle: the fractions people say. */
export const STOPS: readonly { pct: number; label: string }[] = [
  { pct: 25, label: "¼" },
  { pct: 50, label: "½" },
  { pct: 75, label: "¾" },
  { pct: 100, label: "Whole" },
];

/**
 * The slider's step, in percent: a twentieth of a bottle. Finer than an eye
 * can judge the water in one, and every stop above lands on it.
 */
export const STEP_PCT = 5;

/** Water at 20 °C, in grams per millilitre, as `trackit_core::water` has it. */
const DENSITY = 0.9982;

/**
 * What `share` of a bottle comes to in millilitres: its own label where it
 * was calibrated, the density of water where it was only weighed empty — what
 * `volume_of` in Rust makes of the grams the backend will log. Null for a
 * bottle never weighed empty, since what it holds is not known.
 */
export function shareMl(b: Bottle, share: number): number | null {
  if (b.empty_g === null) return null;
  const held = b.full_g - b.empty_g;
  if (!(held > 0)) return null;
  return b.volume_ml !== null ? share * b.volume_ml : (share * held) / DENSITY;
}

/** The share, said: "Half of Steel flask", "A quarter of …", "40% of …", "All of …". */
export function shareOf(share: number, name: string): string {
  const pct = Math.round(share * 100);
  if (pct >= 100) return `All of ${name}`;
  if (pct === 75) return `Three quarters of ${name}`;
  if (pct === 50) return `Half of ${name}`;
  if (pct === 25) return `A quarter of ${name}`;
  return `${pct}% of ${name}`;
}
