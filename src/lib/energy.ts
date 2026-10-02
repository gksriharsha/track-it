/**
 * The figure a line of Today prints for an entry, a meal or the day.
 *
 * Today's rows carry their energy now, in small sans on the right, because
 * that is the one figure a person scans a log for — and a log that hid it
 * behind a tap made every reading of the day a trip into a sheet. What a row
 * must not do is say more than is known. So it reads in the same three states
 * every total in the app reads in, decided by the same rule (`stateOf`, which
 * `read` uses too), and only the formatting is a row's own:
 *
 *   measured   "228"     enough of it, by weight, had a figure
 *   partial    "≥208"    this much is accounted for, and some of it is not
 *   unknown    "—"       nothing in it had a figure — not zero
 *   a dose     ""        a tablet stating no energy has none to print
 *
 * The unit is left to the line around it: a column of bare numbers reads as a
 * column, and "kcal" eleven times down the right-hand side is noise. The `≥`
 * sits against the number, without the space `read` gives it, so that a
 * right-aligned column keeps its digits lined up under each other.
 *
 * Bare Node runs this file's test (`energy.test.ts`), so its imports carry
 * their `.ts`.
 */
import type { DailyTotal } from "../types.ts";
import { stateOf } from "./nutrient.ts";

/**
 * An entry's or a meal's energy as a row prints it, or a macronutrient's
 * grams on the day's line.
 *
 * Null is a supplement whose panel states no energy (see `EntryBreakdown`):
 * nothing to print, which is different from "—". A pill is not an unmeasured
 * food, and a dash beside it would say it was.
 */
export function rowFigure(t: DailyTotal | null): string {
  if (t === null) return "";
  const state = stateOf(t);
  if (state === "unknown") return "—";
  const n = Math.round(t.lower);
  // "≥0" looks like a measurement of nothing and says less than a dash. When
  // none of it can be accounted for, it is read the way the no-data case is —
  // the rule `read` follows for "≥ 0 mg".
  if (state === "partial") return n === 0 ? "—" : `≥${n.toLocaleString()}`;
  return n.toLocaleString();
}

/**
 * A figure on the day's own line — its energy, and its protein, carbohydrate
 * and fat beside it.
 *
 * The same as a row, with one difference, and it is the one the old hero made:
 * a day on which nothing with a mass was logged reads "—" rather than the
 * supplements' few calories. A pill's energy is not the day's energy, and
 * "10 kcal" at the head of a day that held a fish-oil capsule and nothing
 * else reads as "you barely ate", which is not what is known.
 */
export function dayFigure(t: DailyTotal | null | undefined): string {
  if (t == null || t.coverage === null) return "—";
  return rowFigure(t);
}

/**
 * A sitting's subtotal, or null for none — by the day's rule, not a row's.
 *
 * A meal is a part of the day, so what holds for the day holds for it: a
 * sitting at which nothing with a mass was had has no energy to total. Read
 * the way a row is, a dinner of two fish-oil softgels headed itself "20 kcal"
 * under a day line reading "—" for the same twenty calories. No subtotal at
 * all, rather than a dash, because the softgel's own row already says what
 * it carried — the same as a sitting holding only a vitamin.
 */
export function mealFigure(t: DailyTotal | null | undefined): string | null {
  if (t == null || t.coverage === null) return null;
  return rowFigure(t);
}

/**
 * How the day's protein, carbohydrate and fat split the energy the three of
 * them carry, in whole percents that add up to 100 — the bar under Today's
 * figure. A share of a whole, so it describes what the day was made of and
 * cannot be read as filling toward anything.
 *
 * At the general factors, 4, 4 and 9 kcal a gram, over what is accounted for
 * of each (its lower bound). Null when any of the three has no figure at all,
 * or none of them has any weight: a split with a part missing would be a
 * split of something else.
 */
export function energyShares(
  protein: DailyTotal | null | undefined,
  carbs: DailyTotal | null | undefined,
  fat: DailyTotal | null | undefined,
): { protein: number; carbs: number; fat: number } | null {
  const parts = [protein, carbs, fat];
  if (parts.some((t) => t == null || t.coverage === null || stateOf(t) === "unknown")) return null;
  const kcal = [parts[0]!.lower * 4, parts[1]!.lower * 4, parts[2]!.lower * 9];
  const sum = kcal[0] + kcal[1] + kcal[2];
  if (!(sum > 0)) return null;
  // Largest remainder, so the three printed percents always add up to 100.
  const exact = kcal.map((k) => (k / sum) * 100);
  const whole = exact.map(Math.floor);
  const order = exact.map((x, i) => [x - whole[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < 100 - (whole[0] + whole[1] + whole[2]); k++) whole[order[k][1]] += 1;
  return { protein: whole[0], carbs: whole[1], fat: whole[2] };
}
