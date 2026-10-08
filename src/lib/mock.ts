/**
 * A plausible day, for running the interface in a plain browser.
 *
 * The Rust side is reached through `invoke`, which exists only inside the Tauri
 * webview. Opening the same Vite server in a browser therefore used to render
 * one error and nothing else, which made every layout question — how a wide
 * window should be used, how dense a pointer-driven list should be — impossible
 * to answer without a full native rebuild.
 *
 * This is a fixture, not a second implementation. It answers the read commands
 * the screens need in order to draw themselves and it accepts the writes, so
 * `pnpm dev` in a browser is a design surface. Most writes are accepted and
 * forgotten; the ones a screen's own feedback depends on — removing an entry
 * and undoing it, a bottle drunk, an activity — are kept for the life of the
 * tab (`mockDay.ts`, `mockActivity.ts`), and a reload is a fresh day. It
 * is never reached from the real app: `bridge.ts` prefers Tauri whenever Tauri
 * is there, and this module is only imported for its side-effect-free data.
 *
 * The figures are deliberately UNEVEN — one breached limit, several genuine
 * shortfalls, two nutrients nothing measured, one partially covered day. A
 * fixture where everything is green would hide exactly the states this app
 * exists to distinguish.
 */
import { LABEL_NUTRIENTS } from "../types";
import { ACTIVITY_TABLE, exportActivity } from "./mockActivity";
import {
  BOTTLES,
  DAY_TABLE,
  dayBreakdowns,
  dayEnergy,
  dayEntries,
  dayMeals,
  localIso,
  localToday,
  OWN_KCAL_100,
  OWN_PIECE,
} from "./mockDay";
import type {
  BackupStatus,
  Cook,
  CustomFood,
  CustomFoodDetail,
  CustomNutrientRow,
  DaySummary,
  DayView,
  EnergyTarget,
  ExportLog,
  FoodDetail,
  FoodFamily,
  FoodForm,
  FoodHit,
  FrequentFood,
  GoalsView,
  MacroRange,
  Meal,
  NutrientMeta,
  NutrientTotal,
  NutrientValue,
  Profile,
  RangeView,
  Recipe,
  Supplement,
  Vessel,
  Container,
  ContainerEvent,
  ContainerStretch,
  ContainerSummary,
  FoodTasteFactor,
  Pantry,
  PantryFood,
  PercentBasis,
  PercentLine,
} from "../types";

/* ── the nutrients this fixture knows about ─────────────────────────────── */

/**
 * `lower` is what the day accounts for and `target` what it is read against;
 * `coverage` is the share of the day's food mass that had data for the line.
 * A coverage below 0.8 renders as "≥ x" rather than as a figure, and a
 * coverage of 0 renders as "—" — see `read()` in nutrient.ts.
 */
interface Spec {
  id: number;
  name: string;
  full: string;
  unit: string;
  group: string;
  tier: "core" | "extended";
  lower: number;
  target: number | null;
  basis: NutrientTotal["target_basis"];
  limit?: boolean;
  coverage?: number;
}

/**
 * Ordered by group, and CONTIGUOUSLY so.
 *
 * The nutrients screen groups by walking the list and starting a new group
 * whenever the group name changes from the previous row — which is correct
 * against a backend that returns totals in display order, and which produces
 * two separate "Minerals" headings (and a duplicate React key) the moment a
 * fixture interleaves them. The real ordering is a property of the data, so
 * the fixture has to have it too.
 */
const SPECS: Spec[] = [
  // Energy. The hero.
  { id: 1008, name: "Energy", full: "Energy", unit: "kcal", group: "Energy", tier: "core", lower: 1742, target: 2240, basis: "user_set" },

  // Macronutrients — the three figures under the hero, plus fibre and water.
  { id: 1003, name: "Protein", full: "Protein", unit: "g", group: "Macronutrients", tier: "core", lower: 68.4, target: 84, basis: "rda" },
  { id: 1005, name: "Carbohydrate", full: "Carbohydrate, by difference", unit: "g", group: "Macronutrients", tier: "core", lower: 224, target: 300, basis: "rda" },
  { id: 1004, name: "Total fat", full: "Total lipid (fat)", unit: "g", group: "Macronutrients", tier: "core", lower: 58.1, target: 78, basis: "daily_value" },
  { id: 1079, name: "Fibre", full: "Fiber, total dietary", unit: "g", group: "Macronutrients", tier: "core", lower: 17.2, target: 38, basis: "ai" },
  { id: 2000, name: "Total sugars", full: "Sugars, total", unit: "g", group: "Macronutrients", tier: "core", lower: 41.3, target: 50, basis: "daily_value", limit: true },
  { id: 1051, name: "Water", full: "Water", unit: "g", group: "Macronutrients", tier: "core", lower: 1820, target: 3700, basis: "ai" },

  // Minerals. Sodium is the one breached ceiling — the only place in the whole
  // fixture that earns the alarm colour. Calcium, iron, magnesium and zinc are
  // genuine shortfalls; iodine and selenium are measured by nothing in the day.
  { id: 1093, name: "Sodium", full: "Sodium, Na", unit: "mg", group: "Minerals", tier: "core", lower: 2836, target: 2300, basis: "daily_value", limit: true },
  { id: 1087, name: "Calcium", full: "Calcium, Ca", unit: "mg", group: "Minerals", tier: "core", lower: 412, target: 1000, basis: "rda" },
  { id: 1089, name: "Iron", full: "Iron, Fe", unit: "mg", group: "Minerals", tier: "core", lower: 7.9, target: 18, basis: "rda" },
  { id: 1090, name: "Magnesium", full: "Magnesium, Mg", unit: "mg", group: "Minerals", tier: "core", lower: 244, target: 420, basis: "rda" },
  { id: 1095, name: "Zinc", full: "Zinc, Zn", unit: "mg", group: "Minerals", tier: "core", lower: 6.1, target: 11, basis: "rda" },
  { id: 1092, name: "Potassium", full: "Potassium, K", unit: "mg", group: "Minerals", tier: "core", lower: 2410, target: 3400, basis: "ai" },
  { id: 1100, name: "Iodine", full: "Iodine, I", unit: "ug", group: "Minerals", tier: "core", lower: 0, target: 150, basis: "rda", coverage: 0 },
  { id: 1091, name: "Phosphorus", full: "Phosphorus, P", unit: "mg", group: "Minerals", tier: "extended", lower: 1024, target: 700, basis: "rda" },
  { id: 1103, name: "Selenium", full: "Selenium, Se", unit: "ug", group: "Minerals", tier: "extended", lower: 0, target: 55, basis: "rda", coverage: 0 },

  // Vitamins. B12 and thiamin are only partially covered — one dish in the day
  // has no figure for them — so they read "≥ x" rather than as a number.
  { id: 1106, name: "Vitamin A", full: "Vitamin A, RAE", unit: "ug", group: "Vitamins", tier: "core", lower: 812, target: 900, basis: "rda" },
  { id: 1162, name: "Vitamin C", full: "Vitamin C, total ascorbic acid", unit: "mg", group: "Vitamins", tier: "core", lower: 98.4, target: 90, basis: "rda" },
  { id: 1114, name: "Vitamin D", full: "Vitamin D (D2 + D3)", unit: "ug", group: "Vitamins", tier: "core", lower: 4.2, target: 20, basis: "rda" },
  { id: 1177, name: "Folate", full: "Folate, total", unit: "ug", group: "Vitamins", tier: "core", lower: 388, target: 400, basis: "rda" },
  { id: 1178, name: "Vitamin B12", full: "Vitamin B-12", unit: "ug", group: "Vitamins", tier: "core", lower: 1.9, target: 2.4, basis: "rda", coverage: 0.62 },
  { id: 1109, name: "Vitamin E", full: "Vitamin E (alpha-tocopherol)", unit: "mg", group: "Vitamins", tier: "extended", lower: 11.8, target: 15, basis: "rda" },
  { id: 1185, name: "Vitamin K", full: "Vitamin K (phylloquinone)", unit: "ug", group: "Vitamins", tier: "extended", lower: 86, target: 120, basis: "ai" },
  { id: 1165, name: "Thiamin", full: "Thiamin", unit: "mg", group: "Vitamins", tier: "extended", lower: 0.94, target: 1.2, basis: "rda", coverage: 0.71 },
];

const DEFAULT_COVERAGE = 0.94;

function total(s: Spec): NutrientTotal {
  const coverage = s.coverage ?? DEFAULT_COVERAGE;
  return {
    id: s.id,
    name: s.name,
    full_name: s.full,
    magnitude: s.unit,
    tier: s.tier,
    group: s.group,
    total: {
      lower: s.lower,
      upper: null,
      coverage,
      items_total: 6,
      items_covered: Math.round(coverage * 6),
      from_supplements: null,
    },
    target: s.target,
    target_basis: s.basis,
    is_limit: s.limit ?? false,
  };
}

/* ── the day ────────────────────────────────────────────────────────────── */

/*
  The entries themselves — what was had, what each came to, and the writes
  that change them — live in `mockDay.ts`. What is here is what a day is read
  against, which does not move when an entry does.
*/

const ENERGY_TARGET: EnergyTarget = {
  kcal: 2240,
  basis: "user_set",
  resting: 1580,
  factor: 1.42,
};

const MACRO_RANGES: MacroRange[] = [
  { nutrient_id: 1003, low_g: 56, high_g: 196, low_pct: 10, high_pct: 35 },
  { nutrient_id: 1005, low_g: 252, high_g: 364, low_pct: 45, high_pct: 65 },
  { nutrient_id: 1004, low_g: 50, high_g: 87, low_pct: 20, high_pct: 35 },
];

function day(iso: string): DayView {
  // The day's energy follows its entries, so a remove and its undo move the
  // figure the way they do in the app. Everything else is the fixed fixture —
  // except on a day with no food on it at all, where the macronutrients are
  // the same empty sum energy is, rather than the fixture's figures for a day
  // that was eaten.
  const energy = dayEnergy(iso);
  const nothingEaten = energy.items_total === 0;
  const fromEntries = (t: NutrientTotal): NutrientTotal =>
    t.id === 1008 || (nothingEaten && (t.id === 1003 || t.id === 1004 || t.id === 1005))
      ? { ...t, total: energy }
      : t;
  return {
    logged_on: iso,
    entries: dayEntries(iso),
    breakdowns: dayBreakdowns(iso),
    meals: dayMeals(iso),
    totals: SPECS.map(total).map(fromEntries),
    energy_target: ENERGY_TARGET,
    macro_ranges: MACRO_RANGES,
  };
}

/* ── search ─────────────────────────────────────────────────────────────── */

const CATALOGUE: FoodHit[] = [
  hit(172421, "Lentils, mature seeds, raw", "SR Legacy", null, false),
  hit(172420, "Lentils, pink or red, mature seeds, raw", "SR Legacy", "masoor dal", true),
  hit(174288, "Chickpea flour (besan)", "SR Legacy", "besan", true),
  hit(168874, "Rice, white, long-grain, regular, raw", "SR Legacy", null, false),
  hit(170933, "Spices, turmeric, ground", "SR Legacy", "haldi", true),
  hit(169705, "Wheat flour, whole-grain", "Foundation", "atta", true),
  hit(171287, "Yogurt, plain, whole milk", "SR Legacy", "dahi / curd", true),
  hit(170457, "Tomatoes, red, ripe, raw", "Foundation", null, false),
  hit(170000, "Onions, raw", "Foundation", null, false),
  hit(173410, "Paneer, whole milk", "SR Legacy", null, false),
  hit(168196, "Tamarind, raw", "SR Legacy", "imli", true),
  hit(169414, "Semolina, enriched", "SR Legacy", "rava / sooji", true),
  hit(170185, "Okra, raw", "Foundation", "bhindi", true),
  hit(171705, "Ghee, clarified butter", "SR Legacy", null, false),
  hit(168409, "Millet, raw", "SR Legacy", "bajra", true),
  hit(170554, "Spinach, raw", "Foundation", "palak", true),
  hit(169995, "Eggplant, raw", "Foundation", "brinjal / baingan", true),
  hit(174266, "Mustard seed, ground", "SR Legacy", "rai / sarson", true),
  hit(168881, "Rice, brown, long-grain, raw", "SR Legacy", null, false),
  hit(173727, "Coconut, raw", "SR Legacy", "nariyal", true),
];

function hit(fdc: number, description: string, dataType: string, note: string | null, alias: boolean): FoodHit {
  return {
    kind: "reference",
    fdc_id: fdc,
    custom_food_id: null,
    description,
    brand: null,
    data_type: dataType,
    note,
    matched_alias: alias,
    name: null,
    forms: [],
  };
}

/*
  One food in two forms, as the bundled data has it: the raw seeds, and the
  boiled ones every urad alias points at. The salted twin is left out, as the
  backend hides it from anyone who has not typed "salt" or logged it. The note
  is the alias table's own, word for word.
*/
const MUNGO: FoodForm[] = [
  { fdc_id: 174259, label: "raw", description: "Mungo beans, mature seeds, raw" },
  { fdc_id: 172427, label: "boiled", description: "Mungo beans, mature seeds, cooked, boiled, without salt" },
];
const URAD_NOTE = "USDA files urad dal under its botanical name, Mungo beans";
/** The real portions, so a serving chip visibly follows a change of form: a cup is 207 g raw, 180 g boiled. */
const MUNGO_PORTIONS: Record<number, FoodDetail["portions"]> = {
  174259: [{ amount: 1, unit: "cup", description: null, gram_weight: 207 }],
  172427: [
    { amount: 1, unit: "cup", description: null, gram_weight: 180 },
    { amount: 1, unit: "oz dry, yield after cooking", description: null, gram_weight: 69 },
  ],
};

/** The bundled alias table's urad rows, word for word: each Indian name and the row it means. */
const URAD_ALIASES: Record<string, number> = { "urad": 172427, "urad dal": 172427, "urad dal raw": 174259 };

/**
 * The family as search returns it: one entry, opened on the form the typed
 * Indian name means and otherwise on the first; or, `flat`, one entry a form.
 * A name matches when every word typed starts the alias's word in its place
 * ("urad d" is "urad dal"); only an alias typed in full says which form.
 */
function mungo(q: string, flat: boolean): FoodHit[] {
  const typed = q.split(/\s+/);
  const aliases = Object.keys(URAD_ALIASES).filter((a) => {
    const words = a.split(" ");
    return typed.length <= words.length && typed.every((t, i) => words[i].startsWith(t));
  });
  const alias = aliases.length > 0;
  if (!alias && !MUNGO.some((f) => f.description.toLowerCase().includes(q))) return [];
  // Opened on the exact alias's row; a name only begun opens on the first form.
  const target = URAD_ALIASES[q] ?? MUNGO[0].fdc_id;
  const entry = (f: FoodForm, name: string, forms: FoodForm[]): FoodHit => ({
    ...hit(f.fdc_id, f.description, "SR Legacy", alias ? URAD_NOTE : null, alias), name, forms,
  });
  if (flat) return MUNGO.map((f) => entry(f, `Mungo beans, ${f.label}`, []));
  return [entry(MUNGO.find((f) => f.fdc_id === target) ?? MUNGO[0], "Mungo beans", MUNGO)];
}

/** `food_forms`: the family of a form, or a food on its own. */
function familyOf(fdcId: number): FoodFamily {
  if (MUNGO.some((f) => f.fdc_id === fdcId)) return { name: "Mungo beans", forms: MUNGO };
  return { name: detail(fdcId).description, forms: [] };
}

const OWN: FoodHit[] = [
  {
    kind: "custom",
    fdc_id: null,
    custom_food_id: "c1",
    description: "Roasted chana, salted",
    brand: "Haldiram's",
    data_type: "custom",
    note: "replaces the generic roasted chickpea entry",
    matched_alias: false,
    name: null,
    forms: [],
  },
];

function search(query: string, limit: number, flat: boolean): FoodHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const matches = (h: FoodHit) =>
    h.description.toLowerCase().includes(q) ||
    (h.note ?? "").toLowerCase().includes(q) ||
    (h.brand ?? "").toLowerCase().includes(q);
  // The user's own foods first, the same order the real backend returns.
  const saved: FoodHit[] = CUSTOM.filter((f) => !OWN.some((h) => h.custom_food_id === f.id)).map((f) => ({
    kind: "custom", fdc_id: null, custom_food_id: f.id, description: f.name, brand: f.brand,
    data_type: "custom", note: null, matched_alias: false, name: null, forms: [],
  }));
  // An alias match leads the reference foods, as it does in the backend.
  const family = mungo(q, flat);
  const lead = family.some((h) => h.matched_alias);
  return [
    ...OWN.filter(matches), ...saved.filter(matches),
    ...(lead ? family : []), ...CATALOGUE.filter(matches), ...(lead ? [] : family),
  ].slice(0, limit);
}

function detail(fdcId: number): FoodDetail {
  const form = MUNGO.find((f) => f.fdc_id === fdcId);
  const found = CATALOGUE.find((h) => h.fdc_id === fdcId) ?? CATALOGUE[0];
  return {
    fdc_id: fdcId,
    description: form?.description ?? found.description,
    data_type: form ? "SR Legacy" : found.data_type,
    // A realistic mix: most lines measured, a handful genuinely absent.
    nutrients: SPECS.map((s, i) => ({
      id: s.id,
      name: s.name,
      magnitude: s.unit,
      basis: "per 100 g",
      tier: s.tier,
      value:
        i % 7 === 5
          ? { kind: "absent" as const }
          : { kind: "measured" as const, amount: Math.round(s.lower / 3.2 * 100) / 100 },
    })),
    portions: MUNGO_PORTIONS[fdcId] ?? [
      { amount: 1, unit: "cup", description: null, gram_weight: 185 },
      { amount: 1, unit: "tbsp", description: null, gram_weight: 12 },
      { amount: 100, unit: "g", description: null, gram_weight: 100 },
    ],
  };
}

/**
 * The quick-add list, and deliberately reference foods ONLY.
 *
 * Not an oversight and not a claim that the real list is reference-only — the
 * backend happily ranks the user's own packs alongside these. It is that this
 * fixture's own foods live for the life of a tab (see `CUSTOM`), and a
 * shortcut naming one would open a food a reload has already forgotten.
 *
 * The amounts are uneven and one of them is four figures, because
 * `last_amount_label` is generated in Rust and the whole reason it exists is
 * that it must read the same way `fmtAmount` writes it.
 */
const FREQUENT: FrequentFood[] = [
  {
    source_kind: "food",
    key: "food:168874",
    fdc_id: 168874,
    custom_food_id: null,
    description: "Rice, white, long-grain, regular, raw",
    brand: null,
    last_grams: 85,
    last_ml: null,
    last_pieces: null,
    last_amount_label: "85 g",
  },
  {
    source_kind: "food",
    key: "food:172421",
    fdc_id: 172421,
    custom_food_id: null,
    description: "Lentils, mature seeds, raw",
    brand: null,
    last_grams: 60,
    last_ml: null,
    last_pieces: null,
    last_amount_label: "60 g",
  },
  {
    source_kind: "food",
    key: "food:172427",
    fdc_id: 172427,
    custom_food_id: null,
    description: "Mungo beans, mature seeds, cooked, boiled, without salt",
    // What search calls it, and so what the chip says; a tap still logs the
    // description.
    name: "Mungo beans, boiled",
    brand: null,
    last_grams: 150,
    last_ml: null,
    last_pieces: null,
    last_amount_label: "150 g",
  },
  {
    source_kind: "food",
    key: "food:171287",
    fdc_id: 171287,
    custom_food_id: null,
    description: "Yogurt, plain, whole milk",
    brand: null,
    last_grams: 1200,
    last_ml: null,
    last_pieces: null,
    last_amount_label: "1,200 g",
  },
  {
    source_kind: "food",
    key: "food:171705",
    fdc_id: 171705,
    custom_food_id: null,
    description: "Ghee, clarified butter",
    brand: null,
    last_grams: 12,
    last_ml: null,
    last_pieces: null,
    last_amount_label: "12 g",
  },
  {
    source_kind: "food",
    key: "food:170554",
    fdc_id: 170554,
    custom_food_id: null,
    description: "Spinach, raw",
    brand: null,
    last_grams: 150,
    last_ml: null,
    last_pieces: null,
    last_amount_label: "150 g",
  },
];

/**
 * What each sitting has had on more than one day, most days first, with the
 * last helping AT that sitting — the two things `frequent_foods_at` narrows
 * for a meal, so the chips under "Usually" open on the amount the app would
 * open them on (curd is a 150 g bowl at breakfast and the 1,200 g pot's worth
 * only in the whole list). Uneven on purpose: nothing at all as a snack, so a
 * meal's short list and an empty one are both reachable in a browser.
 */
const FREQUENT_AT: Record<Meal, [key: string, grams: number][]> = {
  breakfast: [["food:171287", 150]],
  lunch: [["food:172427", 150], ["food:172421", 60], ["food:168874", 120], ["food:170554", 90]],
  dinner: [["food:168874", 85], ["food:171287", 200], ["food:171705", 12]],
  snack: [],
};

function frequent(limit: number, meal: Meal | null): FrequentFood[] {
  if (meal === null) return FREQUENT.slice(0, limit);
  return FREQUENT_AT[meal].slice(0, limit).flatMap(([key, grams]) => {
    const f = FREQUENT.find((x) => x.key === key);
    // `fmtAmount`'s way of writing a weight, which is the label's whole job.
    return f ? [{ ...f, last_grams: grams, last_amount_label: `${grams.toLocaleString("en-US")} g` }] : [];
  });
}

/**
 * Restaurant dishes had lately, for "From restaurants": counted by the portion,
 * as a pasted dish is. Two, so the row and its dedupe against "Usually" can be
 * seen in a browser.
 */
const RESTAURANT_DISHES: FrequentFood[] = [
  ["mock-dish-biryani", "Chicken biryani", "Paradise"],
  ["mock-dish-biryani-2", "Chicken biryani", "Bawarchi"],
  ["mock-dish-padthai", "Pad thai", null],
].map(([id, name, place]) => ({
  source_kind: "custom", key: `custom:${id}`, fdc_id: null, custom_food_id: id as string,
  description: name as string, name: null, brand: place, place, restaurant: true, last_grams: 400, last_ml: null,
  last_pieces: 1, last_amount_label: "1 portion",
}));

/* ── the library ────────────────────────────────────────────────────────── */

const VESSELS: Vessel[] = [
  { id: "v1", name: "Small steel bowl", grams: 68, last_used_at: "2026-09-05T18:20:00Z" },
  { id: "v2", name: "Dinner plate", grams: 412, last_used_at: "2026-09-05T13:05:00Z" },
  { id: "v3", name: "Small glass bowl", grams: 186, last_used_at: null },
  { id: "v4", name: "Melamine plate", grams: 240, last_used_at: "2026-09-01T20:00:00Z" },
];

/*
  A kitchen to draw the Food screen with: two pots on the stove, one written
  recipe, one supplement. Lines are left out, which these screens never read;
  the cook sheet and the recipe builder start from empty in the browser as
  they always have.
*/
const RECIPES: Recipe[] = [
  {
    id: "r-dal-makhani", name: "Dal makhani", yield_g: 1400, servings: null, notes: null,
    default_origin: "home", default_cuisine: "North Indian", ingredients: [],
    serving_options: [{ id: "rs-bowl", label: "1 bowl", grams: 180 }],
  },
];
function pot(id: string, name: string, daysAgo: number, yieldG: number, weighed: boolean, loggedG: number): Cook {
  const on = new Date();
  on.setDate(on.getDate() - daysAgo);
  const cookedOn = `${on.getFullYear()}-${String(on.getMonth() + 1).padStart(2, "0")}-${String(on.getDate()).padStart(2, "0")}`;
  return {
    id, recipe_id: null, name, cooked_on: cookedOn, cooked_at: `${cookedOn}T08:30:00Z`, scale: 1,
    expected_yield_g: yieldG, weighed_yield_g: weighed ? yieldG : null, gross_g: null, tare_g: null,
    tare_note: null, default_origin: "home", default_cuisine: "South Indian", notes: null,
    finished_at: null, ingredients: [], logged_g: loggedG, yield_g: yieldG,
    remaining_g: Math.max(0, yieldG - loggedG),
  };
}
const COOKS: Cook[] = [
  pot("c-dal-tadka", "Dal tadka", 0, 1140, false, 540),
  pot("c-sambar", "Sambar", 5, 1680, true, 780),
];
const SUPPLEMENTS: Supplement[] = [
  {
    id: "sup-d3", name: "Vitamin D3, 1,000 IU", brand: null, unit_noun: "tablet", serving_units: 1,
    serving_label: null, default_units: 1, regime: "us", panel_complete: false, other_ingredients: null,
    barcode: null, photo_panel: null, photo_ingredients: null, nutrients: [],
  },
];
/**
 * The user's own foods, for the life of a tab: the one pack `OWN` finds in a
 * search, and whatever is saved in the editor after it. Enough to walk the
 * editor and a pack's amount step in a browser, a can included.
 */
const CUSTOM: CustomFood[] = [
  {
    id: "c1", name: "Roasted chana, salted", brand: "Haldiram's", overrides_fdc_id: null,
    serving_g: 30, serving_ml: null, serving_pieces: null, piece_noun: null,
    serving_label: "1 pack (30 g)", ingredients: null, barcode: "8904004400762",
    photo_label: null, photo_ingredients: null, import_only: false,
    nutrients: [{ nutrient_id: 1008, kind: "measured", amount: 123, upper: null }],
  },
];
OWN_KCAL_100.c1 = 410;
// The restaurant dishes under "From restaurants": one portion each, so a tap
// in the browser logs one as the app would.
for (const d of RESTAURANT_DISHES) {
  OWN_PIECE[d.custom_food_id!] = { each: d.last_grams, noun: "portion" };
  OWN_KCAL_100[d.custom_food_id!] = 190;
}
let ownSeq = 0;

function ownFood(id: string): CustomFood {
  const f = CUSTOM.find((x) => x.id === id);
  if (!f) throw new Error(`custom food ${id}: not in this tab's fixture`);
  return structuredClone(f);
}

/** As the backend saves one: a serving that is a volume is counted at a gram a ml. */
function saveOwn(food: CustomFood, id: string | null): string {
  const saved: CustomFood = { ...food, id: id ?? `own-${++ownSeq}`, serving_g: food.serving_ml ?? food.serving_g };
  const at = CUSTOM.findIndex((x) => x.id === saved.id);
  if (at >= 0) CUSTOM[at] = saved;
  else CUSTOM.push(saved);
  const energy = saved.nutrients.find((n) => n.nutrient_id === 1008);
  OWN_KCAL_100[saved.id] = energy?.amount != null ? (energy.amount * 100) / saved.serving_g : null;
  OWN_PIECE[saved.id] = saved.serving_pieces != null && saved.piece_noun
    ? { each: saved.serving_g / saved.serving_pieces, noun: saved.piece_noun.trim() }
    : undefined;
  return saved.id;
}

/** The pack's own lines per 100 of what it is measured in, and nothing borrowed. */
function ownDetail(f: CustomFood): CustomFoodDetail {
  const per = 100 / f.serving_g;
  const nutrients: CustomNutrientRow[] = LABEL_NUTRIENTS.map((l) => {
    const n = f.nutrients.find((x) => x.nutrient_id === l.id);
    const value: NutrientValue = !n
      ? { kind: "absent" }
      : n.kind === "measured"
        ? { kind: "measured", amount: (n.amount ?? 0) * per }
        : ({ kind: n.kind, upper: (n.upper ?? 0) * per } as NutrientValue);
    return {
      id: l.id, name: l.name, magnitude: l.unit, basis: f.serving_ml != null ? "per 100 ml" : "per 100 g",
      tier: "core", group: "Label", value, provenance: n ? "label" : "unknown",
    };
  });
  return {
    food: f, nutrients, base_description: null,
    from_label: f.nutrients.length, from_base: 0, unknown: nutrients.length - f.nutrients.length,
  };
}

/**
 * A slice of `label_percent_table` for the browser fixture: the backend's
 * figures for 1% of each Daily Value, copied for the lines a design pass
 * needs. The app reads them from Rust; nothing outside this file uses these.
 */
const pb = (amount: number, unit: string, per: number | null, forms: PercentBasis["forms"] = []): PercentBasis => ({
  reference_amount: amount,
  reference_unit: unit,
  per_percent: per,
  forms,
});
const PERCENT_TABLE: PercentLine[] = [
  { nutrient_id: 1004, name: "Total fat", unit: "g", current: pb(78, "g", 0.78), older: pb(65, "g", 0.65) },
  { nutrient_id: 1258, name: "Saturated fat", unit: "g", current: pb(20, "g", 0.2), older: pb(20, "g", 0.2) },
  { nutrient_id: 1253, name: "Cholesterol", unit: "mg", current: pb(300, "mg", 3), older: pb(300, "mg", 3) },
  { nutrient_id: 1093, name: "Sodium", unit: "mg", current: pb(2300, "mg", 23), older: pb(2400, "mg", 24) },
  { nutrient_id: 1005, name: "Total carbohydrate", unit: "g", current: pb(275, "g", 2.75), older: pb(300, "g", 3) },
  { nutrient_id: 1079, name: "Dietary fiber", unit: "g", current: pb(28, "g", 0.28), older: pb(25, "g", 0.25) },
  { nutrient_id: 1235, name: "Added sugars", unit: "g", current: pb(50, "g", 0.5), older: null },
  { nutrient_id: 1003, name: "Protein", unit: "g", current: pb(50, "g", 0.5), older: pb(50, "g", 0.5) },
  {
    nutrient_id: 1106, name: "Vitamin A", unit: "ug",
    current: pb(900, "ug", 9),
    older: pb(5000, "IU", null, [
      { form: "retinol", per_percent: 15 },
      { form: "beta_carotene_supplemental", per_percent: 15 },
      { form: "beta_carotene_dietary", per_percent: 2.5 },
    ]),
  },
  { nutrient_id: 1162, name: "Vitamin C", unit: "mg", current: pb(90, "mg", 0.9), older: pb(60, "mg", 0.6) },
  { nutrient_id: 1114, name: "Vitamin D", unit: "ug", current: pb(20, "ug", 0.2), older: pb(400, "IU", 0.1) },
  { nutrient_id: 1087, name: "Calcium", unit: "mg", current: pb(1300, "mg", 13), older: pb(1000, "mg", 10) },
  { nutrient_id: 1089, name: "Iron", unit: "mg", current: pb(18, "mg", 0.18), older: pb(18, "mg", 0.18) },
  { nutrient_id: 1092, name: "Potassium", unit: "mg", current: pb(4700, "mg", 47), older: pb(3500, "mg", 35) },
  { nutrient_id: 1178, name: "Vitamin B12", unit: "ug", current: pb(2.4, "ug", 0.024), older: pb(6, "ug", 0.06) },
  { nutrient_id: 1095, name: "Zinc", unit: "mg", current: pb(11, "mg", 0.11), older: pb(15, "mg", 0.15) },
];

const PROFILE: Profile = {
  sex: "male",
  birth_year: 1991,
  height_cm: 174,
  weight_kg: 71,
  activity: "light",
  life_stage: "standard",
  energy_kcal: 2240,
};

function goals(): GoalsView {
  return {
    profile: PROFILE,
    group_label: "Males 31–50",
    energy_target: ENERGY_TARGET,
    estimated_kcal: 2244,
    estimated_resting: 1580,
    macro_ranges: MACRO_RANGES,
    rows: SPECS.map((s) => ({
      id: s.id,
      name: s.name,
      magnitude: s.unit,
      group: s.group,
      tier: s.tier,
      amount: s.target,
      basis: s.basis,
      is_limit: s.limit ?? false,
      user_amount: s.id === 1008 ? 2240 : null,
      user_note: null,
      published_amount: s.target,
      published_basis: s.basis === "user_set" ? "daily_value" : s.basis,
    })),
  };
}

function meta(): NutrientMeta[] {
  return SPECS.map((s, i) => ({
    id: s.id,
    short_name: s.name,
    magnitude: s.unit,
    basis: "per 100 g",
    tier: s.tier,
    display_group: s.group,
    display_order: i,
  }));
}

/* ── the pantry ─────────────────────────────────────────────────────────── */

/** A date `n` days before today, local. */
function back(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p2 = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

const ev = (id: string, kind: ContainerEvent["kind"], daysBack: number, amount: number | null, unit: "g" | "ml" | null, spilled = false): ContainerEvent => ({
  id, kind, happened_on: back(daysBack), happened_at: `${back(daysBack)}T12:00:00Z`, amount, unit, spilled, note: null,
});

/**
 * Three containers: the salt jar on the scale with a spill in its history,
 * the oil dispenser read by its marks, and the ghee tin still waiting for its
 * empty weight. Figures are the backend's own arithmetic, done by hand.
 */
const CONTAINERS: Container[] = [
  {
    id: "salt", name: "Salt jar", food: { fdc_id: 173468, custom_food_id: null }, description: "Salt, table",
    read_by: "scale", empty_g: null, capacity_ml: null, cup_ml: 240, density: { g_per_ml: 1.2173, source: "reference", note: "USDA: 1 tbsp is 18 g" },
    events: [ev("s1", "poured_in", 34, 1000, "g"), ev("s2", "reading", 34, 1182, "g"), ev("s3", "reading", 19, 1031, "g"),
      ev("s4", "reading", 14, 940, "g", true), ev("s5", "reading", 3, 862, "g")],
    stretches: [
      { from_on: back(34), to_on: back(19), status: "counted", used_g: 151, used_ml: 124, discarded_g: null, days: 15 },
      { from_on: back(19), to_on: back(14), status: "spilled", used_g: 91, used_ml: 75, discarded_g: null, days: 5 },
      { from_on: back(14), to_on: back(3), status: "counted", used_g: 78, used_ml: 64, discarded_g: null, days: 11 },
      { from_on: back(3), to_on: null, status: "open", used_g: null, used_ml: null, discarded_g: null, days: null },
    ],
    finished: false,
  },
  {
    id: "oil", name: "Oil dispenser", food: { fdc_id: 171017, custom_food_id: null }, description: "Sunflower oil",
    read_by: "marks", empty_g: null, capacity_ml: 1000, cup_ml: 240, density: { g_per_ml: 0.9197, source: "reference", note: "USDA: 1 tbsp is 13.6 g" },
    events: [ev("o1", "poured_in", 21, 1000, "ml"), ev("o2", "reading", 12, 820, "ml"), ev("o3", "reading", 5, 640, "ml")],
    stretches: [
      { from_on: back(21), to_on: back(12), status: "counted", used_g: 166, used_ml: 180, discarded_g: null, days: 9 },
      { from_on: back(12), to_on: back(5), status: "counted", used_g: 166, used_ml: 180, discarded_g: null, days: 7 },
      { from_on: back(5), to_on: null, status: "open", used_g: null, used_ml: null, discarded_g: null, days: null },
    ],
    finished: false,
  },
  {
    id: "ghee", name: "Ghee tin", food: { fdc_id: null, custom_food_id: "amul-ghee" }, description: "Amul ghee",
    read_by: "scale", empty_g: null, capacity_ml: null, cup_ml: 240, density: { g_per_ml: 0.905, source: "label", note: "The pack: 1000 ml is 905 g" },
    events: [ev("g1", "poured_in", 16, 905, "g"), ev("g2", "reading", 8, 1214, "g")],
    stretches: [
      { from_on: back(16), to_on: back(8), status: "awaiting_tare", used_g: null, used_ml: null, discarded_g: null, days: 8 },
      { from_on: back(8), to_on: null, status: "open", used_g: null, used_ml: null, discarded_g: null, days: null },
    ],
    finished: false,
  },
  {
    id: "sesame", name: "Sesame oil bottle", food: { fdc_id: 171016, custom_food_id: null }, description: "Sesame oil",
    read_by: "marks", empty_g: null, capacity_ml: 500, cup_ml: 240, density: null,
    events: [ev("e1", "poured_in", 60, 500, "ml"), ev("e2", "emptied", 13, null, null)],
    stretches: [{ from_on: back(60), to_on: back(13), status: "awaiting_density", used_g: null, used_ml: 500, discarded_g: null, days: 47 }],
    finished: true,
  },
];

const FACTORS: FoodTasteFactor[] = [
  { food: { fdc_id: 173468, custom_food_id: null }, description: "Salt, table", factor: { factor: 1.24, stretches: 2, by_feel_g: 186, written_g: 150 }, typical_written_g: 5 },
  { food: { fdc_id: 171017, custom_food_id: null }, description: "Sunflower oil", factor: { factor: 1.38, stretches: 2, by_feel_g: 450, written_g: 326 }, typical_written_g: 15 },
  { food: { fdc_id: null, custom_food_id: "amul-ghee" }, description: "Amul ghee", factor: { factor: 1, stretches: 0, by_feel_g: 0, written_g: 0 }, typical_written_g: 10 },
];

const pantryRow = (c: Container): ContainerSummary => {
  const last = [...c.events].reverse().find((e) => e.kind === "reading") ?? c.events.find((e) => e.kind === "poured_in");
  return {
    id: c.id, name: c.name, read_by: c.read_by, cup_ml: c.cup_ml,
    last: last && last.amount !== null && last.unit !== null ? { kind: last.kind as "reading" | "poured_in", amount: last.amount, unit: last.unit, on: last.happened_on } : null,
    waiting: c.id === "ghee" ? "tare" : null,
  };
};

function pantry(): Pantry {
  const usage = (food: Container["food"], description: string, days: number, g: number | null, ml: number | null): PantryFood["usage"] =>
    ({ food, description, days, used_per_day_g: g, used_per_day_ml: ml, recorded_per_day_g: g === null ? null : g * 0.8 });
  const [salt, oil, ghee, sesame] = CONTAINERS;
  return {
    foods: [
      { food: salt.food, description: "Salt", factor: FACTORS[0].factor, typical_written_g: 5, usage: usage(salt.food, "Salt", 26, 8.8, null), waiting: null, containers: [pantryRow(salt)] },
      { food: oil.food, description: "Sunflower oil", factor: FACTORS[1].factor, typical_written_g: 15, usage: usage(oil.food, "Sunflower oil", 16, 20.7, 22.5), waiting: null, containers: [pantryRow(oil)] },
      { food: ghee.food, description: "Amul ghee", factor: FACTORS[2].factor, typical_written_g: 10, usage: usage(ghee.food, "Amul ghee", 0, null, null), waiting: "tare", containers: [pantryRow(ghee)] },
    ],
    finished: [pantryRow(sesame)],
  };
}

/** What the sheet would say, worked against the fixture's last reading. */
function previewEvent(a: Record<string, unknown>): ContainerStretch | null {
  const c = CONTAINERS.find((x) => x.id === a.containerId);
  if (!c || a.kind === "poured_in") return null;
  const amount = typeof a.amount === "number" ? a.amount : null;
  const unit = String(a.unit ?? "");
  const last = [...c.events].reverse().find((e) => e.kind === "reading");
  if (!last || last.amount === null || amount === null) return null;
  const typed = unit === "cup" ? amount * c.cup_ml : unit === "l" ? amount * 1000 : unit === "kg" ? amount * 1000 : amount;
  const asMl = unit === "ml" || unit === "l" || unit === "cup";
  const sameUnit = (last.unit === "ml") === asMl;
  if (!sameUnit) return null;
  const usedRaw = last.amount - typed;
  return {
    from_on: last.happened_on, to_on: today(), status: a.spilled ? "spilled" : usedRaw < 0 ? "inconsistent" : "counted",
    used_g: asMl ? usedRaw * (c.density?.g_per_ml ?? 1) : usedRaw, used_ml: asMl ? usedRaw : null, discarded_g: null, days: 5,
  };
}

/* ── dates ──────────────────────────────────────────────────────────────── */

/**
 * The local calendar date, as the app asks for it. This used to be the UTC
 * date, which west of Greenwich is tomorrow by the evening — and the fixture
 * then answered the app's "today" with an empty day.
 */
function today(): string {
  return localToday();
}

/**
 * Eleven weeks back, most days logged.
 *
 * Long enough to fill the date strip, which reaches twelve weeks: a fixture
 * covering three weeks would leave nine scrollable weeks unmarked, and the one
 * thing worth looking at on that strip is whether the marks are in the right
 * place. Deliberately one week SHORT of the strip's reach, so the oldest week
 * is genuinely blank and the difference between "no dot" and "off the end of
 * the data" is visible here rather than only on a phone.
 */
function loggedDates(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < 77; i++) {
    if (i % 7 === 4) continue; // a gap, so the calendar is not a solid block
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(localIso(d));
  }
  return out;
}

/**
 * Notes typed in a browser tab, by date.
 *
 * In a module-level object rather than localStorage: the fixture is for looking
 * at what the screen does, and a note that survived a reload would make the
 * empty state — the state most worth looking at — the one that takes a cleared
 * browser to reach.
 */
const DAY_NOTES: Record<string, string> = {};

/**
 * One day's summary, for the calendar and the range report.
 *
 * `kcal` varies across the days and one day in seven carries only a
 * supplement: a calendar where every cell is identical would hide the two
 * things its cells actually encode — the energy bar's intensity, and the dot
 * that says "a pill, and no food" rather than "you barely ate".
 */
function summary(iso: string, i: number): DaySummary {
  const supplementOnly = i % 7 === 2;
  const kcal = supplementOnly ? null : 1500 + ((i * 137) % 900);
  const homeShare = 1 + (i % 3);
  return {
    date: iso,
    items: supplementOnly ? 1 : 6 + (i % 4),
    grams: supplementOnly ? 0 : 1200 + ((i * 91) % 700),
    kcal,
    food_items: supplementOnly ? 0 : 6 + (i % 4),
    supplement_items: supplementOnly || i % 3 === 0 ? 1 : 0,
    water_items: i % 4 === 0 ? 1 : 0,
    // Varies the way a person's drinking does, and absent on days nobody
    // logged a bottle — null, not zero.
    water_ml: supplementOnly ? null : 1500 + ((i * 211) % 1400),
    origins: supplementOnly
      ? []
      : [
          { key: "home", label: "Made at home", entries: homeShare },
          { key: "ordered_in", label: "Ordered in", entries: i % 2 },
        ].filter((o) => o.entries > 0),
    cuisines: supplementOnly
      ? []
      : [{ key: "south_indian", label: "South Indian", entries: homeShare }],
    untagged_origin: supplementOnly ? 0 : i % 3,
    untagged_cuisine: supplementOnly ? 0 : 1 + (i % 2),
  };
}

/**
 * A whole period. Every field the screen reads is present: `days_logged` and
 * the two counts beside it are the divisors every average on that screen uses,
 * and an absent one is not a zero — it is a crash.
 */
function range(from: string, to: string): RangeView {
  const dates = loggedDates().filter((d) => d >= from && d <= to);
  const days = dates.map(summary);
  return {
    from,
    to,
    days_logged: days.filter((d) => d.food_items > 0).length,
    days_with_supplements: days.filter((d) => d.supplement_items > 0).length,
    days_with_water: days.filter((d) => d.water_items > 0).length,
    days,
    // Period sums: the day's figures multiplied by the days that had food.
    totals: SPECS.map((spec) => {
      const n = Math.max(days.filter((d) => d.food_items > 0).length, 1);
      // The bounds are period sums; the TARGET is not. A reference figure is a
      // daily amount whatever period it is read over — `targets::resolve` on
      // the Rust side hands back one figure per nutrient, and nothing scales
      // it — so multiplying it here made every percentage in the range report
      // read about a thirtieth of the truth.
      return total({ ...spec, lower: spec.lower * n });
    }),
    origins: [
      { key: "home", label: "Made at home", entries: 42, days: days.length, grams: 18400 },
      { key: "ordered_in", label: "Ordered in", entries: 9, days: 6, grams: 3900 },
      { key: null, label: null, entries: 7, days: 5, grams: 2100 },
    ],
    cuisines: [
      { key: "south_indian", label: "South Indian", entries: 24, days: 12, grams: 9800 },
      { key: "north_indian", label: "North Indian", entries: 19, days: 11, grams: 8600 },
      { key: null, label: null, entries: 15, days: 9, grams: 6000 },
    ],
  };
}

/* ── the table the bridge dispatches through ────────────────────────────── */

/**
 * Read commands answer with a fixture; write commands accept and return the
 * shape the caller expects. Nothing outlives the tab — a reload is a fresh
 * day, which is the right behaviour for a design fixture and the wrong
 * behaviour for anything else, so this must never be reachable inside Tauri.
 */
/**
 * A household with one other device in it.
 *
 * Mutable, so the fixture can be paired with and unpaired from and the screen
 * behaves as it will against the real backend. `pairStartedAt` drives a
 * scripted pairing: the QR sits there, a phone "connects" after a couple of
 * seconds, and the six digits appear to be compared.
 */
const HOUSEHOLD = {
  device: { device_id: "this-mac", name: "Mac" },
  shared: { pots: 3, recipes: 12, foods: 8, supplements: 2, vessels_and_bottles: 4 },
  peers: [
    {
      device_id: "her-phone",
      name: "Pixel",
      paired_at: "2026-09-02T18:20:00Z",
      last_seen_at: "2026-09-06T08:41:00Z",
    },
  ] as { device_id: string; name: string; paired_at: string; last_seen_at: string | null }[],
  last: [
    {
      at: "2026-09-06T08:41:00Z",
      peer_name: "Pixel",
      ok: true,
      detail: "3 pots and 1 recipe went over; 2 helpings came back.",
    },
  ] as { at: string; peer_name: string; ok: boolean; detail: string }[],
  queued: 0,
};

let pairStartedAt: number | null = null;
let pairConfirmed = false;

/**
 * A payload in the real shape: tag, addresses, port, base64url key, expiry.
 *
 * Flat and pipe-delimited because the real one is, and the real one is because
 * its exact bytes are hashed into the handshake on both sides — a re-serialised
 * JSON object could differ by a space.
 */
const PAIR_PAYLOAD =
  "trackit-household-1|192.168.1.24|51733|" +
  "8Kx2vQ1mZ0pR7sN4dT9hJ3bW6yL5cF8aG2eU0iO1kM4|2026-09-06T08:43:00Z";

/** Where the scripted pairing has got to, from how long the QR has been up. */
function pairing() {
  if (pairStartedAt === null) return { stage: "expired" };
  if (pairConfirmed) return { stage: "paired", peer_name: "Pixel 9" };
  const elapsed = Date.now() - pairStartedAt;
  if (elapsed > 120_000) return { stage: "expired" };
  if (elapsed > 2_500) {
    return { stage: "confirming", peer_name: "Pixel 9", digits: "418 207" };
  }
  return { stage: "waiting" };
}

const TABLE: Record<string, (a: Record<string, unknown>) => unknown> = {
  // A copy, because the real bridge serialises across IPC and hands back a
  // fresh object every time. Returning the live one made React see the same
  // reference after a sync and skip the re-render — a bug that exists only in
  // the fixture, which is exactly the kind the fixture must not invent.
  get_household: () => structuredClone(HOUSEHOLD),
  rename_device: (a) => {
    HOUSEHOLD.device.name = String(a.name ?? "").trim() || HOUSEHOLD.device.name;
  },
  begin_pairing: () => {
    pairStartedAt = Date.now();
    pairConfirmed = false;
    return {
      // Shaped like the real thing: tag, addresses, port, static key, expiry.
      payload: PAIR_PAYLOAD,
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      // A real code is drawn in Rust from the real key. The fixture cannot
      // encode one, and a wrong pattern of squares would look like a code that
      // does not scan rather than like a fixture, so this says what it is.
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" ' +
        'aria-label="Pairing code, drawn only in the real app">' +
        '<rect width="100" height="100" fill="#fff"/>' +
        '<text x="50" y="46" text-anchor="middle" font-family="system-ui" ' +
        'font-size="9" fill="#000">no real code</text>' +
        '<text x="50" y="60" text-anchor="middle" font-family="system-ui" ' +
        'font-size="9" fill="#000">in the browser</text></svg>',
    };
  },
  join_pairing: () => {
    // The scanning half lands in the same scripted pairing as the showing
    // half, which is what the screen's single polling effect assumes.
    pairStartedAt = Date.now();
    pairConfirmed = false;
  },
  scan_pair_code: () => ({ payload: PAIR_PAYLOAD, trouble: null }),
  pairing_state: () => pairing(),
  confirm_pairing: (a) => {
    if (a.matches === true) {
      pairConfirmed = true;
      HOUSEHOLD.peers.push({
        device_id: "new-phone",
        name: "Pixel 9",
        paired_at: new Date().toISOString(),
        last_seen_at: null,
      });
    } else {
      pairStartedAt = null;
    }
  },
  cancel_pairing: () => {
    pairStartedAt = null;
  },
  unpair_device: (a) => {
    const i = HOUSEHOLD.peers.findIndex((p) => p.device_id === a.deviceId);
    if (i >= 0) HOUSEHOLD.peers.splice(i, 1);
  },
  sync_now: () => {
    const out = HOUSEHOLD.peers.map((p) => ({
      at: new Date().toISOString(),
      peer_name: p.name,
      // The fixture fails against a device never yet seen, so the screen's
      // failure path is reachable without unplugging anything.
      ok: p.last_seen_at !== null,
      detail:
        p.last_seen_at !== null
          ? "Nothing to send; nothing came back."
          : "No answer on this network. Nothing was changed on either device.",
    }));
    HOUSEHOLD.last = out;
    for (const p of HOUSEHOLD.peers) {
      if (p.last_seen_at !== null) p.last_seen_at = new Date().toISOString();
    }
    return out;
  },

  get_day: (a) => day(String(a.loggedOn ?? today())),
  export_log: (a) => exportLog(String(a.from ?? today()), String(a.to ?? today())),
  // A browser tab has no save panel, so nothing is written and the screen says
  // so — which is also the state a cancelled panel leaves the real app in, and
  // therefore the one worth being able to look at here.
  save_exported_file: () => null,
  search_foods: (a) => search(String(a.query ?? ""), Number(a.limit ?? 40), a.flat === true),
  get_food_detail: (a) => detail(Number(a.fdcId)),
  food_forms: (a) => familyOf(Number(a.fdcId)),
  frequent_foods: (a) => frequent(Number(a.limit ?? 6), (a.meal as Meal | null | undefined) ?? null),
  recent_restaurant_dishes: (a) => RESTAURANT_DISHES.slice(0, Number(a.limit ?? 4)),
  logged_dates: (a) => {
    const since = String(a.since ?? "");
    return loggedDates().filter((d) => d >= since);
  },
  get_day_note: (a) => DAY_NOTES[String(a.loggedOn ?? today())] ?? null,
  set_day_note: (a) => {
    const on = String(a.loggedOn ?? today());
    const body = String(a.body ?? "").trim();
    // Matches the backend: a note of nothing but whitespace is a cleared note,
    // and what is stored is never the empty string.
    if (body === "") delete DAY_NOTES[on];
    else DAY_NOTES[on] = body;
    return undefined;
  },
  get_range: (a) => range(String(a.from ?? today()), String(a.to ?? today())),
  list_nutrients: () => meta(),
  get_goals: () => goals(),
  list_vessels: () => VESSELS,
  // A copy: logging from a bottle moves its `last_used_at`, and handing back
  // the same array would let React skip the re-render that shows it.
  list_bottles: () => structuredClone(BOTTLES),
  list_containers: () => CONTAINERS,
  get_container: (a) => CONTAINERS.find((c) => c.id === a.id) ?? CONTAINERS[0],
  pantry: () => pantry(),
  taste_factors: () => FACTORS,
  container_usage: () => [],
  suggest_density: () => ({ g_per_ml: 0.9197, source: "reference", note: "USDA: 1 tbsp is 13.6 g" }),
  preview_container_event: (a) => previewEvent(a),
  add_container_event: (a) => CONTAINERS.find((c) => c.id === a.containerId) ?? CONTAINERS[0],
  save_container: () => "salt",
  delete_container: () => undefined,
  delete_container_event: () => undefined,
  list_recipes: () => RECIPES,
  list_open_cooks: () => COOKS,
  list_supplements: () => SUPPLEMENTS,
  list_custom_foods: () => structuredClone(CUSTOM),
  get_custom_food: (a) => ownFood(String(a.id)),
  get_custom_food_detail: (a) => ownDetail(ownFood(String(a.id))),
  save_custom_food: (a) => saveOwn(a.food as CustomFood, (a.id as string | null) ?? null),
  delete_custom_food: (a) => {
    const at = CUSTOM.findIndex((x) => x.id === String(a.id));
    if (at >= 0) CUSTOM.splice(at, 1);
    return undefined;
  },
  label_percent_table: () => PERCENT_TABLE,
  // Pack photos, for walking the editor's read-and-confirm in a browser. A
  // photo is kept in memory for the life of the tab and "read" as the same
  // Indian pack whatever it shows: energy, protein, carbohydrate, sugars and
  // fat, in that order, with its list printed under the panel.
  save_food_photo: (a) => {
    const name = `${(++PHOTO_SEQ).toString(16).padStart(32, "0")}.jpg`;
    PHOTOS.set(name, String(a.dataBase64));
    return name;
  },
  read_food_photo: (a) => PHOTOS.get(String(a.name)) ?? "",
  discard_food_photo: (a) => { PHOTOS.delete(String(a.name)); return undefined; },
  scan_label_photo: () => ({
    serving_g: 30, serving_ml: null, serving_label: "1 pack (30 g)",
    readings: [
      { nutrient_id: 1008, kind: "measured", amount: 123, upper: null },
      { nutrient_id: 1003, kind: "measured", amount: 6.2, upper: null },
      { nutrient_id: 1005, kind: "measured", amount: 17.4, upper: null },
      { nutrient_id: 2000, kind: "measured", amount: 0.9, upper: null },
      { nutrient_id: 1004, kind: "measured", amount: 2.1, upper: null },
      { nutrient_id: 1093, kind: "measured", amount: 189, upper: null },
    ],
    missing: [1258, 1257, 1253, 1079, 1235, 1114, 1087, 1089, 1092],
    lines: 14, unmatched_rows: 3, trouble: null,
  }),
  // Amounts in the nutrient's own magnitude pass through; nothing here does IU.
  convert_label_figure: (a) => ({
    nutrient_id: Number(a.nutrientId), position: 0, label_amount: Number(a.amount),
    label_unit: a.unit, label_form: a.form,
    kind: a.unit === "IU" ? "not_converted" : "measured",
    amount: a.unit === "IU" ? null : Number(a.amount), upper: null,
    convert_note: a.unit === "IU" ? "The browser fixture does not convert IU." : null,
  }),
  scan_supplement_photo: () => ({
    serving_units: 2, serving_label: "2 capsules", unit_noun: "capsule",
    readings: [
      { nutrient_id: 1114, label_amount: 25, label_unit: "mcg", label_form: "" },
      { nutrient_id: 1178, label_amount: 500, label_unit: "mcg", label_form: "" },
      { nutrient_id: 1090, label_amount: 200, label_unit: "mg", label_form: "" },
      { nutrient_id: 1095, label_amount: 91, label_unit: "% DV", label_form: "" },
    ],
    unmatched_rows: 2, lines: 12, trouble: null,
  }),
  scan_ingredients_photo: () => ({
    text: "Bengal Gram (Chana) (88%), Edible Vegetable Oil (Cottonseed Oil), Salt, Turmeric Powder.",
    contains: null, lines: 14, trouble: null,
  }),
  list_cuisines: () => ["South Indian", "North Indian", "Gujarati", "Bengali"],
  recall_tags: () => ({ origin: null, cuisine: null }),
  set_entry_tags: () => undefined,
  save_profile: () => undefined,
  set_nutrient_target: () => undefined,
  // No screen to hold open in a browser tab, and the real command is a no-op
  // off Android anyway — but without an entry here the fixture would throw on
  // every `pnpm dev` session, because `lib/awake.ts` asks as the page boots.
  set_keep_awake: () => undefined,

  backup_status: () => BACKUP,
  enable_log_encryption: (a) => {
    // The fixture enforces the same two refusals the backend does, because the
    // whole reason to have this screen reachable in a browser is to look at
    // what a refusal does to the layout.
    const pass = String(a.passphrase ?? "");
    if (pass.length < 12) {
      throw new Error(
        "a recovery passphrase has to be at least 12 characters — it is the only thing that " +
          "can open the sealed copy, and there is nothing to reset it with",
      );
    }
    if (pass !== String(a.confirm ?? "")) throw new Error("the two passphrases are not the same");
    BACKUP.encrypted = true;
    BACKUP.passphrase_set = true;
    BACKUP.keystore_holds_key = true;
    return BACKUP;
  },
  disable_log_encryption: () => {
    BACKUP.encrypted = false;
    BACKUP.passphrase_set = false;
    BACKUP.keystore_holds_key = false;
    BACKUP.sealed_at = null;
    BACKUP.sealed_bytes = null;
    BACKUP.plain_bytes = null;
    return BACKUP;
  },
  change_backup_passphrase: (a) => {
    if (String(a.passphrase ?? "") !== String(a.confirm ?? "")) {
      throw new Error("the two passphrases are not the same");
    }
    // Matches the backend: changing the passphrase does not re-seal, so the
    // copy on the phone reads as out of date until a fresh one is sealed.
    if (BACKUP.sealed_at !== null) BACKUP.stale = true;
    return BACKUP;
  },
  seal_backup_now: () => {
    BACKUP.sealed_at = new Date().toISOString();
    BACKUP.sealed_bytes = 4_312_774;
    BACKUP.plain_bytes = 19_267_584;
    BACKUP.over_quota = false;
    BACKUP.stale = false;
    return BACKUP;
  },
  set_auto_reseal: (a) => {
    BACKUP.auto_reseal = Boolean(a.on);
    return BACKUP;
  },
  remove_sealed_backup: () => {
    BACKUP.sealed_at = null;
    BACKUP.sealed_bytes = null;
    BACKUP.plain_bytes = null;
    BACKUP.auto_reseal = false;
    return BACKUP;
  },
  restore_backup: () => ({
    entries: 1_284,
    sealed_at: BACKUP.sealed_at ?? new Date().toISOString(),
    superseded_path: "/data/user/0/com.kgundu1.trackit/user.db.superseded",
    replaced_earlier_superseded: false,
  }),
  unlock_log: () => {
    BACKUP.locked = false;
    BACKUP.locked_note = null;
    return BACKUP;
  },
  // No home screen in a browser tab, so nothing was ever parked. Null rather
  // than absent: the landing effect runs on every mount, and a missing entry
  // here would throw mock.ts's own "not in the browser fixture" on every
  // reload of the design fixture.
  take_widget_landing: () => null,
  // The day's writes — remove and its undo, a bottle weighed or drunk whole,
  // the corrections — which change the day `get_day` reads back.
  ...DAY_TABLE,
  ...ACTIVITY_TABLE,
  // A plate weighed with vessels under it is logged at what is left once they
  // come off, as the backend does, from the library here.
  add_log_entry: (a) => {
    if (a.grossG == null) return DAY_TABLE.add_log_entry(a);
    const ids = (a.vesselIds as string[] | null) ?? [];
    const tare = VESSELS.filter((v) => ids.includes(v.id)).reduce((t, v) => t + v.grams, 0);
    return DAY_TABLE.add_log_entry({ ...a, grams: Number(a.grossG) - tare, grossG: null });
  },
};

/**
 * A phone partway through setting this up, for looking at the Backup screen in
 * a browser (`pnpm dev`, then `?android` — see `isAndroid`).
 *
 * Deliberately NOT the finished state. `encrypted: false` with no sealed copy
 * is the state the screen has the most to say in — two consents still to give,
 * a keystore to describe, and every "what this does not do" paragraph on show
 * at once. The screen's other states are reached by using the buttons, which is
 * also how a design question about them gets answered.
 */
const BACKUP: BackupStatus = {
  supported: true,
  encrypted: false,
  locked: false,
  locked_note: null,
  passphrase_set: false,
  keystore: { available: true, hardware: "tee", note: null },
  keystore_holds_key: false,
  sealed_at: null,
  sealed_bytes: null,
  plain_bytes: null,
  quota_bytes: 25 * 1024 * 1024,
  over_quota: false,
  stale: false,
  auto_reseal: false,
  restore_available: false,
  logged_entries: 1_284,
  sealed_dir: "/data/user/0/com.kgundu1.trackit/files/backup",
  superseded_path: null,
};

/**
 * What an export of a period would carry, built out of the same day the rest of
 * this fixture draws.
 *
 * Deliberately uneven, for the reason the whole fixture is: two rows carry a
 * full set of figures, one carries three, and one carries none at all. A file
 * where every cell is filled would hide the two states the export screen exists
 * to state — a blank because nothing knew the value, and a row that will come
 * back as no row at all.
 */
function exportLog(from: string, to: string): ExportLog {
  const known = (n: number) =>
    LABEL_NUTRIENTS.slice(0, n).map((n2, i) => ({ nutrient_id: n2.id, amount: 4 + i * 3.5 }));
  const entries = dayEntries(today());
  // Food only: a dose goes on its own sheet in the real export, and this
  // fixture leaves that sheet empty rather than inventing a panel for it.
  const rows = entries.filter((e) => e.source_kind !== "water" && e.source_kind !== "supplement").map((e, i) => ({
    logged_on: from,
    meal: e.meal ?? "snack",
    description: e.description,
    nutrients: i === 3 ? [] : known(i % 3 === 0 ? LABEL_NUTRIENTS.length : 3),
  }));
  const blanks = rows.reduce((n, r) => n + (LABEL_NUTRIENTS.length - r.nutrients.length), 0);
  return {
    from,
    to,
    days: 1,
    rows,
    doses: [],
    water: entries.filter((e) => e.source_kind === "water").map((e) => ({
      logged_on: from,
      description: e.description,
      ml: Math.round((e.grams ?? 0) / 0.9982),
      measured: e.bottle_id === "b1",
    })),
    ...exportActivity(from, to),
    blanks,
    rows_without_values: rows.filter((r) => r.nutrients.length === 0).length,
    unexportable: 0,
  };
}

/** Answers one command, or explains that the fixture does not cover it. */
/** Pack photos taken in this tab, by the name `save_food_photo` gave them. */
const PHOTOS = new Map<string, string>();
let PHOTO_SEQ = 0;

export async function mockInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const fn = TABLE[cmd];
  if (!fn) {
    throw new Error(
      `${cmd} is not in the browser fixture. Run the app with \`pnpm tauri dev\` for the real backend.`,
    );
  }
  // A tick of latency, so skeletons and busy states are actually reachable
  // here rather than only in the real app.
  await new Promise((r) => setTimeout(r, 90));
  return fn(args) as T;
}
