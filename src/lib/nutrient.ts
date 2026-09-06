import type { NutrientTotal, TargetBasis } from "../types";
import { CONFIDENCE_THRESHOLD } from "../types";

/**
 * How one nutrient total should read on screen.
 *
 * Three states, kept visually distinct because a dashboard that collapses them
 * into "0" is confidently wrong:
 *
 *   measured   "142 mg"     enough of the day's mass had data
 *   partial    "≥ 4.2 mg"   we can account for this much and no more
 *   unknown    "—"          nothing measured this nutrient
 *
 * `showTrack` keys off COVERAGE, never off whether the number happens to be
 * non-null. Drawing an empty progress track asserts "0% of target", which is
 * the exact falsehood the whole data model exists to prevent.
 */
export type Reading = {
  state: "measured" | "partial" | "unknown";
  amount: string;
  note: string;
  /** Percent of the daily value, or null when no reference value exists. */
  pct: number | null;
  showTrack: boolean;
  /** True only when a nutrient that is a ceiling has been exceeded. */
  over: boolean;
  /**
   * Which reference system the percentage is against, or null when there is no
   * target. A percentage whose denominator cannot be named is not a fact about
   * anything, so this travels with `pct` rather than being looked up again.
   */
  basis: TargetBasis | null;
  /**
   * How much of the amount came from a supplement rather than from food,
   * already formatted — or null when none was taken. Kept separate because
   * "1,000 µg of B12" means a different thing when it came out of a bottle,
   * and because the upper limits for supplemental magnesium, folic acid,
   * niacin and vitamin E are stated over exactly this quantity.
   */
  fromSupplement: string | null;
};

export function fmtAmount(n: number, unit: string): string {
  const digits = n === 0 ? 0 : n < 1 ? 2 : n < 10 ? 1 : 0;
  return `${n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${displayUnit(unit)}`;
}

/**
 * The magnitude as a reader expects to see it.
 *
 * The reference database stores micrograms as the ASCII "ug", which is a
 * storage spelling rather than a unit anyone writes — labels print "mcg" and
 * the DRI tables print "µg". Rendering it raw put "45 ug" on screen.
 */
export function displayUnit(unit: string): string {
  return unit === "ug" ? "\u00b5g" : unit;
}

export function read(t: NutrientTotal): Reading {
  const { total, magnitude, target, target_basis, is_limit } = t;
  const sup = total.from_supplements;

  if (total.items_total === 0) {
    return {
      state: "unknown", amount: "—", note: "", pct: null,
      showTrack: false, over: false, basis: null, fromSupplement: null,
    };
  }

  // How much of the day's FOOD had data. Null means nothing with a mass was
  // logged — a supplements-only day — which is not the same as nothing being
  // known, so it must not fall through to the zero-coverage branch below.
  const massOk = total.coverage === null || total.coverage >= CONFIDENCE_THRESHOLD;
  const dosesOk = sup === null || sup.doses_covered === sup.doses_total;

  // Grams and pill counts are not commensurable, so the two are required
  // separately rather than blended into one fraction. A blend would need an
  // exchange rate between a gram of dal and a tablet, which would have to be
  // invented.
  if (total.coverage === 0 && sup === null) {
    const n = total.items_total;
    return {
      state: "unknown",
      amount: "—",
      note: `no data in ${n} item${n > 1 ? "s" : ""}`,
      pct: null,
      showTrack: false,
      over: false,
      basis: null,
      fromSupplement: null,
    };
  }

  const fromSupplement = sup === null ? null : fmtAmount(sup.lower, magnitude);

  if (!massOk || !dosesOk) {
    // Say which side is short. A supplement whose panel was not fully
    // transcribed is genuinely an unknown quantity of this nutrient, however
    // well the food was measured — and the remedy is different from the one
    // for an unmeasured ingredient, so the note has to distinguish them.
    const missing = total.items_total - total.items_covered;
    const why = !dosesOk && massOk
      ? "a supplement does not list it"
      : `${missing} item${missing > 1 ? "s" : ""} unmeasured`;
    return {
      state: "partial",
      // "≥ 0 mg" looks like a measurement of nothing and conveys less than a
      // dash. When we cannot account for any of it, say so the same way the
      // no-data case does.
      amount: total.lower === 0 ? "—" : `≥ ${fmtAmount(total.lower, magnitude)}`,
      note: why,
      pct: null,
      showTrack: false,
      over: false,
      basis: target_basis,
      fromSupplement,
    };
  }

  const pct = target ? (total.lower / target) * 100 : null;
  const measured = total.coverage !== null && total.coverage < 1
    ? `${Math.round(total.coverage * 100)}% measured`
    : "";
  return {
    state: "measured",
    amount: fmtAmount(total.lower, magnitude),
    note: measured,
    pct,
    showTrack: pct !== null,
    // Only a nutrient that is a CEILING can be exceeded. Being under a target
    // is information, not an error — colouring both alarms trains you to
    // ignore the alarm.
    over: is_limit && pct !== null && pct > 100,
    basis: target_basis,
    fromSupplement,
  };
}

/**
 * What actually deserves attention today: limits that have been breached
 * first, then the furthest-below targets. Only nutrients with enough measured
 * data to judge are eligible — we can't call something low if we didn't
 * measure it.
 */
/**
 * Energy and the macros are already the hero, and "carbs at 4% of target" at
 * 9am is not a finding — it is the time of day. Flagging them here is noise
 * that pushes the micronutrients you actually cannot see out of the list.
 */
const NOT_A_FINDING = new Set([
  1008, // Energy
  1003, // Protein
  1004, // Total fat
  1005, // Carbohydrate
  1051, // Water
]);

export function worthALook(totals: NutrientTotal[], limit = 5) {
  const judged = totals
    .map((t) => ({ t, r: read(t) }))
    .filter((x) => x.r.state === "measured" && x.r.pct !== null && !NOT_A_FINDING.has(x.t.id));

  const breached = judged.filter((x) => x.r.over).sort((a, b) => b.r.pct! - a.r.pct!);
  const low = judged
    .filter((x) => !x.t.is_limit && x.r.pct! < 60)
    .sort((a, b) => a.r.pct! - b.r.pct!);

  return [...breached, ...low].slice(0, limit);
}

export function unassessable(totals: NutrientTotal[]) {
  return totals.filter((t) => {
    const r = read(t);
    return t.total.items_total > 0 && r.state !== "measured";
  });
}

/** "1 ingredient" / "2 ingredients" — count first so the call site reads naturally. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A fraction as a percentage, for an ingredient's share of a batch.
 *
 * Anything at or above 10% is whole; below that it keeps one decimal, because
 * a recipe's small lines are where the interesting differences live — 0.4% of
 * the batch and 2% of it both round to nothing useful otherwise. A non-zero
 * share never renders as "0%": a line that is genuinely in the dish must not
 * read as absent from it.
 */
export function pct(fraction: number): string {
  const p = fraction * 100;
  // A line that is not the whole batch must never read as if it were. 99.87%
  // rounds to "100%", which alongside a 0.1% line says the two add to 100.1
  // and says the small one is nothing — so anything short of the whole keeps a
  // decimal rather than being rounded up into a claim.
  if (p < 100 && Math.round(p) >= 100) return "99.9%";
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 0.1) return `${Math.round(p * 10) / 10}%`;
  return p > 0 ? "<0.1%" : "0%";
}
