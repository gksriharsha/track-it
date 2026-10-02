/**
 * What a single day's nutrient is read against, in words — shared by the
 * day's sheet on Today and the desktop's Nutrients screen, which are two
 * views of one day and used to disagree about it: the sheet said "Daily Value
 * 2,300 mg, a limit" and drew sodium in plain ink, while the screen said
 * "limit 2,300 mg" in the ceiling's red and "of your target" under energy.
 * One set of words, here, so they cannot drift apart again.
 */
import type { EnergyTarget, MacroRange, NutrientTotal } from "../types";
import { fmtAmount } from "./nutrient";

const ENERGY = 1008;

/** The three macronutrients' names, as a range's (i) lists them. */
const MACRO_NAME: Record<number, string> = { 1003: "protein", 1005: "carbohydrate", 1004: "fat" };

/**
 * The figure a nutrient is read against, with the name of the system it comes
 * from — never "your target", which turned a published figure the user never
 * set into a commitment, and never a bare number with no name at all.
 *
 * Energy reads the day's own figure — the one set in About you, or estimated
 * from it — rather than the generic one the panel would otherwise carry.
 */
export function referenceFor(t: NutrientTotal, energy: EnergyTarget | null): string | null {
  if (t.id === ENERGY && energy !== null) {
    const kcal = Math.round(energy.kcal).toLocaleString();
    return energy.basis === "estimated" ? `estimated need ${kcal} kcal` : `set by you ${kcal} kcal`;
  }
  if (t.target === null || t.target_basis === null) return null;
  const amount = fmtAmount(t.target, t.magnitude);
  const limit = t.is_limit ? ", a limit" : "";
  switch (t.target_basis) {
    case "rda": return `RDA ${amount}${limit}`;
    case "ai": return `adequate intake ${amount}${limit}`;
    case "daily_value": return `Daily Value ${amount}${limit}`;
    case "user_set": return `set by you ${amount}${limit}`;
  }
}

/**
 * A macronutrient's acceptable range, in grams for this person: "acceptable
 * 252–364 g". A range and not a point — there is no single right amount of
 * fat, and the midpoint of 20–35% is not a figure to reach. The share of
 * energy each range is drawn from is method, and is in the sheet's (i)
 * (`rangeShares`): on a phone it wrapped the row to three lines.
 */
export function rangeFor(t: NutrientTotal, ranges: MacroRange[]): string | null {
  const r = ranges.find((m) => m.nutrient_id === t.id);
  if (!r) return null;
  return `acceptable ${Math.round(r.low_g)}–${Math.round(r.high_g)} g`;
}

/** "protein 10–35%, carbohydrate 45–65% and fat 20–35%", or null for none. */
export function rangeShares(ranges: MacroRange[]): string | null {
  const bits = [1003, 1005, 1004]
    .map((id) => ranges.find((r) => r.nutrient_id === id))
    .filter((r): r is MacroRange => r !== undefined)
    .map((r) => `${MACRO_NAME[r.nutrient_id]} ${r.low_pct}–${r.high_pct}%`);
  if (bits.length === 0) return null;
  return bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}`;
}

/**
 * The "N% measured" most of a day's measured nutrients share, as a whole
 * percent — or null when no share is common to at least three.
 *
 * It is one fact about the day's food, not about each nutrient: when a pack
 * with nothing on it is a twentieth of what was eaten, every nutrient the rest
 * measured reads "95% measured", and eighteen rows of the same note were
 * eighteen readings of one sentence. Said once at the head instead, and kept
 * on a row only where that row's share differs.
 */
export function sharedCoverage(totals: NutrientTotal[], measured: (t: NutrientTotal) => boolean): number | null {
  const counts = new Map<number, number>();
  for (const t of totals) {
    const c = t.total.coverage;
    if (!measured(t) || c === null || c >= 1) continue;
    const pct = Math.round(c * 100);
    counts.set(pct, (counts.get(pct) ?? 0) + 1);
  }
  let best: number | null = null;
  let most = 2;
  for (const [pct, n] of counts) {
    if (n > most) {
      best = pct;
      most = n;
    }
  }
  return best;
}
