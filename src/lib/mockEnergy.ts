/**
 * The browser fixture's energy arithmetic: one component's energy, and the
 * sum of several, the way `trackit_core::aggregate::sum` works them out —
 * closely enough to draw the screen, and no more. The real one is tested in
 * Rust. Kept apart from `mockDay.ts`, which holds the log itself, so that the
 * log stays a file a person can read down.
 */
import type { DailyTotal } from "../types";

/**
 * What one component contributed to the day's energy. `grams` is null for a
 * dose, which has no mass and stays out of the coverage denominator.
 */
export interface Part {
  description: string;
  fdc_id: number | null;
  grams: number | null;
  lower: number;
  /** Null when nothing bounds it above — the component is unmeasured. */
  upper: number | null;
  covered: boolean;
  /** False when nothing at all is known about it, so the row can say so. */
  has_data: boolean;
}

export function measured(description: string, fdc_id: number | null, grams: number, kcal: number): Part {
  return { description, fdc_id, grams, lower: kcal, upper: kcal, covered: true, has_data: true };
}

export function unmeasured(description: string, grams: number): Part {
  return { description, fdc_id: null, grams, lower: 0, upper: null, covered: false, has_data: false };
}

/** A dose: no mass, and whatever its panel bounds. */
export function dose(description: string, lower: number, upper: number | null, covered: boolean): Part {
  return { description, fdc_id: null, grams: null, lower, upper, covered, has_data: true };
}

/** `aggregate::sum` for energy, and nothing more. */
export function sum(parts: Part[]): DailyTotal {
  let lower = 0;
  let upper: number | null = 0;
  let mass = 0;
  let massCovered = 0;
  let covered = 0;
  let doses = 0;
  let dosesCovered = 0;
  let supLower = 0;
  let supUpper: number | null = 0;
  for (const p of parts) {
    lower += p.lower;
    upper = upper === null || p.upper === null ? null : upper + p.upper;
    if (p.covered) covered += 1;
    if (p.grams === null) {
      doses += 1;
      supLower += p.lower;
      supUpper = supUpper === null || p.upper === null ? null : supUpper + p.upper;
      if (p.covered) dosesCovered += 1;
    } else {
      mass += p.grams;
      if (p.covered) massCovered += p.grams;
    }
  }
  return {
    lower,
    upper,
    coverage: mass > 0 ? massCovered / mass : null,
    items_total: parts.length,
    items_covered: covered,
    from_supplements:
      doses > 0
        ? { lower: supLower, upper: supUpper, doses_total: doses, doses_covered: dosesCovered }
        : null,
  };
}
