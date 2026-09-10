/**
 * Mirrors of the Rust types that cross the IPC boundary.
 *
 * `NutrientValue` is a discriminated union on purpose: TypeScript will not let
 * you read `.amount` without first narrowing on `kind`, which is what stops a
 * missing measurement from being rendered as `0`. Never write `?? 0` against
 * one of these.
 */

export type NutrientValue =
  | { kind: "measured"; amount: number }
  | { kind: "measured_zero" }
  | { kind: "assumed_zero" }
  | { kind: "zero_unknown" }
  | { kind: "below_loq"; upper: number }
  | { kind: "label_zero"; upper: number }
  | { kind: "trace"; upper: number }
  | { kind: "absent" };

/** What supplements alone contributed to one nutrient. */
export interface SupplementSubtotal {
  /** Already part of `DailyTotal.lower`; this is the pill's share of it. */
  lower: number;
  upper: number | null;
  doses_total: number;
  doses_covered: number;
}

export interface DailyTotal {
  /** Sum of lower bounds — what we can positively account for. */
  lower: number;
  /** Sum of upper bounds, or null if any contributor is unbounded. */
  upper: number | null;
  /**
   * Fraction of the day's logged FOOD mass that had data for this nutrient, or
   * null when nothing with a mass was logged.
   *
   * Null, not 0 — on a day holding only a multivitamin there is no mass to have
   * covered, and a zero here would render as "nothing is known" when the
   * amounts are in fact known exactly. Never write `?? 0` against it.
   */
  coverage: number | null;
  items_total: number;
  items_covered: number;
  /** What supplements contributed, or null if none were taken. */
  from_supplements: SupplementSubtotal | null;
}

export interface NutrientTotal {
  id: number;
  name: string;
  full_name: string;
  magnitude: string;
  tier: "core" | "extended";
  group: string;
  total: DailyTotal;
  /**
   * What this nutrient is being read against, or null where no reference
   * system publishes a figure. Never defaulted — an invented denominator
   * renders a confident percentage out of nothing.
   */
  target: number | null;
  /**
   * Which system that figure came from. Carried beside the number because a
   * percentage is meaningless without saying what it is a percentage OF, and
   * because an Adequate Intake and an RDA support very different conclusions
   * from the same shortfall.
   */
  target_basis: TargetBasis | null;
  /**
   * True when the daily value is a ceiling to stay under rather than a goal to
   * reach. Only a breach of one of these earns alarm colour — being under a
   * target mid-day is information, not an error.
   */
  is_limit: boolean;
}

export interface LogEntry {
  id: string;
  /**
   * What a water entry came to in millilitres. Absent on everything else —
   * food is a mass and stays one.
   */
  water?: Volume;
  logged_on: string;
  /**
   * The sitting this was part of, or null for water.
   *
   * A meal is a sitting, and food belongs to one because that is genuinely how
   * it was eaten. Water is refilled and sipped from across a whole day, so
   * naming a meal for it would record a fact the user never gave — the same
   * error as a nutrient stored as 0 when it was only unmeasured. The database
   * enforces the pairing: water has no meal, everything else has one.
   */
  meal: Meal | null;
  source_kind: SourceKind;
  fdc_id: number | null;
  recipe_id: string | null;
  /**
   * The pot this portion came out of. Distinct from `recipe_id`: a recipe entry
   * portioned the batch as written, a cook entry portioned the batch that
   * existed.
   */
  cook_id: string | null;
  custom_food_id: string | null;
  supplement_id: string | null;
  bottle_id: string | null;
  description: string;
  /**
   * What was eaten, in grams. Null for a supplement, which is counted rather
   * than weighed. Never write `?? 0`: a dose rendered as "0 g" is the same
   * class of lie as a nutrient rendered as 0.
   */
  grams: number | null;
  /** The dose taken, counted in the supplement's own unit noun. */
  units: number | null;
  /** What the scale read with the vessels on it, or null if weighed directly. */
  gross_g: number | null;
  /** What came off. Null exactly when `gross_g` is. */
  tare_g: number | null;
  /**
   * The vessel names, joined. Denormalised for the same reason `description` is:
   * deleting a vessel must not change what a past day says it weighed.
   */
  tare_note: string | null;
  /**
   * Where the dish came from and what the user calls its cuisine. Null means
   * they have not said, which is a different fact from any answer they could
   * give — nothing may substitute a default.
   */
  origin: Origin | null;
  cuisine: string | null;
}

export type SourceKind = "food" | "recipe" | "cook" | "custom" | "supplement" | "water";

/** Where a dish came from. A closed set: who cooked it, and where. */
export type Origin = "home" | "ordered_in" | "eaten_out" | "packaged";

export const ORIGINS: { id: Origin; label: string; short: string }[] = [
  { id: "home", label: "Made at home", short: "Home" },
  { id: "ordered_in", label: "Ordered in", short: "Ordered" },
  { id: "eaten_out", label: "Ate out", short: "Out" },
  { id: "packaged", label: "Packaged", short: "Packaged" },
];

export const ORIGIN_LABEL: Record<Origin, string> = {
  home: "Made at home",
  ordered_in: "Ordered in",
  eaten_out: "Ate out",
  packaged: "Packaged",
};

/**
 * Cuisines offered before the user has a vocabulary of their own.
 *
 * Suggestions in a picker and nothing more: none of these is written anywhere
 * until the user picks it, and the list disappears once they have six of their
 * own. Cuisine is stored as free text because a fixed list forces a wrong
 * answer on the dishes eaten most — gobi manchurian is neither "Indian" nor
 * "Chinese", and one "Indian" bar covering four fifths of every period is a
 * constant rather than a chart.
 */
export const CUISINE_SUGGESTIONS = [
  "South Indian",
  "North Indian",
  "Indo-Chinese",
  "Chinese",
  "Italian",
  "Continental",
];

/**
 * One physical vessel, weighed empty once. Not a vessel TYPE — two steel katoris
 * off the same shelf differ by several grams, and a table keyed by type would put
 * back the error the tare exists to remove.
 */
export interface Vessel {
  id: string;
  name: string;
  grams: number;
  /** ISO timestamp of the last log entry that used it, or null if never used. */
  last_used_at: string | null;
}

/**
 * One physical water bottle, weighed full once. Not a bottle TYPE — the same
 * reasoning as `Vessel`: two bottles of the same model can differ by a few
 * grams, and consumption is read against a specific bottle's own full weight.
 */
export interface Bottle {
  id: string;
  name: string;
  full_g: number;
  /**
   * Weighed empty, and what the maker calls it in millilitres.
   *
   * Both together or neither. With them a bottle converts its own weighings
   * into the volume its owner thinks in — a bottle sold as a litre that takes
   * 940 g of water to the line they fill to is still a litre TO THEM, and that
   * is the number the app should say. Without them water reads at the density
   * of water, which is right to about two parts in a thousand and is marked as
   * an assumption rather than a measurement.
   */
  empty_g: number | null;
  volume_ml: number | null;
  /** ISO timestamp of the last log entry that used it, or null if never used. */
  last_used_at: string | null;
}

/** A volume of water, and where the conversion from mass came from. */
export type Volume =
  | { kind: "measured"; ml: number }
  | { kind: "assumed"; ml: number };

/** Litres past a litre, millilitres below — how people actually say it. */
export function describeVolume(ml: number): string {
  return ml >= 1000 ? `${(ml / 1000).toFixed(1)} L` : `${Math.round(ml)} ml`;
}

/** One resolved component of an entry: the food, or one recipe ingredient. */
export interface Component {
  description: string;
  fdc_id: number | null;
  /** Null for a supplement, which contributed a dose and no mass. */
  grams: number | null;
  /** False when no composition data exists — show the gap, don't hide the row. */
  has_data: boolean;
}

export interface EntryBreakdown {
  entry_id: string;
  components: Component[];
  recipe_name: string | null;
  recipe_yield_g: number | null;
  recipe_servings: number | null;
}

export interface DayView {
  logged_on: string;
  entries: LogEntry[];
  breakdowns: EntryBreakdown[];
  totals: NutrientTotal[];
  /**
   * What the day's energy is read against, or null when the profile gives
   * neither a figure of the user's own nor enough to estimate one. Null means
   * the dashboard shows what was eaten and draws no rail — which is what
   * replaced a hard-coded 2,200 kcal that described nobody.
   */
  energy_target: EnergyTarget | null;
  macro_ranges: MacroRange[];
}

/* ── who the targets are for ───────────────────────────────────────────── */

/**
 * Which system a target came from.
 *
 * These are not interchangeable. An RDA meets the needs of 97–98% of a group,
 * so falling under one means something. An Adequate Intake is used where the
 * evidence could not support an RDA — usually the observed median intake of a
 * healthy population — so falling under one means much less. A Daily Value is
 * one adult column off a food label, which is what a pack is labelled against
 * rather than what any particular person needs.
 */
export type TargetBasis = "rda" | "ai" | "daily_value" | "user_set";

export const BASIS_LABEL: Record<TargetBasis, string> = {
  rda: "RDA",
  ai: "adequate intake",
  daily_value: "Daily Value",
  user_set: "your target",
};

/** The longer form, for wherever there is room to say it properly. */
export const BASIS_NOTE: Record<TargetBasis, string> = {
  rda: "Recommended Dietary Allowance — set to meet the needs of 97–98% of people in your group.",
  ai: "Adequate Intake — used where the evidence could not support an RDA, so falling under it says less than falling under one.",
  daily_value:
    "FDA Daily Value — the single adult figure printed on food labels, not a figure for you specifically.",
  user_set: "The figure you set yourself.",
};

/** The sex whose reference column applies — a lookup key, not a description. */
export type Sex = "female" | "male";

export type LifeStage = "standard" | "pregnant" | "lactating";

export const LIFE_STAGES: { id: LifeStage; label: string }[] = [
  { id: "standard", label: "Neither" },
  { id: "pregnant", label: "Pregnant" },
  { id: "lactating", label: "Breastfeeding" },
];

export type Activity =
  | "sedentary"
  | "light"
  | "moderate"
  | "very_active"
  | "extra_active";

export const ACTIVITIES: { id: Activity; label: string; note: string }[] = [
  { id: "sedentary", label: "Sedentary", note: "desk work, little deliberate exercise" },
  { id: "light", label: "Lightly active", note: "light exercise 1–3 days a week" },
  { id: "moderate", label: "Moderately active", note: "moderate exercise 3–5 days a week" },
  { id: "very_active", label: "Very active", note: "hard exercise 6–7 days a week" },
  { id: "extra_active", label: "Extremely active", note: "physical job, or twice-daily training" },
];

export interface Profile {
  sex: Sex | null;
  birth_year: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  activity: Activity | null;
  life_stage: LifeStage;
  /** Their own energy figure. Null means "estimate it from the body above". */
  energy_kcal: number | null;
}

export interface EnergyTarget {
  kcal: number;
  basis: "user_set" | "estimated";
  /** An estimate's working — resting expenditure and the activity multiplier. */
  resting: number | null;
  factor: number | null;
}

/**
 * A macronutrient's acceptable share of energy, in grams.
 *
 * A range, not a point: there is no single right amount of fat, and the
 * midpoint of 20–35% is not a target.
 */
export interface MacroRange {
  nutrient_id: number;
  low_g: number;
  high_g: number;
  low_pct: number;
  high_pct: number;
}

/** One nutrient on the settings screen. */
export interface GoalRow {
  id: number;
  name: string;
  magnitude: string;
  group: string;
  tier: "core" | "extended";
  amount: number | null;
  basis: TargetBasis | null;
  is_limit: boolean;
  user_amount: number | null;
  user_note: string | null;
  /** What would apply if the user's own figure were cleared. */
  published_amount: number | null;
  published_basis: TargetBasis | null;
}

export interface GoalsView {
  profile: Profile;
  /** How the DRI tables name this person's column, or null if unplaced. */
  group_label: string | null;
  energy_target: EnergyTarget | null;
  /** What the body estimates to, whether or not that is what is in force. */
  estimated_kcal: number | null;
  estimated_resting: number | null;
  macro_ranges: MacroRange[];
  rows: GoalRow[];
}

export interface FoodHit {
  /**
   * Which shelf the hit came off. The user's own foods are a different kind of
   * knowledge from the bundled reference data, so the screens group on this
   * rather than interleaving by score.
   */
  kind: "custom" | "reference";
  /** Null for a custom food: it has no USDA identity. */
  fdc_id: number | null;
  custom_food_id: string | null;
  description: string;
  brand: string | null;
  data_type: string;
  /**
   * Why a USDA name that looks wrong is in fact the right entry — or, for a
   * custom food, which generic entry it replaces.
   */
  note: string | null;
  /** True when an Indian-name alias matched, so this hit is ranked first. */
  matched_alias: boolean;
}

/**
 * One row of the quick-add list: something logged often enough lately to be
 * worth a shortcut, with the last amount to open the portion step on.
 *
 * Note what it is not. It is not a scoreboard, and it carries no count, no rank
 * and no score to render — that absence is the design. A tally beside a food
 * name is a leaderboard of the user's own habits, which is a streak wearing
 * different clothes; the ordering's basis is stated ONCE, in the section's own
 * line of prose, and never per row.
 *
 * Shaped for two readers. The other is the Android home-screen widget, which
 * is `RemoteViews` and can draw nothing but pre-formatted strings, which is why
 * the amount arrives already written out.
 */
export interface FrequentFood {
  /** Only these two. A cook, a recipe, a supplement and water are all excluded. */
  source_kind: "food" | "custom";
  /** "food:16033" / "custom:<uuid>". Stable — use it as the React key. */
  key: string;
  /** Null for one of the user's own foods: it has no USDA identity. */
  fdc_id: number | null;
  custom_food_id: string | null;
  /**
   * A custom food's name AS IT STANDS NOW, and for a reference food the
   * description the bundled dataset carries now. Both are read live rather
   * than taken from the log, because tapping this row logs the CURRENT food —
   * a row showing an old name and writing a new one would say one thing and do
   * another.
   */
  description: string;
  brand: string | null;
  /**
   * The last net weight, to open the portion step on. Never null, and never
   * write `?? 0` against it — see the Rust doc: a supplement is the only kind
   * that may omit a weight and no supplement reaches this list.
   */
  last_grams: number;
  /** `last_grams` already written out, e.g. "150 g". */
  last_amount_label: string;
}

export interface Portion {
  amount: number;
  unit: string | null;
  description: string | null;
  gram_weight: number;
}

export interface NutrientRow {
  id: number;
  name: string;
  magnitude: string;
  basis: string;
  tier: "core" | "extended";
  value: NutrientValue;
}

export interface FoodDetail {
  fdc_id: number;
  description: string;
  data_type: string;
  nutrients: NutrientRow[];
  portions: Portion[];
}

/**
 * One line a nutrition panel actually prints, per serving. The kinds stop at
 * what a pack can assert: there is no `measured_zero`, because a printed 0 is a
 * figure below a rounding threshold and not an observed absence.
 */
export interface CustomNutrient {
  nutrient_id: number;
  kind: "measured" | "label_zero" | "below_loq" | "trace";
  /** Per serving, as printed. Set only for `measured`. */
  amount: number | null;
  /** Per serving. The bound for `label_zero`, `below_loq` and `trace`. */
  upper: number | null;
}

/**
 * A food as the pack describes it. `serving_g` is mandatory because label
 * figures are per serving while the rest of the app is per 100 g; without it
 * every transcribed number is wrong by whatever the serving happens to be.
 */
export interface CustomFood {
  id: string;
  name: string;
  brand: string | null;
  /** The generic reference entry this replaces in search, or null. */
  overrides_fdc_id: number | null;
  serving_g: number;
  /** The pack's own wording, e.g. "1 bar (43 g)". */
  serving_label: string | null;
  ingredients: string | null;
  barcode: string | null;
  /** Base filename in the app's photo directory — read it via `readFoodPhoto`. */
  photo_label: string | null;
  photo_ingredients: string | null;
  nutrients: CustomNutrient[];
  /**
   * True for a row a spreadsheet import created rather than a person typing a
   * pack in. These are excluded from search and "My foods" — a year of history
   * would otherwise swarm both with entries nobody would ever search for or log
   * a second time — but a day that already logged one keeps resolving it. Never
   * set by the existing custom-food editor, so it is safe to default to false.
   */
  import_only?: boolean;
}

/**
 * Where one displayed value came from. A pack prints about 15 numbers and this
 * app shows 47, so most of a custom food's panel is either borrowed from the
 * overridden entry or simply not known — and the UI has to say which, because
 * laundering the second into the first is the failure this app exists to
 * prevent.
 */
export type Provenance = "label" | "inherited" | "unknown";

export interface CustomNutrientRow extends NutrientRow {
  group: string;
  provenance: Provenance;
}

export interface CustomFoodDetail {
  food: CustomFood;
  /** All 47 displayed nutrients, in display order. */
  nutrients: CustomNutrientRow[];
  /** Name of the reference food being overridden, if any. */
  base_description: string | null;
  from_label: number;
  from_base: number;
  unknown: number;
}

/**
 * What a US nutrition panel prints, in the order it prints it. Two screens
 * transcribe against this list, so it lives here rather than in either of them
 * — the ids have to agree or the same pack yields two different foods. Ids
 * verified against the bundled reference database.
 */
export const LABEL_NUTRIENTS: { id: number; name: string; unit: string }[] = [
  { id: 1008, name: "Energy", unit: "kcal" },
  { id: 1004, name: "Total fat", unit: "g" },
  { id: 1258, name: "Saturated fat", unit: "g" },
  { id: 1257, name: "Trans fat", unit: "g" },
  { id: 1253, name: "Cholesterol", unit: "mg" },
  { id: 1093, name: "Sodium", unit: "mg" },
  { id: 1005, name: "Total carbohydrate", unit: "g" },
  { id: 1079, name: "Dietary fiber", unit: "g" },
  { id: 2000, name: "Total sugars", unit: "g" },
  { id: 1235, name: "Added sugars", unit: "g" },
  { id: 1003, name: "Protein", unit: "g" },
  { id: 1114, name: "Vitamin D", unit: "µg" },
  { id: 1087, name: "Calcium", unit: "mg" },
  { id: 1089, name: "Iron", unit: "mg" },
  { id: 1092, name: "Potassium", unit: "mg" },
];

export type Meal = "breakfast" | "lunch" | "dinner" | "snack";
export const MEALS: Meal[] = ["breakfast", "lunch", "dinner", "snack"];

export const SOURCE_LABEL: Record<string, string> = {
  foundation_food: "Foundation",
  sr_legacy_food: "SR Legacy",
  survey_fndds_food: "FNDDS",
};

/** Below this mass-coverage, we show a bound rather than a number, and no bar. */
export const CONFIDENCE_THRESHOLD = 0.8;

export interface RecipeIngredient {
  id: string;
  position: number;
  /** null when no composition data exists for this ingredient. */
  fdc_id: number | null;
  description: string;
  raw_g: number;
  cooked_g: number;
  /**
   * Whether the dish is still the dish without this line. A note to the person
   * at the stove — it moves no weight and enters no arithmetic. Actually
   * leaving the line out is recorded on the cook, never here: a recipe that
   * omits its own ingredient is a different recipe.
   */
  optional: boolean;
}

/**
 * A named portion — "1 katori", "1 dosa" — so a meal need not be weighed.
 * Unrelated to `Recipe.servings`: a label for an amount on a plate, not a
 * count of the people a batch feeds.
 */
export interface RecipeServing {
  id: string;
  label: string;
  grams: number;
}

/**
 * A dish as it is meant to be made: ingredients in proportion to one another.
 *
 * A recipe is an intention, never a measurement. What was actually made is a
 * cook — the same lines dialled up or down, some left out, some swapped, and a
 * pot that went on a scale — and it is a portion of that which gets logged.
 */
export interface Recipe {
  id: string;
  name: string;
  /**
   * The reference batch: what the ingredient weights happen to add up to. Not
   * a claim about how much you will make, which is why a cook carries a scale
   * of its own.
   */
  yield_g: number;
  /**
   * How many the batch feeds, if the user chose to say. Null is the normal
   * case and nothing ever fills it in: the same dal feeds two on a weeknight
   * and six when there are guests. Never a divisor — portioning divides by a
   * yield. Never write `?? 0` or `?? 4`.
   */
  servings: number | null;
  notes: string | null;
  /** Pre-fills the pickers when this recipe has never been logged. */
  default_origin: Origin | null;
  default_cuisine: string | null;
  ingredients: RecipeIngredient[];
  serving_options: RecipeServing[];
}

/** One line of a pot, as it actually went in. */
export interface CookIngredient {
  id: string;
  position: number;
  fdc_id: number | null;
  description: string;
  /**
   * What the recipe called for at this cook's scale, frozen when the cook was
   * opened. The dial's centre, and what "what moved" is measured against —
   * which is why it survives a later rewrite of the recipe.
   */
  planned_g: number;
  /**
   * What went in. Zero means deliberately left out, which is a different fact
   * from the line never having been in the dish — the one place in this app
   * where a zero weight is a measurement rather than a missing one.
   */
  raw_g: number;
  cooked_g: number;
  /** The line this replaced, when it was a substitution. */
  substituted_for: string | null;
}

/**
 * One pot, actually made.
 *
 * Where a `Recipe` says what the dish should be, a cook says what it was: the
 * same lines scaled, dialled, left out or swapped, and a pot that went on a
 * scale. It is the only place in the app where an ingredient amount is a
 * measurement, and it is what a logged portion is taken out of.
 */
export interface Cook {
  id: string;
  /** What this started from. Null for a pot cooked without a written recipe. */
  recipe_id: string | null;
  name: string;
  cooked_on: string;
  cooked_at: string;
  /** What the recipe was multiplied by before any single line was dialled. */
  scale: number;
  /** What the pot weighed, when it was weighed. Null means it never was. */
  weighed_yield_g: number | null;
  gross_g: number | null;
  tare_g: number | null;
  tare_note: string | null;
  default_origin: Origin | null;
  default_cuisine: string | null;
  notes: string | null;
  /** Set when the pot is empty or thrown out. Never set automatically. */
  finished_at: string | null;
  ingredients: CookIngredient[];
  /** How much has been logged from this pot. Summed from the live entries. */
  logged_g: number;
  /**
   * What a portion is divided by: the weighed yield where there is one, the
   * summed line weights otherwise. Computed in the backend so both sides use
   * one definition — never recompute it here.
   */
  yield_g: number;
  /** What is left. Floored at zero; logging past the yield is allowed. */
  remaining_g: number;
}

/** What the cook sheet sends when it saves a pot. Vessel ids, never weights. */
export interface CookDraft {
  recipeId: string | null;
  name: string;
  cookedOn: string;
  scale: number;
  grossG: number | null;
  vesselIds: string[];
  weighedYieldG: number | null;
  notes: string | null;
  origin: Origin | null;
  cuisine: string | null;
  ingredients: CookIngredient[];
}

export interface DayTag {
  key: string;
  label: string;
  entries: number;
}

export interface DaySummary {
  date: string;
  items: number;
  /** Mass of FOOD logged. Neither a supplement nor a bottle of water contributes. */
  grams: number;
  /** Energy for that day, or null where nothing logged measured it. */
  kcal: number | null;
  /**
   * A day with `food_items === 0` held only a supplement and/or a bottle of
   * water. That is not a day of almost no food, and the calendar must not draw
   * it as one.
   */
  food_items: number;
  supplement_items: number;
  water_items: number;
  /**
   * Water drunk that day in millilitres, or null on a day no bottle was
   * logged. Distinct from the nutrient called Water, which counts the water in
   * food as well — these are two different facts and the app keeps them apart.
   */
  water_ml: number | null;
  origins: DayTag[];
  cuisines: DayTag[];
  untagged_origin: number;
  untagged_cuisine: number;
}

/** How a period's dishes split across one dimension. */
export interface TagBreakdown {
  /** Null is the untagged group — reported, never hidden. */
  key: string | null;
  label: string | null;
  entries: number;
  days: number;
  grams: number;
}

export interface RangeView {
  from: string;
  to: string;
  /**
   * Days in the range with at least one entry. Averages divide by THIS, never
   * by the calendar length — logging three days of a week and dividing by seven
   * understates intake by more than half.
   */
  days_logged: number;
  /**
   * Days on which a supplement was taken. Counted apart from `days_logged`,
   * which deliberately excludes days holding no food: dividing a period's
   * nutrient totals by a day you only took a vitamin would understate intake
   * in exactly the way that divisor exists to prevent.
   */
  days_with_supplements: number;
  /**
   * Days on which a bottle of water was logged. Counted apart from
   * `days_logged` for the same reason as `days_with_supplements`: finishing a
   * bottle is not a claim about what, or whether, anything was eaten.
   */
  days_with_water: number;
  days: DaySummary[];
  /** Period sums; divide by days_logged for a daily average. */
  totals: NutrientTotal[];
  origins: TagBreakdown[];
  cuisines: TagBreakdown[];
}

/* ── supplements ───────────────────────────────────────────────────────── */

/**
 * The magnitudes a supplement panel prints. `IU` is one of these because that
 * is where it sits on a real pack — but it is a measure of biological activity,
 * not a mass, and converts only when the compound is named.
 */
export type LabelUnit = "g" | "mg" | "ug" | "IU" | "kcal";

/** The chemical forms where naming the compound changes the arithmetic. */
export type LabelForm =
  | "unspecified"
  | "retinol"
  | "beta_carotene_supplemental"
  | "beta_carotene_dietary"
  | "vitamin_d"
  | "alpha_tocopherol_natural"
  | "alpha_tocopherol_synthetic"
  | "folic_acid"
  | "food_folate"
  | "methylfolate";

/**
 * The form options for one nutrient, given the unit the figure was printed in.
 *
 * The two cases mean genuinely different things, which is why this is a
 * function and not a table:
 *
 * - **In IU**, the form names the compound in the product. An IU is a measure
 *   of biological activity and the mass it stands for depends on what the
 *   compound is, so this is the question that decides whether the figure can be
 *   converted at all.
 * - **In mg or mcg**, the form names *what the number measures*. 21 CFR 101.36
 *   makes a compliant panel print vitamin A as mcg RAE and folate as mcg DFE
 *   whatever the product contains — so a beta-carotene product still prints RAE.
 *   Applying the compound's factor to the panel's own figure would convert a
 *   number that has already been converted. "As printed" is therefore the
 *   default and the right answer for a panel line; the alternatives are for a
 *   figure read off the ingredient statement instead.
 *
 * A nutrient with no entry here takes its figure as it stands: 21 CFR
 * 101.36(b)(3)(ii) makes a mineral line the weight of the mineral and not of
 * its salt, so magnesium oxide versus citrate changes nothing.
 */
export function formsFor(
  nutrientId: number,
  unit: LabelUnit,
): { id: LabelForm; label: string }[] | null {
  const iu = unit === "IU";
  switch (nutrientId) {
    case 1106:
      return iu
        ? [
            { id: "retinol", label: "Retinol / retinyl ester" },
            { id: "beta_carotene_supplemental", label: "Beta-carotene (supplemental)" },
            { id: "beta_carotene_dietary", label: "Beta-carotene (from food)" },
          ]
        : [
            { id: "unspecified", label: "As printed (mcg RAE)" },
            { id: "retinol", label: "mcg of retinol" },
            { id: "beta_carotene_supplemental", label: "mcg of beta-carotene (supplemental)" },
            { id: "beta_carotene_dietary", label: "mcg of beta-carotene (from food)" },
          ];
    case 1114:
      // Vitamin D is the one case where an unstated form is safe — D2 and D3
      // share the factor — so there is nothing to ask.
      return null;
    case 1109:
      return iu
        ? [
            { id: "alpha_tocopherol_natural", label: "Natural — d-alpha-tocopherol" },
            { id: "alpha_tocopherol_synthetic", label: "Synthetic — dl-alpha-tocopherol" },
          ]
        : null;
    case 1190:
      return iu
        ? null
        : [
            { id: "unspecified", label: "As printed (mcg DFE)" },
            { id: "folic_acid", label: "mcg of folic acid" },
            { id: "methylfolate", label: "mcg of L-5-methylfolate" },
            { id: "food_folate", label: "mcg of food folate" },
          ];
    default:
      return null;
  }
}

/** One line a supplement panel prints, kept as printed AND as counted. */
export interface SupplementNutrient {
  nutrient_id: number;
  position: number;
  /** Exactly as the pack prints it. Never read by the arithmetic. */
  label_amount: number;
  label_unit: LabelUnit;
  label_form: LabelForm;
  /**
   * What that figure is on this app's basis, per label serving.
   * `not_converted` when the pack's figure cannot be put on it at all.
   */
  kind: "measured" | "label_zero" | "below_loq" | "trace" | "not_converted";
  amount: number | null;
  upper: number | null;
  /** Why the conversion was refused, in a sentence. */
  convert_note: string | null;
}

export interface Supplement {
  id: string;
  name: string;
  brand: string | null;
  /** What one of these is called, singular: "tablet", "capsule", "gummy". */
  unit_noun: string;
  /** How many of those the panel's figures are per. */
  serving_units: number;
  serving_label: string | null;
  default_units: number | null;
  /**
   * Which labelling regime the pack was printed under. It decides what the
   * panel's SILENCE is worth, so it is asked rather than inferred.
   */
  regime: "us" | "other";
  /** The user's own claim that the panel lists everything in the product. */
  panel_complete: boolean;
  other_ingredients: string | null;
  barcode: string | null;
  photo_panel: string | null;
  photo_ingredients: string | null;
  nutrients: SupplementNutrient[];
}

/** One nutrient this app displays, as the reference database describes it. */
export interface NutrientMeta {
  id: number;
  short_name: string;
  magnitude: string;
  basis: string;
  tier: "core" | "extended";
  display_group: string;
  display_order: number;
}

export interface SupplementPanelRow {
  id: number;
  name: string;
  magnitude: string;
  group: string;
  tier: "core" | "extended";
  value: NutrientValue;
  provenance: "label" | "omitted";
  label_text: string | null;
  convert_note: string | null;
}

export interface SupplementDetail {
  supplement: Supplement;
  nutrients: SupplementPanelRow[];
  from_label: number;
  unconverted: number;
  omitted: number;
  omitted_bounded: number;
}

/* ── reading a panel from a photo ──────────────────────────────────────── */

/**
 * One value the camera thinks a panel prints. Deliberately the same shape as
 * `CustomNutrient`, so accepting a suggestion is handing the row straight to
 * the form — nothing is re-derived in between, and so nothing can drift there.
 *
 * It is not a `CustomNutrient` until the user says it is. See `Scan`.
 */
export type ScanReading = CustomNutrient;

/**
 * What one photograph of a nutrition panel yielded.
 *
 * Everything in here is a SUGGESTION, never a value. Text recognition reads
 * "1.5" as "15" often enough that a number off a camera is not something the
 * user has asserted, and one wrong figure is wrong again on every day the food
 * is logged. So a `Scan` cannot enter a food on its own: each reading is shown
 * as it was read, for the user to check against the photo, and becomes a
 * `CustomNutrient` only on their confirming that row.
 */
export interface Scan {
  /** Grams per serving, where the panel printed them. Suggested, not filled in. */
  serving_g: number | null;
  /** The pack's own wording of the serving, e.g. "1 package (57g)". */
  serving_label: string | null;
  readings: ScanReading[];
  /**
   * The label nutrients this photo yielded nothing for. Reported rather than
   * quietly dropped: "we did not read the fibre line" and "the pack is silent
   * on fibre" are different facts, and only the user, holding the pack, can
   * tell which one this was.
   */
  missing: number[];
  /** Lines of text the recogniser returned, panel or not. */
  lines: number;
  /** Rows that were read but belonged to no nutrient. */
  unmatched_rows: number;
  /**
   * Set when the photo does not look like a nutrition panel at all, with a
   * sentence to put in front of the user. Null when it parsed — including when
   * it parsed to no readings, which is a different failure and gets its own
   * wording rather than this one.
   */
  trouble: string | null;
}

/**
 * What one live preview frame looks like to the recogniser, for the indicator
 * that tells the user whether they are close enough.
 *
 * `panel_lines` counts only the lines that read like panel content, because a
 * keyboard and a paper bag on the same table also produce text — a frame full
 * of lines, none of them a panel, is precisely the case worth saying out loud.
 */
export interface Probe {
  lines: number;
  panel_lines: number;
  /** True when the frame holds enough of a panel to be worth capturing. */
  ok: boolean;
}

/* ── reading the rest of a pack from a photo ───────────────────────────── */

/**
 * What one photograph of an ingredient statement yielded.
 *
 * A suggestion, on the same terms as `Scan`. Recognition mangles a word as
 * readily as a digit, and an ingredient list is the thing people read when they
 * are avoiding something — so this is offered beside the field for the user to
 * check against the photo, and never written over text they typed themselves.
 */
export interface IngredientsScan {
  /**
   * The list as the pack prints it, wrapped lines rejoined. Commas, brackets
   * and capitalisation are left exactly as read: this is shown back as what the
   * pack says, not as this app's own prose. Empty when no list was found.
   */
  text: string;
  /**
   * A "CONTAINS: WHEAT, MILK" statement, kept apart from the list. It is a
   * different assertion — the manufacturer's own allergen declaration rather
   * than an item in the recipe — so it is offered as its own line instead of
   * being merged into the commas.
   */
  contains: string | null;
  /** Lines of text the recogniser returned, ingredient list or not. */
  lines: number;
  /**
   * Set when no ingredients row was found at all, with a sentence to put in
   * front of the user. Null when a list was read.
   */
  trouble: string | null;
}

/**
 * What one frame holding a barcode yielded.
 *
 * A barcode is the one thing on a pack a device can check its own reading of:
 * the GS1 numeric symbologies — EAN-13, EAN-8, UPC-A, UPC-E — end in a digit
 * computed from the ones before it. `trusted` is that arithmetic, not a
 * confidence score.
 *
 * Untrusted does not mean "probably right". A code that fails its own check
 * digit was misread, and a misread code is a different product — so an
 * untrusted payload is shown as one that did not verify and is never offered as
 * if it were good; the user retakes it or types it. Symbologies carrying no
 * check digit (Code 128, QR) come back trusted because nothing can be verified
 * either way — `checkDigitVerified` is what tells the two apart, and a screen
 * wording an assurance to the user reads that and never `trusted`.
 *
 * The frame is not stored. Once the digits are read, a photograph of a barcode
 * is worth nothing and would only clutter the photo store.
 */
export interface BarcodeScan {
  /** The decoded payload. Null when the frame held no barcode. */
  payload: string | null;
  /**
   * The symbology in the spelling a person reads: "EAN-13", "Code 128", "QR".
   * The backend has already turned the recogniser's own constant into this, so
   * it is for showing and never for deciding.
   */
  symbology: string | null;
  /**
   * Whether anything contradicts the reading: a GS1 check digit that computes,
   * or a symbology that carries none to test. Not an assurance on its own.
   */
  trusted: boolean;
  /**
   * Whether a check digit was actually computed and matched — the only field
   * that says arithmetic ran. False for Code 128 and QR, which carry none.
   */
  check_digit_verified: boolean;
  /**
   * Why there is nothing to offer, or why what was found did not verify, in a
   * sentence. Null when a trusted payload came back.
   */
  trouble: string | null;
}

/**
 * One line the camera thinks a Supplement Facts panel prints, in the three
 * fields that keep the figure auditable against the pack.
 *
 * There is deliberately no converted amount here. Putting a number nobody has
 * checked onto this app's basis would carry a misread digit into the day's
 * arithmetic before anyone had a chance to look at it, so a reading becomes a
 * `SupplementNutrient` only when the user confirms the row — and the conversion
 * happens then, through `convertLabelFigure`, exactly as it does for a figure
 * typed by hand.
 */
export interface SupplementScanReading {
  nutrient_id: number;
  /**
   * Exactly as printed. Where a pack declares the same figure twice — "25 mcg
   * (1,000 IU)" — this is the non-IU one: an IU figure means nothing without a
   * named compound, and the pack usually does not name it.
   */
  label_amount: number;
  /**
   * The printed unit text verbatim: "mcg", but also "mcg DFE", "mg NE",
   * "mg alpha-tocopherol". Not a `LabelUnit`, because the compound units a
   * panel prints carry a basis as well as a magnitude, and keeping the whole
   * token is what lets a stored figure be checked back against the pack. Fold
   * the leading magnitude to a `LabelUnit` before storing the row.
   */
  label_unit: string;
  /**
   * What a parenthetical named — "(as cholecalciferol)", "(as magnesium
   * oxide)".
   *
   * The EMPTY STRING when the pack does not say — not `"unspecified"`. A scan
   * reports what it read, and "the bottle named no form" is a different fact
   * from "the user asserted no form matters"; only the latter is the stored
   * `unspecified`. Test for `""`, never for `"unspecified"`, or the check
   * silently never matches. An unread form is a real state and not a gap to be
   * filled in: a form guessed from the nutrient would change the arithmetic on
   * no evidence at all.
   */
  label_form: LabelForm | "";
}

/**
 * What one photograph of a Supplement Facts panel yielded.
 *
 * Suggestions throughout, for the reasons `Scan` gives. Two of the fields this
 * app keeps are absent here and can never appear: `regime`, because nothing
 * printed on a bottle says which market it was printed for, and
 * `panel_complete`, because no photograph can assert that a panel lists
 * everything in the product. Both are the user's own claim, and the day's
 * arithmetic reads them — a scan that quietly set either would turn that claim
 * into a machine guess.
 */
export interface SupplementScan {
  /** How many units the panel's figures are per, where it printed a serving. */
  serving_units: number | null;
  /** The serving row's own wording, e.g. "Serving Size 2 tablets". */
  serving_label: string | null;
  /** What one of them is called, singular: "tablet", "capsule", "gummy". */
  unit_noun: string | null;
  readings: SupplementScanReading[];
  /** Rows that were read but named no nutrient this app carries. */
  unmatched_rows: number;
  /** Lines of text the recogniser returned, panel or not. */
  lines: number;
  /**
   * Set when the photo does not look like a Supplement Facts panel at all, with
   * a sentence to put in front of the user. Null when it parsed — including
   * when it parsed to no readings, which is a different failure and gets its
   * own wording rather than this one.
   */
  trouble: string | null;
}

/* ── spreadsheet import ───────────────────────────────────────────────── */

/** One nutrient value a spreadsheet row gave. A column with no cell for a row
 * contributes no entry here — that's how "blank cell" and "typed 0" stay two
 * different facts all the way to the database. */
export interface ImportNutrientInput {
  nutrient_id: number;
  amount: number;
}

/** One already-parsed, already-clean row, ready for the backend to validate
 * and write. Everything spreadsheet-shaped — headers, units, dates — has been
 * resolved by `src/lib/spreadsheet.ts` before this shape exists; the backend
 * still treats every field as untrusted, same as any other file the user picked. */
export interface ImportRowInput {
  logged_on: string;
  meal: Meal;
  description: string;
  nutrients: ImportNutrientInput[];
  /** The row in the user's own file, 1-based with the header as row 1. Sent so
   * a failure can name the row they would actually find if they opened it —
   * rows dropped during parsing make this batch's own indices meaningless. */
  source_row: number;
}

/** Why one row of the batch did not become a log entry. `row` is 1-based,
 * matching the row number a person would see if they opened the file themselves. */
export interface ImportRowFailure {
  row: number;
  reason: string;
}

export interface ImportSummary {
  imported: number;
  failed: ImportRowFailure[];
}

/* ── exporting the log ─────────────────────────────────────────────────── */

/** One nutrient of one exported entry, in that nutrient's own unit and already
 * rounded by the backend. Never round, scale or convert one here. */
export interface ExportNutrient {
  nutrient_id: number;
  amount: number;
}

/** One food entry as one row of the sheet the importer reads back.
 *
 * `meal` is a plain string and not nullable: only water has no sitting, and
 * water is not on this sheet. */
export interface ExportLogRow {
  logged_on: string;
  meal: string;
  description: string;
  /** Only the nutrients this entry is exactly known for. A nutrient missing
   * from here becomes a BLANK cell, which the parser reads as "not tracked".
   * Never write `?? 0` against one of these, and never write a 0 for an
   * absence — a spreadsheet will sum whatever is in the cell. */
  nutrients: ExportNutrient[];
}

/** One dose, on a sheet the importer never looks at. A supplement read back as
 * a 100 g food would be nonsense: a tablet's contents are not a function of
 * its weight. */
export interface ExportDoseRow {
  logged_on: string;
  meal: string;
  description: string;
  /** Counted in the supplement's own unit noun, never a mass. */
  units: number;
  nutrients: ExportNutrient[];
}

/** One bottle finished, on a sheet the importer never looks at either. */
export interface ExportWaterRow {
  logged_on: string;
  description: string;
  ml: number;
  /** False when the millilitres came from the density of water rather than from
   * this bottle's own two weighings. */
  measured: boolean;
}

/** Everything one export covers, decided by the backend out of what each entry
 * was frozen with. Nothing here was recomputed from today's reference data. */
export interface ExportLog {
  from: string;
  to: string;
  /** Days in the period that have anything logged at all. */
  days: number;
  rows: ExportLogRow[];
  doses: ExportDoseRow[];
  water: ExportWaterRow[];
  /** (entry, nutrient) pairs left blank because the entry's frozen value was
   * not exactly known. Stated on the screen so the gaps in the file are known
   * before it is written. */
  blanks: number;
  /** Food entries carrying no exactly-known nutrient at all. They are still
   * written; on the way back in the importer reports each of them and writes
   * nothing. */
  rows_without_values: number;
  /** Live entries with no frozen nutrition, which the export leaves out rather
   * than valuing against today's data. Normally zero. */
  unexportable: number;
}

/* ── correcting what a day recorded ────────────────────────────────────── */

/**
 * How an entry's stored nutrition came to be what it is.
 *
 * `logged` is the only one that is a record of what was actually believed at
 * the time. `backfilled` was reconstructed afterwards for an entry written
 * before nutrition was stored with it, and `corrected` means the user changed
 * it on purpose. The difference is shown rather than smoothed over: a day's
 * numbers are worth exactly as much as their provenance.
 */
export type SnapshotBasis = "logged" | "backfilled" | "corrected";

/** One recorded value, on the basis its part is measured in. */
export interface EntryValueView {
  nutrient_id: number;
  value: NutrientValue;
}

/**
 * One part of an entry: a whole food, or one ingredient of a dish.
 *
 * Exactly one of `grams` and `servings` is set, and it decides what the values
 * are per — 100 g for anything weighed, one label serving for a dose.
 */
export interface EntryPartView {
  ordinal: number;
  description: string;
  fdc_id: number | null;
  grams: number | null;
  servings: number | null;
  has_data: boolean;
  values: EntryValueView[];
}

/** What a day already recorded for one entry, and where it came from. */
export interface EntrySnapshotView {
  entry_id: string;
  description: string;
  basis: SnapshotBasis;
  /** When the entry was first valued. A correction never rewrites this. */
  frozen_at: string;
  corrected_at: string | null;
  grams: number | null;
  units: number | null;
  /** A supplement's own word for one of itself — "tablet", "gummy". */
  unit_noun: string | null;
  recipe_name: string | null;
  parts: EntryPartView[];
}

/**
 * What a person may assert when correcting a value.
 *
 * `measured_zero` and `assumed_zero` are absent on purpose: both mean a
 * laboratory looked and found nothing, which is a claim about someone else's
 * work. `unknown` removes the value, which says nobody knew it — a different
 * statement from zero, and one the day reports differently.
 */
export type CorrectableKind = "measured" | "label_zero" | "below_loq" | "trace" | "unknown";

// ---------------------------------------------------------------------------
// Household
// ---------------------------------------------------------------------------

/** This installation, as the rest of the household sees it. */
export interface ThisDevice {
  device_id: string;
  /** The user's own word for it. Offered as "Mac" or "Phone" and meant to be changed. */
  name: string;
}

/** Another device in the household, and when it was last heard from. */
export interface Peer {
  device_id: string;
  name: string;
  paired_at: string;
  /**
   * `null` for a device paired but never yet synced with. Distinct from a
   * long-ago instant, which says the pairing works and the phone has been in a
   * bag — and the screen says which.
   */
  last_seen_at: string | null;
}

/**
 * How the last sync with one device went, in words.
 *
 * `ok: false` is as much a result as `ok: true` and is rendered as plainly.
 * A sync that could not reach the other phone has to say so: a silent tick
 * over a stale fridge is the same failure as a nutrient bar drawn at zero
 * because nobody measured it.
 */
export interface SyncOutcome {
  at: string;
  peer_name: string;
  ok: boolean;
  detail: string;
}

/**
 * How much of this device's kitchen the household would see.
 *
 * Real counts of your own rows, not a list of feature names: "your recipes are
 * shared" is a promise, "12 recipes" is this kitchen. There is deliberately no
 * counterpart for the private side — counting what you ate here would be the
 * first step towards publishing it.
 */
export interface SharedCounts {
  pots: number;
  recipes: number;
  foods: number;
  supplements: number;
  vessels_and_bottles: number;
}

export interface HouseholdView {
  device: ThisDevice;
  peers: Peer[];
  shared: SharedCounts;
  /**
   * How the most recent run went, one entry per device it tried — not one
   * entry for the run.
   *
   * A single summary line would let a success with one device stand in for a
   * failure with another, and the failure is the half worth showing: it is the
   * one that leaves this fridge disagreeing with that one. Empty until a sync
   * has been attempted.
   */
  last: SyncOutcome[];
  /** Kitchen and library rows this device has not yet handed to every peer. */
  queued: number;
}

/**
 * An offer to pair, shown as a QR code on the device that is listening.
 *
 * The payload carries this device's address and public key, so the phone that
 * scans it needs no discovery to find the Mac — which is why the first release
 * ships no mDNS at all.
 */
export interface PairingOffer {
  payload: string;
  expires_at: string;
}

/**
 * Where a pairing attempt has got to.
 *
 * `confirming` is the one that matters. Six digits derived from the completed
 * handshake are shown on BOTH screens, and the user says whether they match
 * before either device writes the other down. Someone who photographed the QR
 * from across the room gets a different handshake, so their digits differ —
 * which is the only thing standing between a shoulder-surfer and a place in
 * the household.
 */
export type PairingState =
  | { stage: "waiting" }
  | { stage: "confirming"; peer_name: string; digits: string }
  | { stage: "paired"; peer_name: string }
  | { stage: "expired" }
  | { stage: "failed"; detail: string };

/* ── the encrypted log, and the sealed copy ─────────────────────────────── */

/**
 * What the phone's own keystore turned out to be.
 *
 * Reported rather than assumed, and the Backup screen prints it verbatim: on
 * one phone the "hardware-backed" key really is in secure hardware and on
 * another the same call quietly gives you a software key, and the screen must
 * not claim the first when it got the second.
 */
export interface KeystoreState {
  available: boolean;
  hardware: "strongbox" | "tee" | "software" | "unknown";
  /** Why it is not available, when it is not. Shown unchanged. */
  note: string | null;
}

/** Everything the Backup screen renders, and nothing it has to work out. */
export interface BackupStatus {
  /**
   * False off Android. Every other field is then meaningless, and the screen
   * explains the platform rather than reading them.
   */
  supported: boolean;
  /**
   * Whether the log on this phone is encrypted right now. Asked of the file
   * itself, never of a setting — see `vault.rs`.
   */
  encrypted: boolean;
  /**
   * Encrypted, and this session has no key for it. Nothing else on the screen
   * matters while this is true.
   */
  locked: boolean;
  /** Why, in a sentence. Shown unchanged; it was written to be shown. */
  locked_note: string | null;
  passphrase_set: boolean;
  keystore: KeystoreState;
  /**
   * Whether a keystore copy of the key is actually on disk. Distinct from
   * `keystore.available` — the hardware can be fine and the file absent.
   */
  keystore_holds_key: boolean;
  /** null until a copy has been sealed. Never write `?? ""`. */
  sealed_at: string | null;
  sealed_bytes: number | null;
  plain_bytes: number | null;
  /** 26,214,400. What Google's backup service will carry for one app, named. */
  quota_bytes: number;
  /** Over it, Android stops carrying this app and tells nobody. */
  over_quota: boolean;
  /** The log has moved on since the sealed copy was written. */
  stale: boolean;
  auto_reseal: boolean;
  /**
   * A sealed copy is here and nothing is logged — which is what a fresh install
   * looks like once Google has delivered the backup.
   */
  restore_available: boolean;
  logged_entries: number;
  /** Where the one file that may leave this phone lives. */
  sealed_dir: string | null;
  /** Where the log a restore replaced went, while its copy is still there. */
  superseded_path: string | null;
}

/** What a restore did, in the terms the screen reports it. */
export interface RestoreOutcome {
  entries: number;
  sealed_at: string;
  /**
   * The database that was replaced. Renamed, not deleted, and named here so the
   * screen can say where it went.
   */
  superseded_path: string;
  /** Whether an earlier restore's kept copy had to make room for this one. */
  replaced_earlier_superseded: boolean;
}
