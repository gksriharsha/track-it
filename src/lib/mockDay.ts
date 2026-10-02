/**
 * The day's log for the browser fixture (`pnpm dev`): what was had, what each
 * entry came to in energy, and the writes that change the day — a remove, the
 * undo of a remove, a bottle drunk, a correction — kept for the life of the
 * tab so those flows can be walked through in a browser.
 *
 * Kept apart from `mock.ts` for the reason `mockActivity.ts` is. Like the rest
 * of the fixture it is deliberately uneven: most entries are measured, one dish
 * is only partly measured (its drumstick pods have no data), one pack carries
 * nothing at all, and a vitamin states no energy. A day where every row read
 * cleanly would hide the three states a row exists to tell apart.
 *
 * Energy is the only nutrient modelled entry by entry. It is the one figure a
 * row, a meal and the day all print, and the one a remove and its undo visibly
 * move, so it is worked out here from the entries the way the backend does.
 * Every other nutrient on the day stays the fixed figure `mock.ts` prints. The
 * arithmetic mirrors `trackit_core::aggregate::sum` closely enough to draw the
 * screen and no more; the real one is tested in Rust.
 */
import type {
  Bottle,
  Component,
  DailyTotal,
  EntryBreakdown,
  EntrySnapshotView,
  LogEntry,
  Meal,
  MealEnergy,
  NutrientValue,
  Origin,
  SnapshotBasis,
  Volume,
} from "../types";
import { MEALS, WHOLE_BOTTLE_NOTE } from "../types";

/** A local calendar date, as the app's own `todayIso` writes it — never UTC. */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localToday(): string {
  return localIso(new Date());
}

const ENERGY = 1008;

/* ── one component's energy, already scaled to what was had ─────────────── */

/**
 * What one component contributed to the day's energy. `grams` is null for a
 * dose, which has no mass and stays out of the coverage denominator.
 */
interface Part {
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

function measured(description: string, fdc_id: number | null, grams: number, kcal: number): Part {
  return { description, fdc_id, grams, lower: kcal, upper: kcal, covered: true, has_data: true };
}

function unmeasured(description: string, grams: number): Part {
  return { description, fdc_id: null, grams, lower: 0, upper: null, covered: false, has_data: false };
}

/** `aggregate::sum` for energy, and nothing more. */
function sum(parts: Part[]): DailyTotal {
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

/* ── the log ────────────────────────────────────────────────────────────── */

interface Logged {
  entry: LogEntry;
  parts: Part[];
  recipe: { name: string; yield_g: number; servings: number | null } | null;
  /** When it was removed, in milliseconds, or null while it is on the day. */
  removedAt: number | null;
  basis: SnapshotBasis;
  frozenAt: string;
  correctedAt: string | null;
}

type Tags = { cuisine?: string; origin?: Origin };

function blank(id: string, meal: Meal | null, description: string): LogEntry {
  return {
    id,
    logged_on: localToday(),
    meal,
    source_kind: "food",
    fdc_id: null,
    recipe_id: null,
    cook_id: null,
    custom_food_id: null,
    supplement_id: null,
    bottle_id: null,
    description,
    grams: null,
    units: null,
    gross_g: null,
    tare_g: null,
    tare_note: null,
    origin: null,
    cuisine: null,
  };
}

let created = 0;
function logged(entry: LogEntry, parts: Part[], recipe: Logged["recipe"] = null): Logged {
  // Each entry frozen a few minutes after the last, so the correction screen
  // has a plausible "recorded on" to say.
  created += 1;
  const at = new Date(`${entry.logged_on}T07:30:00`);
  at.setMinutes(at.getMinutes() + created * 7);
  return { entry, parts, recipe, removedAt: null, basis: "logged", frozenAt: at.toISOString(), correctedAt: null };
}

/** A plain reference food: one measured component, and no breakdown rows. */
function plain(id: string, meal: Meal, description: string, grams: number, kcal: number, t: Tags = {}): Logged {
  const e = { ...blank(id, meal, description), fdc_id: 168874, grams, origin: t.origin ?? null, cuisine: t.cuisine ?? null };
  return logged(e, [measured(description, 168874, grams, kcal)]);
}

/** A dish portioned out of a recipe, one part per ingredient. */
function dish(
  id: string,
  meal: Meal,
  description: string,
  grams: number,
  recipe: NonNullable<Logged["recipe"]>,
  parts: Part[],
  t: Tags,
): Logged {
  const e = {
    ...blank(id, meal, description),
    source_kind: "recipe" as const,
    recipe_id: `r-${id}`,
    grams,
    origin: t.origin ?? null,
    cuisine: t.cuisine ?? null,
  };
  return logged(e, parts, recipe);
}

export const BOTTLES: Bottle[] = [
  { id: "b1", name: "Steel flask (1 L)", full_g: 1284, empty_g: 294, volume_ml: 1000, last_used_at: "2026-09-06T09:10:00Z" },
  { id: "b2", name: "Desk bottle (750 ml)", full_g: 968, empty_g: null, volume_ml: null, last_used_at: null },
];

/** `trackit_core::water::volume_of`: the bottle's own scale where it has one. */
function volumeOf(b: Bottle, grams: number): Volume {
  if (b.empty_g !== null && b.volume_ml !== null && b.full_g > b.empty_g) {
    return { kind: "measured", ml: (grams * b.volume_ml) / (b.full_g - b.empty_g) };
  }
  return { kind: "assumed", ml: grams / 0.9982 };
}

let waterSeq = 0;
/**
 * A bottle's worth, against the day rather than a sitting. Weighed off the
 * scale unless `whole`: then the note says so and no reading is stored, the
 * way `log_whole_bottle` writes it.
 */
function water(b: Bottle, grams: number, whole = false, id?: string): Logged {
  waterSeq += 1;
  const e: LogEntry = {
    ...blank(id ?? `w-${waterSeq}`, null, b.name),
    source_kind: "water",
    bottle_id: b.id,
    grams,
    water: volumeOf(b, grams),
    gross_g: whole ? null : b.full_g,
    tare_g: whole ? null : b.full_g - grams,
    tare_note: whole ? WHOLE_BOTTLE_NOTE : "",
  };
  return logged(e, [measured(b.name, null, grams, 0)]);
}

const LOG: Logged[] = [
  plain("e1", "breakfast", "Idli, steamed rice cake", 156, 228, { cuisine: "South Indian", origin: "home" }),
  // Partly measured: nothing knows drumstick pods, so the dish reads "≥".
  dish("e2", "breakfast", "Sambar, lentil and vegetable stew", 210, { name: "Sambar", yield_g: 1680, servings: 8 }, [
    measured("Lentils, toor, raw", 172420, 48, 165),
    unmeasured("Drumstick pods, raw", 70),
    measured("Tamarind pulp", 168196, 18, 43),
  ], { cuisine: "South Indian", origin: "home" }),
  plain("e3", "breakfast", "Coffee, brewed, with whole milk", 240, 98, { origin: "home" }),
  // A US panel that leaves calories off says "under 5 kcal" — a bound, not a
  // figure, and nothing a row should print as energy.
  logged(
    { ...blank("s1", "breakfast", "Vitamin D3, 1,000 IU"), source_kind: "supplement", supplement_id: "sup1", units: 1 },
    [{
      description: "Vitamin D3 — 1 off the panel, 14 bounded by what the panel must declare, 32 the panel does not mention",
      fdc_id: null, grams: null, lower: 0, upper: 5, covered: true, has_data: true,
    }],
  ),
  // Mostly measured: the ghee line has no data, which is 12 g of 219.
  dish("e4", "lunch", "Dal tadka (urad and toor)", 285, { name: "Dal tadka", yield_g: 1140, servings: 4 }, [
    measured("Lentils, urad, raw", 172421, 62, 211),
    measured("Lentils, toor, raw", 172420, 38, 130),
    measured("Onions, raw", 170000, 45, 18),
    measured("Tomatoes, red, ripe", 170457, 60, 11),
    unmeasured("Ghee", 12),
    measured("Turmeric, ground", 170933, 2, 6),
  ], { cuisine: "North Indian", origin: "home" }),
  plain("e5", "lunch", "Chapati, whole wheat", 96, 285, { cuisine: "North Indian", origin: "home" }),
  plain("e6", "lunch", "Bhindi masala", 168, 156, { cuisine: "North Indian", origin: "home" }),
  plain("e7", "lunch", "Curd, plain whole milk", 120, 73, { origin: "home" }),
  // One of the user's own packs with nothing transcribed off it: unmeasured,
  // which reads "—" and never 0.
  logged(
    { ...blank("e8", "snack", "Roasted chana, salted"), source_kind: "custom", custom_food_id: "c1", grams: 45, origin: "packaged" },
    [unmeasured("Roasted chana, salted — nothing off the pack", 45)],
  ),
  plain("e9", "dinner", "Vegetable pulao", 320, 352, { cuisine: "North Indian", origin: "ordered_in" }),
  plain("e10", "dinner", "Paneer butter masala", 190, 380, { cuisine: "North Indian", origin: "ordered_in" }),
  // Two bottles and no meal: water is drunk across the day. One weighed, one
  // from the uncalibrated bottle, so both readings of a volume are on show.
  water(BOTTLES[0], 884, false, "w1"),
  water(BOTTLES[1], 612, false, "w2"),
];

/* ── what get_day reads ─────────────────────────────────────────────────── */

const live = (iso: string) => LOG.filter((l) => l.removedAt === null && l.entry.logged_on === iso);

export function dayEntries(iso: string): LogEntry[] {
  return live(iso).map((l) => ({ ...l.entry }));
}

/** Null for a dose whose panel states no energy, exactly as `collect_day` decides it. */
function energyOf(l: Logged): DailyTotal | null {
  const t = sum(l.parts);
  return l.entry.source_kind === "supplement" && t.lower <= 0 ? null : t;
}

/** One per live entry, so a row can always find its own. */
export function dayBreakdowns(iso: string): EntryBreakdown[] {
  return live(iso).map((l) => ({
    entry_id: l.entry.id,
    // A plain food and a bottle are their own description; repeating it as a
    // single component would print the same line twice.
    components:
      l.entry.source_kind === "food" || l.entry.source_kind === "water"
        ? []
        : l.parts.map<Component>((p) => ({
            description: p.description,
            fdc_id: p.fdc_id,
            grams: p.grams,
            has_data: p.has_data,
          })),
    recipe_name: l.recipe?.name ?? null,
    recipe_yield_g: l.recipe?.yield_g ?? null,
    recipe_servings: l.recipe?.servings ?? null,
    energy: energyOf(l),
  }));
}

/** Summed from the parts, not from rounded rows; a vitamin alone is no meal. */
export function dayMeals(iso: string): MealEnergy[] {
  const out: MealEnergy[] = [];
  for (const meal of MEALS) {
    const parts = live(iso)
      .filter((l) => l.entry.meal === meal && energyOf(l) !== null)
      .flatMap((l) => l.parts);
    if (parts.length > 0) out.push({ meal, energy: sum(parts) });
  }
  return out;
}

/** The day's energy, from every live entry — doses included, as the day's is. */
export function dayEnergy(iso: string): DailyTotal | null {
  const all = live(iso);
  return all.length === 0 ? null : sum(all.flatMap((l) => l.parts));
}

/* ── correcting an entry ────────────────────────────────────────────────── */

function find(id: string): Logged {
  const l = LOG.find((x) => x.entry.id === id);
  if (!l) throw new Error(`log entry ${id} is not in the log`);
  return l;
}

/** Energy per 100 g, or per serving for a dose, as the snapshot stores it. */
function valueOf(p: Part): NutrientValue | null {
  const per = p.grams === null ? 1 : p.grams / 100;
  if (!p.covered) return null;
  if (p.upper !== null && p.upper > p.lower) return { kind: "label_zero", upper: p.upper / per };
  return { kind: "measured", amount: p.lower / per };
}

function snapshot(l: Logged): EntrySnapshotView {
  return {
    entry_id: l.entry.id,
    description: l.entry.description,
    basis: l.basis,
    frozen_at: l.frozenAt,
    corrected_at: l.correctedAt,
    grams: l.entry.grams,
    units: l.entry.units,
    unit_noun: l.entry.source_kind === "supplement" ? "tablet" : null,
    recipe_name: l.recipe?.name ?? null,
    parts: l.parts.map((p, ordinal) => {
      const v = valueOf(p);
      return {
        ordinal,
        description: p.description,
        fdc_id: p.fdc_id,
        grams: p.grams,
        servings: p.grams === null ? l.entry.units : null,
        has_data: p.has_data,
        values: v === null ? [] : [{ nutrient_id: ENERGY, value: v }],
      };
    }),
  };
}

function corrected(l: Logged) {
  l.basis = "corrected";
  l.correctedAt = new Date().toISOString();
}

/** Ten minutes, as `store::RESTORE_WINDOW_SECS` has it. */
const RESTORE_WINDOW_MS = 600_000;

function logBottle(a: Record<string, unknown>, whole: boolean): string {
  const b = BOTTLES.find((x) => x.id === String(a.bottleId));
  if (!b) throw new Error(`bottle ${String(a.bottleId)} is no longer in the library`);
  let grams: number;
  if (whole) {
    if (b.empty_g === null) {
      throw new Error(
        `${b.name} has never been weighed empty, so what a full one holds is not known — ` +
          "weigh it after drinking instead, or add its empty weight in Water bottles",
      );
    }
    grams = b.full_g - b.empty_g;
  } else {
    grams = b.full_g - Number(a.currentG);
    if (!(grams > 0)) throw new Error(`${b.name} reads no less than its full weight — nothing to log`);
  }
  const l = water(b, grams, whole);
  l.entry.logged_on = String(a.loggedOn ?? localToday());
  LOG.push(l);
  b.last_used_at = new Date().toISOString();
  return l.entry.id;
}

/** Energy per 100 g of the foods offered one tap, roughly as the reference has them. */
const KCAL_100G: Record<number, number> = { 168874: 365, 172421: 352, 171287: 61, 171705: 876, 170554: 23 };
let addSeq = 0;

export const DAY_TABLE: Record<string, (a: Record<string, unknown>) => unknown> = {
  // Onto the day for the life of the tab, so a one-tap repeat shows on Today
  // and its Undo has a row to take away. A dose is drawn with no energy, a
  // weighed plate at its gross (the vessels live in mock.ts), and anything off
  // the list above at 150 kcal per 100 g.
  add_log_entry: (a) => {
    addSeq += 1;
    const n = (k: string) => (a[k] == null ? null : Number(a[k]));
    const e: LogEntry = {
      ...blank(`a-${addSeq}`, (a.meal as Meal) ?? "snack", String(a.description ?? "")),
      logged_on: String(a.loggedOn ?? localToday()),
      source_kind: a.supplementId ? "supplement" : a.customFoodId ? "custom" : a.recipeId ? "recipe" : a.cookId ? "cook" : "food",
      fdc_id: n("fdcId"), recipe_id: (a.recipeId as string) ?? null, cook_id: (a.cookId as string) ?? null,
      custom_food_id: (a.customFoodId as string) ?? null, supplement_id: (a.supplementId as string) ?? null,
      grams: n("grams") ?? n("grossG"), units: n("units"),
      origin: (a.origin as Origin) ?? null, cuisine: (a.cuisine as string) ?? null,
    };
    const kcal = (e.grams ?? 0) * (KCAL_100G[e.fdc_id ?? 0] ?? 150) / 100;
    LOG.push(logged(e, e.units !== null
      ? [{ description: e.description, fdc_id: null, grams: null, lower: 0, upper: 0, covered: true, has_data: true }]
      : [measured(e.description, e.fdc_id, e.grams ?? 0, kcal)]));
    return e.id;
  },
  // Off the day, and recoverable for ten minutes — the real remove is a soft
  // delete too. An id the log does not hold is a no-op, as an UPDATE that
  // matches nothing is.
  delete_log_entry: (a) => {
    const l = LOG.find((x) => x.entry.id === String(a.id));
    if (l && l.removedAt === null) l.removedAt = Date.now();
    return undefined;
  },
  restore_log_entry: (a) => {
    const l = LOG.find((x) => x.entry.id === String(a.id));
    if (!l) throw new Error("that entry is not in the log, so there is nothing to bring back");
    if (l.removedAt === null) throw new Error("that entry was never removed, so there is nothing to undo");
    if (Date.now() - l.removedAt > RESTORE_WINDOW_MS) {
      throw new Error(
        "that entry was removed more than ten minutes ago, which is too long ago to undo — log it again instead",
      );
    }
    // The same object, flag cleared: same id, same place in the day, same parts.
    l.removedAt = null;
    return undefined;
  },
  log_water: (a) => logBottle(a, false),
  log_whole_bottle: (a) => logBottle(a, true),

  get_entry_snapshot: (a) => snapshot(find(String(a.entryId))),
  // Rescales every part by the same ratio, as the real correction does, and
  // clears the scale reading that no longer explains the number.
  correct_entry_amount: (a) => {
    const l = find(String(a.entryId));
    const was = l.entry.grams ?? l.entry.units ?? 0;
    const now = Number(a.grams ?? a.units);
    if (!(now > 0) || !(was > 0)) throw new Error("that needs to be a positive number");
    const r = now / was;
    for (const p of l.parts) {
      p.lower *= r;
      p.upper = p.upper === null ? null : p.upper * r;
      if (p.grams !== null) p.grams *= r;
    }
    if (l.entry.grams !== null) l.entry.grams = now;
    else l.entry.units = now;
    l.entry.gross_g = null;
    l.entry.tare_g = null;
    l.entry.tare_note = null;
    corrected(l);
    return undefined;
  },
  // Only energy is modelled per part here; a correction to any other figure is
  // accepted and recorded as a correction, and changes nothing the fixture draws.
  correct_entry_value: (a) => {
    const l = find(String(a.entryId));
    const p = l.parts[Number(a.ordinal)];
    if (!p) throw new Error("that part is not in this entry");
    if (Number(a.nutrientId) === ENERGY) {
      const per = p.grams === null ? (l.entry.units ?? 1) : p.grams / 100;
      const kind = String(a.kind);
      if (kind === "measured") {
        p.lower = p.upper = Number(a.amount) * per;
        p.covered = p.has_data = true;
      } else if (kind === "unknown") {
        p.lower = 0;
        p.upper = null;
        p.covered = false;
      } else {
        p.lower = 0;
        p.upper = Number(a.upper) * per;
        p.covered = p.has_data = true;
      }
    }
    corrected(l);
    return undefined;
  },
  refreeze_entry: (a) => {
    corrected(find(String(a.entryId)));
    return undefined;
  },
};
