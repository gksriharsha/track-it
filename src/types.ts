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
   * What a reference food entry is called on screen: the short name search
   * gives it, "Mungo beans, boiled", while `description` keeps the full USDA
   * wording it was logged with. Worked out each time the day is read, and
   * only while that wording is still the dataset's, so a past day never
   * changes under it. Null for the user's own foods, dishes, pots,
   * supplements and water, which keep their own names. Show it through
   * `displayName`.
   */
  name?: string | null;
  /**
   * What was eaten, in grams. Null for a supplement, which is counted rather
   * than weighed. Never write `?? 0`: a dose rendered as "0 g" is the same
   * class of lie as a nutrient rendered as 0.
   */
  grams: number | null;
  /** The dose taken, counted in the supplement's own unit noun. */
  units: number | null;
  /**
   * How much was had in millilitres, for one of the user's own foods whose pack
   * gives its figures per ml — a can, a carton. `grams` is set beside it as the
   * mass the sums ran on, but this is what was measured, so it is the amount
   * the entry is shown as. Null for everything weighed or counted, and for
   * water, whose volume comes from its bottle (`water`).
   */
  ml: number | null;
  /**
   * How many pieces were had, for one of the user's own foods whose pack
   * counts its serving — "3 figs" — and what a piece was called then. `grams`
   * is set beside them as their share of the pack's serving. Null together for
   * everything weighed, measured or dosed.
   */
  pieces: number | null;
  piece_noun: string | null;
  /** What the scale read with the vessels on it, or null if weighed directly. */
  gross_g: number | null;
  /** What came off. Null exactly when `gross_g` is. */
  tare_g: number | null;
  /**
   * The vessel names, joined. Denormalised for the same reason `description` is:
   * deleting a vessel must not change what a past day says it weighed.
   *
   * Also the one note a water entry logged without a scale carries —
   * `WHOLE_BOTTLE_NOTE` — with `gross_g` and `tare_g` null, because no reading
   * was taken. Worth showing as a marker on the row: it is how that amount
   * was arrived at.
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

/* ── kitchen containers ───────────────────────────────────────────────── */

/** A food, as a container and an ingredient line both name it. Exactly one is set. */
export interface FoodRef {
  fdc_id: number | null;
  custom_food_id: string | null;
}

export type ContainerEventKind = "poured_in" | "reading" | "emptied";

/** How a container is read day to day: on a scale in grams, or by the marks on its side in ml. */
export type ReadBy = "scale" | "marks";

/** The units a person can type for a container. The backend stores g or ml. */
export type ContainerUnit = "g" | "kg" | "ml" | "l" | "cup";

/**
 * Something that happened to a container, as stored. `unit` is `g` or `ml`:
 * a reading in g is on the scale with the container included; in ml it is
 * off the marks, the food alone. A pour is the pack's own amount. Amount and
 * unit are both null only for emptied-to-the-last-drop.
 */
export interface ContainerEvent {
  id: string;
  kind: ContainerEventKind;
  happened_on: string;
  happened_at: string;
  amount: number | null;
  unit: "g" | "ml" | null;
  /** On a reading taken after an accident: the span ending here is discarded. */
  spilled: boolean;
  note: string | null;
}

/**
 * Why a span between readings does or does not count toward the correction.
 * `awaiting_tare` and `awaiting_density` become `counted` by themselves once
 * the container's empty weight, or its food's weight per ml, is entered;
 * `inconsistent` is a reading of more than everything known to be in it.
 */
export type StretchStatus =
  | "counted"
  | "spilled"
  | "awaiting_tare"
  | "awaiting_density"
  | "inconsistent"
  | "open";

export interface ContainerStretch {
  from_on: string;
  /** Null while the span is still open. */
  to_on: string | null;
  status: StretchStatus;
  /** Grams that left the container, when the arithmetic could be done. */
  used_g: number | null;
  /** The same in ml, exactly between two readings of the marks, else through the weight per ml. */
  used_ml: number | null;
  /** Grams thrown out with it when emptied, if known. */
  discarded_g: number | null;
  days: number | null;
}

/** A food's weight per ml and where the figure came from. */
export interface Density {
  g_per_ml: number;
  source: "label" | "reference" | "weighed";
  /** The source in words: "USDA: 1 tbsp is 13.6 g". */
  note: string;
}

/** One physical container in the kitchen: the oil dispenser, the salt jar. */
export interface Container {
  id: string;
  name: string;
  food: FoodRef;
  description: string;
  read_by: ReadBy;
  /** Weighed empty, once its owner gets round to it. Optional by design. */
  empty_g: number | null;
  capacity_ml: number | null;
  /** The owner's measuring cup; 240 ml unless they said otherwise. */
  cup_ml: number;
  density: Density | null;
  events: ContainerEvent[];
  stretches: ContainerStretch[];
  /** Used up and not refilled since. */
  finished: boolean;
}

/** What the add and edit screen sends. */
export interface ContainerInput {
  name: string;
  food: FoodRef;
  description: string;
  read_by: ReadBy;
  empty_g: number | null;
  capacity_ml: number | null;
  cup_ml: number | null;
}

/**
 * How far written to-taste amounts run from what the containers say.
 * `factor` is exactly 1 — the written amount — while `stretches` is 0.
 */
export interface TasteFactor {
  factor: number;
  stretches: number;
  /** Grams used by feel over those spans, after measured uses came off. */
  by_feel_g: number;
  /** What the to-taste lines in those spans were written as. */
  written_g: number;
}

export interface FoodTasteFactor {
  food: FoodRef;
  description: string;
  factor: TasteFactor;
  /** The median of what this person writes for the food by feel, if anything. */
  typical_written_g: number | null;
}

/**
 * A food's kitchen use over a period beside what cooks and plates recorded,
 * both at kitchen level (the pot, not a portion). For aggregate views only.
 * `days` is 0 when no counted span falls in the period, and every rate is null.
 */
export interface FoodUsage {
  food: FoodRef;
  description: string;
  days: number;
  used_per_day_g: number | null;
  used_per_day_ml: number | null;
  recorded_per_day_g: number | null;
}

/** A container's last reading, or the pack poured in when there is none yet. */
export interface LastFigure {
  kind: "reading" | "poured_in";
  amount: number;
  unit: "g" | "ml";
  on: string;
}

/** Why nothing about a container or a food counts yet. */
export type PantryWaiting = "tare" | "density" | "reading" | "to_taste";

export interface ContainerSummary {
  id: string;
  name: string;
  read_by: ReadBy;
  cup_ml: number;
  last: LastFigure | null;
  waiting: "tare" | "density" | null;
}

/** One food in the pantry: what its containers have shown, then the containers. */
export interface PantryFood {
  food: FoodRef;
  description: string;
  factor: TasteFactor;
  typical_written_g: number | null;
  usage: FoodUsage;
  waiting: PantryWaiting | null;
  containers: ContainerSummary[];
}

export interface Pantry {
  foods: PantryFood[];
  /** Used up and not refilled, kept so their history can be opened. */
  finished: ContainerSummary[];
}

/** A volume of water, and where the conversion from mass came from. */
export type Volume =
  | { kind: "measured"; ml: number }
  | { kind: "assumed"; ml: number };

/**
 * The `tare_note` of a water entry logged as a whole bottle without a scale —
 * `store::WHOLE_BOTTLE_NOTE` in Rust, which writes it. Matched against rather
 * than inferred from a null `gross_g`, because an amount corrected by hand
 * carries no reading either, and that is a different fact. A Rust test reads
 * this line and fails if the two sentences ever differ by a character.
 */
export const WHOLE_BOTTLE_NOTE = "whole bottle, not weighed";

/**
 * The same for part of a bottle, judged by eye on the water sheet's slider —
 * `store::PART_BOTTLE_NOTE`, held to this line by the same Rust test.
 */
export const PART_BOTTLE_NOTE = "part of a bottle, not weighed";

/** Litres past a litre, millilitres below — how people actually say it. */
export function describeVolume(ml: number): string {
  return ml >= 1000 ? `${(ml / 1000).toFixed(1)} L` : `${Math.round(ml)} ml`;
}

/** One resolved component of an entry: the food, or one recipe ingredient. */
export interface Component {
  description: string;
  /** A reference ingredient's short name, as on `LogEntry`; null for anything else. */
  name?: string | null;
  fdc_id: number | null;
  /** Null for a supplement, which contributed a dose and no mass. */
  grams: number | null;
  /** False when no composition data exists — show the gap, don't hide the row. */
  has_data: boolean;
}

/**
 * What one entry is made of, and what it came to in energy.
 *
 * Every live entry on a day has exactly one, a plain food included (its
 * `components` are empty), so a row can look its own up by `entry_id`.
 */
export interface EntryBreakdown {
  entry_id: string;
  components: Component[];
  recipe_name: string | null;
  recipe_yield_g: number | null;
  recipe_servings: number | null;
  /**
   * For a portion of a pot, whether `recipe_yield_g` was the pot weighed —
   * as it stood when the portion was taken. False means the portion was
   * divided by the recipe's estimate, which its row says ("pot not
   * weighed"). Null for a recipe, which has no pot, and for an older portion
   * whose pot could not be matched back up: not recorded, so not claimed.
   */
  recipe_yield_weighed: boolean | null;
  /**
   * How the values came to be what they are: frozen as the entry was logged,
   * worked out later for an entry logged before freezing existed, or changed
   * on purpose. Only "logged" is a record of what was believed at the time,
   * so the other two are said on the row and on the sheet.
   */
  basis: SnapshotBasis;
  frozen_at: string;
  corrected_at: string | null;
  /**
   * This entry's own energy, in kcal, summed exactly the way the day's is —
   * so it reads "228", "≥ 112" or "—" by the same rule, and the rows of a day
   * add up to the day. Read it through the same three states as any total:
   * `coverage` of 0 is unmeasured ("—"), never 0 kcal.
   *
   * Null for what is not food, which the day's energy leaves out too: water,
   * and a supplement whose panel states neither energy nor protein,
   * carbohydrate or fat — almost all of them. A tablet is not a zero-calorie
   * food, so it gets no figure at all. A softgel whose label prints its
   * calories keeps them, with `coverage` null (a dose has no mass) and
   * `from_supplements` set.
   */
  energy: DailyTotal | null;
}

/**
 * One sitting's energy, summed from its entries' own contributions rather
 * than from their rounded rows — so its coverage is weighted by mass across
 * the whole meal. Never water, which belongs to no sitting.
 */
export interface MealEnergy {
  meal: Meal;
  energy: DailyTotal;
}

export interface DayView {
  logged_on: string;
  entries: LogEntry[];
  breakdowns: EntryBreakdown[];
  /**
   * Each sitting that holds something with energy to count, in the order the
   * day is eaten. Absent for a sitting holding only a vitamin, and for one
   * with nothing in it — look a meal up by name, and treat a miss as "no
   * subtotal", not as zero.
   */
  meals: MealEnergy[];
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
  /**
   * What the row is called on screen: the family name ("Mungo beans") for a
   * food in several forms, the tidied name of a single food ("Spinach,
   * baby"), null for a custom food. `description` stays the full USDA name,
   * which is what is logged. Optional so the fixture and older shapes still
   * read: missing is null (`displayName`).
   */
  name?: string | null;
  /**
   * The food's forms in form order — uncooked first, then cooked, then fat
   * stated, canned, frozen, other; a salted form right after its unsalted
   * twin. Empty unless the food comes in two or more, and then this entry IS
   * the food: search returns one entry per food, `fdc_id` is the form the
   * amount panel opens on, and the form is chosen there. Missing is empty.
   */
  forms?: FoodForm[];
}

/** One form of a food that comes in several: one USDA row. */
export interface FoodForm {
  fdc_id: number;
  /** The words that tell this form from its siblings, lower-case: "raw", "boiled, salted". */
  label: string;
  /** The full USDA description, as logged. */
  description: string;
}

/**
 * A reference food's forms under the name they share, for a panel reached
 * without a search hit to carry them (`food_forms`). `forms` is empty when the
 * food comes in only one.
 */
export interface FoodFamily {
  name: string;
  forms: FoodForm[];
}

/**
 * What 100 g of a food, one of your own foods, a recipe or a pot comes to —
 * its energy and the three nutrients energy is made of — worked out the way
 * a logged entry's own energy is (`per_100g` in Rust). A portion is this
 * scaled by its grams (`atGrams`): the bounds move with the mass and the
 * coverage does not.
 */
export interface Per100g {
  energy: DailyTotal;
  protein: DailyTotal;
  carbs: DailyTotal;
  fat: DailyTotal;
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
  /**
   * A reference food's short name, as search gives it ("Mungo beans,
   * boiled"): what the chip says. `description` is still what a tap logs.
   * Null for one of the user's own foods.
   */
  name?: string | null;
  brand: string | null;
  /**
   * The last net weight, to open the portion step on. Never null, and never
   * write `?? 0` against it — see the Rust doc: a supplement is the only kind
   * that may omit a weight and no supplement reaches this list.
   */
  last_grams: number;
  /**
   * The last volume, where that helping was measured in ml. A repeat logs
   * this rather than `last_grams`, so it comes back as the volume it was.
   */
  last_ml: number | null;
  /** The last count, where that helping was counted in pieces: a repeat logs it. */
  last_pieces: number | null;
  /** The last amount already written out, e.g. "150 g", "330 ml" or "3 figs". */
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
  /**
   * The percentage of the Daily Value the pack printed, when it printed one
   * instead of an amount ("Vitamin A 10%"). The backend derives `amount` or
   * `upper` from it against the food's `dv_basis` when the food is saved,
   * replacing whatever was sent. Absent or null for a line typed as an amount.
   */
  printed_pct?: number | null;
  /** The compound an older panel's percentage needs (vitamin A, E, folate). */
  label_form?: LabelForm | null;
}

/**
 * Which Daily Values a pack's percentages are of: a current panel's (2020
 * onward) or an older panel's 1993 reference amounts, under which milk's
 * "Calcium 30%" is 300 mg rather than 390 mg.
 */
export type DvBasis = "current" | "older";

/** What 1% of a Daily Value is under one basis. See `label_percent_table`. */
export interface PercentBasis {
  /** What the panel's 100% was, as printed: 5,000 IU, 1,000 mg. */
  reference_amount: number;
  reference_unit: string;
  /** 1% in the unit the app stores, when no compound has to be named. */
  per_percent: number | null;
  /** When one does: 1% under each compound it may be. */
  forms: { form: LabelForm; per_percent: number }[];
}

/** A nutrient a pack can print as "% Daily Value". */
export interface PercentLine {
  nutrient_id: number;
  name: string;
  /** The magnitude the app stores it in: "g", "mg", "ug". */
  unit: string;
  current: PercentBasis | null;
  older: PercentBasis | null;
}

/**
 * What a pack's serving is measured in: a weight for nearly every pack, a
 * volume for one that gives its figures per ml — a can, a carton — which is
 * then logged in millilitres too.
 */
export type ServingUnit = "g" | "ml";

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
  /**
   * What the figures are per, as a mass. For a pack whose serving is a volume
   * this is `serving_ml` counted at a gram a millilitre — set by the backend,
   * whatever is sent.
   */
  serving_g: number;
  /**
   * The serving as a volume, for a pack whose figures are per ml; null for one
   * whose serving is a weight. Where it is set the food is logged in ml.
   */
  serving_ml: number | null;
  /**
   * The serving counted in pieces, where the pack counts it — "2 figs (57 g)"
   * is 2 — and what one piece is called, singular: "fig". Null together for a
   * pack that does not count its serving; where set, the food can be logged by
   * the piece, each one the pack's own share of its serving.
   */
  serving_pieces: number | null;
  piece_noun: string | null;
  /** The pack's own wording, e.g. "1 bar (43 g)". */
  serving_label: string | null;
  ingredients: string | null;
  barcode: string | null;
  /** Base filename in the app's photo directory — read it via `readFoodPhoto`. */
  photo_label: string | null;
  photo_ingredients: string | null;
  nutrients: CustomNutrient[];
  /** Which Daily Values its percentages are of. Missing reads as "current". */
  dv_basis?: DvBasis;
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
  /**
   * A reference food. Null when this line is one of your own foods instead, or
   * when it has no composition data at all.
   */
  fdc_id: number | null;
  /**
   * One of the user's own transcribed foods. Never set alongside `fdc_id`.
   *
   * Both exist because a generic entry is often not the thing in the kitchen:
   * USDA has forty-two rows matching "tofu" and none of them is the block you
   * actually buy. A pack you transcribed yourself is better data about your own
   * dinner than any of them.
   */
  custom_food_id: string | null;
  description: string;
  /**
   * Weighed before it goes in — the one weight an ingredient has.
   *
   * There is deliberately no cooked weight beside it. A person can put each
   * ingredient on a scale before it goes in the pot; nobody can lift the rajma
   * back out of a finished curry and weigh it apart from the onions, so a
   * per-ingredient cooked figure could only ever be guessed. The raw-to-cooked
   * change is handled instead by `Recipe.yield_g` — one weighing of one
   * finished dish — because nutrient mass is conserved through cooking while
   * concentration is not. See D22.
   */
  raw_g: number;
  /**
   * Whether the dish is still the dish without this line. A note to the person
   * at the stove — it moves no weight and enters no arithmetic. Actually
   * leaving the line out is recorded on the cook, never here: a recipe that
   * omits its own ingredient is a different recipe.
   */
  optional: boolean;
  /**
   * Added by feel: salt, oil, ketchup. `raw_g` is then the amount the person
   * wrote, and a pot gets that times the correction their kitchen containers
   * give for the food (`TasteFactor`). Missing on drafts saved before this
   * existed, which reads as false.
   */
  to_taste?: boolean;
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
   * What the dish comes out at, cooked, when made at the weights below. The
   * user's own single weighing of a finished pot — NOT the sum of the
   * ingredients, which are raw and add to a quite different number.
   *
   * This is the divisor. A portion is `grams / yield_g` of the dish, and that
   * fraction of every ingredient's raw weight. Not a claim about how much you
   * will make, which is why a cook carries a scale of its own.
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
  /** One of your own foods. Never set alongside `fdc_id`. */
  custom_food_id: string | null;
  description: string;
  /**
   * The raw weight the recipe called for at this cook's scale, frozen when the
   * cook was opened. The dial's centre, and what "what moved" is measured
   * against — which is why it survives a later rewrite of the recipe.
   */
  planned_g: number;
  /**
   * What went in, weighed raw — the one weight an ingredient has, here as on a
   * recipe. Zero means deliberately left out, which is a different fact from
   * the line never having been in the dish — the one place in this app where a
   * zero weight is a measurement rather than a missing one.
   */
  raw_g: number;
  /** The line this replaced, when it was a substitution. */
  substituted_for: string | null;
  /**
   * Added by feel. `planned_g` is the written amount and `raw_g` is it times
   * `taste_factor`. The backend values the line when the pot is saved: send
   * `taste_factor: null` on a new line and it is filled in from the
   * containers; send it back unchanged on a re-save and the line keeps the
   * amount it was valued at.
   */
  to_taste?: boolean;
  taste_factor?: number | null;
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
  /**
   * What the recipe says this dish comes out at, times this pot's scale, frozen
   * when the pot was opened. The divisor until the pot goes on a scale.
   */
  expected_yield_g: number;
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
   * expected yield otherwise. Never the summed line weights — those are raw,
   * and a pot of rajma weighs roughly three times its dry beans. Computed in
   * the backend so both sides use one definition — never recompute it here.
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
  /** Carried from the draft, so editing the recipe cannot re-portion a pot. */
  expectedYieldG: number;
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
  /** Millilitres per serving, where the panel printed them: "1 can (330 mL)". */
  serving_ml: number | null;
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

/** One activity session, on a sheet of its own (D26). */
export interface ExportActivityRow {
  logged_on: string;
  kind: string;
  label: string | null;
  minutes: number | null;
  effort: string | null;
  /** How many sets a strength session holds; they are on the sets sheet. */
  sets: number;
  note: string | null;
}

/** One set of a strength session, under the name it was logged with. */
export interface ExportSetRow {
  logged_on: string;
  exercise: string;
  /** 1 for the first set of this lift in its session. */
  set: number;
  reps: number | null;
  load_kg: number | null;
  seconds: number | null;
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
  activities: ExportActivityRow[];
  sets: ExportSetRow[];
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
  /** A reference part's short name, as on `Component`. */
  name?: string | null;
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
  /** Set where the amount was measured in ml, which a correction then changes. */
  ml: number | null;
  /** Set where the amount was counted in pieces, which a correction then changes. */
  pieces: number | null;
  piece_noun: string | null;
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
  /**
   * The code itself, as SVG markup ready to drop into the page.
   *
   * Drawn in Rust, beside the key material, because the payload is hashed into
   * the handshake as EXACT bytes on both sides — assembling it a second time
   * here is one space away from a pairing that fails for no visible reason.
   * Trusted markup: it comes from this app's own backend and holds nothing but
   * a viewBox, a rect and a path.
   */
  svg: string;
}

/**
 * What one camera frame held, when looking for a pairing code.
 *
 * `payload` is `null` while the camera is still being pointed, which is the
 * ordinary case rather than a failure — the same distinction `Probe` draws.
 * Never write `?? ""`.
 */
export interface PairCodeScan {
  payload: string | null;
  /** Why nothing came back, in the user's terms. `null` when something did. */
  trouble: string | null;
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

/**
 * Where a tap on an Android home-screen widget asked the app to land.
 *
 * Read once from `no_backup/widget/landing.json`, which `MainActivity` wrote
 * and Rust deleted on the way out — the file is the whole mechanism, so a tap
 * is honoured exactly once however many times the Activity is rebuilt.
 *
 * Both fields have already been checked twice, in Kotlin against its own
 * whitelist and in Rust against `WIDGET_ROUTES` and the pick grammar, and they
 * are checked a third time here before anything touches `location.hash`.
 * `MainActivity` is exported because it carries LAUNCHER, so any installed app
 * can start it with an extra of its choosing, and a whitelist on one side of a
 * bridge is not a whitelist.
 */
export interface WidgetLanding {
  route: string;
  /** `"<kind>:<id>"`, the literal `"water"`, or null for a screen alone. */
  pick: string | null;
}

/**
 * Which shelf a preselected food came off.
 *
 * Deliberately narrower than the log's own six source kinds. A pot drains, so a
 * frequently-logged cook points at something that no longer exists by the time
 * anybody taps it; a recipe is proportions rather than a thing with a portion;
 * a supplement is taken by count and has no amount step to land on. `water`
 * names the Foods screen's water tab rather than a food, because that is where
 * a bottle is actually logged — the bottle library is an inventory screen.
 */
export type PickKind = "food" | "custom" | "water" | "activity" | "strength";

export interface PickTarget {
  kind: PickKind;
  /** Decimal text for an FDC id, a uuid for one of the user's own foods. */
  id: string | null;
}

/**
 * Read a widget's pick token, or refuse it.
 *
 * Never a partial parse: a token with anything unexpected in it is thrown away
 * WHOLE rather than sanitised into something that looks valid, because a
 * half-cleaned token is how a rejected input ends up being honoured in a shape
 * nobody designed. Returning null lands the user on a blank Add food screen,
 * which is the right answer to a token this app did not write.
 */
export function parsePick(raw: string | null): PickTarget | null {
  if (raw === null) return null;
  if (raw === "water") return { kind: "water", id: null };
  // The Add screen's Activity tab, and with an id a session to carry on with or
  // to correct (D26). Not a food, for the same reason water is not one.
  if (raw === "activity") return { kind: "activity", id: null };
  // The Activity tab, with a strength session started on the lifts of the
  // last one: the + sheet's one tap for "the gym, like last time".
  if (raw === "strength") return { kind: "strength", id: null };
  const cut = raw.indexOf(":");
  if (cut === -1) return null;
  const kind = raw.slice(0, cut);
  const id = raw.slice(cut + 1);
  if (kind === "food") return /^[0-9]{1,12}$/.test(id) ? { kind, id } : null;
  if (kind === "custom") return /^[0-9a-f-]{36}$/.test(id) ? { kind, id } : null;
  if (kind === "activity") return /^[0-9a-f-]{36}$/.test(id) ? { kind, id } : null;
  return null;
}
