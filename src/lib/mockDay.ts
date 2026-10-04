/**
 * The day's log for the browser fixture (`pnpm dev`): what was had, what each
 * entry came to in energy, and the writes that change the day — a remove, the
 * undo of a remove, a bottle drunk, a correction — kept for the life of the
 * tab so those flows can be walked through in a browser.
 *
 * Kept apart from `mock.ts` for the reason `mockActivity.ts` is. Like the rest
 * of the fixture it is deliberately uneven: most entries are measured, one dish
 * is only partly measured (its drumstick pods have no data), one pack carries
 * nothing at all, two vitamins state no energy (one on a US panel, which
 * bounds it, one on an Indian panel, which cannot), a pot was never weighed
 * and one entry was corrected. A day where every row read cleanly would hide
 * the states a row exists to tell apart.
 *
 * Energy is the only nutrient modelled entry by entry. It is the one figure a
 * row, a meal and the day all print, and the one a remove and its undo visibly
 * move, so it is worked out here from the entries the way the backend does —
 * water and a dose that states no energy left out of the day as they are left
 * out of its rows and meals (see `collect_day`). Every other nutrient on the
 * day stays the fixed figure `mock.ts` prints. The arithmetic is in
 * `mockEnergy.ts`.
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
  Per100g,
  SnapshotBasis,
  Volume,
} from "../types";
import { MEALS, PART_BOTTLE_NOTE, WHOLE_BOTTLE_NOTE } from "../types";
import type { Part } from "./mockEnergy";
import { dose, measured, sum, unmeasured } from "./mockEnergy";

/** A local calendar date, as the app's own `todayIso` writes it — never UTC. */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localToday(): string {
  return localIso(new Date());
}

const ENERGY = 1008;

/* ── the log ────────────────────────────────────────────────────────────── */

interface Logged {
  entry: LogEntry;
  parts: Part[];
  /** `weighed` is for a pot: whether its yield was a weighing (see SnapRecipe). */
  recipe: { name: string; yield_g: number; servings: number | null; weighed: boolean | null } | null;
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
    ml: null,
    pieces: null,
    piece_noun: null,
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
function plain(
  id: string, meal: Meal, description: string, grams: number, kcal: number, t: Tags = {}, fdc = 168874,
): Logged {
  const e = { ...blank(id, meal, description), fdc_id: fdc, grams, origin: t.origin ?? null, cuisine: t.cuisine ?? null };
  return logged(e, [measured(description, fdc, grams, kcal)]);
}

/**
 * The short names the backend gives the reference foods this fixture logs
 * (`Index::entry_name`), each held against the row's description as the
 * dataset has it. An entry carrying other words keeps them, as a past day
 * does once a dataset has reworded its row.
 */
const SHORT_NAMES: Record<number, [description: string, name: string]> = {
  172427: ["Mungo beans, mature seeds, cooked, boiled, without salt", "Mungo beans, boiled"],
  174259: ["Mungo beans, mature seeds, raw", "Mungo beans, raw"],
};

function shortName(fdc: number | null, description: string): string | null {
  const known = fdc === null ? undefined : SHORT_NAMES[fdc];
  return known !== undefined && known[0] === description ? known[1] : null;
}

/** Only a plain reference food is renamed; everything else keeps the name it was logged under. */
function named(e: LogEntry): LogEntry {
  return { ...e, name: e.source_kind === "food" ? shortName(e.fdc_id, e.description) : null };
}

/** A dish portioned out of a recipe or, with `pot`, out of a pot that was cooked. */
function dish(
  id: string,
  meal: Meal,
  description: string,
  grams: number,
  recipe: NonNullable<Logged["recipe"]>,
  parts: Part[],
  t: Tags,
  pot = false,
): Logged {
  const e = {
    ...blank(id, meal, description),
    source_kind: pot ? ("cook" as const) : ("recipe" as const),
    recipe_id: pot ? null : `r-${id}`,
    cook_id: pot ? `k-${id}` : null,
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
 * scale unless it carries a `note` — a whole bottle, or part of one judged by
 * eye — and then no reading is stored, the way `log_whole_bottle` and
 * `log_bottle_share` write it.
 */
function water(b: Bottle, grams: number, note: string | null = null, id?: string): Logged {
  waterSeq += 1;
  const e: LogEntry = {
    ...blank(id ?? `w-${waterSeq}`, null, b.name),
    source_kind: "water",
    bottle_id: b.id,
    grams,
    water: volumeOf(b, grams),
    gross_g: note !== null ? null : b.full_g,
    tare_g: note !== null ? null : b.full_g - grams,
    tare_note: note ?? "",
  };
  return logged(e, [measured(b.name, null, grams, 0)]);
}

const LOG: Logged[] = [
  plain("e1", "breakfast", "Idli, steamed rice cake", 156, 228, { cuisine: "South Indian", origin: "home" }),
  // Partly measured: nothing knows drumstick pods, so the dish reads "≥".
  dish("e2", "breakfast", "Sambar, lentil and vegetable stew", 210, { name: "Sambar", yield_g: 1680, servings: 8, weighed: null }, [
    measured("Lentils, toor, raw", 172420, 48, 165),
    unmeasured("Drumstick pods, raw", 70),
    measured("Tamarind pulp", 168196, 18, 43),
  ], { cuisine: "South Indian", origin: "home" }),
  plain("e3", "breakfast", "Coffee, brewed, with whole milk", 240, 98, { origin: "home" }),
  // A US panel that leaves calories off says "under 5 kcal" — a bound, not a
  // figure, and nothing a row should print as energy.
  logged(
    { ...blank("s1", "breakfast", "Vitamin D3, 1,000 IU"), source_kind: "supplement", supplement_id: "sup1", units: 1 },
    [dose("Vitamin D3 — 1 off the panel, 14 bounded by what the panel must declare, 32 the panel does not mention", 0, 5, true)],
  ),
  // An Indian panel bounds nothing it leaves out, so its energy is simply not
  // known — and still not food: it stays off the day as it stays off the row.
  logged(
    { ...blank("s2", "breakfast", "Vitamin B12, 500 mcg"), source_kind: "supplement", supplement_id: "sup2", units: 1 },
    [dose("Vitamin B12 — 1 off the panel, 46 the panel does not mention", 0, null, false)],
  ),
  // Mostly measured: the ghee line has no data, which is 12 g of 219. Out of a
  // pot nobody weighed, so the portion was divided by the recipe's estimate.
  dish("e4", "lunch", "Dal tadka (urad and toor)", 285, { name: "Dal tadka", yield_g: 1140, servings: null, weighed: false }, [
    measured("Mungo beans, mature seeds, raw", 174259, 62, 211),
    measured("Lentils, toor, raw", 172420, 38, 130),
    measured("Onions, raw", 170000, 45, 18),
    measured("Tomatoes, red, ripe", 170457, 60, 11),
    unmeasured("Ghee", 12),
    measured("Turmeric, ground", 170933, 2, 6),
  ], { cuisine: "North Indian", origin: "home" }, true),
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
  // Urad, boiled: its row reads "Mungo beans, boiled", and its sheet keeps
  // the USDA wording it was logged under.
  plain("e11", "dinner", "Mungo beans, mature seeds, cooked, boiled, without salt", 150, 158,
    { cuisine: "North Indian", origin: "home" }, 172427),
  // Two bottles and no meal: water is drunk across the day. One weighed, one
  // from the uncalibrated bottle, so both readings of a volume are on show.
  water(BOTTLES[0], 884, null, "w1"),
  water(BOTTLES[1], 612, null, "w2"),
  // Yesterday, from before values were frozen: worked out afterwards, which
  // its row says.
  backfilled(plain("y1", "breakfast", "Upma, semolina", 210, 248, { cuisine: "South Indian", origin: "home" })),
];
// The curd was weighed in the wrong bowl and set right: a correction, dated.
corrected(LOG.find((l) => l.entry.id === "e7")!);

function backfilled(l: Logged): Logged {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  l.entry.logged_on = localIso(d);
  l.basis = "backfilled";
  return l;
}

/* ── what get_day reads ─────────────────────────────────────────────────── */

const live = (iso: string) => LOG.filter((l) => l.removedAt === null && l.entry.logged_on === iso);

export function dayEntries(iso: string): LogEntry[] {
  return live(iso).map((l) => named(l.entry));
}

/**
 * Null for what is not food, exactly as `collect_day` decides it: water, and a
 * dose whose panel states no energy. (The backend also keeps a dose that
 * prints only its protein; the fixture models energy alone.)
 */
function energyOf(l: Logged): DailyTotal | null {
  if (l.entry.source_kind === "water") return null;
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
            name: shortName(p.fdc_id, p.description),
            fdc_id: p.fdc_id,
            grams: p.grams,
            has_data: p.has_data,
          })),
    recipe_name: l.recipe?.name ?? null,
    recipe_yield_g: l.recipe?.yield_g ?? null,
    recipe_servings: l.recipe?.servings ?? null,
    recipe_yield_weighed: l.recipe?.weighed ?? null,
    basis: l.basis,
    frozen_at: l.frozenAt,
    corrected_at: l.correctedAt,
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

/**
 * The day's energy, from every entry that is food — a softgel that prints its
 * calories included, water and a vitamin not — so it is its meals added up.
 * An empty day is the empty sum, as the backend's is: nothing to count, which
 * reads "—" and never a measured 0.
 */
export function dayEnergy(iso: string): DailyTotal {
  return sum(live(iso).filter((l) => energyOf(l) !== null).flatMap((l) => l.parts));
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
    ml: l.entry.ml,
    pieces: l.entry.pieces,
    piece_noun: l.entry.piece_noun,
    unit_noun: l.entry.source_kind === "supplement" ? "tablet" : null,
    recipe_name: l.recipe?.name ?? null,
    parts: l.parts.map((p, ordinal) => {
      const v = valueOf(p);
      return {
        ordinal,
        description: p.description,
        name: shortName(p.fdc_id, p.description),
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

/**
 * `share` is null for a bottle put on the scale (`log_water`), and otherwise
 * how much of it was drunk without weighing — one for a whole bottle, less for
 * part of one judged by eye (`log_bottle_share`).
 */
function logBottle(a: Record<string, unknown>, share: number | null): string {
  const b = BOTTLES.find((x) => x.id === String(a.bottleId));
  if (!b) throw new Error(`bottle ${String(a.bottleId)} is no longer in the library`);
  let grams: number;
  if (share !== null) {
    if (!(Number.isFinite(share) && share > 0 && share <= 1)) {
      throw new Error("how much of the bottle was drunk must be more than none and no more than all of it");
    }
    if (b.empty_g === null) {
      throw new Error(
        `${b.name} has never been weighed empty, so what a full one holds is not known — ` +
          "weigh it after drinking instead, or add its empty weight in Water bottles",
      );
    }
    grams = (b.full_g - b.empty_g) * share;
  } else {
    grams = b.full_g - Number(a.currentG);
    if (!(grams > 0)) throw new Error(`${b.name} reads no less than its full weight — nothing to log`);
  }
  const l = water(b, grams, share === null ? null : share === 1 ? WHOLE_BOTTLE_NOTE : PART_BOTTLE_NOTE);
  l.entry.logged_on = String(a.loggedOn ?? localToday());
  LOG.push(l);
  b.last_used_at = new Date().toISOString();
  return l.entry.id;
}

/** Energy per 100 g of the foods offered one tap, roughly as the reference has them. */
const KCAL_100G: Record<number, number> = {
  168874: 365, 172421: 352, 171287: 61, 171705: 876, 170554: 23,
  // Mungo beans raw and boiled, so a change of form moves the line under the window.
  174259: 341, 172427: 105,
};

/** What a write or a valuation names: one of a food, your own food, a recipe or a pot. */
interface Weighable {
  fdcId?: unknown;
  customFoodId?: unknown;
  recipeId?: unknown;
  cookId?: unknown;
}

/**
 * What `grams` of something comes to in energy in the browser fixture, as the
 * parts an entry is summed from. The foods offered one tap at roughly the
 * reference's figure and the rest of the catalogue at one of its own; your
 * own foods measured; and a pot or a recipe with 30% of it unmeasured, as
 * a dish with drumstick pods in it is. `per_100g` values by it and the add
 * below logs by it, so what an amount previews is the entry Today then draws.
 */
/**
 * An own food's energy per 100 of what it is measured in, by id, as saved in
 * this tab (mock.ts fills it): per 100 ml for a can, whose grams are its
 * millilitres. Null where the pack printed no energy; a food not here at all
 * reads at the fixture's old flat figure.
 */
export const OWN_KCAL_100: Record<string, number | null> = {};

/**
 * An own food's piece, by id, where its pack counts its serving: how much of
 * the food's own unit one piece is, and what it is called. mock.ts fills it.
 */
export const OWN_PIECE: Record<string, { each: number; noun: string } | undefined> = {};

function partsOf(src: Weighable, grams: number, description: string): Part[] {
  const k = grams / 100;
  if (src.fdcId != null) {
    const fdc = Number(src.fdcId);
    return [measured(description, fdc, grams, (KCAL_100G[fdc] ?? 60 + (fdc % 37) * 9) * k)];
  }
  if (src.customFoodId != null) {
    const kcal = OWN_KCAL_100[String(src.customFoodId)];
    if (kcal === null) return [unmeasured(description, grams)];
    return [measured(description, null, grams, (kcal ?? 410) * k)];
  }
  const per = src.cookId === "c-sambar" ? 67 : src.cookId === "c-dal-tadka" ? 132 : 148;
  return [measured(description, null, grams * 0.7, per * k), unmeasured("Drumstick pods", grams * 0.3)];
}

/** `per_100g`: energy as above, and the three it is made of in a dal's proportions. */
function per100Of(src: Weighable): Per100g | null {
  if (src.fdcId == null && src.customFoodId == null && src.recipeId == null && src.cookId == null) return null;
  const energy = sum(partsOf(src, 100, ""));
  const share = (f: number): DailyTotal => ({
    ...energy, lower: energy.lower * f, upper: energy.upper === null ? null : energy.upper * f,
  });
  return { energy, protein: share(0.06), carbs: share(0.13), fat: share(0.03) };
}

let addSeq = 0;

export const DAY_TABLE: Record<string, (a: Record<string, unknown>) => unknown> = {
  per_100g: (a) => ((a.items as Weighable[] | undefined) ?? []).map(per100Of),
  // Onto the day for the life of the tab, so a one-tap repeat shows on Today
  // and its Undo has a row to take away. A dose is drawn with no energy, and
  // everything else by `partsOf`. A weighed plate arrives here already net:
  // the vessels live in mock.ts, which takes them off first.
  add_log_entry: (a) => {
    addSeq += 1;
    const n = (k: string) => (a[k] == null ? null : Number(a[k]));
    // A can is measured in ml and counted at a gram a ml, as the backend does,
    // and pieces are their share of the pack's serving.
    const ml = n("ml");
    const pieces = n("pieces");
    const piece = pieces === null ? undefined : OWN_PIECE[String(a.customFoodId)];
    if (pieces !== null && !piece) throw new Error("that food does not count its serving in pieces");
    const e: LogEntry = {
      ...blank(`a-${addSeq}`, (a.meal as Meal) ?? "snack", String(a.description ?? "")),
      logged_on: String(a.loggedOn ?? localToday()),
      source_kind: a.supplementId ? "supplement" : a.customFoodId ? "custom" : a.recipeId ? "recipe" : a.cookId ? "cook" : "food",
      fdc_id: n("fdcId"), recipe_id: (a.recipeId as string) ?? null, cook_id: (a.cookId as string) ?? null,
      custom_food_id: (a.customFoodId as string) ?? null, supplement_id: (a.supplementId as string) ?? null,
      grams: n("grams") ?? n("grossG") ?? ml ?? (piece && pieces !== null ? pieces * piece.each : null),
      units: n("units"), ml, pieces, piece_noun: piece?.noun ?? null,
      origin: (a.origin as Origin) ?? null, cuisine: (a.cuisine as string) ?? null,
    };
    LOG.push(logged(e, e.units !== null
      ? [{ description: e.description, fdc_id: null, grams: null, lower: 0, upper: 0, covered: true, has_data: true }]
      : partsOf(a, e.grams ?? 0, e.description)));
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
  log_water: (a) => logBottle(a, null),
  log_whole_bottle: (a) => logBottle(a, 1),
  log_bottle_share: (a) => logBottle(a, Number(a.share)),

  get_entry_snapshot: (a) => snapshot(find(String(a.entryId))),
  // Rescales every part by the same ratio, as the real correction does, and
  // clears the scale reading that no longer explains the number.
  correct_entry_amount: (a) => {
    const l = find(String(a.entryId));
    const was = l.entry.ml ?? l.entry.pieces ?? l.entry.grams ?? l.entry.units ?? 0;
    const now = Number(a.ml ?? a.pieces ?? a.grams ?? a.units);
    if (!(now > 0) || !(was > 0)) throw new Error("that needs to be a positive number");
    const r = now / was;
    for (const p of l.parts) {
      p.lower *= r;
      p.upper = p.upper === null ? null : p.upper * r;
      if (p.grams !== null) p.grams *= r;
    }
    // A volume is corrected as one, and its grams move with it.
    if (l.entry.ml !== null) {
      l.entry.ml = now;
      l.entry.grams = (l.entry.grams ?? was) * r;
    } else if (l.entry.pieces !== null) {
      l.entry.pieces = now;
      l.entry.grams = (l.entry.grams ?? was) * r;
    } else if (l.entry.grams !== null) l.entry.grams = now;
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
