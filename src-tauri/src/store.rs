//! The user's own mutable data: what they logged, and when.
//!
//! Kept in a separate SQLite file from the bundled USDA reference database so a
//! dataset upgrade can replace the reference data without ever touching user
//! logs (`docs/decisions.md` D9). Ids are UUID-shaped text and rows carry
//! `updated_at` / `deleted_at` so adding sync later does not require migrating
//! every primary key.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use trackit_core::NutrientValue;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub struct Store(pub Mutex<Connection>);

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS log_entries (
  id          TEXT PRIMARY KEY,
  logged_on   TEXT NOT NULL,              -- ISO date, local
  -- Which sitting this was part of, or NULL for a thing that was not had at
  -- one. Nullable for exactly one kind of entry: water. A meal is a sitting,
  -- and food belongs to one because that is genuinely how it was eaten; a
  -- bottle is refilled and sipped from across a whole day, so naming a meal
  -- for it would record a fact the user never gave — the same failure as a
  -- nutrient stored as 0 when it was merely unmeasured.
  --
  -- Stated as a disjunction rather than left as a bare `CHECK (meal IN (...))`:
  -- once the column is nullable that predicate evaluates to NULL for a NULL
  -- meal, and SQLite treats a NULL CHECK as PASSING — so the shorter form
  -- would silently stop constraining the non-null case. Same trap as `grams`.
  meal        TEXT CHECK (meal IS NULL OR
                meal IN ('breakfast','lunch','dinner','snack')),
  -- Polymorphic reference: exactly one of fdc_id / recipe_id / cook_id /
  -- custom_food_id / supplement_id / bottle_id is set.
  source_kind TEXT NOT NULL DEFAULT 'food'
                CHECK (source_kind IN ('food','recipe','cook','custom','supplement','water')),
  fdc_id      INTEGER,
  recipe_id   TEXT REFERENCES recipes(id),
  -- A portion of a pot that was actually made. Distinct from `recipe_id`, and
  -- the difference is the point: a recipe entry portions the batch as written,
  -- a cook entry portions the batch that existed. Both stay loggable, because
  -- on a day you followed the recipe there is nothing to adjust.
  cook_id     TEXT REFERENCES cooks(id),
  custom_food_id TEXT REFERENCES custom_foods(id),
  supplement_id  TEXT REFERENCES supplements(id),
  bottle_id      TEXT REFERENCES bottles(id),
  description TEXT NOT NULL,              -- denormalised so history survives a dataset swap
  -- What was eaten, in grams. NULL for exactly one kind of entry: a supplement,
  -- which is taken by count. A tablet's mass is not on the pack, is mostly
  -- excipient, and — the part that decides this — is not what its nutrients
  -- arrived in proportion to. Inventing one would be D1's failure a table over,
  -- where the text names a quantity different from the value it encodes.
  --
  -- The CHECK is restated as an explicit disjunction rather than left as
  -- `grams REAL CHECK (grams > 0)`: once the column is nullable that predicate
  -- evaluates to NULL for a NULL grams, and SQLite treats a NULL CHECK as
  -- PASSING — so the shorter form would silently stop enforcing positivity.
  grams       REAL,
  -- The dose taken, counted in the supplement's own unit noun. One tablet of a
  -- two-tablet serving is 1; the halving happens at read time against
  -- `supplements.serving_units`, never here and never in the stored panel.
  units       REAL,
  -- How the weight was arrived at, when it came off a scale with the vessel on
  -- it. NULL for a weight typed in directly. `tare_note` is denormalised for
  -- the same reason `description` is: deleting a vessel must never retroactively
  -- change or break a day that used it.
  gross_g     REAL,
  tare_g      REAL,
  tare_note   TEXT,
  -- Where this dish came from and what kind of food it is. Both are the user's
  -- own answer and both are NULL until they give one: "not recorded" has to be
  -- structurally distinct from "recorded as home", the same discipline
  -- NutrientValue::Absent enforces for composition. Nothing in the read path
  -- may substitute a default for either.
  origin      TEXT CHECK (origin IS NULL OR
                origin IN ('home','ordered_in','eaten_out','packaged')),
  -- Free text, in the user's own words, because a fixed list would force a
  -- wrong answer on the dishes they eat most: gobi manchurian is neither
  -- "Indian" nor "Chinese", and one "Indian" bar covering four fifths of every
  -- period is a constant rather than a chart.
  cuisine     TEXT,
  -- `folded(cuisine)` — the grouping identity, so "South Indian", "south
  -- indian" and "SOUTH  Indian" are one bar and not three. Written by the same
  -- function that folds a custom food's name; SQLite's own lower() is
  -- ASCII-only and cannot be used for this.
  cuisine_key TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
  CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
  CHECK ((source_kind = 'cook')   = (cook_id   IS NOT NULL)),
  CHECK ((source_kind = 'custom') = (custom_food_id IS NOT NULL)),
  -- A fourth biconditional is required, not optional: the three above are all
  -- satisfied by a row with every id NULL (FALSE = FALSE is TRUE), so without
  -- this one a supplement row could be stored naming no supplement at all.
  CHECK ((source_kind = 'supplement') = (supplement_id IS NOT NULL)),
  -- A bottle is weighed, not counted, so it sits with food rather than beside
  -- the supplement exemptions below: `grams` stays required for it, and it is
  -- what the day's coverage denominator sees.
  CHECK ((source_kind = 'water') = (bottle_id IS NOT NULL)),
  -- Water has no sitting, and everything else has one. A biconditional rather
  -- than a one-way rule, for the reason the id checks above are: permitting a
  -- NULL meal generally would let a plain food be stored with no sitting at
  -- all, which is a gap in a fact the logging screen always collects.
  CHECK ((source_kind = 'water') = (meal IS NULL)),
  -- Counted xor weighed. A weighed scoop of powder is not an exception to this
  -- — its values really are per a mass, so it belongs in custom_foods, where
  -- the per-100 g machinery is already correct for it.
  CHECK ((source_kind = 'supplement') = (grams IS NULL)),
  CHECK ((source_kind = 'supplement') = (units IS NOT NULL)),
  CHECK (grams IS NULL OR grams > 0),
  CHECK (units IS NULL OR units > 0),
  -- A tare is the provenance of a mass; attached to an entry that has no mass
  -- it describes nothing.
  CHECK (grams IS NOT NULL OR gross_g IS NULL),
  CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
  CHECK (gross_g IS NULL OR gross_g > tare_g),
  CHECK ((cuisine IS NULL) = (cuisine_key IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_log_day ON log_entries(logged_on) WHERE deleted_at IS NULL;
-- The index on cuisine_key is deliberately NOT here. SCHEMA runs before
-- migrate(), so on a database still in an older shape the column it indexes
-- does not exist yet and the whole batch would fail. It is created at the end
-- of migrate() instead, once the table is known to have the column.

-- Cutlery and cookware with a known empty weight, so a plate can go on the
-- scale food and all. Each row is ONE physical object weighed empty once:
-- two katoris off the same shelf differ by several grams, so a table keyed
-- by vessel TYPE would reintroduce the error the tare exists to remove.
CREATE TABLE IF NOT EXISTS vessels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  grams        REAL NOT NULL CHECK (grams > 0),
  -- Drives picker order: the vessel you used last is the one you reach for.
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_vessels_live ON vessels(name) WHERE deleted_at IS NULL;

-- A water bottle, weighed full once, the same way a vessel is weighed empty
-- once: a physical object with a known reference weight, not a type of
-- object. Consumption for a day is read as how much of a FULL bottle is
-- gone — full_g is the number this feature starts from, never something
-- derived from what the reference database claims to know about water.
CREATE TABLE IF NOT EXISTS bottles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  full_g       REAL NOT NULL CHECK (full_g > 0),
  -- Drives picker order: the bottle you used last is the one you reach for.
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_bottles_live ON bottles(name) WHERE deleted_at IS NULL;

-- A user recipe: a composite food defined as ingredients in proportion.
-- Storing ingredients rather than a nutrient snapshot is what keeps the
-- breakdown honest — a dish's values derive from ingredients that each carry
-- their own measured data AND their own gaps, and those gaps must propagate
-- rather than being laundered into a confident zero.
--
-- A recipe is an intention, never a measurement. What was actually made is a
-- `cooks` row: the same lines dialled up or down, some left out, some swapped,
-- and a pot that was put on a scale. Everything here is the ideal it started
-- from.
CREATE TABLE IF NOT EXISTS recipes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- The reference batch: what the amounts below add up to. Not a claim about
  -- how much you will make, only the size the proportions happen to be written
  -- at, which is why a cook carries its own scale.
  yield_g     REAL NOT NULL CHECK (yield_g > 0),
  -- How many people the batch feeds, if the user chose to say. NULL is the
  -- normal case and is never filled in: the same dal feeds two on a weeknight
  -- and six when there are guests, so a number here is a note about a typical
  -- evening rather than a property of the recipe. Nothing in the nutrition
  -- arithmetic reads it — portioning divides by a yield, never by this.
  servings    REAL CHECK (servings IS NULL OR servings > 0),
  notes       TEXT,
  -- Where this dish usually comes from and what the user calls its cuisine.
  -- A DEFAULT only: it pre-fills the picker when the recipe has never been
  -- logged, and is never written into a past entry. A recipe is the user's own
  -- construct, so asking once in the builder is their statement rather than a
  -- guess — which is why reference foods get no equivalent, there being 13,694
  -- of those and no honest source of a default for any of them.
  default_origin  TEXT,
  default_cuisine TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id          TEXT PRIMARY KEY,
  recipe_id   TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  fdc_id      INTEGER,            -- NULL = no composition data for this ingredient
  description TEXT NOT NULL,
  raw_g       REAL NOT NULL CHECK (raw_g > 0),
  -- What this weighs once cooked. Dry rajma roughly triples; ignoring that
  -- reads a katori of cooked beans as if it were dry, a threefold error.
  cooked_g    REAL NOT NULL CHECK (cooked_g > 0),
  -- Whether the dish is still the dish without this line. It changes nothing
  -- about the recipe's own arithmetic — it is a note to the person at the
  -- stove, telling them which lines they may skip without having made
  -- something else. Leaving a line out is recorded on the cook, never here:
  -- a recipe that omits its own ingredient is just a different recipe.
  optional    INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_ri_recipe ON recipe_ingredients(recipe_id, position);

-- Named portions ("1 katori", "1 dosa") so a user need not weigh every meal.
-- Unrelated to `recipes.servings`: this is a label for an amount on a plate,
-- not a count of the people a batch feeds.
CREATE TABLE IF NOT EXISTS recipe_servings (
  id        TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  label     TEXT NOT NULL,
  grams     REAL NOT NULL CHECK (grams > 0)
);
CREATE INDEX IF NOT EXISTS idx_rs_recipe ON recipe_servings(recipe_id);

-- One pot, actually made. Where a recipe says what the dish should be, a cook
-- says what it was: the same lines scaled, dialled, left out or swapped, and a
-- pot that went on a scale.
--
-- It exists because the two are not the same claim and never were. Logging
-- straight off a recipe portions a batch nobody made -- fine on a day you
-- followed it, a fiction on a day you halved it and skipped the hing. A cook is
-- the only place in the app where an ingredient amount is a measurement.
--
-- A cook stays open until it is finished, because a pot lasts longer than a
-- meal. What is left is derived from the entries logged against it, never
-- stored: deleting an entry has to put the food back, and a counter would
-- drift away from the log it is supposed to describe.
CREATE TABLE IF NOT EXISTS cooks (
  id          TEXT PRIMARY KEY,
  -- What this started from. NULL is allowed twice over: a pot can be cooked
  -- without a written recipe, and a recipe deleted afterwards must not take
  -- the pot with it.
  recipe_id   TEXT REFERENCES recipes(id),
  -- Denormalised for the same reason log_entries.description is. Rewriting or
  -- deleting the recipe must not rename a pot already in the fridge.
  name        TEXT NOT NULL,
  cooked_on   TEXT NOT NULL,          -- ISO date, local
  cooked_at   TEXT NOT NULL,          -- instant, so two pots on one day order
  -- What the recipe was multiplied by before any single line was dialled.
  -- Recorded rather than inferred from the amounts: "half the recipe, with
  -- extra onion" is a different statement from the weights it produces, and
  -- only the first is any use the next time this is cooked.
  scale       REAL NOT NULL DEFAULT 1 CHECK (scale > 0),
  -- What the pot weighed. NULL means it never went on a scale, and the yield
  -- falls back to the sum of the lines. The two are separate columns because
  -- one is a measurement and the other is an estimate, and which one a portion
  -- was divided by is exactly the sort of thing this app refuses to lose.
  --
  -- A weighed yield below the summed one is normal, not an error: water leaves
  -- a pot, nutrients do not. Dividing by what the pot actually weighs is what
  -- concentrates a reduced dal correctly.
  weighed_yield_g REAL CHECK (weighed_yield_g IS NULL OR weighed_yield_g > 0),
  -- How that weight was arrived at, when it came off a scale with the pot on
  -- it. `tare_note` is denormalised like log_entries.tare_note, so deleting a
  -- vessel cannot retroactively change what a pot was recorded as weighing.
  gross_g     REAL,
  tare_g      REAL,
  tare_note   TEXT,
  -- Copied from the recipe when the cook was opened, and editable here. The
  -- user's own statement about their own construct, which is the only thing
  -- D15 lets pre-fill a tag -- and keeping it on the pot is what lets a batch
  -- carry an answer that differs from the recipe's usual one.
  default_origin  TEXT CHECK (default_origin IS NULL OR
                    default_origin IN ('home','ordered_in','eaten_out','packaged')),
  default_cuisine TEXT,
  notes       TEXT,
  -- Empty, or thrown out. A finished pot leaves the Available list but stays
  -- readable, because entries logged from it still name it. Never set
  -- automatically: a pot reading 4 g left is not a claim that it is empty.
  finished_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  -- A tare describes how a weight was reached, so it cannot outlive the
  -- weight: the same pairing log_entries enforces on its own reading.
  CHECK (weighed_yield_g IS NOT NULL OR gross_g IS NULL),
  CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
  CHECK (gross_g IS NULL OR gross_g > tare_g)
);
CREATE INDEX IF NOT EXISTS idx_cooks_open ON cooks(cooked_at DESC)
  WHERE deleted_at IS NULL AND finished_at IS NULL;

CREATE TABLE IF NOT EXISTS cook_ingredients (
  id          TEXT PRIMARY KEY,
  cook_id     TEXT NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  fdc_id      INTEGER,            -- NULL = no composition data, as on a recipe
  description TEXT NOT NULL,
  -- What the recipe called for at this cook's scale, frozen when the cook was
  -- opened. It is what the dial is centred on, and it keeps "what moved"
  -- answerable after the recipe itself has been rewritten. 0 for a line thrown
  -- in at the stove that the recipe never mentioned.
  planned_g   REAL NOT NULL CHECK (planned_g >= 0),
  -- What actually went in. Zero is meaningful and allowed -- it is the record
  -- of an ingredient deliberately left out, which is a different fact from the
  -- line never having been in the dish. This is the one place in the app where
  -- a zero weight is a measurement rather than a missing one.
  raw_g       REAL NOT NULL CHECK (raw_g >= 0),
  cooked_g    REAL NOT NULL CHECK (cooked_g >= 0),
  -- What this stood in for, when it was a substitution. Both are kept: the
  -- substitute is what was eaten, the original is what the dish was meant to
  -- be, and collapsing them would lose the reason the numbers differ.
  substituted_for TEXT
);
CREATE INDEX IF NOT EXISTS idx_ci_cook ON cook_ingredients(cook_id, position);

-- A food as the pack describes it, which is what the person actually ate.
-- `overrides_fdc_id` points at the generic reference entry this replaces, so a
-- branded bar can supersede "Chocolate, milk" in search while still borrowing
-- the 30-odd nutrients no label prints.
CREATE TABLE IF NOT EXISTS custom_foods (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  brand            TEXT,
  overrides_fdc_id INTEGER,
  -- Label figures are per serving; everything else in this app is per 100 g.
  -- Without this, transcribed values are wrong by whatever the serving is.
  serving_g        REAL NOT NULL CHECK (serving_g > 0),
  serving_label    TEXT,
  ingredients      TEXT,
  barcode          TEXT,
  photo_label       TEXT,
  photo_ingredients TEXT,
  -- Set only by a bulk spreadsheet import: this row is a one-off container for
  -- that row's numbers, never a food the user would search for or log a
  -- second time. Excluded from search and from "My foods" (see idx_cf_live and
  -- the four queries that filter on it in Rust) so hundreds of imported rows
  -- do not swarm either list; NOT excluded from the path a day's own history
  -- resolves through, for the same reason a soft-deleted food isn't either.
  import_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cf_live ON custom_foods(name)
  WHERE deleted_at IS NULL AND import_only = 0;
CREATE INDEX IF NOT EXISTS idx_cf_override ON custom_foods(overrides_fdc_id)
  WHERE deleted_at IS NULL AND overrides_fdc_id IS NOT NULL;

-- One row per nutrient the pack actually prints. A nutrient with NO row here is
-- not zero: it is unknown, and is either inherited from the overridden food or
-- reported absent.
CREATE TABLE IF NOT EXISTS custom_food_nutrients (
  id          TEXT PRIMARY KEY,
  food_id     TEXT NOT NULL REFERENCES custom_foods(id) ON DELETE CASCADE,
  nutrient_id INTEGER NOT NULL,
  -- Only the kinds a LABEL can express. 'measured_zero' is deliberately absent:
  -- a pack cannot assert a true zero, only a figure below a rounding threshold.
  kind        TEXT NOT NULL CHECK (kind IN ('measured','label_zero','below_loq','trace')),
  amount      REAL,   -- per serving, as printed
  upper       REAL,   -- per serving
  CHECK ((kind = 'measured') = (amount IS NOT NULL)),
  CHECK ((kind = 'measured') = (upper IS NULL)),
  CHECK (amount IS NULL OR amount >= 0),
  CHECK (upper IS NULL OR upper > 0),
  UNIQUE (food_id, nutrient_id)
);
CREATE INDEX IF NOT EXISTS idx_cfn_food ON custom_food_nutrients(food_id);

-- A supplement as its Supplement Facts panel describes it.
--
-- Deliberately NOT a kind of custom food. A custom food may override a generic
-- reference entry, because both describe the same eaten thing and the generic
-- one can honestly fill the gaps a pack does not print. There is no USDA entry
-- standing behind "one multivitamin tablet", and borrowing one would credit a
-- pill with values measured in a food. A supplement therefore inherits nothing:
-- it asserts what its panel lists, and nothing else.
CREATE TABLE IF NOT EXISTS supplements (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  brand         TEXT,
  -- What one of these is called, singular: "tablet", "capsule", "softgel",
  -- "gummy", "sachet", "drop". Free text rather than a CHECK, because a
  -- vocabulary that had never heard of a sachet would push the transcriber into
  -- calling it something it is not.
  unit_noun     TEXT NOT NULL,
  -- What the panel's figures are per, counted in `unit_noun`s: "Serving Size
  -- 2 tablets" is 2. Mandatory and positive for exactly the reason
  -- custom_foods.serving_g is — every figure below is per THIS, and without it
  -- each one is wrong by whatever the serving turns out to be. Per D1 the
  -- printed quantity and the amounts stay separate: no per-tablet figure is
  -- ever derived and stored in their place.
  serving_units REAL NOT NULL CHECK (serving_units > 0),
  serving_label TEXT,                     -- the pack's own wording, verbatim
  -- What this person usually takes, when that is not the panel's serving. It
  -- only pre-fills the dose; the dose itself lives on the log entry, so
  -- changing your mind about how many you take cannot rewrite what you already
  -- took.
  default_units REAL CHECK (default_units IS NULL OR default_units > 0),
  -- Which labelling regime the pack was printed under. This is not bureaucratic
  -- detail: it decides what the panel's SILENCE is worth. A US panel must not
  -- declare one of fifteen mandatory nutrients below the declarable-zero
  -- threshold, so omitting one asserts a bound; FSSAI has no mandatory
  -- micronutrient list and no threshold, so omission there asserts nothing.
  -- Asked once, never inferred — nothing about a bottle says which market
  -- printed it.
  regime        TEXT NOT NULL DEFAULT 'other' CHECK (regime IN ('us','other')),
  -- The user's own assertion that the panel lists everything in the product.
  -- The ONLY route by which an unlisted nutrient becomes a true zero rather
  -- than an unknown: no regulation supports the claim, because a nutrient can
  -- be present from an undeclared route (a botanical extract, an algae base, an
  -- oil carrier). Stored as their claim, and shown back to them as one.
  panel_complete INTEGER NOT NULL DEFAULT 0 CHECK (panel_complete IN (0,1)),
  other_ingredients TEXT,                 -- "Other Ingredients", as printed
  barcode           TEXT,
  photo_panel       TEXT,
  photo_ingredients TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sup_live ON supplements(name) WHERE deleted_at IS NULL;

-- One row per line the panel declares, per LABEL SERVING.
--
-- Every row is stored twice over: once as the pack prints it, once as this app
-- counts it. The printed columns are never read by the arithmetic — they are
-- what makes a conversion auditable, the way D3 keeps `raw_amount` beside a
-- clamped figure. An IU converts only when the compound is known (D6), so
-- `label_form` is load-bearing rather than decorative: it is what decides
-- whether `amount` exists at all.
CREATE TABLE IF NOT EXISTS supplement_nutrients (
  id            TEXT PRIMARY KEY,
  supplement_id TEXT NOT NULL REFERENCES supplements(id) ON DELETE CASCADE,
  -- The order the pack prints them. A Supplement Facts panel is not the fixed
  -- fifteen lines of a Nutrition Facts panel, so its own order is the only one
  -- that lets a reader follow the pack down the screen.
  position      INTEGER NOT NULL,
  nutrient_id   INTEGER NOT NULL,

  -- as the panel prints it
  label_amount  REAL NOT NULL CHECK (label_amount >= 0),
  label_unit    TEXT NOT NULL CHECK (label_unit IN ('g','mg','ug','IU','kcal')),
  label_form    TEXT NOT NULL,            -- supplement::Form, "unspecified" if unsaid

  -- as this app counts it, per label serving, in the nutrient's own magnitude
  -- and basis. 'not_converted' is what keeps a line honest when its figure
  -- cannot be put on that basis — 400 IU of vitamin E with no form named. It
  -- reaches the day as unknown and unbounded while the printed columns still
  -- say exactly what the pack said; dropping the row instead would lose the
  -- transcription and make the pack look silent on a nutrient it declares.
  kind   TEXT NOT NULL CHECK (kind IN
           ('measured','label_zero','below_loq','trace','not_converted')),
  amount REAL,
  upper  REAL,
  -- Why the conversion was refused, in a sentence, so the screen can say it.
  convert_note TEXT,

  CHECK ((kind = 'measured') = (amount IS NOT NULL)),
  CHECK ((kind IN ('label_zero','below_loq','trace')) = (upper IS NOT NULL)),
  CHECK (kind <> 'not_converted' OR (amount IS NULL AND upper IS NULL)),
  CHECK ((kind = 'not_converted') = (convert_note IS NOT NULL)),
  CHECK (amount IS NULL OR amount >= 0),
  CHECK (upper IS NULL OR upper > 0),
  UNIQUE (supplement_id, nutrient_id)
);
CREATE INDEX IF NOT EXISTS idx_sn_supp ON supplement_nutrients(supplement_id, position);

-- Who the targets are for. Exactly one row, or none at all.
--
-- Every field is optional, and each unlocks a different amount. Age and sex
-- place someone in the DRI tables, which is what replaces the one-size Daily
-- Values. Height, weight and activity are what an energy estimate needs, and
-- without all of them there is no estimate — only a blank the user can fill in
-- with a figure of their own.
CREATE TABLE IF NOT EXISTS profile (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  -- The column of the published tables to read, not a statement about the
  -- person. The DRI tables have exactly two, so this does too.
  sex           TEXT CHECK (sex IN ('female','male')),
  -- Year rather than a full date: age is only ever used to pick a band, and
  -- the bands are years wide. It does mean age is right to within a year,
  -- which matters only for the few days either side of a band boundary.
  birth_year    INTEGER CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2200),
  height_cm     REAL CHECK (height_cm IS NULL OR height_cm > 0),
  weight_kg     REAL CHECK (weight_kg IS NULL OR weight_kg > 0),
  activity      TEXT CHECK (activity IS NULL OR activity IN
                  ('sedentary','light','moderate','very_active','extra_active')),
  -- Pregnancy and lactation are their own columns in the DRI tables — folate
  -- goes from 400 to 600 µg, iron from 18 to 27 mg — so they are recorded
  -- rather than derived.
  life_stage    TEXT NOT NULL DEFAULT 'standard'
                  CHECK (life_stage IN ('standard','pregnant','lactating')),
  -- The user's own energy figure. NULL means "estimate it from the body above",
  -- and if that cannot be done either, the day shows what was eaten with no
  -- target at all — which is the honest outcome and what replaced a hard-coded
  -- 2,200 kcal that applied to nobody in particular.
  energy_kcal   REAL CHECK (energy_kcal IS NULL OR energy_kcal > 0),
  updated_at    TEXT
);

-- Targets the user set themselves, which beat both reference tables.
--
-- No soft delete: removing one is a return to the published figure, not the
-- deletion of a fact, and nothing historical depends on it. Days already logged
-- are unaffected either way — a target is a lens on a day, never part of it.
CREATE TABLE IF NOT EXISTS nutrient_targets (
  nutrient_id INTEGER PRIMARY KEY,
  amount      REAL NOT NULL CHECK (amount > 0),
  -- Why, in the user's words: "what my doctor said", "training block".
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Frozen history.
--
-- A logged entry records something already eaten, so its nutrition must not
-- move afterwards. Before these tables existed a day's totals were recomputed
-- on every read from whatever the recipe, the custom food, the supplement and
-- the bundled reference database said TODAY -- so correcting a product's label,
-- adjusting a recipe, or shipping a new USDA extract silently rewrote months of
-- history.
--
-- Two facts about the world decide this, and neither is a database concern. A
-- manufacturer reformulates, so the pack eaten in March genuinely differed from
-- the pack bought in June. And a home recipe is not a formula -- the cook varies
-- it every time it is made. Neither is a correction to a past day; both are new
-- facts about a new day.
--
-- So each entry keeps its own copy of what it contributed and the day is read
-- from that copy. Nothing below references recipes, custom_foods or supplements:
-- a snapshot has to outlive whatever produced it, which is what lets deleting a
-- recipe remove it from future logging without touching the days it is already
-- part of.

CREATE TABLE IF NOT EXISTS entry_snapshots (
  entry_id   TEXT PRIMARY KEY REFERENCES log_entries(id) ON DELETE CASCADE,
  -- When these values were frozen, which is NOT when the food was eaten: an
  -- entry logged before this existed was frozen at the next launch afterwards.
  frozen_at  TEXT NOT NULL,
  -- 'logged'     — frozen as the entry was written, from what was believed then.
  -- 'backfilled' — frozen later, from what was believed at backfill time.
  -- 'corrected'  — the user deliberately changed it after the fact. Immutable
  --                by default is only honest if a real mistake can still be
  --                fixed; what must never happen is a change nobody asked for,
  --                so a correction is recorded as one rather than blended in.
  basis      TEXT NOT NULL CHECK (basis IN ('logged','backfilled','corrected')),
  -- When the user last corrected it. `frozen_at` keeps saying when the entry
  -- was first valued, so both facts survive instead of one overwriting the
  -- other.
  corrected_at TEXT,
  -- A recipe entry's identity as it stood when logged. Denormalised for the
  -- same reason log_entries.description is: renaming or deleting the recipe
  -- must not change what a past day says was eaten.
  recipe_name     TEXT,
  recipe_yield_g  REAL CHECK (recipe_yield_g IS NULL OR recipe_yield_g > 0),
  recipe_servings REAL CHECK (recipe_servings IS NULL OR recipe_servings > 0)
);

CREATE TABLE IF NOT EXISTS entry_components (
  entry_id    TEXT NOT NULL REFERENCES entry_snapshots(entry_id) ON DELETE CASCADE,
  -- Display order, and half of the key the nutrient rows hang off.
  ordinal     INTEGER NOT NULL,
  description TEXT NOT NULL,
  -- Kept so the breakdown can still name the reference food this came from.
  -- Values are NEVER re-read through it; that is the entire point of the table.
  fdc_id      INTEGER,
  -- Exactly one of these is set, mirroring the two shapes a contribution can
  -- take: a mass, which enters the day's coverage denominator, or a count of
  -- label servings, which must stay out of it. A tablet has a mass, but its
  -- nutrients did not arrive in proportion to that mass.
  grams       REAL,
  servings    REAL,
  has_data    INTEGER NOT NULL CHECK (has_data IN (0,1)),
  PRIMARY KEY (entry_id, ordinal),
  CHECK ((grams IS NULL) <> (servings IS NULL)),
  CHECK (grams    IS NULL OR grams    > 0),
  CHECK (servings IS NULL OR servings > 0)
);

CREATE TABLE IF NOT EXISTS entry_nutrients (
  entry_id    TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  nutrient_id INTEGER NOT NULL,
  -- The vocabulary food_nutrients uses, round-tripped through
  -- NutrientValue::to_db / ::from_db. Storing a bare amount would throw away
  -- which nutrients were measured, inherited, label-declared or merely unknown,
  -- and every bound this app reports is built on that distinction.
  value_kind  TEXT NOT NULL,
  amount      REAL,
  upper_bound REAL,
  PRIMARY KEY (entry_id, ordinal, nutrient_id),
  FOREIGN KEY (entry_id, ordinal)
    REFERENCES entry_components(entry_id, ordinal) ON DELETE CASCADE
);
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: String,
    pub logged_on: String,
    /// The sitting this was part of, or `None` for water — which is drunk
    /// across the whole day and belongs to no one meal. See the `meal` column.
    pub meal: Option<String>,
    pub source_kind: String,
    pub fdc_id: Option<i64>,
    pub recipe_id: Option<String>,
    /// The pot this portion came out of. Distinct from `recipe_id`: a recipe
    /// entry portioned the batch as written, a cook entry portioned the batch
    /// that existed.
    pub cook_id: Option<String>,
    pub custom_food_id: Option<String>,
    pub supplement_id: Option<String>,
    pub bottle_id: Option<String>,
    pub description: String,
    /// What was eaten, in grams. `None` for a supplement and for nothing else —
    /// a dose is counted, not weighed. Never read this as `0`.
    pub grams: Option<f64>,
    /// The dose taken, counted in the supplement's own unit noun. `Some` for a
    /// supplement and `None` for everything else.
    pub units: Option<f64>,
    /// The scale reading and what came off it, when the entry was weighed with
    /// vessels under the food. All three are NULL together for a typed weight.
    pub gross_g: Option<f64>,
    pub tare_g: Option<f64>,
    pub tare_note: Option<String>,
    /// Where the dish came from, and what the user calls its cuisine. `None`
    /// means they have not said — which is a different fact from any answer
    /// they could give, and must never be filled in with one.
    pub origin: Option<String>,
    pub cuisine: Option<String>,
}

/// One supplement, as its Supplement Facts panel describes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Supplement {
    pub id: String,
    pub name: String,
    pub brand: Option<String>,
    /// What one of these is called, singular: "tablet", "capsule", "gummy".
    pub unit_noun: String,
    /// How many of those the panel's figures are per.
    pub serving_units: f64,
    pub serving_label: Option<String>,
    pub default_units: Option<f64>,
    /// "us" for a 21 CFR 101.36 Supplement Facts panel, "other" otherwise.
    pub regime: String,
    /// The user's assertion that the panel lists everything in the product.
    pub panel_complete: bool,
    pub other_ingredients: Option<String>,
    pub barcode: Option<String>,
    pub photo_panel: Option<String>,
    pub photo_ingredients: Option<String>,
    pub nutrients: Vec<SupplementNutrient>,
}

/// One line a supplement panel prints, kept both as printed and as counted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupplementNutrient {
    pub nutrient_id: i64,
    pub position: i64,
    /// The figure exactly as the pack prints it, with its unit and the chemical
    /// form named beside it. These three are never read by the arithmetic; they
    /// are what makes the conversion below auditable.
    pub label_amount: f64,
    pub label_unit: String,
    pub label_form: String,
    /// What that figure is on this app's basis, per label serving.
    /// `not_converted` when the pack's figure cannot be put on it at all.
    pub kind: String,
    pub amount: Option<f64>,
    pub upper: Option<f64>,
    /// Why the conversion was refused, in a sentence the screen can show.
    pub convert_note: Option<String>,
}

/// One physical vessel, weighed empty once. Not a vessel type — see the
/// `vessels` table comment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vessel {
    pub id: String,
    pub name: String,
    pub grams: f64,
    pub last_used_at: Option<String>,
}

/// One physical water bottle, weighed full once. Not a bottle type — see the
/// `bottles` table comment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bottle {
    pub id: String,
    pub name: String,
    pub full_g: f64,
    pub last_used_at: Option<String>,
}

/// How a weight was arrived at, when it came off a scale with the vessel on it.
#[derive(Debug, Clone)]
pub struct Tare {
    pub gross_g: f64,
    pub tare_g: f64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeIngredient {
    pub id: String,
    pub position: i64,
    /// `None` when no composition data exists for this ingredient. The recipe
    /// still records it, so the gap stays visible instead of vanishing.
    pub fdc_id: Option<i64>,
    pub description: String,
    pub raw_g: f64,
    pub cooked_g: f64,
    /// Whether the dish survives without this line. A note for the person at
    /// the stove; the recipe's own arithmetic ignores it.
    ///
    /// `#[serde(default)]` so a payload written before the flag existed — a
    /// restored builder draft, most likely — still deserializes, as required.
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeServing {
    pub id: String,
    pub label: String,
    pub grams: f64,
}

/// One line of a pot, as it actually went in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CookIngredient {
    pub id: String,
    pub position: i64,
    pub fdc_id: Option<i64>,
    pub description: String,
    /// What the recipe called for at this cook's scale. The dial's centre.
    pub planned_g: f64,
    /// What went in. Zero means deliberately left out — see the table comment.
    pub raw_g: f64,
    pub cooked_g: f64,
    /// The line this replaced, when it was a substitution.
    #[serde(default)]
    pub substituted_for: Option<String>,
}

/// One pot, actually made. See the `cooks` table comment for why it exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cook {
    pub id: String,
    pub recipe_id: Option<String>,
    pub name: String,
    pub cooked_on: String,
    pub cooked_at: String,
    pub scale: f64,
    /// What the pot weighed, when it was weighed. See [`Cook::yield_g`].
    pub weighed_yield_g: Option<f64>,
    pub gross_g: Option<f64>,
    pub tare_g: Option<f64>,
    pub tare_note: Option<String>,
    pub default_origin: Option<String>,
    pub default_cuisine: Option<String>,
    pub notes: Option<String>,
    pub finished_at: Option<String>,
    pub ingredients: Vec<CookIngredient>,
    /// How much of the pot has been logged already, in grams. Summed from the
    /// live entries against this cook rather than stored, so deleting an entry
    /// puts the food back.
    pub logged_g: f64,
    /// What a portion of this pot is divided by. Derived — see [`Cook::seal`].
    pub yield_g: f64,
    /// What is left, in grams. Derived — see [`Cook::seal`].
    pub remaining_g: f64,
}

impl Cook {
    /// Fill in the two derived figures.
    ///
    /// They are fields rather than methods so the frontend sees the same
    /// numbers the nutrition arm divides by, from the one definition here. Every
    /// path that builds a `Cook` ends with this call; nothing else may set them.
    ///
    /// **What you weighed wins.** The summed line weights are an estimate built
    /// out of the recipe's raw-to-cooked ratios; a reading off a scale is the
    /// pot itself, and where both exist the measurement is the honest divisor —
    /// which is also what concentrates a reduced dal correctly, since water
    /// leaves a pot and nutrients do not.
    ///
    /// `remaining_g` never goes negative. Logging more than the pot held is
    /// allowed: grams are estimates, and going over says the yield was
    /// under-read, not that the fridge owes you food.
    pub fn seal(mut self) -> Self {
        self.yield_g = self
            .weighed_yield_g
            .unwrap_or_else(|| self.ingredients.iter().map(|i| i.cooked_g).sum());
        self.remaining_g = (self.yield_g - self.logged_g).max(0.0);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recipe {
    pub id: String,
    pub name: String,
    /// The reference batch the proportions happen to be written at, not a
    /// claim about how much will be made.
    pub yield_g: f64,
    /// How many the batch feeds, if the user said so. `None` is the normal
    /// case and nothing fills it in — see the table comment. Never a divisor.
    #[serde(default)]
    pub servings: Option<f64>,
    pub notes: Option<String>,
    /// What the builder said this dish usually is. A default for the picker
    /// only — never written into an entry that already exists.
    pub default_origin: Option<String>,
    pub default_cuisine: Option<String>,
    pub ingredients: Vec<RecipeIngredient>,
    pub serving_options: Vec<RecipeServing>,
}

/// One nutrient as a nutrition panel prints it, per serving.
///
/// `kind` is restricted to what a pack can actually assert — see the
/// `custom_food_nutrients` CHECK. There is no variant for "not printed":
/// that is the absence of a row, because a nutrient the label omits is
/// unknown, and a row would make it look answered.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomNutrient {
    pub nutrient_id: i64,
    pub kind: String,        // measured | label_zero | below_loq | trace
    pub amount: Option<f64>, // per serving
    pub upper: Option<f64>,  // per serving
}

/// A food defined from its pack rather than from the reference dataset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomFood {
    pub id: String,
    pub name: String,
    pub brand: Option<String>,
    pub overrides_fdc_id: Option<i64>,
    pub serving_g: f64,
    pub serving_label: Option<String>,
    pub ingredients: Option<String>,
    pub barcode: Option<String>,
    pub photo_label: Option<String>,
    pub photo_ingredients: Option<String>,
    pub nutrients: Vec<CustomNutrient>,
    /// Set only by a bulk spreadsheet import — see the `custom_foods` table
    /// comment. `#[serde(default)]` because the existing custom-food editor's
    /// frontend payload does not send this field and must keep deserializing
    /// exactly as it does today, defaulting to `false`.
    #[serde(default)]
    pub import_only: bool,
}

/// The kinds a `custom_food_nutrients` row may carry, mirroring the table's
/// CHECK so a bad kind is refused with a sentence rather than a constraint code.
const LABEL_KINDS: [&str; 4] = ["measured", "label_zero", "below_loq", "trace"];

/// The schema version this build expects. Bump it whenever `SCHEMA` changes
/// shape, and add the corresponding arm to `migrate`.
const SCHEMA_VERSION: i64 = 12;

pub fn open(path: &PathBuf) -> Result<Connection, String> {
    let mut conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    // WAL is not the sqlite default and must be asked for explicitly.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    // Creates anything absent. Note this does NOT alter a table that already
    // exists in an older shape — that is what `migrate` is for.
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(cols)
}

/// Whether `column` is declared NOT NULL on `table`.
///
/// Column presence is the usual gate here, but a migration that only loosens a
/// constraint adds no column to look for. Reading the declaration back is the
/// honest test for "has this table already been rebuilt": it asks the database
/// what shape it is in rather than inferring it from a version number that a
/// half-finished upgrade may have written.
fn column_is_not_null(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(1)?, r.get::<_, i64>(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().any(|(name, notnull)| name == column && *notnull == 1))
}

/// Bring an existing user database up to `SCHEMA_VERSION`, preserving its rows.
///
/// This is user data, so a mismatch can never be resolved by deleting and
/// recreating the way the read-only reference database can be. Every migration
/// rebuilds through a temp table rather than using `ALTER TABLE ADD COLUMN`,
/// because SQLite cannot add a CHECK constraint to an existing table and the
/// constraints here are load-bearing — they are what keeps a log entry from
/// referencing both a food and a recipe, or neither.
fn migrate(conn: &mut Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }

    // v0 -> v1: log_entries gains source_kind / recipe_id so an entry can point
    // at a saved recipe. Rows predating this are all plain foods.
    if !columns(conn, "log_entries")?
        .iter()
        .any(|c| c == "source_kind")
    {
        // Foreign keys must be off around a table rebuild, and the pragma
        // cannot be changed inside a transaction.
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE log_entries_migrating (
              id          TEXT PRIMARY KEY,
              logged_on   TEXT NOT NULL,
              meal        TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
              source_kind TEXT NOT NULL DEFAULT 'food'
                            CHECK (source_kind IN ('food','recipe')),
              fdc_id      INTEGER,
              recipe_id   TEXT REFERENCES recipes(id),
              description TEXT NOT NULL,
              grams       REAL NOT NULL CHECK (grams > 0),
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              deleted_at  TEXT,
              CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
              CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL))
            );
            INSERT INTO log_entries_migrating
              (id, logged_on, meal, source_kind, fdc_id, recipe_id,
               description, grams, created_at, updated_at, deleted_at)
            SELECT id, logged_on, meal, 'food', fdc_id, NULL,
                   description, grams, created_at, updated_at, deleted_at
            FROM log_entries;
            DROP TABLE log_entries;
            ALTER TABLE log_entries_migrating RENAME TO log_entries;
            CREATE INDEX IF NOT EXISTS idx_log_day
              ON log_entries(logged_on) WHERE deleted_at IS NULL;
            "#,
        )
        .map_err(|e| format!("migrating log_entries to v1: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // v1 -> v2: log_entries gains gross_g / tare_g / tare_note so an entry can
    // record that its weight came off a scale with vessels under the food.
    // Rows predating this were all typed in directly, hence NULL. The `vessels`
    // table itself needs no arm here — `CREATE TABLE IF NOT EXISTS` in SCHEMA
    // creates it on open.
    if !columns(conn, "log_entries")?.iter().any(|c| c == "gross_g") {
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE log_entries_migrating (
              id          TEXT PRIMARY KEY,
              logged_on   TEXT NOT NULL,
              meal        TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
              source_kind TEXT NOT NULL DEFAULT 'food'
                            CHECK (source_kind IN ('food','recipe')),
              fdc_id      INTEGER,
              recipe_id   TEXT REFERENCES recipes(id),
              description TEXT NOT NULL,
              grams       REAL NOT NULL CHECK (grams > 0),
              gross_g     REAL,
              tare_g      REAL,
              tare_note   TEXT,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              deleted_at  TEXT,
              CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
              CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
              CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
              CHECK (gross_g IS NULL OR gross_g > tare_g)
            );
            INSERT INTO log_entries_migrating
              (id, logged_on, meal, source_kind, fdc_id, recipe_id,
               description, grams, gross_g, tare_g, tare_note,
               created_at, updated_at, deleted_at)
            SELECT id, logged_on, meal, source_kind, fdc_id, recipe_id,
                   description, grams, NULL, NULL, NULL,
                   created_at, updated_at, deleted_at
            FROM log_entries;
            DROP TABLE log_entries;
            ALTER TABLE log_entries_migrating RENAME TO log_entries;
            CREATE INDEX IF NOT EXISTS idx_log_day
              ON log_entries(logged_on) WHERE deleted_at IS NULL;
            "#,
        )
        .map_err(|e| format!("migrating log_entries to v2: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // v2 -> v3: log_entries gains a third source, so an entry can point at a
    // food the user transcribed off a pack. Rows predating this are foods and
    // recipes, hence NULL. The `custom_foods` and `custom_food_nutrients`
    // tables need no arm here — `CREATE TABLE IF NOT EXISTS` in SCHEMA creates
    // them on open, which is also why the FK below has something to point at.
    if !columns(conn, "log_entries")?
        .iter()
        .any(|c| c == "custom_food_id")
    {
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE log_entries_migrating (
              id          TEXT PRIMARY KEY,
              logged_on   TEXT NOT NULL,
              meal        TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
              source_kind TEXT NOT NULL DEFAULT 'food'
                            CHECK (source_kind IN ('food','recipe','custom')),
              fdc_id      INTEGER,
              recipe_id   TEXT REFERENCES recipes(id),
              custom_food_id TEXT REFERENCES custom_foods(id),
              description TEXT NOT NULL,
              grams       REAL NOT NULL CHECK (grams > 0),
              gross_g     REAL,
              tare_g      REAL,
              tare_note   TEXT,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              deleted_at  TEXT,
              CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
              CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
              CHECK ((source_kind = 'custom') = (custom_food_id IS NOT NULL)),
              CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
              CHECK (gross_g IS NULL OR gross_g > tare_g)
            );
            INSERT INTO log_entries_migrating
              (id, logged_on, meal, source_kind, fdc_id, recipe_id, custom_food_id,
               description, grams, gross_g, tare_g, tare_note,
               created_at, updated_at, deleted_at)
            SELECT id, logged_on, meal, source_kind, fdc_id, recipe_id, NULL,
                   description, grams, gross_g, tare_g, tare_note,
                   created_at, updated_at, deleted_at
            FROM log_entries;
            DROP TABLE log_entries;
            ALTER TABLE log_entries_migrating RENAME TO log_entries;
            CREATE INDEX IF NOT EXISTS idx_log_day
              ON log_entries(logged_on) WHERE deleted_at IS NULL;
            "#,
        )
        .map_err(|e| format!("migrating log_entries to v3: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // v3 -> v4: two features land in one shape change, because both add columns
    // to log_entries and SQLite cannot add a CHECK to an existing table — doing
    // them as two versions would mean rebuilding the same table twice.
    //
    //   * a fourth source, so an entry can point at a supplement, which is
    //     counted rather than weighed: `supplement_id` and `units` arrive, and
    //     `grams` becomes NULL for exactly that kind of row.
    //   * `origin` and `cuisine`, so a dish records whether it was made at home
    //     or ordered, and what the user calls it.
    //
    // Rows predating this are foods, recipes and custom foods, all weighed and
    // none tagged — hence NULL for every new column. The `supplements` and
    // `supplement_nutrients` tables need no arm: CREATE TABLE IF NOT EXISTS in
    // SCHEMA makes them on open, which is also why the new FK has something to
    // point at.
    if !columns(conn, "log_entries")?.iter().any(|c| c == "units") {
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE log_entries_migrating (
              id          TEXT PRIMARY KEY,
              logged_on   TEXT NOT NULL,
              meal        TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
              source_kind TEXT NOT NULL DEFAULT 'food'
                            CHECK (source_kind IN ('food','recipe','custom','supplement')),
              fdc_id      INTEGER,
              recipe_id   TEXT REFERENCES recipes(id),
              custom_food_id TEXT REFERENCES custom_foods(id),
              supplement_id  TEXT REFERENCES supplements(id),
              description TEXT NOT NULL,
              grams       REAL,
              units       REAL,
              gross_g     REAL,
              tare_g      REAL,
              tare_note   TEXT,
              origin      TEXT CHECK (origin IS NULL OR
                            origin IN ('home','ordered_in','eaten_out','packaged')),
              cuisine     TEXT,
              cuisine_key TEXT,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              deleted_at  TEXT,
              CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
              CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
              CHECK ((source_kind = 'custom') = (custom_food_id IS NOT NULL)),
              CHECK ((source_kind = 'supplement') = (supplement_id IS NOT NULL)),
              CHECK ((source_kind = 'supplement') = (grams IS NULL)),
              CHECK ((source_kind = 'supplement') = (units IS NOT NULL)),
              CHECK (grams IS NULL OR grams > 0),
              CHECK (units IS NULL OR units > 0),
              CHECK (grams IS NOT NULL OR gross_g IS NULL),
              CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
              CHECK (gross_g IS NULL OR gross_g > tare_g),
              CHECK ((cuisine IS NULL) = (cuisine_key IS NULL))
            );
            INSERT INTO log_entries_migrating
              (id, logged_on, meal, source_kind, fdc_id, recipe_id, custom_food_id,
               supplement_id, description, grams, units, gross_g, tare_g, tare_note,
               origin, cuisine, cuisine_key, created_at, updated_at, deleted_at)
            SELECT id, logged_on, meal, source_kind, fdc_id, recipe_id, custom_food_id,
                   NULL, description, grams, NULL, gross_g, tare_g, tare_note,
                   NULL, NULL, NULL,
                   created_at, updated_at, deleted_at
            FROM log_entries;
            DROP TABLE log_entries;
            ALTER TABLE log_entries_migrating RENAME TO log_entries;
            CREATE INDEX IF NOT EXISTS idx_log_day
              ON log_entries(logged_on) WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_log_cuisine ON log_entries(cuisine_key)
              WHERE deleted_at IS NULL AND cuisine_key IS NOT NULL;
            "#,
        )
        .map_err(|e| format!("migrating log_entries to v4: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // The recipe defaults carry no CHECK, so they can be added in place rather
    // than through a rebuild. `origin` is validated in Rust on the way in; the
    // load-bearing constraint is the one on log_entries, which is where the
    // answer that counts is actually stored.
    {
        let cols = columns(conn, "recipes")?;
        if !cols.iter().any(|c| c == "default_origin") {
            conn.execute_batch("ALTER TABLE recipes ADD COLUMN default_origin TEXT;")
                .map_err(|e| format!("adding recipes.default_origin: {e}"))?;
        }
        if !cols.iter().any(|c| c == "default_cuisine") {
            conn.execute_batch("ALTER TABLE recipes ADD COLUMN default_cuisine TEXT;")
                .map_err(|e| format!("adding recipes.default_cuisine: {e}"))?;
        }
    }

    // Indexes over columns that only exist from v4 onwards. Created here rather
    // than in SCHEMA because SCHEMA runs first, against whatever shape the
    // database is still in.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_log_cuisine ON log_entries(cuisine_key)
           WHERE deleted_at IS NULL AND cuisine_key IS NOT NULL;",
    )
    .map_err(|e| format!("indexing cuisine_key: {e}"))?;

    // v4 -> v5: custom_foods gains import_only, so a bulk spreadsheet import
    // can create hundreds of rows that store and resolve exactly like any
    // other transcribed pack, while staying invisible in search and in "My
    // foods" — see the column's comment in SCHEMA. This is genuinely simpler
    // than every arm above: it adds no CHECK constraint, and SQLite can add a
    // column with a plain non-NULL literal default via ordinary
    // `ALTER TABLE ADD COLUMN`, so there is no need to rebuild the table
    // through a temp table the way a new CHECK would force. The index is
    // rebuilt because a bulk import can add far more rows than ordinary use of
    // this table ever did, and `list_custom_foods`/`search_custom_foods` need
    // the partial index to stay selective once most rows are import-only.
    if !columns(conn, "custom_foods")?
        .iter()
        .any(|c| c == "import_only")
    {
        conn.execute_batch(
            "ALTER TABLE custom_foods ADD COLUMN import_only INTEGER NOT NULL DEFAULT 0;
             DROP INDEX IF EXISTS idx_cf_live;
             CREATE INDEX idx_cf_live ON custom_foods(name)
               WHERE deleted_at IS NULL AND import_only = 0;",
        )
        .map_err(|e| format!("migrating custom_foods to v5: {e}"))?;
    }

    // v5 -> v6: the profile gains a body, a life stage and an energy figure, so
    // targets can come from the DRI tables rather than from one adult column of
    // Daily Values.
    //
    // Rebuilt through a temp table rather than extended with ALTER TABLE,
    // because the new columns carry CHECK constraints — an activity level and a
    // life stage are closed sets, and a weight is positive — and SQLite cannot
    // add a CHECK to an existing table. The INSERT ... SELECT preserves any row
    // that exists; in practice there is none, because until this version
    // nothing in the app ever wrote to this table.
    if !columns(conn, "profile")?.iter().any(|c| c == "life_stage") {
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE profile_migrating (
              id            INTEGER PRIMARY KEY CHECK (id = 1),
              sex           TEXT CHECK (sex IN ('female','male')),
              birth_year    INTEGER CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2200),
              height_cm     REAL CHECK (height_cm IS NULL OR height_cm > 0),
              weight_kg     REAL CHECK (weight_kg IS NULL OR weight_kg > 0),
              activity      TEXT CHECK (activity IS NULL OR activity IN
                              ('sedentary','light','moderate','very_active','extra_active')),
              life_stage    TEXT NOT NULL DEFAULT 'standard'
                              CHECK (life_stage IN ('standard','pregnant','lactating')),
              energy_kcal   REAL CHECK (energy_kcal IS NULL OR energy_kcal > 0),
              updated_at    TEXT
            );
            INSERT INTO profile_migrating
              (id, sex, birth_year, height_cm, weight_kg, activity, life_stage,
               energy_kcal, updated_at)
            SELECT id, sex, birth_year, height_cm, NULL, NULL, 'standard', NULL, updated_at
            FROM profile;
            DROP TABLE profile;
            ALTER TABLE profile_migrating RENAME TO profile;
            "#,
        )
        .map_err(|e| format!("migrating profile to v6: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // v6 -> v7: entry_snapshots / entry_components / entry_nutrients freeze what
    // each entry contributed at the moment it was logged.
    //
    // No arm is needed here. The three tables are new rather than reshaped, so
    // `CREATE TABLE IF NOT EXISTS` in SCHEMA -- which `open` runs before this
    // function -- creates them on an existing database exactly as on a new one,
    // and no existing table gains a column. Filling them for entries that
    // predate the feature is deliberately NOT done here: it needs the reference
    // database, which this module has no connection to, so it happens once at
    // startup and marks what it writes as `backfilled`.

    // v7 -> v8: a snapshot may be corrected on purpose.
    //
    // Rebuilt rather than ALTERed because `basis` carries a CHECK and SQLite
    // cannot add a value to one in place. The children are left alone: their
    // foreign key points at entry_id, which the rebuild preserves, and dropping
    // the parent with foreign_keys OFF leaves them untouched.
    if !columns(conn, "entry_snapshots")?
        .iter()
        .any(|c| c == "corrected_at")
    {
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE entry_snapshots_migrating (
              entry_id   TEXT PRIMARY KEY REFERENCES log_entries(id) ON DELETE CASCADE,
              frozen_at  TEXT NOT NULL,
              basis      TEXT NOT NULL CHECK (basis IN ('logged','backfilled','corrected')),
              corrected_at TEXT,
              recipe_name     TEXT,
              recipe_yield_g  REAL CHECK (recipe_yield_g IS NULL OR recipe_yield_g > 0),
              recipe_servings REAL CHECK (recipe_servings IS NULL OR recipe_servings > 0)
            );
            INSERT INTO entry_snapshots_migrating
              (entry_id, frozen_at, basis, corrected_at,
               recipe_name, recipe_yield_g, recipe_servings)
            SELECT entry_id, frozen_at, basis, NULL,
                   recipe_name, recipe_yield_g, recipe_servings
            FROM entry_snapshots;
            DROP TABLE entry_snapshots;
            ALTER TABLE entry_snapshots_migrating RENAME TO entry_snapshots;
            "#,
        )
        .map_err(|e| format!("migrating entry_snapshots to v8: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // v8 -> v9: a recipe stops being a batch and becomes a set of proportions.
    //
    // `servings` was NOT NULL, which forced every recipe to answer a question
    // it cannot answer: the same dal feeds two on a weeknight and six when
    // there are guests. The column stays -- a user who wants to note "usually
    // four" should be able to -- but it stops being demanded, and nothing
    // writes it any more. Existing values carry over untouched rather than
    // being cleared: they are the user's own past statement, and deleting a
    // fact because the app stopped asking for it is not a migration.
    //
    // Nothing about the nutrition arithmetic moves. `servings` was never a
    // divisor; portioning has always been `grams / yield_g`.
    if column_is_not_null(conn, "recipes", "servings")? {
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE recipes_migrating (
              id          TEXT PRIMARY KEY,
              name        TEXT NOT NULL,
              yield_g     REAL NOT NULL CHECK (yield_g > 0),
              servings    REAL CHECK (servings IS NULL OR servings > 0),
              notes       TEXT,
              default_origin  TEXT,
              default_cuisine TEXT,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              deleted_at  TEXT
            );
            INSERT INTO recipes_migrating
              (id, name, yield_g, servings, notes,
               default_origin, default_cuisine, created_at, updated_at, deleted_at)
            SELECT id, name, yield_g, servings, notes,
                   default_origin, default_cuisine, created_at, updated_at, deleted_at
            FROM recipes;
            DROP TABLE recipes;
            ALTER TABLE recipes_migrating RENAME TO recipes;
            "#,
        )
        .map_err(|e| format!("migrating recipes to v9: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // v8 -> v9, second half: an ingredient can be marked optional.
    //
    // Rebuilt rather than ALTERed for the 0/1 CHECK. Every existing line
    // defaults to 0 -- required -- because a recipe written before the flag
    // existed said nothing about which of its ingredients could be skipped, and
    // guessing that a 1 g line is optional would be the app inventing the
    // user's intent.
    if !columns(conn, "recipe_ingredients")?
        .iter()
        .any(|c| c == "optional")
    {
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE recipe_ingredients_migrating (
              id          TEXT PRIMARY KEY,
              recipe_id   TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
              position    INTEGER NOT NULL,
              fdc_id      INTEGER,
              description TEXT NOT NULL,
              raw_g       REAL NOT NULL CHECK (raw_g > 0),
              cooked_g    REAL NOT NULL CHECK (cooked_g > 0),
              optional    INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0,1))
            );
            INSERT INTO recipe_ingredients_migrating
              (id, recipe_id, position, fdc_id, description, raw_g, cooked_g, optional)
            SELECT id, recipe_id, position, fdc_id, description, raw_g, cooked_g, 0
            FROM recipe_ingredients;
            DROP TABLE recipe_ingredients;
            ALTER TABLE recipe_ingredients_migrating RENAME TO recipe_ingredients;
            CREATE INDEX IF NOT EXISTS idx_ri_recipe ON recipe_ingredients(recipe_id, position);
            "#,
        )
        .map_err(|e| format!("migrating recipe_ingredients to v9: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // v9 -> v10: a fifth source, so an entry can point at a bottle of water,
    // read at the end of the day the same way a plate is weighed on a vessel:
    // `bottle_id` arrives, and `source_kind` widens to 'water'.
    //
    // Rows predating this are food, recipe, custom and supplement entries,
    // never water, hence NULL for the new column. The `bottles` table needs no
    // arm: CREATE TABLE IF NOT EXISTS in SCHEMA makes it on open, which is
    // also why the new FK has something to point at.
    if !columns(conn, "log_entries")?.iter().any(|c| c == "bottle_id") {
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE log_entries_migrating (
              id          TEXT PRIMARY KEY,
              logged_on   TEXT NOT NULL,
              meal        TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
              source_kind TEXT NOT NULL DEFAULT 'food'
                            CHECK (source_kind IN ('food','recipe','custom','supplement','water')),
              fdc_id      INTEGER,
              recipe_id   TEXT REFERENCES recipes(id),
              custom_food_id TEXT REFERENCES custom_foods(id),
              supplement_id  TEXT REFERENCES supplements(id),
              bottle_id      TEXT REFERENCES bottles(id),
              description TEXT NOT NULL,
              grams       REAL,
              units       REAL,
              gross_g     REAL,
              tare_g      REAL,
              tare_note   TEXT,
              origin      TEXT CHECK (origin IS NULL OR
                            origin IN ('home','ordered_in','eaten_out','packaged')),
              cuisine     TEXT,
              cuisine_key TEXT,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              deleted_at  TEXT,
              CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
              CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
              CHECK ((source_kind = 'custom') = (custom_food_id IS NOT NULL)),
              CHECK ((source_kind = 'supplement') = (supplement_id IS NOT NULL)),
              CHECK ((source_kind = 'water') = (bottle_id IS NOT NULL)),
              CHECK ((source_kind = 'supplement') = (grams IS NULL)),
              CHECK ((source_kind = 'supplement') = (units IS NOT NULL)),
              CHECK (grams IS NULL OR grams > 0),
              CHECK (units IS NULL OR units > 0),
              CHECK (grams IS NOT NULL OR gross_g IS NULL),
              CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
              CHECK (gross_g IS NULL OR gross_g > tare_g),
              CHECK ((cuisine IS NULL) = (cuisine_key IS NULL))
            );
            INSERT INTO log_entries_migrating
              (id, logged_on, meal, source_kind, fdc_id, recipe_id, custom_food_id,
               supplement_id, bottle_id, description, grams, units, gross_g, tare_g, tare_note,
               origin, cuisine, cuisine_key, created_at, updated_at, deleted_at)
            SELECT id, logged_on, meal, source_kind, fdc_id, recipe_id, custom_food_id,
                   supplement_id, NULL, description, grams, units, gross_g, tare_g, tare_note,
                   origin, cuisine, cuisine_key, created_at, updated_at, deleted_at
            FROM log_entries;
            DROP TABLE log_entries;
            ALTER TABLE log_entries_migrating RENAME TO log_entries;
            CREATE INDEX IF NOT EXISTS idx_log_day
              ON log_entries(logged_on) WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_log_cuisine ON log_entries(cuisine_key)
              WHERE deleted_at IS NULL AND cuisine_key IS NOT NULL;
            "#,
        )
        .map_err(|e| format!("migrating log_entries to v10: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // v10 -> v11: a sixth source, so an entry can point at a pot that was
    // actually made rather than at the recipe it came from.
    //
    // `recipe_id` stays and keeps working. The two are different claims, not
    // successive versions of one: a recipe entry portions the batch as written,
    // a cook entry portions the batch that existed, and on a day you followed
    // the recipe there is nothing to adjust and no reason to open a cook sheet.
    //
    // Rows predating this all point at one of the five older sources, hence
    // NULL. The `cooks` table needs no arm — CREATE TABLE IF NOT EXISTS in
    // SCHEMA makes it on open, which is also why the new FK has something to
    // point at.
    if !columns(conn, "log_entries")?.iter().any(|c| c == "cook_id") {
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE log_entries_migrating (
              id          TEXT PRIMARY KEY,
              logged_on   TEXT NOT NULL,
              meal        TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
              source_kind TEXT NOT NULL DEFAULT 'food'
                            CHECK (source_kind IN ('food','recipe','cook','custom','supplement','water')),
              fdc_id      INTEGER,
              recipe_id   TEXT REFERENCES recipes(id),
              cook_id     TEXT REFERENCES cooks(id),
              custom_food_id TEXT REFERENCES custom_foods(id),
              supplement_id  TEXT REFERENCES supplements(id),
              bottle_id      TEXT REFERENCES bottles(id),
              description TEXT NOT NULL,
              grams       REAL,
              units       REAL,
              gross_g     REAL,
              tare_g      REAL,
              tare_note   TEXT,
              origin      TEXT CHECK (origin IS NULL OR
                            origin IN ('home','ordered_in','eaten_out','packaged')),
              cuisine     TEXT,
              cuisine_key TEXT,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              deleted_at  TEXT,
              CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
              CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
              CHECK ((source_kind = 'cook')   = (cook_id   IS NOT NULL)),
              CHECK ((source_kind = 'custom') = (custom_food_id IS NOT NULL)),
              CHECK ((source_kind = 'supplement') = (supplement_id IS NOT NULL)),
              CHECK ((source_kind = 'water') = (bottle_id IS NOT NULL)),
              CHECK ((source_kind = 'supplement') = (grams IS NULL)),
              CHECK ((source_kind = 'supplement') = (units IS NOT NULL)),
              CHECK (grams IS NULL OR grams > 0),
              CHECK (units IS NULL OR units > 0),
              CHECK (grams IS NOT NULL OR gross_g IS NULL),
              CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
              CHECK (gross_g IS NULL OR gross_g > tare_g),
              CHECK ((cuisine IS NULL) = (cuisine_key IS NULL))
            );
            INSERT INTO log_entries_migrating
              (id, logged_on, meal, source_kind, fdc_id, recipe_id, cook_id, custom_food_id,
               supplement_id, bottle_id, description, grams, units, gross_g, tare_g, tare_note,
               origin, cuisine, cuisine_key, created_at, updated_at, deleted_at)
            SELECT id, logged_on, meal, source_kind, fdc_id, recipe_id, NULL, custom_food_id,
                   supplement_id, bottle_id, description, grams, units, gross_g, tare_g, tare_note,
                   origin, cuisine, cuisine_key, created_at, updated_at, deleted_at
            FROM log_entries;
            DROP TABLE log_entries;
            ALTER TABLE log_entries_migrating RENAME TO log_entries;
            CREATE INDEX IF NOT EXISTS idx_log_day
              ON log_entries(logged_on) WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_log_cuisine ON log_entries(cuisine_key)
              WHERE deleted_at IS NULL AND cuisine_key IS NOT NULL;
            "#,
        )
        .map_err(|e| format!("migrating log_entries to v11: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // v11 -> v12: `meal` becomes nullable, and water is required to have no
    // meal at all.
    //
    // Water was logged through the food screen, meal picker included, which
    // asked which sitting a bottle belonged to. There is no answer: a bottle is
    // refilled and drunk from across the whole day. Whatever the picker
    // happened to be defaulted to by the clock got stored as if the user had
    // said it, which is the same class of invention as a nutrient stored as 0
    // when it was only unmeasured.
    //
    // The existing water rows have that meal cleared rather than carried over.
    // It is not a rewrite of anything the user stated — the value was the
    // form's, never theirs — and the new biconditional CHECK could not admit
    // those rows otherwise. Nothing about what was drunk changes: `grams`,
    // `gross_g`, `tare_g` and the frozen nutrient values are copied across
    // untouched, so every past day still totals exactly what it did.
    //
    // Guarded on the column's own declaration rather than on a new column,
    // since a migration that only loosens a constraint adds nothing to look
    // for. See `column_is_not_null`.
    if column_is_not_null(conn, "log_entries", "meal")? {
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE log_entries_migrating (
              id          TEXT PRIMARY KEY,
              logged_on   TEXT NOT NULL,
              meal        TEXT CHECK (meal IS NULL OR
                            meal IN ('breakfast','lunch','dinner','snack')),
              source_kind TEXT NOT NULL DEFAULT 'food'
                            CHECK (source_kind IN ('food','recipe','cook','custom','supplement','water')),
              fdc_id      INTEGER,
              recipe_id   TEXT REFERENCES recipes(id),
              cook_id     TEXT REFERENCES cooks(id),
              custom_food_id TEXT REFERENCES custom_foods(id),
              supplement_id  TEXT REFERENCES supplements(id),
              bottle_id      TEXT REFERENCES bottles(id),
              description TEXT NOT NULL,
              grams       REAL,
              units       REAL,
              gross_g     REAL,
              tare_g      REAL,
              tare_note   TEXT,
              origin      TEXT CHECK (origin IS NULL OR
                            origin IN ('home','ordered_in','eaten_out','packaged')),
              cuisine     TEXT,
              cuisine_key TEXT,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              deleted_at  TEXT,
              CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
              CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
              CHECK ((source_kind = 'cook')   = (cook_id   IS NOT NULL)),
              CHECK ((source_kind = 'custom') = (custom_food_id IS NOT NULL)),
              CHECK ((source_kind = 'supplement') = (supplement_id IS NOT NULL)),
              CHECK ((source_kind = 'water') = (bottle_id IS NOT NULL)),
              CHECK ((source_kind = 'water') = (meal IS NULL)),
              CHECK ((source_kind = 'supplement') = (grams IS NULL)),
              CHECK ((source_kind = 'supplement') = (units IS NOT NULL)),
              CHECK (grams IS NULL OR grams > 0),
              CHECK (units IS NULL OR units > 0),
              CHECK (grams IS NOT NULL OR gross_g IS NULL),
              CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
              CHECK (gross_g IS NULL OR gross_g > tare_g),
              CHECK ((cuisine IS NULL) = (cuisine_key IS NULL))
            );
            INSERT INTO log_entries_migrating
              (id, logged_on, meal, source_kind, fdc_id, recipe_id, cook_id, custom_food_id,
               supplement_id, bottle_id, description, grams, units, gross_g, tare_g, tare_note,
               origin, cuisine, cuisine_key, created_at, updated_at, deleted_at)
            SELECT id, logged_on,
                   CASE WHEN source_kind = 'water' THEN NULL ELSE meal END,
                   source_kind, fdc_id, recipe_id, cook_id, custom_food_id,
                   supplement_id, bottle_id, description, grams, units, gross_g, tare_g, tare_note,
                   origin, cuisine, cuisine_key, created_at, updated_at, deleted_at
            FROM log_entries;
            DROP TABLE log_entries;
            ALTER TABLE log_entries_migrating RENAME TO log_entries;
            CREATE INDEX IF NOT EXISTS idx_log_day
              ON log_entries(logged_on) WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_log_cuisine ON log_entries(cuisine_key)
              WHERE deleted_at IS NULL AND cuisine_key IS NOT NULL;
            "#,
        )
        .map_err(|e| format!("migrating log_entries to v12: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
    }

    // Not in SCHEMA, for the reason `idx_log_cuisine` is not: SCHEMA runs
    // before this function, so on a database still in an older shape the
    // column this indexes does not exist yet and the whole batch would fail.
    // It matters here — `logged_from_cook` runs this lookup once per open pot
    // every time the Available list is drawn.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_log_cook ON log_entries(cook_id)
           WHERE deleted_at IS NULL AND cook_id IS NOT NULL;",
    )
    .map_err(|e| e.to_string())?;

    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// What one log entry points at. Exactly one, which is why this is an enum and
/// not four nullable parameters: the invalid combinations are unrepresentable
/// rather than merely rejected.
#[derive(Debug, Clone, Copy)]
pub enum Source<'a> {
    Food(i64),
    Recipe(&'a str),
    /// A portion of a pot that was actually made. Kept beside `Recipe` rather
    /// than replacing it: the two portion different things, and the batch as
    /// written is still the right answer on a day you followed it.
    Cook(&'a str),
    Custom(&'a str),
    Supplement(&'a str),
    Water(&'a str),
}

impl Source<'_> {
    fn kind(&self) -> &'static str {
        match self {
            Source::Food(_) => "food",
            Source::Recipe(_) => "recipe",
            Source::Cook(_) => "cook",
            Source::Custom(_) => "custom",
            Source::Supplement(_) => "supplement",
            Source::Water(_) => "water",
        }
    }
}

/// How much of it. A dose is counted and a food is weighed, and the two are
/// separate variants so that no call site can supply a mass for a tablet.
#[derive(Debug, Clone, Copy)]
pub enum Quantity {
    Grams(f64),
    Units(f64),
}

/// The user's own answer about where a dish came from. Both fields are optional
/// because "not recorded" is a real state and is not any of the answers.
#[derive(Debug, Clone, Default)]
pub struct Tags {
    pub origin: Option<String>,
    pub cuisine: Option<String>,
}

/// The four origins a dish can have. Mirrors the table's CHECK so a bad value
/// is refused with a sentence rather than a constraint code.
const ORIGINS: [&str; 4] = ["home", "ordered_in", "eaten_out", "packaged"];

pub fn check_origin(origin: Option<&str>) -> Result<(), String> {
    match origin {
        None => Ok(()),
        Some(o) if ORIGINS.contains(&o) => Ok(()),
        Some(o) => Err(format!(
            "“{o}” is not one of the origins this app records ({})",
            ORIGINS.join(", ")
        )),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn add(
    conn: &Connection,
    logged_on: &str,
    // `None` only for water. Everything else was had at a sitting.
    meal: Option<&str>,
    source: Source<'_>,
    description: &str,
    quantity: Quantity,
    tare: Option<&Tare>,
    tags: &Tags,
) -> Result<String, String> {
    let kind = source.kind();
    // Checked here as well as in SQL, for the reason the counted-xor-weighed
    // pair above is: the table can only answer with a constraint code, and the
    // caller deserves a sentence.
    match (meal, source) {
        (Some(_), Source::Water(_)) => {
            return Err("water is drunk across the day, so it is not logged against a meal".into())
        }
        (None, s) if !matches!(s, Source::Water(_)) => {
            return Err(format!("a {} has to say which meal it was part of", s.kind()))
        }
        _ => {}
    }
    // Counted xor weighed, checked here as well as in SQL: the table can only
    // answer with a constraint code, and the caller deserves a sentence.
    let (grams, units) = match (quantity, source) {
        (Quantity::Grams(_), Source::Supplement(_)) => {
            return Err("a supplement is taken by count, not by weight".into())
        }
        (Quantity::Units(_), s) if !matches!(s, Source::Supplement(_)) => {
            return Err(format!("a {} is logged by weight, not by count", s.kind()))
        }
        (Quantity::Grams(g), _) => {
            if !(g.is_finite() && g > 0.0) {
                return Err("grams must be a positive number".into());
            }
            (Some(g), None)
        }
        (Quantity::Units(u), _) => {
            if !(u.is_finite() && u > 0.0) {
                return Err("the dose must be a positive number".into());
            }
            (None, Some(u))
        }
    };
    check_origin(tags.origin.as_deref())?;
    let cuisine = opt_trim(tags.cuisine.as_ref());
    let cuisine_key = cuisine.as_deref().map(folded);

    let (fdc_id, recipe_id, cook_id, custom_food_id, supplement_id, bottle_id) = match source {
        Source::Food(id) => (Some(id), None, None, None, None, None),
        Source::Recipe(id) => (None, Some(id), None, None, None, None),
        Source::Cook(id) => (None, None, Some(id), None, None, None),
        Source::Custom(id) => (None, None, None, Some(id), None, None),
        Source::Supplement(id) => (None, None, None, None, Some(id), None),
        Source::Water(id) => (None, None, None, None, None, Some(id)),
    };
    // The gross/tare/net invariant is checked where the row is written, not
    // only in the UI: a caller that has already done the subtraction wrong must
    // not be able to store a net weight that disagrees with its own provenance.
    if let Some(t) = tare {
        // A tare is the provenance of a mass. Attached to something that has no
        // mass it describes nothing, so it is refused rather than stored.
        let Some(net) = grams else {
            return Err("a dose does not come off a scale, so it cannot carry a tare".into());
        };
        if !t.gross_g.is_finite() || !t.tare_g.is_finite() {
            return Err("the scale reading and the tare must both be numbers".into());
        }
        if (t.gross_g - t.tare_g - net).abs() > 0.05 {
            return Err(format!(
                "{} g on the scale less {} g of vessels is not {} g",
                t.gross_g, t.tare_g, net
            ));
        }
    }
    let id = new_id(conn)?;
    let now = now_iso(conn)?;
    conn.execute(
        "INSERT INTO log_entries
           (id, logged_on, meal, source_kind, fdc_id, recipe_id, cook_id, custom_food_id,
            supplement_id, bottle_id, description, grams, units, gross_g, tare_g, tare_note,
            origin, cuisine, cuisine_key, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?20)",
        rusqlite::params![
            id,
            logged_on,
            meal,
            kind,
            fdc_id,
            recipe_id,
            cook_id,
            custom_food_id,
            supplement_id,
            bottle_id,
            description,
            grams,
            units,
            tare.map(|t| t.gross_g),
            tare.map(|t| t.tare_g),
            tare.map(|t| t.note.as_str()),
            tags.origin.as_deref(),
            cuisine,
            cuisine_key,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Insert when `id` is None, update in place when it is Some — one entry point
/// for adding a vessel and for re-weighing one.
pub fn save_vessel(
    conn: &Connection,
    id: Option<&str>,
    name: &str,
    grams: f64,
) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("a vessel needs a name".into());
    }
    if !(grams.is_finite() && grams > 0.0) {
        return Err("a vessel's empty weight must be a positive number".into());
    }
    let now = now_iso(conn)?;
    match id {
        Some(existing) => {
            let n = conn
                .execute(
                    "UPDATE vessels SET name = ?2, grams = ?3, updated_at = ?4
                     WHERE id = ?1 AND deleted_at IS NULL",
                    rusqlite::params![existing, name.trim(), grams, now],
                )
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(format!("vessel {existing} is not in the library"));
            }
            Ok(existing.to_string())
        }
        None => {
            let new = new_id(conn)?;
            conn.execute(
                "INSERT INTO vessels (id, name, grams, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?4)",
                rusqlite::params![new, name.trim(), grams, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(new)
        }
    }
}

/// Most recently used first, never-used last, alphabetical within each.
pub fn list_vessels(conn: &Connection) -> Result<Vec<Vessel>, String> {
    let mut stmt = conn
        .prepare(
            // SQLite sorts NULLs last under DESC, which puts a vessel that has
            // never been used behind every one that has.
            "SELECT id, name, grams, last_used_at FROM vessels
             WHERE deleted_at IS NULL ORDER BY last_used_at DESC, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Vessel {
                id: r.get(0)?,
                name: r.get(1)?,
                grams: r.get(2)?,
                last_used_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn delete_vessel(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    // Soft delete, matching recipes: past days keep the `tare_note` they were
    // logged with, and a future sync can propagate the deletion.
    conn.execute(
        "UPDATE vessels SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve ids to live vessels, preserving the given order. Errors if any id is
/// unknown or deleted, so a stale client can never silently log an untared weight.
pub fn vessels_by_id(conn: &Connection, ids: &[String]) -> Result<Vec<Vessel>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, grams, last_used_at FROM vessels
             WHERE id = ?1 AND deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let v = stmt
            .query_row([id], |r| {
                Ok(Vessel {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    grams: r.get(2)?,
                    last_used_at: r.get(3)?,
                })
            })
            .map_err(|_| format!("vessel {id} is no longer in the library"))?;
        out.push(v);
    }
    Ok(out)
}

/// Turn a scale reading and the vessels under it into a net weight.
///
/// Returns `(net_g, tare_g, note)`. The vessel names are joined into a note so
/// the caller can denormalise them: deleting a vessel must never retroactively
/// change what something was recorded as weighing.
///
/// Only ids reach here, and the weights are read from the library — a caller
/// holding a stale figure cannot write a net the library disagrees with. No
/// vessels at all is legitimate: an untared scale with nothing under the food
/// has a tare of zero.
pub fn weigh(
    conn: &Connection,
    gross_g: f64,
    ids: &[String],
) -> Result<(f64, f64, Option<String>), String> {
    let vessels = vessels_by_id(conn, ids)?;
    let tare_g: f64 = vessels.iter().map(|v| v.grams).sum();
    let note = if vessels.is_empty() {
        None
    } else {
        Some(
            vessels
                .iter()
                .map(|v| v.name.as_str())
                .collect::<Vec<_>>()
                .join(" + "),
        )
    };
    let net_g = gross_g - tare_g;
    if !(net_g.is_finite() && net_g > 0.0) {
        return Err(format!(
            "the scale read {gross_g:.1} g and the vessels weigh {tare_g:.1} g, \
             which leaves nothing to weigh"
        ));
    }
    Ok((net_g, tare_g, note))
}

pub fn touch_vessels(conn: &Connection, ids: &[String]) -> Result<(), String> {
    let now = now_iso(conn)?;
    for id in ids {
        conn.execute(
            "UPDATE vessels SET last_used_at = ?2, updated_at = ?2 WHERE id = ?1",
            rusqlite::params![id, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Insert when `id` is None, update in place when it is Some — one entry point
/// for adding a bottle and for re-weighing one full.
pub fn save_bottle(
    conn: &Connection,
    id: Option<&str>,
    name: &str,
    full_g: f64,
) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("a bottle needs a name".into());
    }
    if !(full_g.is_finite() && full_g > 0.0) {
        return Err("a bottle's full weight must be a positive number".into());
    }
    let now = now_iso(conn)?;
    match id {
        Some(existing) => {
            let n = conn
                .execute(
                    "UPDATE bottles SET name = ?2, full_g = ?3, updated_at = ?4
                     WHERE id = ?1 AND deleted_at IS NULL",
                    rusqlite::params![existing, name.trim(), full_g, now],
                )
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(format!("bottle {existing} is not in the library"));
            }
            Ok(existing.to_string())
        }
        None => {
            let new = new_id(conn)?;
            conn.execute(
                "INSERT INTO bottles (id, name, full_g, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?4)",
                rusqlite::params![new, name.trim(), full_g, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(new)
        }
    }
}

/// Most recently used first, never-used last, alphabetical within each.
pub fn list_bottles(conn: &Connection) -> Result<Vec<Bottle>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, full_g, last_used_at FROM bottles
             WHERE deleted_at IS NULL ORDER BY last_used_at DESC, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Bottle {
                id: r.get(0)?,
                name: r.get(1)?,
                full_g: r.get(2)?,
                last_used_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn delete_bottle(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    // Soft delete, matching vessels: past days keep the bottle name they were
    // logged with, and a future sync can propagate the deletion.
    conn.execute(
        "UPDATE bottles SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve one id to a live bottle. Errors if it is unknown or deleted, so a
/// stale client can never silently log against a full weight the library no
/// longer stands behind.
pub fn get_bottle(conn: &Connection, id: &str) -> Result<Bottle, String> {
    conn.query_row(
        "SELECT id, name, full_g, last_used_at FROM bottles
         WHERE id = ?1 AND deleted_at IS NULL",
        [id],
        |r| {
            Ok(Bottle {
                id: r.get(0)?,
                name: r.get(1)?,
                full_g: r.get(2)?,
                last_used_at: r.get(3)?,
            })
        },
    )
    .map_err(|_| format!("bottle {id} is no longer in the library"))
}

pub fn touch_bottle(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    conn.execute(
        "UPDATE bottles SET last_used_at = ?2, updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save_recipe(
    conn: &mut Connection,
    name: &str,
    yield_g: f64,
    servings: Option<f64>,
    notes: Option<&str>,
    ingredients: &[RecipeIngredient],
    serving_options: &[RecipeServing],
    defaults: &Tags,
) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("a recipe needs a name".into());
    }
    check_origin(defaults.origin.as_deref())?;
    if !(yield_g.is_finite() && yield_g > 0.0) {
        return Err("a recipe's reference batch must be a positive weight".into());
    }
    // Absent is fine and is the normal case. A number that was offered has to
    // be usable, though: a servings of 0 or NaN would sail past the column's
    // CHECK as a NULL never could, and would divide something later.
    if servings.is_some_and(|s| !(s.is_finite() && s > 0.0)) {
        return Err("if a recipe says how many it feeds, it must be a positive number".into());
    }
    if ingredients.is_empty() {
        return Err("a recipe needs at least one ingredient".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = new_id(&tx)?;
    let now = now_iso(&tx)?;
    tx.execute(
        "INSERT INTO recipes
           (id,name,yield_g,servings,notes,default_origin,default_cuisine,
            created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)",
        rusqlite::params![
            id,
            name.trim(),
            yield_g,
            servings,
            notes,
            defaults.origin.as_deref(),
            opt_trim(defaults.cuisine.as_ref()),
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    for (i, ing) in ingredients.iter().enumerate() {
        let iid = new_id(&tx)?;
        tx.execute(
            "INSERT INTO recipe_ingredients
               (id,recipe_id,position,fdc_id,description,raw_g,cooked_g,optional)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                iid,
                id,
                i as i64,
                ing.fdc_id,
                ing.description,
                ing.raw_g,
                ing.cooked_g,
                ing.optional as i64
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for so in serving_options {
        let sid = new_id(&tx)?;
        tx.execute(
            "INSERT INTO recipe_servings (id,recipe_id,label,grams) VALUES (?1,?2,?3,?4)",
            rusqlite::params![sid, id, so.label, so.grams],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Fetch a recipe for the picker and the recipe list. Soft-deleted recipes are
/// excluded — you should not be able to log one you have deleted.
pub fn get_recipe(conn: &Connection, id: &str) -> Result<Recipe, String> {
    get_recipe_inner(conn, id, false)
}

/// Fetch a recipe to expand a log entry that already references it, INCLUDING
/// one that has since been deleted.
///
/// Deleting a recipe must not retroactively break days that used it. Without
/// this, expansion would fail and the whole day would fail to load — history
/// disappearing because of an edit made today.
pub fn get_recipe_for_history(conn: &Connection, id: &str) -> Result<Recipe, String> {
    get_recipe_inner(conn, id, true)
}

fn get_recipe_inner(conn: &Connection, id: &str, include_deleted: bool) -> Result<Recipe, String> {
    let sql = if include_deleted {
        "SELECT name, yield_g, servings, notes, default_origin, default_cuisine
         FROM recipes WHERE id = ?1"
    } else {
        "SELECT name, yield_g, servings, notes, default_origin, default_cuisine
         FROM recipes WHERE id = ?1 AND deleted_at IS NULL"
    };
    let (name, yield_g, servings, notes, default_origin, default_cuisine) = conn
        .query_row(sql, [id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| format!("recipe {id}: {e}"))?;

    let mut istmt = conn
        .prepare(
            "SELECT id, position, fdc_id, description, raw_g, cooked_g, optional
             FROM recipe_ingredients WHERE recipe_id = ?1 ORDER BY position",
        )
        .map_err(|e| e.to_string())?;
    let ingredients = istmt
        .query_map([id], |r| {
            Ok(RecipeIngredient {
                id: r.get(0)?,
                position: r.get(1)?,
                fdc_id: r.get(2)?,
                description: r.get(3)?,
                raw_g: r.get(4)?,
                cooked_g: r.get(5)?,
                optional: r.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut sstmt = conn
        .prepare("SELECT id, label, grams FROM recipe_servings WHERE recipe_id = ?1 ORDER BY grams")
        .map_err(|e| e.to_string())?;
    let serving_options = sstmt
        .query_map([id], |r| {
            Ok(RecipeServing {
                id: r.get(0)?,
                label: r.get(1)?,
                grams: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(Recipe {
        id: id.to_string(),
        name,
        yield_g,
        servings,
        notes,
        default_origin,
        default_cuisine,
        ingredients,
        serving_options,
    })
}

pub fn list_recipes(conn: &Connection) -> Result<Vec<Recipe>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM recipes WHERE deleted_at IS NULL ORDER BY name")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    ids.iter().map(|i| get_recipe(conn, i)).collect()
}

// ---------------------------------------------------------------------------
// Cooks — one pot, actually made
// ---------------------------------------------------------------------------

/// Everything a cook is saved with. A struct rather than a dozen arguments
/// because the invalid combinations — a tare with no reading, a scale of zero —
/// are all checked in one place below.
#[derive(Debug, Clone, Default)]
pub struct CookInput {
    pub recipe_id: Option<String>,
    pub name: String,
    pub cooked_on: String,
    pub scale: f64,
    /// The scale reading with the pot on it, and the vessels under it. Only
    /// ids cross this boundary: the weights are re-summed here, so a screen
    /// holding a stale figure cannot write a yield the library disagrees with.
    pub gross_g: Option<f64>,
    pub vessel_ids: Vec<String>,
    /// A yield typed straight in, for a pot weighed on someone else's scale.
    /// Ignored when `gross_g` is given — a reading and its tare are the better
    /// record, and two sources for one number is how they drift apart.
    pub weighed_yield_g: Option<f64>,
    pub notes: Option<String>,
    pub defaults: Tags,
    pub ingredients: Vec<CookIngredient>,
}

/// What the screen sends when it saves a pot.
///
/// Separate from [`CookInput`] because this is the wire shape: it is what the
/// frontend serialises, so its field names are the ones the TypeScript side
/// writes, and only ids for the vessels — never their weights.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookDraft {
    pub recipe_id: Option<String>,
    pub name: String,
    pub cooked_on: String,
    pub scale: f64,
    pub gross_g: Option<f64>,
    #[serde(default)]
    pub vessel_ids: Vec<String>,
    pub weighed_yield_g: Option<f64>,
    pub notes: Option<String>,
    pub origin: Option<String>,
    pub cuisine: Option<String>,
    pub ingredients: Vec<CookIngredient>,
}

impl CookDraft {
    pub fn into_input(self) -> CookInput {
        CookInput {
            recipe_id: self.recipe_id,
            name: self.name,
            cooked_on: self.cooked_on,
            scale: self.scale,
            gross_g: self.gross_g,
            vessel_ids: self.vessel_ids,
            weighed_yield_g: self.weighed_yield_g,
            notes: self.notes,
            defaults: Tags {
                origin: self.origin,
                cuisine: self.cuisine,
            },
            ingredients: self.ingredients,
        }
    }
}

/// Save a pot, new or edited.
///
/// Unlike a recipe, a cook **is** editable in place: you add the second onion
/// half an hour after the first, and re-weigh the pot when it comes off the
/// heat. What must not move is anything already logged from it — and nothing
/// can, because an entry's nutrition was frozen at the moment it was written
/// and no read path reaches back through this table.
pub fn save_cook(
    conn: &mut Connection,
    id: Option<&str>,
    input: &CookInput,
) -> Result<String, String> {
    if input.name.trim().is_empty() {
        return Err("a cook needs a name".into());
    }
    check_origin(input.defaults.origin.as_deref())?;
    if !(input.scale.is_finite() && input.scale > 0.0) {
        return Err("the batch scale must be a positive number".into());
    }
    if input.ingredients.is_empty() {
        return Err("a cook needs at least one ingredient".into());
    }
    // Zero is allowed — it is how "left out" is written — but a negative or a
    // NaN would sail past the column CHECK on the NaN and mean nothing on the
    // negative.
    for ing in &input.ingredients {
        for (what, v) in [
            ("planned", ing.planned_g),
            ("raw", ing.raw_g),
            ("cooked", ing.cooked_g),
        ] {
            if !(v.is_finite() && v >= 0.0) {
                return Err(format!(
                    "“{}” has a {what} weight that is not a number at or above zero",
                    ing.description
                ));
            }
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_iso(&tx)?;

    // The yield, resolved once. A gross reading wins over a typed figure
    // because it carries its own provenance; `weigh` refuses a tare that
    // exceeds the reading, so an impossible pot is rejected rather than stored
    // as a negative.
    let (weighed_yield_g, gross_g, tare_g, tare_note) = match input.gross_g {
        Some(gross) => {
            let (net, tare, note) = weigh(&tx, gross, &input.vessel_ids)?;
            (Some(net), Some(gross), Some(tare), note)
        }
        None => match input.weighed_yield_g {
            Some(y) if y.is_finite() && y > 0.0 => (Some(y), None, None, None),
            Some(_) => return Err("a weighed yield must be a positive number".into()),
            None => (None, None, None, None),
        },
    };

    let id = match id {
        Some(existing) => {
            let n = tx
                .execute(
                    "UPDATE cooks SET recipe_id=?2, name=?3, cooked_on=?4, scale=?5,
                        weighed_yield_g=?6, gross_g=?7, tare_g=?8, tare_note=?9,
                        default_origin=?10, default_cuisine=?11, notes=?12, updated_at=?13
                     WHERE id=?1 AND deleted_at IS NULL",
                    rusqlite::params![
                        existing,
                        input.recipe_id,
                        input.name.trim(),
                        input.cooked_on,
                        input.scale,
                        weighed_yield_g,
                        gross_g,
                        tare_g,
                        tare_note,
                        input.defaults.origin.as_deref(),
                        opt_trim(input.defaults.cuisine.as_ref()),
                        opt_trim(input.notes.as_ref()),
                        now
                    ],
                )
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(format!("cook {existing} is not there to update"));
            }
            tx.execute("DELETE FROM cook_ingredients WHERE cook_id = ?1", [existing])
                .map_err(|e| e.to_string())?;
            existing.to_string()
        }
        None => {
            let fresh = new_id(&tx)?;
            tx.execute(
                "INSERT INTO cooks
                   (id,recipe_id,name,cooked_on,cooked_at,scale,
                    weighed_yield_g,gross_g,tare_g,tare_note,
                    default_origin,default_cuisine,notes,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",
                rusqlite::params![
                    fresh,
                    input.recipe_id,
                    input.name.trim(),
                    input.cooked_on,
                    now,
                    input.scale,
                    weighed_yield_g,
                    gross_g,
                    tare_g,
                    tare_note,
                    input.defaults.origin.as_deref(),
                    opt_trim(input.defaults.cuisine.as_ref()),
                    opt_trim(input.notes.as_ref()),
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
            fresh
        }
    };

    for (i, ing) in input.ingredients.iter().enumerate() {
        let iid = new_id(&tx)?;
        tx.execute(
            "INSERT INTO cook_ingredients
               (id,cook_id,position,fdc_id,description,planned_g,raw_g,cooked_g,substituted_for)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![
                iid,
                id,
                i as i64,
                ing.fdc_id,
                ing.description,
                ing.planned_g,
                ing.raw_g,
                ing.cooked_g,
                opt_trim(ing.substituted_for.as_ref())
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn get_cook(conn: &Connection, id: &str) -> Result<Cook, String> {
    get_cook_inner(conn, id, false)
}

/// Read a cook that may have been deleted.
///
/// Valuing an entry logged from a pot that has since been thrown away must
/// still work — the same reason `get_recipe_for_history` exists. Only history
/// may use it; the live screens must not show a deleted pot.
pub fn get_cook_for_history(conn: &Connection, id: &str) -> Result<Cook, String> {
    get_cook_inner(conn, id, true)
}

fn get_cook_inner(conn: &Connection, id: &str, include_deleted: bool) -> Result<Cook, String> {
    let sql = if include_deleted {
        "SELECT recipe_id, name, cooked_on, cooked_at, scale, weighed_yield_g,
                gross_g, tare_g, tare_note, default_origin, default_cuisine, notes, finished_at
         FROM cooks WHERE id = ?1"
    } else {
        "SELECT recipe_id, name, cooked_on, cooked_at, scale, weighed_yield_g,
                gross_g, tare_g, tare_note, default_origin, default_cuisine, notes, finished_at
         FROM cooks WHERE id = ?1 AND deleted_at IS NULL"
    };
    let mut cook = conn
        .query_row(sql, [id], |r| {
            Ok(Cook {
                id: id.to_string(),
                recipe_id: r.get(0)?,
                name: r.get(1)?,
                cooked_on: r.get(2)?,
                cooked_at: r.get(3)?,
                scale: r.get(4)?,
                weighed_yield_g: r.get(5)?,
                gross_g: r.get(6)?,
                tare_g: r.get(7)?,
                tare_note: r.get(8)?,
                default_origin: r.get(9)?,
                default_cuisine: r.get(10)?,
                notes: r.get(11)?,
                finished_at: r.get(12)?,
                ingredients: Vec::new(),
                logged_g: 0.0,
                yield_g: 0.0,
                remaining_g: 0.0,
            })
        })
        .map_err(|e| format!("cook {id}: {e}"))?;

    let mut istmt = conn
        .prepare(
            "SELECT id, position, fdc_id, description, planned_g, raw_g, cooked_g, substituted_for
             FROM cook_ingredients WHERE cook_id = ?1 ORDER BY position",
        )
        .map_err(|e| e.to_string())?;
    cook.ingredients = istmt
        .query_map([id], |r| {
            Ok(CookIngredient {
                id: r.get(0)?,
                position: r.get(1)?,
                fdc_id: r.get(2)?,
                description: r.get(3)?,
                planned_g: r.get(4)?,
                raw_g: r.get(5)?,
                cooked_g: r.get(6)?,
                substituted_for: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    cook.logged_g = logged_from_cook(conn, id)?;
    Ok(cook.seal())
}

/// How much of a pot has already been eaten, summed from the log.
///
/// Derived rather than stored. A counter would have to be decremented on every
/// delete and correction, and the first one it missed would leave the fridge
/// disagreeing with the diary — so the log stays the only record of what left
/// the pot.
fn logged_from_cook(conn: &Connection, cook_id: &str) -> Result<f64, String> {
    // COALESCE, because SUM over no rows is NULL rather than 0 — the one place
    // a `?? 0` is right, since "nothing logged" really is nothing eaten.
    conn.query_row(
        "SELECT COALESCE(SUM(grams), 0) FROM log_entries
         WHERE cook_id = ?1 AND deleted_at IS NULL",
        [cook_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Pots with food still in them, newest first. What "Available foods" lists.
pub fn list_open_cooks(conn: &Connection) -> Result<Vec<Cook>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM cooks
             WHERE deleted_at IS NULL AND finished_at IS NULL
             ORDER BY cooked_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    ids.iter().map(|i| get_cook(conn, i)).collect()
}

/// Mark a pot empty, or unmark it.
///
/// Always the user's own act. Nothing closes a pot because the arithmetic says
/// it is nearly gone: the yield is an estimate and four grams left is not a
/// claim about the fridge. Re-opening is allowed because "I found more of it"
/// is a thing that happens.
pub fn finish_cook(conn: &Connection, id: &str, finished: bool) -> Result<(), String> {
    let now = now_iso(conn)?;
    let n = conn
        .execute(
            "UPDATE cooks SET finished_at = ?2, updated_at = ?3
             WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id, if finished { Some(&now) } else { None }, now],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("cook {id} is not there to close"));
    }
    Ok(())
}

/// Soft delete, like every other user record here: days that already drew on
/// this pot keep their entries, and a future sync can see the deletion.
pub fn delete_cook(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    conn.execute(
        "UPDATE cooks SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_recipe(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    conn.execute(
        "UPDATE recipes SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Trim an optional text field, treating a field the user left blank as absent.
/// A brand stored as `""` would print as a brand and sort as one.
fn opt_trim(v: Option<&String>) -> Option<String> {
    v.map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Reject a nutrient row a label could not have produced, before SQLite does.
/// The CHECKs on `custom_food_nutrients` would catch all of this, but they
/// report a constraint code; the person transcribing a pack deserves a sentence.
fn check_nutrient(n: &CustomNutrient) -> Result<(), String> {
    if !LABEL_KINDS.contains(&n.kind.as_str()) {
        return Err(format!(
            "nutrient {}: a pack can print a number, a zero, a \"less than\" or a trace — not {:?}",
            n.nutrient_id, n.kind
        ));
    }
    if let Some(a) = n.amount {
        if !a.is_finite() || a < 0.0 {
            return Err(format!(
                "nutrient {}: a printed amount must be zero or more",
                n.nutrient_id
            ));
        }
    }
    if let Some(u) = n.upper {
        if !u.is_finite() || u <= 0.0 {
            return Err(format!(
                "nutrient {}: an upper bound must be a positive number",
                n.nutrient_id
            ));
        }
    }
    // A measured value is a point and a bound is an interval; carrying both, or
    // neither, would leave the panel unable to say which it is.
    if n.kind == "measured" {
        if n.amount.is_none() {
            return Err(format!(
                "nutrient {}: a printed value needs the number that is printed",
                n.nutrient_id
            ));
        }
        if n.upper.is_some() {
            return Err(format!(
                "nutrient {}: a printed value is a number, not a bound",
                n.nutrient_id
            ));
        }
    } else {
        if n.upper.is_none() {
            return Err(format!(
                "nutrient {}: a {} value needs the bound it sits under",
                n.nutrient_id, n.kind
            ));
        }
        if n.amount.is_some() {
            return Err(format!(
                "nutrient {}: a {} value is a bound, not a number",
                n.nutrient_id, n.kind
            ));
        }
    }
    Ok(())
}

/// Insert when `id` is None, replace in place when Some — one entry point for
/// creating a food and for editing one. Nutrient rows are replaced wholesale
/// inside the transaction, so an edit that drops a line really drops it: a row
/// left behind would keep asserting a value the pack no longer says.
pub fn save_custom_food(
    conn: &mut Connection,
    id: Option<&str>,
    f: &CustomFood,
) -> Result<String, String> {
    if f.name.trim().is_empty() {
        return Err("a custom food needs a name".into());
    }
    if !(f.serving_g.is_finite() && f.serving_g > 0.0) {
        return Err(
            "a serving must weigh a positive number of grams: the label's figures are per serving"
                .into(),
        );
    }
    let mut seen: Vec<i64> = Vec::with_capacity(f.nutrients.len());
    for n in &f.nutrients {
        check_nutrient(n)?;
        if seen.contains(&n.nutrient_id) {
            return Err(format!(
                "nutrient {} is listed twice; a pack prints each line once",
                n.nutrient_id
            ));
        }
        seen.push(n.nutrient_id);
    }

    let name = f.name.trim().to_string();
    let brand = opt_trim(f.brand.as_ref());
    let serving_label = opt_trim(f.serving_label.as_ref());
    let ingredients = opt_trim(f.ingredients.as_ref());
    let barcode = opt_trim(f.barcode.as_ref());

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_iso(&tx)?;
    let food_id = match id {
        Some(existing) => {
            let n = tx
                .execute(
                    "UPDATE custom_foods
                       SET name = ?2, brand = ?3, overrides_fdc_id = ?4, serving_g = ?5,
                           serving_label = ?6, ingredients = ?7, barcode = ?8,
                           photo_label = ?9, photo_ingredients = ?10, import_only = ?11,
                           updated_at = ?12
                     WHERE id = ?1 AND deleted_at IS NULL",
                    rusqlite::params![
                        existing,
                        name,
                        brand,
                        f.overrides_fdc_id,
                        f.serving_g,
                        serving_label,
                        ingredients,
                        barcode,
                        f.photo_label,
                        f.photo_ingredients,
                        f.import_only as i64,
                        now
                    ],
                )
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(format!("custom food {existing} is not in your foods"));
            }
            tx.execute(
                "DELETE FROM custom_food_nutrients WHERE food_id = ?1",
                [existing],
            )
            .map_err(|e| e.to_string())?;
            existing.to_string()
        }
        None => {
            let new = new_id(&tx)?;
            tx.execute(
                "INSERT INTO custom_foods
                   (id, name, brand, overrides_fdc_id, serving_g, serving_label,
                    ingredients, barcode, photo_label, photo_ingredients, import_only,
                    created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)",
                rusqlite::params![
                    new,
                    name,
                    brand,
                    f.overrides_fdc_id,
                    f.serving_g,
                    serving_label,
                    ingredients,
                    barcode,
                    f.photo_label,
                    f.photo_ingredients,
                    f.import_only as i64,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
            new
        }
    };

    for n in &f.nutrients {
        let nid = new_id(&tx)?;
        tx.execute(
            "INSERT INTO custom_food_nutrients (id, food_id, nutrient_id, kind, amount, upper)
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![nid, food_id, n.nutrient_id, n.kind, n.amount, n.upper],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(food_id)
}

/// For the picker and search: soft-deleted foods excluded, because you should
/// not be able to log a food you have deleted.
pub fn get_custom_food(conn: &Connection, id: &str) -> Result<CustomFood, String> {
    get_custom_food_inner(conn, id, false)
}

/// To expand a log entry that ALREADY references one, including a food since
/// deleted.
///
/// Deleting a food today must not break a day logged last week — the same
/// hazard `get_recipe_for_history` exists for. Without this, the day's totals
/// would fail to load and history would disappear because of an edit made now.
pub fn get_custom_food_for_history(conn: &Connection, id: &str) -> Result<CustomFood, String> {
    get_custom_food_inner(conn, id, true)
}

fn get_custom_food_inner(
    conn: &Connection,
    id: &str,
    include_deleted: bool,
) -> Result<CustomFood, String> {
    let sql = if include_deleted {
        "SELECT name, brand, overrides_fdc_id, serving_g, serving_label,
                ingredients, barcode, photo_label, photo_ingredients, import_only
         FROM custom_foods WHERE id = ?1"
    } else {
        "SELECT name, brand, overrides_fdc_id, serving_g, serving_label,
                ingredients, barcode, photo_label, photo_ingredients, import_only
         FROM custom_foods WHERE id = ?1 AND deleted_at IS NULL"
    };
    let mut food = conn
        .query_row(sql, [id], |r| {
            Ok(CustomFood {
                id: id.to_string(),
                name: r.get(0)?,
                brand: r.get(1)?,
                overrides_fdc_id: r.get(2)?,
                serving_g: r.get(3)?,
                serving_label: r.get(4)?,
                ingredients: r.get(5)?,
                barcode: r.get(6)?,
                photo_label: r.get(7)?,
                photo_ingredients: r.get(8)?,
                nutrients: Vec::new(),
                import_only: r.get::<_, i64>(9)? != 0,
            })
        })
        .map_err(|e| format!("custom food {id}: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT nutrient_id, kind, amount, upper FROM custom_food_nutrients
             WHERE food_id = ?1 ORDER BY nutrient_id",
        )
        .map_err(|e| e.to_string())?;
    food.nutrients = stmt
        .query_map([id], |r| {
            Ok(CustomNutrient {
                nutrient_id: r.get(0)?,
                kind: r.get(1)?,
                amount: r.get(2)?,
                upper: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(food)
}

pub fn list_custom_foods(conn: &Connection) -> Result<Vec<CustomFood>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM custom_foods
             WHERE deleted_at IS NULL AND import_only = 0 ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    ids.iter().map(|i| get_custom_food(conn, i)).collect()
}

pub fn delete_custom_food(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    // Soft, matching recipes and vessels: a day logged against this food still
    // has to expand, and a future sync has to see the deletion rather than
    // watch the row reappear from another device. The food's photos are left on
    // disk rather than unlinked, so that nothing a past day resolves through
    // depends on a file this delete removed. Note no screen displays them once
    // the food is deleted — the promise to the user is the VALUES a day was
    // logged with, and that is what the confirmation says.
    conn.execute(
        "UPDATE custom_foods SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The one folding a search query and a stored name both pass through.
///
/// Whitespace-insensitive — "  hershey   bar " matches "Hershey bar" — and case
/// folded by Rust's `to_lowercase`, which is full Unicode.
///
/// Folding here rather than in SQL is the whole point. SQLite's `lower()` and
/// its LIKE are ASCII-only, so a query folded in Rust and a column folded in SQL
/// disagreed on every accented capital: a pack transcribed as printed —
/// "CAFÉ BUSTELO", "NESTLÉ CRUNCH", "Éclair" — could not be found by typing its
/// own name. Both sides now go through this function, so they cannot disagree.
fn folded(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Name/brand/barcode match over the user's own foods, best first.
///
/// A few hundred rows, so scoring them in memory is right here — an FTS table
/// would be another migration for no gain, and the reference database's FTS
/// index is what this deliberately outranks rather than joins. Scoring in Rust
/// also means one case-folding implementation rather than two: see [`folded`].
pub fn search_custom_foods(
    conn: &Connection,
    query: &str,
    limit: u32,
) -> Result<Vec<CustomFood>, String> {
    let q = folded(query);
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, name, COALESCE(brand,''), COALESCE(barcode,'')
             FROM custom_foods WHERE deleted_at IS NULL AND import_only = 0",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // A word prefix: "milk" should find "Hershey's milk chocolate". Bounded by a
    // space rather than any non-letter, which is what a food name separates on.
    let inner_word = format!(" {q}");
    let mut scored: Vec<(u8, usize, String, String)> = rows
        .into_iter()
        .filter_map(|(id, name, brand, barcode)| {
            let n = folded(&name);
            let b = folded(&brand);
            let c = folded(&barcode);
            let score = if n == q {
                0
            } else if c == q {
                1
            } else if n.starts_with(&q) {
                2
            } else if n.contains(&inner_word) {
                3
            } else if b.starts_with(&q) {
                4
            } else if n.contains(&q) {
                5
            } else if b.contains(&q) || c.contains(&q) {
                6
            } else {
                return None;
            };
            // Shortest name first within a score: it is the one that says least
            // beyond what was typed. A `%` or a `_` typed into the box is a
            // character being looked for, not a pattern — there is no pattern
            // language left to escape.
            Some((score, name.chars().count(), name, id))
        })
        .collect();
    scored.sort();

    scored
        .iter()
        .take(limit as usize)
        .map(|(_, _, _, id)| get_custom_food(conn, id))
        .collect()
}

/// One of the user's own foods, as the thing that REPLACES a bundled entry.
///
/// Only the identifying columns: this exists to build a search hit, which
/// carries no nutrients.
#[derive(Debug, Clone)]
pub struct OverridingFood {
    pub id: String,
    pub name: String,
    pub brand: Option<String>,
}

/// The live food that replaces one bundled entry, if any does.
///
/// Search needs the replacement itself and not merely the fact that one exists.
/// A query can match the generic entry's description and not the pack's own name
/// — "candies" against a bar called "Hershey's", "milk" against "Amul Taaza" —
/// and dropping the generic row without offering its replacement would leave the
/// food less findable after being overridden than before.
///
/// Two foods may name the same entry; the first by name wins, so the choice does
/// not change between searches.
pub fn custom_food_overriding(
    conn: &Connection,
    fdc_id: i64,
) -> Result<Option<OverridingFood>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, brand FROM custom_foods
             WHERE deleted_at IS NULL AND import_only = 0 AND overrides_fdc_id = ?1
             ORDER BY name LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([fdc_id], |r| {
            Ok(OverridingFood {
                id: r.get(0)?,
                name: r.get(1)?,
                brand: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// fdc_ids that a live custom food replaces, so reference search can drop them.
/// A deleted food overrides nothing: its generic entry has to come back, or the
/// user is left unable to log the food at all.
pub fn overridden_fdc_ids(conn: &Connection) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT overrides_fdc_id FROM custom_foods
             WHERE deleted_at IS NULL AND import_only = 0 AND overrides_fdc_id IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids)
}

/// Which of the given dates already carry at least one import-only entry —
/// so a second import over the same file, or an overlapping one, can be
/// caught before it silently doubles those days' totals.
pub fn dates_with_existing_imports(
    conn: &Connection,
    dates: &[String],
) -> Result<Vec<String>, String> {
    if dates.is_empty() {
        return Ok(Vec::new());
    }
    // Placeholders built to match `dates.len()` exactly — a date is untrusted
    // input from a file the user picked, so it goes in as a bound parameter,
    // never formatted into the SQL text.
    let placeholders = std::iter::repeat("?")
        .take(dates.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT DISTINCT le.logged_on
         FROM log_entries le
         JOIN custom_foods cf ON cf.id = le.custom_food_id
         WHERE le.source_kind = 'custom' AND le.deleted_at IS NULL
           AND cf.import_only = 1
           AND le.logged_on IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let found = stmt
        .query_map(rusqlite::params_from_iter(dates.iter()), |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(found)
}

pub fn remove(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    // Soft delete, so a future sync can propagate the deletion rather than
    // seeing the row simply reappear from another device.
    conn.execute(
        "UPDATE log_entries SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn day(conn: &Connection, logged_on: &str) -> Result<Vec<LogEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, logged_on, meal, source_kind, fdc_id, recipe_id, custom_food_id,
                    description, grams, gross_g, tare_g, tare_note,
                    supplement_id, units, origin, cuisine, bottle_id, cook_id
             FROM log_entries
             WHERE logged_on = ?1 AND deleted_at IS NULL
             ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([logged_on], |r| {
            Ok(LogEntry {
                id: r.get(0)?,
                logged_on: r.get(1)?,
                meal: r.get(2)?,
                source_kind: r.get(3)?,
                fdc_id: r.get(4)?,
                recipe_id: r.get(5)?,
                custom_food_id: r.get(6)?,
                description: r.get(7)?,
                // Reads as Option because a supplement row stores no mass here.
                // As `f64` this would be an InvalidColumnType that fails the
                // WHOLE day rather than the one entry.
                grams: r.get(8)?,
                gross_g: r.get(9)?,
                tare_g: r.get(10)?,
                tare_note: r.get(11)?,
                supplement_id: r.get(12)?,
                units: r.get(13)?,
                origin: r.get(14)?,
                cuisine: r.get(15)?,
                bottle_id: r.get(16)?,
                cook_id: r.get(17)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Dates in the last `n` days that have at least one entry — used to mark the
/// date picker so the user can find days they actually logged.
pub fn logged_dates(conn: &Connection, limit: u32) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT logged_on FROM log_entries
             WHERE deleted_at IS NULL ORDER BY logged_on DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Dates in a range that have at least one entry, with a cheap per-day count.
/// Days with nothing logged are deliberately ABSENT rather than present with a
/// zero — the calendar must show them as blank, and a period average must not
/// divide by them.
/// One day's shape, before its nutrients are resolved.
pub struct LoggedDay {
    pub date: String,
    pub items: i64,
    /// Mass of FOOD logged. A supplement contributes none because it carries
    /// no mass at all, and water is subtracted out on purpose even though it
    /// does — a bottle is not a dish, so this stays the mass of what was
    /// eaten, not of everything that was weighed.
    pub grams: f64,
    /// Entries that were an actual dish: food, a recipe, or a custom food.
    /// Zero means the day holds only supplements and/or water, which is a
    /// different thing from a day with nothing on it and must not be
    /// averaged as if food had been recorded — a bottle finished on an
    /// otherwise-unlogged day is not a claim that nothing was eaten.
    pub food_items: i64,
    pub supplement_items: i64,
    pub water_items: i64,
}

pub fn logged_days_between(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<Vec<LoggedDay>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT logged_on,
                    COUNT(*),
                    COALESCE(SUM(CASE WHEN source_kind = 'water' THEN 0.0 ELSE grams END), 0.0),
                    SUM(CASE WHEN source_kind IN ('supplement','water') THEN 0 ELSE 1 END),
                    SUM(CASE WHEN source_kind = 'supplement' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN source_kind = 'water' THEN 1 ELSE 0 END)
             FROM log_entries
             WHERE logged_on BETWEEN ?1 AND ?2 AND deleted_at IS NULL
             GROUP BY logged_on ORDER BY logged_on",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![from, to], |r| {
            Ok(LoggedDay {
                date: r.get(0)?,
                items: r.get(1)?,
                grams: r.get(2)?,
                food_items: r.get(3)?,
                supplement_items: r.get(4)?,
                water_items: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// How a period's entries split across origins and cuisines.
///
/// Counted over ENTRIES rather than days or meals: an entry is one dish, which
/// is the unit the user actually tagged, and it is the only count that does not
/// need a rule for what a mixed day or a mixed meal should be called.
/// Supplements and water are excluded — a vitamin or a bottle has no cuisine
/// and is not a dish.
pub struct TagCount {
    /// `None` is the untagged group. It is reported rather than dropped: how
    /// much you have not said is part of what the chart is showing.
    pub key: Option<String>,
    /// The user's own spelling, for a cuisine. Their most recent one wins where
    /// two spellings fold together.
    pub label: Option<String>,
    pub entries: i64,
    pub days: i64,
    pub grams: f64,
}

fn tag_counts(conn: &Connection, column: &str, from: &str, to: &str) -> Result<Vec<TagCount>, String> {
    // `column` is chosen from two literals below, never from user input.
    let key = if column == "cuisine" { "cuisine_key" } else { "origin" };
    let sql = format!(
        "SELECT {key},
                (SELECT {column} FROM log_entries i
                  WHERE i.deleted_at IS NULL AND i.source_kind NOT IN ('supplement','water')
                    AND i.logged_on BETWEEN ?1 AND ?2
                    AND ((i.{key} IS NULL AND o.{key} IS NULL) OR i.{key} = o.{key})
                  ORDER BY i.created_at DESC, i.rowid DESC LIMIT 1),
                COUNT(*), COUNT(DISTINCT logged_on), COALESCE(SUM(grams), 0.0)
         FROM log_entries o
         WHERE logged_on BETWEEN ?1 AND ?2 AND deleted_at IS NULL
           AND source_kind NOT IN ('supplement','water')
         GROUP BY {key}
         ORDER BY COUNT(*) DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![from, to], |r| {
            Ok(TagCount {
                key: r.get(0)?,
                label: r.get(1)?,
                entries: r.get(2)?,
                days: r.get(3)?,
                grams: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn origin_counts(conn: &Connection, from: &str, to: &str) -> Result<Vec<TagCount>, String> {
    tag_counts(conn, "origin", from, to)
}

pub fn cuisine_counts(conn: &Connection, from: &str, to: &str) -> Result<Vec<TagCount>, String> {
    tag_counts(conn, "cuisine", from, to)
}

/// The cuisines this user has actually used, most-used first, for the picker.
///
/// Their own vocabulary and nothing else. A starter list of suggestions lives
/// in the UI and disappears once there are enough of these; it is never written
/// into the database, so it cannot end up in the chart as a cuisine the user
/// never ate.
pub fn list_cuisines(conn: &Connection, limit: u32) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT cuisine FROM log_entries
             WHERE deleted_at IS NULL AND cuisine_key IS NOT NULL
             GROUP BY cuisine_key
             ORDER BY COUNT(*) DESC, MAX(created_at) DESC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// The user's own last answer for this exact food, per dimension.
///
/// Never a guess. Nothing here reads a description, an alias or a food
/// category: an alias says "this USDA row is what 'urad dal' means", not
/// "anything containing urad dal is Indian cuisine", and urad dal is an
/// ingredient in dishes across several cuisines. If the user has not answered
/// for this food before, the answer is `None` and the control stays blank.
///
/// The two dimensions are recalled independently because the last entry may
/// have carried an origin and no cuisine.
pub fn recall_tags(conn: &Connection, source: Source<'_>) -> Result<Tags, String> {
    let column = match source {
        Source::Food(_) => "fdc_id",
        Source::Recipe(_) => "recipe_id",
        // A cook recalls against its OWN pot, not against the recipe behind it.
        // Not a shortcut: a cook-backed entry carries no `recipe_id` at all —
        // the biconditionals forbid it — so a lookup through the recipe would
        // see only the entries logged straight off the written batch and miss
        // every pot ever cooked. What covers a brand-new pot instead is the
        // origin and cuisine copied onto it from the recipe when the cook sheet
        // opened, which is why those columns are on `cooks`.
        Source::Cook(_) => "cook_id",
        Source::Custom(_) => "custom_food_id",
        // Neither a supplement nor a bottle is a dish, and neither carries tags.
        Source::Supplement(_) | Source::Water(_) => return Ok(Tags::default()),
    };
    let mut out = Tags::default();
    // `created_at` is accurate only to the second, and logging two dishes
    // inside one second is ordinary. Without the rowid tiebreak below, the
    // "last answer" is whichever row SQLite reaches first — which is the
    // OLDEST one, the exact opposite of what this function means.
    for field in ["origin", "cuisine"] {
        let sql = format!(
            "SELECT {field} FROM log_entries
             WHERE {column} = ?1 AND deleted_at IS NULL AND {field} IS NOT NULL
             ORDER BY created_at DESC, rowid DESC LIMIT 1"
        );
        let found: Option<String> = match source {
            Source::Food(id) => conn
                .query_row(&sql, rusqlite::params![id], |r| r.get(0))
                .ok(),
            Source::Recipe(id) | Source::Cook(id) | Source::Custom(id) => conn
                .query_row(&sql, rusqlite::params![id], |r| r.get(0))
                .ok(),
            Source::Supplement(_) | Source::Water(_) => None,
        };
        match field {
            "origin" => out.origin = found,
            _ => out.cuisine = found,
        }
    }
    Ok(out)
}

/// Retag one entry, or clear a tag. Used from the day view, where a dish that
/// was logged in a hurry gets its origin added afterwards.
pub fn set_tags(conn: &Connection, id: &str, tags: &Tags) -> Result<(), String> {
    check_origin(tags.origin.as_deref())?;
    let cuisine = opt_trim(tags.cuisine.as_ref());
    let cuisine_key = cuisine.as_deref().map(folded);
    let now = now_iso(conn)?;
    let n = conn
        .execute(
            "UPDATE log_entries
                SET origin = ?2, cuisine = ?3, cuisine_key = ?4, updated_at = ?5
              WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id, tags.origin.as_deref(), cuisine, cuisine_key, now],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("that entry is not in the log".into());
    }
    Ok(())
}

/// Insert when `id` is None, replace in place when it is Some — one entry point
/// for adding a supplement and for correcting a transcription. The nutrient
/// rows are replaced wholesale, so deleting a line here really deletes it.
pub fn save_supplement(
    conn: &mut Connection,
    id: Option<&str>,
    sup: &Supplement,
) -> Result<String, String> {
    if sup.name.trim().is_empty() {
        return Err("a supplement needs a name".into());
    }
    if sup.unit_noun.trim().is_empty() {
        return Err("say what one of these is called — a tablet, a capsule, a gummy".into());
    }
    if !(sup.serving_units.is_finite() && sup.serving_units > 0.0) {
        return Err(
            "a serving must be a positive number of units: the panel's figures are per serving"
                .into(),
        );
    }
    if let Some(d) = sup.default_units {
        if !(d.is_finite() && d > 0.0) {
            return Err("the usual dose must be a positive number of units".into());
        }
    }
    if !["us", "other"].contains(&sup.regime.as_str()) {
        return Err(format!("{} is not a labelling regime this app knows", sup.regime));
    }

    let mut seen: Vec<i64> = Vec::with_capacity(sup.nutrients.len());
    for n in &sup.nutrients {
        check_supplement_nutrient(n)?;
        if seen.contains(&n.nutrient_id) {
            return Err(format!(
                "nutrient {} is listed twice; a panel prints each line once",
                n.nutrient_id
            ));
        }
        seen.push(n.nutrient_id);
    }

    let name = sup.name.trim().to_string();
    let brand = opt_trim(sup.brand.as_ref());
    let unit_noun = sup.unit_noun.trim().to_string();
    let serving_label = opt_trim(sup.serving_label.as_ref());
    let other_ingredients = opt_trim(sup.other_ingredients.as_ref());
    let barcode = opt_trim(sup.barcode.as_ref());

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_iso(&tx)?;
    let sid = match id {
        Some(existing) => {
            let n = tx
                .execute(
                    "UPDATE supplements
                       SET name = ?2, brand = ?3, unit_noun = ?4, serving_units = ?5,
                           serving_label = ?6, default_units = ?7, regime = ?8,
                           panel_complete = ?9, other_ingredients = ?10, barcode = ?11,
                           photo_panel = ?12, photo_ingredients = ?13, updated_at = ?14
                     WHERE id = ?1 AND deleted_at IS NULL",
                    rusqlite::params![
                        existing,
                        name,
                        brand,
                        unit_noun,
                        sup.serving_units,
                        serving_label,
                        sup.default_units,
                        sup.regime,
                        sup.panel_complete as i64,
                        other_ingredients,
                        barcode,
                        sup.photo_panel,
                        sup.photo_ingredients,
                        now
                    ],
                )
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(format!("supplement {existing} is not in your supplements"));
            }
            tx.execute(
                "DELETE FROM supplement_nutrients WHERE supplement_id = ?1",
                [existing],
            )
            .map_err(|e| e.to_string())?;
            existing.to_string()
        }
        None => {
            let new = new_id(&tx)?;
            tx.execute(
                "INSERT INTO supplements
                   (id,name,brand,unit_noun,serving_units,serving_label,default_units,
                    regime,panel_complete,other_ingredients,barcode,photo_panel,
                    photo_ingredients,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",
                rusqlite::params![
                    new,
                    name,
                    brand,
                    unit_noun,
                    sup.serving_units,
                    serving_label,
                    sup.default_units,
                    sup.regime,
                    sup.panel_complete as i64,
                    other_ingredients,
                    barcode,
                    sup.photo_panel,
                    sup.photo_ingredients,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
            new
        }
    };

    for (i, n) in sup.nutrients.iter().enumerate() {
        let rid = new_id(&tx)?;
        tx.execute(
            "INSERT INTO supplement_nutrients
               (id,supplement_id,position,nutrient_id,label_amount,label_unit,label_form,
                kind,amount,upper,convert_note)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![
                rid,
                sid,
                i as i64,
                n.nutrient_id,
                n.label_amount,
                n.label_unit,
                n.label_form,
                n.kind,
                n.amount,
                n.upper,
                n.convert_note
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(sid)
}

/// The kinds a `supplement_nutrients` row may carry, mirroring the table's
/// CHECK so a bad row is refused with a sentence rather than a constraint code.
const SUPPLEMENT_KINDS: [&str; 5] = [
    "measured",
    "label_zero",
    "below_loq",
    "trace",
    "not_converted",
];

fn check_supplement_nutrient(n: &SupplementNutrient) -> Result<(), String> {
    if !SUPPLEMENT_KINDS.contains(&n.kind.as_str()) {
        return Err(format!("{} is not a kind a panel line can be", n.kind));
    }
    if !(n.label_amount.is_finite() && n.label_amount >= 0.0) {
        return Err("a printed amount must be a number, zero or more".into());
    }
    match n.kind.as_str() {
        "measured" => {
            let Some(a) = n.amount else {
                return Err("a measured line needs an amount".into());
            };
            if !(a.is_finite() && a >= 0.0) {
                return Err("a measured amount must be a number, zero or more".into());
            }
            if n.upper.is_some() {
                return Err("a measured line is a point, not a bound".into());
            }
        }
        "not_converted" => {
            if n.amount.is_some() || n.upper.is_some() {
                return Err(
                    "a line this app could not convert carries no amount on its own basis".into(),
                );
            }
            if n.convert_note.is_none() {
                return Err("say why the figure could not be converted".into());
            }
        }
        _ => {
            let Some(u) = n.upper else {
                return Err("a bounded line needs its bound".into());
            };
            if !(u.is_finite() && u > 0.0) {
                return Err("a bound must be a positive number".into());
            }
            if n.amount.is_some() {
                return Err("a bounded line is an interval, not a point".into());
            }
        }
    }
    Ok(())
}

pub fn get_supplement(conn: &Connection, id: &str) -> Result<Supplement, String> {
    get_supplement_inner(conn, id, false)
}

/// Deliberately reads deleted supplements too: removing one today must not stop
/// a day that already took it from opening.
pub fn get_supplement_for_history(conn: &Connection, id: &str) -> Result<Supplement, String> {
    get_supplement_inner(conn, id, true)
}

fn get_supplement_inner(
    conn: &Connection,
    id: &str,
    include_deleted: bool,
) -> Result<Supplement, String> {
    let sql = if include_deleted {
        "SELECT name,brand,unit_noun,serving_units,serving_label,default_units,regime,
                panel_complete,other_ingredients,barcode,photo_panel,photo_ingredients
         FROM supplements WHERE id = ?1"
    } else {
        "SELECT name,brand,unit_noun,serving_units,serving_label,default_units,regime,
                panel_complete,other_ingredients,barcode,photo_panel,photo_ingredients
         FROM supplements WHERE id = ?1 AND deleted_at IS NULL"
    };
    let mut sup = conn
        .query_row(sql, [id], |r| {
            Ok(Supplement {
                id: id.to_string(),
                name: r.get(0)?,
                brand: r.get(1)?,
                unit_noun: r.get(2)?,
                serving_units: r.get(3)?,
                serving_label: r.get(4)?,
                default_units: r.get(5)?,
                regime: r.get(6)?,
                panel_complete: r.get::<_, i64>(7)? != 0,
                other_ingredients: r.get(8)?,
                barcode: r.get(9)?,
                photo_panel: r.get(10)?,
                photo_ingredients: r.get(11)?,
                nutrients: Vec::new(),
            })
        })
        .map_err(|e| format!("supplement {id}: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT nutrient_id,position,label_amount,label_unit,label_form,
                    kind,amount,upper,convert_note
             FROM supplement_nutrients WHERE supplement_id = ?1 ORDER BY position",
        )
        .map_err(|e| e.to_string())?;
    sup.nutrients = stmt
        .query_map([id], |r| {
            Ok(SupplementNutrient {
                nutrient_id: r.get(0)?,
                position: r.get(1)?,
                label_amount: r.get(2)?,
                label_unit: r.get(3)?,
                label_form: r.get(4)?,
                kind: r.get(5)?,
                amount: r.get(6)?,
                upper: r.get(7)?,
                convert_note: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(sup)
}

pub fn list_supplements(conn: &Connection) -> Result<Vec<Supplement>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM supplements WHERE deleted_at IS NULL ORDER BY name")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    ids.iter().map(|i| get_supplement(conn, i)).collect()
}

/// Soft delete. Days that already took this supplement keep the values they
/// were logged with, and its rows stay readable through
/// `get_supplement_for_history`.
pub fn delete_supplement(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    let n = conn
        .execute(
            "UPDATE supplements SET deleted_at = ?2, updated_at = ?2
             WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id, now],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("supplement {id} is not in your supplements"));
    }
    Ok(())
}

/// Who the targets are for. Every field optional; see the table comment.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Profile {
    pub sex: Option<String>,
    pub birth_year: Option<i64>,
    pub height_cm: Option<f64>,
    pub weight_kg: Option<f64>,
    pub activity: Option<String>,
    pub life_stage: String,
    /// The user's own energy figure. `None` means "estimate it from the body".
    pub energy_kcal: Option<f64>,
}

/// One target the user set for themselves.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NutrientTarget {
    pub nutrient_id: i64,
    pub amount: f64,
    pub note: Option<String>,
}

const ACTIVITIES: [&str; 5] = [
    "sedentary",
    "light",
    "moderate",
    "very_active",
    "extra_active",
];
const LIFE_STAGES: [&str; 3] = ["standard", "pregnant", "lactating"];

/// The profile, or an all-empty one when none has been saved.
///
/// Never `None`: "no profile yet" and "a profile with nothing filled in" mean
/// the same thing to every caller — the tables cannot place this person — and
/// making them one shape keeps that from being decided twice.
pub fn get_profile(conn: &Connection) -> Result<Profile, String> {
    let found = conn
        .query_row(
            "SELECT sex, birth_year, height_cm, weight_kg, activity, life_stage, energy_kcal
             FROM profile WHERE id = 1",
            [],
            |r| {
                Ok(Profile {
                    sex: r.get(0)?,
                    birth_year: r.get(1)?,
                    height_cm: r.get(2)?,
                    weight_kg: r.get(3)?,
                    activity: r.get(4)?,
                    life_stage: r.get(5)?,
                    energy_kcal: r.get(6)?,
                })
            },
        )
        .ok();
    Ok(found.unwrap_or(Profile {
        life_stage: "standard".into(),
        ..Default::default()
    }))
}

/// Replace the profile wholesale.
///
/// Every field is sent every time, so clearing one really clears it. A partial
/// update would make "leave my height alone" and "I no longer want to say how
/// tall I am" indistinguishable, and the second has to stay expressible — it is
/// what turns the energy estimate back off.
pub fn save_profile(conn: &Connection, p: &Profile) -> Result<(), String> {
    if let Some(sex) = p.sex.as_deref() {
        if !["female", "male"].contains(&sex) {
            return Err(format!("{sex} is not one of the two columns the tables have"));
        }
    }
    if let Some(a) = p.activity.as_deref() {
        if !ACTIVITIES.contains(&a) {
            return Err(format!("{a} is not an activity level this app knows"));
        }
    }
    if !LIFE_STAGES.contains(&p.life_stage.as_str()) {
        return Err(format!("{} is not a life stage this app knows", p.life_stage));
    }
    if let Some(y) = p.birth_year {
        if !(1900..=2200).contains(&y) {
            return Err("that birth year is not a year someone was born in".into());
        }
    }
    for (label, v) in [
        ("height", p.height_cm),
        ("weight", p.weight_kg),
        ("energy target", p.energy_kcal),
    ] {
        if let Some(v) = v {
            if !(v.is_finite() && v > 0.0) {
                return Err(format!("{label} must be a positive number, or left blank"));
            }
        }
    }

    let now = now_iso(conn)?;
    conn.execute(
        "INSERT INTO profile
           (id, sex, birth_year, height_cm, weight_kg, activity, life_stage, energy_kcal, updated_at)
         VALUES (1,?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET
           sex = ?1, birth_year = ?2, height_cm = ?3, weight_kg = ?4,
           activity = ?5, life_stage = ?6, energy_kcal = ?7, updated_at = ?8",
        rusqlite::params![
            p.sex,
            p.birth_year,
            p.height_cm,
            p.weight_kg,
            p.activity,
            p.life_stage,
            p.energy_kcal,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_targets(conn: &Connection) -> Result<Vec<NutrientTarget>, String> {
    let mut stmt = conn
        .prepare("SELECT nutrient_id, amount, note FROM nutrient_targets ORDER BY nutrient_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(NutrientTarget {
                nutrient_id: r.get(0)?,
                amount: r.get(1)?,
                note: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Set one target, or clear it by passing `None` for the amount.
///
/// Clearing is a return to whichever published figure applies, not a deletion:
/// the nutrient keeps a target, it just stops being this one.
pub fn set_target(
    conn: &Connection,
    nutrient_id: i64,
    amount: Option<f64>,
    note: Option<&str>,
) -> Result<(), String> {
    let Some(amount) = amount else {
        conn.execute(
            "DELETE FROM nutrient_targets WHERE nutrient_id = ?1",
            [nutrient_id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    };
    if !(amount.is_finite() && amount > 0.0) {
        return Err("a target must be a positive number".into());
    }
    let now = now_iso(conn)?;
    conn.execute(
        "INSERT INTO nutrient_targets (nutrient_id, amount, note, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?4)
         ON CONFLICT(nutrient_id) DO UPDATE SET amount = ?2, note = ?3, updated_at = ?4",
        rusqlite::params![nutrient_id, amount, note, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn new_id(conn: &Connection) -> Result<String, String> {
    conn.query_row(
        "SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||
                substr(hex(randomblob(2)),2)||'-'||
                substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||
                hex(randomblob(6)))",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn now_iso(conn: &Connection) -> Result<String, String> {
    conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| {
        r.get(0)
    })
    .map_err(|e| e.to_string())
}

/// Today's date on the machine's own clock.
///
/// `localtime`, not UTC. West of UTC an evening's cooking is already tomorrow
/// in UTC, and a pot made at dinner would be filed under the wrong day.
pub fn today_iso(conn: &Connection) -> Result<String, String> {
    conn.query_row("SELECT date('now','localtime')", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Frozen history
// ---------------------------------------------------------------------------

/// How much of a component was eaten, in the only two units a contribution can
/// have. Keeping them apart in the type is what stops a tablet count from being
/// added to a mass: grams and doses are not commensurable, and the day's
/// coverage figure is a fraction of mass.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SnapQuantity {
    Grams(f64),
    Servings(f64),
}

/// Whether a snapshot was taken when the entry was written, or reconstructed
/// afterwards.
///
/// The distinction is worth carrying because only one of them is a record of
/// what was actually believed at the time. A backfilled snapshot froze whatever
/// the app could still work out later, which for an entry logged before this
/// feature existed is the best available answer and not the true one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapBasis {
    Logged,
    Backfilled,
    /// The user changed these values on purpose, after the fact.
    Corrected,
}

impl SnapBasis {
    fn as_str(self) -> &'static str {
        match self {
            SnapBasis::Logged => "logged",
            SnapBasis::Backfilled => "backfilled",
            SnapBasis::Corrected => "corrected",
        }
    }

    fn parse(s: &str) -> Self {
        // An unrecognised value is treated as backfilled rather than logged.
        // Overstating how well a past day is known is the error that matters.
        match s {
            "logged" => SnapBasis::Logged,
            "corrected" => SnapBasis::Corrected,
            _ => SnapBasis::Backfilled,
        }
    }
}

/// A recipe entry's identity, frozen. The recipe row it came from may since
/// have been renamed, re-portioned or deleted.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapRecipe {
    pub name: String,
    pub yield_g: f64,
    /// Only ever present on an entry logged while the recipe carried a count.
    /// Kept so a past day still reads the way it did when it was written, and
    /// never backfilled: an entry frozen without one was never told a number.
    pub servings: Option<f64>,
}

/// One frozen contribution: what it was, how much of it, and what it contained.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapComponent {
    pub description: String,
    pub fdc_id: Option<i64>,
    pub quantity: SnapQuantity,
    pub has_data: bool,
    /// Per 100 g for a weighed component, per label serving for a dose — the
    /// same bases the live resolution produces. [`NutrientValue::Absent`] is
    /// never included: absence is stored as the absence of a row.
    pub values: Vec<(i64, NutrientValue)>,
}

/// Everything a day needs about one entry, without consulting any other table.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub basis: SnapBasis,
    /// When this entry was first valued. Unchanged by a later correction.
    pub frozen_at: String,
    /// When the user last corrected it, if they ever did.
    pub corrected_at: Option<String>,
    pub recipe: Option<SnapRecipe>,
    pub components: Vec<SnapComponent>,
}

/// Write one entry's frozen contribution. The caller supplies the connection so
/// this can join a transaction that also inserts the entry itself — a row with
/// no snapshot would be read as a day with a hole in it.
fn write_snapshot(conn: &Connection, entry_id: &str, snap: &Snapshot) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO entry_snapshots
           (entry_id, frozen_at, basis, corrected_at,
            recipe_name, recipe_yield_g, recipe_servings)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            entry_id,
            snap.frozen_at,
            snap.basis.as_str(),
            snap.corrected_at,
            snap.recipe.as_ref().map(|r| r.name.as_str()),
            snap.recipe.as_ref().map(|r| r.yield_g),
            snap.recipe.as_ref().and_then(|r| r.servings),
        ],
    )
    .map_err(|e| format!("freezing entry {entry_id}: {e}"))?;

    // REPLACE above does not cascade to children on its own in every SQLite
    // configuration, so the old rows are cleared explicitly. Re-freezing is
    // otherwise the one way a snapshot could silently accumulate duplicates.
    conn.execute(
        "DELETE FROM entry_components WHERE entry_id = ?1",
        [entry_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM entry_nutrients WHERE entry_id = ?1", [entry_id])
        .map_err(|e| e.to_string())?;

    for (ordinal, c) in snap.components.iter().enumerate() {
        let (grams, servings) = match c.quantity {
            SnapQuantity::Grams(g) => {
                if !(g.is_finite() && g > 0.0) {
                    return Err(format!(
                        "entry {entry_id} component {ordinal} has no usable weight"
                    ));
                }
                (Some(g), None)
            }
            SnapQuantity::Servings(u) => {
                if !(u.is_finite() && u > 0.0) {
                    return Err(format!(
                        "entry {entry_id} component {ordinal} has no usable dose"
                    ));
                }
                (None, Some(u))
            }
        };
        conn.execute(
            "INSERT INTO entry_components
               (entry_id, ordinal, description, fdc_id, grams, servings, has_data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                entry_id,
                ordinal as i64,
                c.description,
                c.fdc_id,
                grams,
                servings,
                if c.has_data { 1 } else { 0 },
            ],
        )
        .map_err(|e| format!("freezing entry {entry_id} component {ordinal}: {e}"))?;

        let mut stmt = conn
            .prepare_cached(
                "INSERT INTO entry_nutrients
                   (entry_id, ordinal, nutrient_id, value_kind, amount, upper_bound)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| e.to_string())?;
        for (nutrient_id, value) in &c.values {
            // `Absent` yields None and is skipped, so the stored shape matches
            // food_nutrients: a nutrient nothing knew about has no row.
            let Some((kind, amount, upper)) = value.to_db() else {
                continue;
            };
            stmt.execute(rusqlite::params![
                entry_id,
                ordinal as i64,
                nutrient_id,
                kind,
                amount,
                upper
            ])
            .map_err(|e| format!("freezing entry {entry_id} nutrient {nutrient_id}: {e}"))?;
        }
    }
    Ok(())
}

/// Add an entry and freeze what it contributed, both or neither.
///
/// The snapshot is resolved by the caller, because working out what an entry
/// contains needs the reference database and this module deliberately has no
/// connection to it.
#[allow(clippy::too_many_arguments)]
pub fn add_with_snapshot(
    conn: &mut Connection,
    logged_on: &str,
    meal: Option<&str>,
    source: Source<'_>,
    description: &str,
    quantity: Quantity,
    tare: Option<&Tare>,
    tags: &Tags,
    snap: &Snapshot,
) -> Result<String, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = add(&tx, logged_on, meal, source, description, quantity, tare, tags)?;
    write_snapshot(&tx, &id, snap)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Freeze an entry that already exists — the backfill path, and the repair path
/// if an entry is ever found without a snapshot.
pub fn freeze_entry(
    conn: &mut Connection,
    entry_id: &str,
    snap: &Snapshot,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    write_snapshot(&tx, entry_id, snap)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Every frozen entry for one day, keyed by entry id.
///
/// Read in three statements rather than three per entry: a day with a dozen
/// entries and a fifteen-ingredient curry would otherwise issue hundreds.
pub fn day_snapshots(conn: &Connection, logged_on: &str) -> Result<HashMap<String, Snapshot>, String> {
    let mut out: HashMap<String, Snapshot> = HashMap::new();

    let mut stmt = conn
        .prepare(
            "SELECT s.entry_id, s.frozen_at, s.basis, s.corrected_at,
                    s.recipe_name, s.recipe_yield_g, s.recipe_servings
             FROM entry_snapshots s
             JOIN log_entries e ON e.id = s.entry_id
             WHERE e.logged_on = ?1 AND e.deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([logged_on], |r| {
            let id: String = r.get(0)?;
            let frozen_at: String = r.get(1)?;
            let basis: String = r.get(2)?;
            let corrected_at: Option<String> = r.get(3)?;
            let name: Option<String> = r.get(4)?;
            let yield_g: Option<f64> = r.get(5)?;
            let servings: Option<f64> = r.get(6)?;
            Ok((id, frozen_at, basis, corrected_at, name, yield_g, servings))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, frozen_at, basis, corrected_at, name, yield_g, servings) =
            row.map_err(|e| e.to_string())?;
        // Name and yield are what make this a recipe entry, and they are
        // written together or not at all; requiring both means a half-written
        // row degrades to "not a recipe" rather than to a division by a missing
        // yield. `servings` is deliberately NOT part of that test — since v9 a
        // recipe need not carry one, so demanding it here would have made every
        // entry logged afterwards read as an ordinary food and lose its
        // breakdown heading.
        let recipe = match (name, yield_g) {
            (Some(name), Some(yield_g)) => Some(SnapRecipe {
                name,
                yield_g,
                servings,
            }),
            _ => None,
        };
        out.insert(
            id,
            Snapshot {
                basis: SnapBasis::parse(&basis),
                frozen_at,
                corrected_at,
                recipe,
                components: Vec::new(),
            },
        );
    }
    if out.is_empty() {
        return Ok(out);
    }

    // Components arrive in ordinal order, so pushing preserves display order.
    let mut stmt = conn
        .prepare(
            "SELECT c.entry_id, c.ordinal, c.description, c.fdc_id,
                    c.grams, c.servings, c.has_data
             FROM entry_components c
             JOIN log_entries e ON e.id = c.entry_id
             WHERE e.logged_on = ?1 AND e.deleted_at IS NULL
             ORDER BY c.entry_id, c.ordinal",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([logged_on], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<i64>>(3)?,
                r.get::<_, Option<f64>>(4)?,
                r.get::<_, Option<f64>>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    // Ordinal -> position in the component vector, per entry, so the nutrient
    // pass below can find its component without a linear search.
    let mut slot: HashMap<(String, i64), usize> = HashMap::new();
    for row in rows {
        let (id, ordinal, description, fdc_id, grams, servings, has_data) =
            row.map_err(|e| e.to_string())?;
        let Some(snap) = out.get_mut(&id) else {
            continue;
        };
        let quantity = match (grams, servings) {
            (Some(g), None) => SnapQuantity::Grams(g),
            (None, Some(u)) => SnapQuantity::Servings(u),
            // The table's CHECK forbids this. Reaching it means the file was
            // edited outside the app, and guessing a unit would put a tablet
            // count into a mass total.
            _ => {
                return Err(format!(
                    "frozen entry {id} component {ordinal} records neither a weight nor a dose"
                ))
            }
        };
        slot.insert((id.clone(), ordinal), snap.components.len());
        snap.components.push(SnapComponent {
            description,
            fdc_id,
            quantity,
            has_data: has_data != 0,
            values: Vec::new(),
        });
    }

    let mut stmt = conn
        .prepare(
            "SELECT n.entry_id, n.ordinal, n.nutrient_id, n.value_kind, n.amount, n.upper_bound
             FROM entry_nutrients n
             JOIN log_entries e ON e.id = n.entry_id
             WHERE e.logged_on = ?1 AND e.deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([logged_on], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<f64>>(4)?,
                r.get::<_, Option<f64>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, ordinal, nutrient_id, kind, amount, upper) = row.map_err(|e| e.to_string())?;
        let Some(&pos) = slot.get(&(id.clone(), ordinal)) else {
            continue;
        };
        if let Some(snap) = out.get_mut(&id) {
            snap.components[pos]
                .values
                .push((nutrient_id, NutrientValue::from_db(&kind, amount, upper)));
        }
    }

    Ok(out)
}

/// Live entries that carry no frozen snapshot, oldest first.
///
/// Non-empty only for entries logged before freezing existed, or written by a
/// build that failed to freeze one. Either way the fix is the same, so this
/// makes no distinction between them.
pub fn entries_missing_snapshots(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id FROM log_entries e
             LEFT JOIN entry_snapshots s ON s.entry_id = e.id
             WHERE e.deleted_at IS NULL AND s.entry_id IS NULL
             ORDER BY e.logged_on, e.created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// One entry by id, whether or not it is still live. Backfill needs a row it
/// can resolve, and a soft-deleted entry is still part of a past day's history.
pub fn entry_by_id(conn: &Connection, id: &str) -> Result<LogEntry, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, logged_on, meal, source_kind, fdc_id, recipe_id, custom_food_id,
                    description, grams, gross_g, tare_g, tare_note,
                    supplement_id, units, origin, cuisine, bottle_id, cook_id
             FROM log_entries WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;
    stmt.query_row([id], |r| {
        Ok(LogEntry {
            id: r.get(0)?,
            logged_on: r.get(1)?,
            meal: r.get(2)?,
            source_kind: r.get(3)?,
            fdc_id: r.get(4)?,
            recipe_id: r.get(5)?,
            custom_food_id: r.get(6)?,
            description: r.get(7)?,
            grams: r.get(8)?,
            gross_g: r.get(9)?,
            tare_g: r.get(10)?,
            tare_note: r.get(11)?,
            supplement_id: r.get(12)?,
            units: r.get(13)?,
            origin: r.get(14)?,
            cuisine: r.get(15)?,
            bottle_id: r.get(16)?,
            cook_id: r.get(17)?,
        })
    })
    .map_err(|_| format!("log entry {id} is not in your history"))
}


/// One entry's frozen values, for showing and correcting.
pub fn snapshot_of(conn: &Connection, entry_id: &str) -> Result<Option<Snapshot>, String> {
    let entry = entry_by_id(conn, entry_id)?;
    Ok(day_snapshots(conn, &entry.logged_on)?.remove(entry_id))
}

/// Record that the user changed a snapshot on purpose.
///
/// `frozen_at` is deliberately left alone: when the entry was first valued and
/// when it was corrected are two different facts, and overwriting one with the
/// other would lose the only evidence that a correction happened at all.
fn mark_corrected(conn: &Connection, entry_id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    let n = conn
        .execute(
            "UPDATE entry_snapshots SET basis = 'corrected', corrected_at = ?2
             WHERE entry_id = ?1",
            rusqlite::params![entry_id, now],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("log entry {entry_id} has no stored nutrition to correct"));
    }
    Ok(())
}

/// Correct how much was eaten, keeping what it was made of.
///
/// The frozen per-100 g values do not change — the pack has not changed, only
/// the reading of the scale — so every component is rescaled by the same ratio.
/// Re-resolving here instead would quietly pull in today's recipe and today's
/// reference data, which is the behaviour freezing exists to prevent.
pub fn correct_amount(
    conn: &mut Connection,
    entry_id: &str,
    quantity: Quantity,
) -> Result<(), String> {
    let entry = entry_by_id(conn, entry_id)?;
    let Some(snap) = snapshot_of(conn, entry_id)? else {
        return Err(format!("log entry {entry_id} has no stored nutrition to correct"));
    };

    let (old, new, grams, units) = match (quantity, entry.grams, entry.units) {
        (Quantity::Grams(g), Some(was), _) => {
            if !(g.is_finite() && g > 0.0) {
                return Err("a corrected weight must be a positive number of grams".into());
            }
            (was, g, Some(g), None)
        }
        (Quantity::Units(u), _, Some(was)) => {
            if !(u.is_finite() && u > 0.0) {
                return Err("a corrected dose must be a positive number".into());
            }
            (was, u, None, Some(u))
        }
        (Quantity::Grams(_), None, _) => {
            return Err("this entry is a dose; correct the number taken, not a weight".into())
        }
        (Quantity::Units(_), _, None) => {
            return Err("this entry was weighed; correct its weight, not a count".into())
        }
    };
    if !(old.is_finite() && old > 0.0) {
        return Err(format!("log entry {entry_id} records no amount to correct from"));
    }
    let ratio = new / old;

    let mut corrected = snap;
    for c in &mut corrected.components {
        c.quantity = match c.quantity {
            SnapQuantity::Grams(g) => SnapQuantity::Grams(g * ratio),
            SnapQuantity::Servings(u) => SnapQuantity::Servings(u * ratio),
        };
    }
    corrected.basis = SnapBasis::Corrected;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_iso(&tx)?;
    // The scale reading and the vessels that produced the old number no longer
    // explain the new one. Keeping them would leave the entry asserting a
    // provenance that is no longer true, which is worse than having none.
    tx.execute(
        "UPDATE log_entries
            SET grams = ?2, units = ?3, gross_g = NULL, tare_g = NULL, tare_note = NULL,
                updated_at = ?4
          WHERE id = ?1",
        rusqlite::params![entry_id, grams, units, now],
    )
    .map_err(|e| e.to_string())?;
    corrected.corrected_at = Some(now);
    write_snapshot(&tx, entry_id, &corrected)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Correct one frozen nutrient value on one component.
///
/// `value` of `None` — or [`NutrientValue::Absent`] — removes the row, which is
/// how the user says "nothing actually knew this". That is a different claim
/// from zero, and the day reports it differently.
pub fn correct_value(
    conn: &mut Connection,
    entry_id: &str,
    ordinal: i64,
    nutrient_id: i64,
    value: Option<NutrientValue>,
) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT count(*) FROM entry_components WHERE entry_id = ?1 AND ordinal = ?2",
            rusqlite::params![entry_id, ordinal],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Err(format!(
            "log entry {entry_id} has no part {ordinal} to correct"
        ));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM entry_nutrients
         WHERE entry_id = ?1 AND ordinal = ?2 AND nutrient_id = ?3",
        rusqlite::params![entry_id, ordinal, nutrient_id],
    )
    .map_err(|e| e.to_string())?;
    if let Some((kind, amount, upper)) = value.as_ref().and_then(|v| v.to_db()) {
        tx.execute(
            "INSERT INTO entry_nutrients
               (entry_id, ordinal, nutrient_id, value_kind, amount, upper_bound)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![entry_id, ordinal, nutrient_id, kind, amount, upper],
        )
        .map_err(|e| e.to_string())?;
    }
    mark_corrected(&tx, entry_id)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Replace an entry's whole snapshot with one the caller has re-resolved.
///
/// The deliberate "value this again from what I know now" action, for when the
/// user has since fixed the food or recipe it came from and wants that applied
/// to a day already logged. It is marked as a correction, because that is what
/// it is — nothing here ever happens on its own.
pub fn recorrect_entry(
    conn: &mut Connection,
    entry_id: &str,
    mut snap: Snapshot,
) -> Result<(), String> {
    // Keep the original freeze time if there is one: this entry was first
    // valued then, and re-valuing it does not change when that happened.
    if let Some(existing) = snapshot_of(conn, entry_id)? {
        snap.frozen_at = existing.frozen_at;
    }
    snap.basis = SnapBasis::Corrected;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    snap.corrected_at = Some(now_iso(&tx)?);
    write_snapshot(&tx, entry_id, &snap)?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plain one-tablet multivitamin: one panel line, in the app's own units.
    fn multivit() -> Supplement {
        Supplement {
            id: String::new(),
            name: "Multivitamin".into(),
            brand: None,
            unit_noun: "tablet".into(),
            serving_units: 1.0,
            serving_label: Some("1 tablet".into()),
            default_units: Some(1.0),
            regime: "us".into(),
            panel_complete: false,
            other_ingredients: None,
            barcode: None,
            photo_panel: None,
            photo_ingredients: None,
            nutrients: vec![SupplementNutrient {
                nutrient_id: 1178, // vitamin B12
                position: 0,
                label_amount: 1000.0,
                label_unit: "ug".into(),
                label_form: "unspecified".into(),
                kind: "measured".into(),
                amount: Some(1000.0),
                upper: None,
                convert_note: None,
            }],
        }
    }

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        // Match production: foreign keys on, so a log entry cannot point at a
        // recipe that does not exist.
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.pragma_update(None, "user_version", SCHEMA_VERSION).unwrap();
        c
    }

    fn ing(desc: &str, fdc: Option<i64>, raw: f64, cooked: f64) -> RecipeIngredient {
        RecipeIngredient {
            id: String::new(),
            position: 0,
            fdc_id: fdc,
            description: desc.into(),
            raw_g: raw,
            cooked_g: cooked,
            optional: false,
        }
    }

    /// The shape shipped before recipes existed.
    const SCHEMA_V0: &str = r#"
    CREATE TABLE log_entries (
      id TEXT PRIMARY KEY, logged_on TEXT NOT NULL, meal TEXT NOT NULL,
      fdc_id INTEGER NOT NULL, description TEXT NOT NULL,
      grams REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      deleted_at TEXT
    );"#;

    fn measured(id: i64, amount: f64) -> CustomNutrient {
        CustomNutrient {
            nutrient_id: id,
            kind: "measured".into(),
            amount: Some(amount),
            upper: None,
        }
    }

    fn bounded(id: i64, kind: &str, upper: f64) -> CustomNutrient {
        CustomNutrient {
            nutrient_id: id,
            kind: kind.into(),
            amount: None,
            upper: Some(upper),
        }
    }

    /// A food as transcribed off a pack: everything the label does not print is
    /// simply not in `nutrients`.
    fn pack(name: &str, serving_g: f64, nutrients: Vec<CustomNutrient>) -> CustomFood {
        CustomFood {
            id: String::new(),
            name: name.into(),
            brand: None,
            overrides_fdc_id: None,
            serving_g,
            serving_label: None,
            ingredients: None,
            barcode: None,
            photo_label: None,
            photo_ingredients: None,
            nutrients,
            import_only: false,
        }
    }

    /// The shape shipped before vessels existed: recipes, but no tare columns.
    const SCHEMA_V1: &str = r#"
    CREATE TABLE recipes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, yield_g REAL NOT NULL,
      servings REAL NOT NULL, notes TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE log_entries (
      id TEXT PRIMARY KEY, logged_on TEXT NOT NULL,
      meal TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
      source_kind TEXT NOT NULL DEFAULT 'food' CHECK (source_kind IN ('food','recipe')),
      fdc_id INTEGER, recipe_id TEXT REFERENCES recipes(id),
      description TEXT NOT NULL, grams REAL NOT NULL CHECK (grams > 0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
      CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL))
    );"#;

    /// The shape shipped before custom foods existed: recipes and tares, but
    /// only two kinds of source.
    const SCHEMA_V2: &str = r#"
    CREATE TABLE recipes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, yield_g REAL NOT NULL,
      servings REAL NOT NULL, notes TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE log_entries (
      id TEXT PRIMARY KEY, logged_on TEXT NOT NULL,
      meal TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
      source_kind TEXT NOT NULL DEFAULT 'food' CHECK (source_kind IN ('food','recipe')),
      fdc_id INTEGER, recipe_id TEXT REFERENCES recipes(id),
      description TEXT NOT NULL, grams REAL NOT NULL CHECK (grams > 0),
      gross_g REAL, tare_g REAL, tare_note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
      CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
      CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
      CHECK (gross_g IS NULL OR gross_g > tare_g)
    );"#;

    /// The shape currently shipped, and therefore the upgrade path every
    /// existing user will actually take. The other three fixtures cover
    /// databases that may no longer exist in the wild; this one certainly does.
    const SCHEMA_V3: &str = r#"
    CREATE TABLE recipes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, yield_g REAL NOT NULL,
      servings REAL NOT NULL, notes TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE custom_foods (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, overrides_fdc_id INTEGER,
      serving_g REAL NOT NULL CHECK (serving_g > 0), serving_label TEXT,
      ingredients TEXT, barcode TEXT, photo_label TEXT, photo_ingredients TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    -- A real v3 database already has this index, built by the SCHEMA that
    -- shipped at the time. It matters here: SCHEMA now defines idx_cf_live
    -- with a WHERE clause over import_only, and `CREATE INDEX IF NOT EXISTS`
    -- only skips column resolution when an index of that name is already
    -- found — so without this, the fixture would not exercise what an actual
    -- upgrade sees, and would instead hit a "no such column" error that a real
    -- v3 database never would.
    CREATE INDEX idx_cf_live ON custom_foods(name) WHERE deleted_at IS NULL;
    CREATE TABLE log_entries (
      id TEXT PRIMARY KEY, logged_on TEXT NOT NULL,
      meal TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
      source_kind TEXT NOT NULL DEFAULT 'food'
        CHECK (source_kind IN ('food','recipe','custom')),
      fdc_id INTEGER, recipe_id TEXT REFERENCES recipes(id),
      custom_food_id TEXT REFERENCES custom_foods(id),
      description TEXT NOT NULL, grams REAL NOT NULL CHECK (grams > 0),
      gross_g REAL, tare_g REAL, tare_note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
      CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
      CHECK ((source_kind = 'custom') = (custom_food_id IS NOT NULL)),
      CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
      CHECK (gross_g IS NULL OR gross_g > tare_g)
    );"#;

    #[test]
    fn migrates_a_v0_database_straight_to_v5_without_losing_a_single_entry() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_V0).unwrap();
        for (i, d) in ["Cheddar", "Broccoli", "Idli"].iter().enumerate() {
            c.execute(
                "INSERT INTO log_entries
                   (id,logged_on,meal,fdc_id,description,grams,created_at,updated_at)
                 VALUES (?1,'2026-09-04','lunch',?2,?3,100.0,'t','t')",
                rusqlite::params![format!("e{i}"), 1000 + i as i64, d],
            )
            .unwrap();
        }
        // A soft-deleted row must survive too, or a future sync loses the deletion.
        c.execute("UPDATE log_entries SET deleted_at='t' WHERE id='e2'", []).unwrap();

        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();

        // All three arms must land in the one pass: v0 knows nothing of
        // recipes, of tares, or of the user's own foods.
        let cols = columns(&c, "log_entries").unwrap();
        assert!(cols.contains(&"source_kind".to_string()));
        assert!(cols.contains(&"recipe_id".to_string()));
        assert!(cols.contains(&"gross_g".to_string()));
        assert!(cols.contains(&"tare_g".to_string()));
        assert!(cols.contains(&"tare_note".to_string()));
        assert!(cols.contains(&"custom_food_id".to_string()));
        assert!(columns(&c, "custom_foods")
            .unwrap()
            .contains(&"import_only".to_string()));

        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM log_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3, "every row must survive, soft-deleted included");

        let (desc, kind, fdc): (String, String, i64) = c
            .query_row(
                "SELECT description, source_kind, fdc_id FROM log_entries WHERE id='e0'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((desc.as_str(), kind.as_str(), fdc), ("Cheddar", "food", 1000));

        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);

        // The rebuild must have carried the CHECK constraints across, not just
        // the columns — ALTER TABLE ADD COLUMN could not have done this. Driven
        // through raw SQL rather than `add`, because `Source` now makes a
        // sourceless entry unrepresentable in Rust and the point here is that
        // the TABLE refuses it too.
        assert!(c
            .execute(
                "INSERT INTO log_entries
                   (id,logged_on,meal,source_kind,description,grams,created_at,updated_at)
                 VALUES ('bad','2026-09-04','lunch','food','Neither',10.0,'t','t')",
                [],
            )
            .is_err());
        // The v4 CHECKs specifically: a supplement may not carry a mass, and a
        // food may not be stored without one. The second is the one that would
        // silently stop being enforced if `grams REAL CHECK (grams > 0)` had
        // been left as-is — SQLite passes a CHECK that evaluates to NULL.
        assert!(c
            .execute(
                "INSERT INTO log_entries
                   (id,logged_on,meal,source_kind,supplement_id,description,grams,units,
                    created_at,updated_at)
                 VALUES ('bad2','2026-09-04','lunch','supplement','s1','Pill',1.0,1.0,'t','t')",
                [],
            )
            .is_err());
        assert!(c
            .execute(
                "INSERT INTO log_entries
                   (id,logged_on,meal,source_kind,fdc_id,description,created_at,updated_at)
                 VALUES ('bad3','2026-09-04','lunch','food',1,'No weight','t','t')",
                [],
            )
            .is_err());
        // Including the v2 ones: a net weight without its scale reading is not
        // a representable row.
        assert!(c
            .execute(
                "UPDATE log_entries SET gross_g = 400.0 WHERE id = 'e0'",
                []
            )
            .is_err());
    }

    #[test]
    fn deleting_a_recipe_does_not_break_days_that_already_used_it() {
        let mut c = db();
        let rid = save_recipe(
            &mut c, "Rajma chawal", 1212.0, Some(4.0), None,
            &[ing("Kidney beans, dry", Some(16033), 128.0, 384.0)], &[],
            &Tags::default(),
        )
        .unwrap();
        add(&c, "2026-08-16", Some("lunch"), Source::Recipe(&rid), "Rajma chawal",
            Quantity::Grams(303.0), None, &Tags::default()).unwrap();
        delete_recipe(&c, &rid).unwrap();

        // Gone from the picker...
        assert!(list_recipes(&c).unwrap().is_empty());
        assert!(get_recipe(&c, &rid).is_err());
        // ...but a day that already used it must still resolve, or history
        // vanishes because of an edit made today.
        let r = get_recipe_for_history(&c, &rid).expect("past days must still expand");
        assert_eq!(r.name, "Rajma chawal");
        assert_eq!(r.ingredients.len(), 1);
        assert_eq!(day(&c, "2026-08-16").unwrap().len(), 1);
    }

    #[test]
    fn migrates_a_v3_database_and_only_then_accepts_a_dose() {
        // The upgrade every existing user takes. Before it, a supplement row is
        // impossible; after it, one is storable and every weighed entry still
        // reads exactly as it did.
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(SCHEMA_V3).unwrap();
        c.execute(
            "INSERT INTO log_entries
               (id,logged_on,meal,source_kind,fdc_id,description,grams,
                gross_g,tare_g,tare_note,created_at,updated_at)
             VALUES ('e0','2026-09-04','lunch','food',1000,'Rajma',300.0,
                     420.0,120.0,'steel katori','t','t')",
            [],
        )
        .unwrap();

        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();

        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);

        // The weighed entry survived with its provenance intact.
        let e = &day(&c, "2026-09-04").unwrap()[0];
        assert_eq!(e.grams, Some(300.0));
        assert_eq!(e.gross_g, Some(420.0));
        assert_eq!(e.tare_note.as_deref(), Some("steel katori"));
        // ...and gained the new fields as "not recorded" rather than as a value.
        assert_eq!(e.units, None);
        assert_eq!(e.origin, None);
        assert_eq!(e.cuisine, None);

        // The point of the migration: a dose is now representable.
        let sid = save_supplement(&mut c, None, &multivit()).unwrap();
        add(
            &c, "2026-09-04", Some("snack"), Source::Supplement(&sid), "Multivitamin",
            Quantity::Units(2.0), None, &Tags::default(),
        )
        .unwrap();
        let entries = day(&c, "2026-09-04").unwrap();
        let pill = entries.iter().find(|e| e.source_kind == "supplement").unwrap();
        assert_eq!(pill.units, Some(2.0));
        assert_eq!(pill.grams, None, "a dose carries no mass, not a zero mass");
    }

    /// The shape shipped before bulk import existed: custom_foods with no
    /// `import_only` column. Minimal on purpose — this migration touches only
    /// this one table, and every other table SCHEMA creates fresh (`CREATE
    /// TABLE IF NOT EXISTS`) already carries the current, already-migrated
    /// shape.
    const SCHEMA_V4: &str = r#"
    CREATE TABLE custom_foods (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, overrides_fdc_id INTEGER,
      serving_g REAL NOT NULL CHECK (serving_g > 0), serving_label TEXT,
      ingredients TEXT, barcode TEXT, photo_label TEXT, photo_ingredients TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    -- See the identical comment on SCHEMA_V3's own idx_cf_live: a real v4
    -- database already has this index, and only its presence lets
    -- `CREATE INDEX IF NOT EXISTS` in the current SCHEMA skip past a WHERE
    -- clause this table cannot yet satisfy.
    CREATE INDEX idx_cf_live ON custom_foods(name) WHERE deleted_at IS NULL;"#;

    #[test]
    fn migrates_a_v4_database_and_only_then_hides_an_imported_food() {
        // The upgrade every existing user takes for bulk import. Before it,
        // `import_only` does not exist at all; after it, an old row reads back
        // as a normal, visible food, and a new import-only one hides itself
        // from search and "My foods" without needing a second migration.
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_V4).unwrap();
        c.execute(
            "INSERT INTO custom_foods (id,name,serving_g,created_at,updated_at)
             VALUES ('f0','Homemade granola',100.0,'t','t')",
            [],
        )
        .unwrap();

        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();

        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        assert!(columns(&c, "custom_foods")
            .unwrap()
            .contains(&"import_only".to_string()));

        // The pre-existing row survived and defaulted to visible.
        let foods = list_custom_foods(&c).unwrap();
        assert_eq!(foods.len(), 1);
        assert_eq!(foods[0].name, "Homemade granola");
        assert!(!foods[0].import_only);

        // The point of the migration: an imported row can now say so, and
        // doing so hides it from the same list.
        let mut imported = pack("Imported — 2024-01-15", 100.0, vec![]);
        imported.import_only = true;
        save_custom_food(&mut c, None, &imported).unwrap();
        let names: Vec<String> = list_custom_foods(&c).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(
            names,
            vec!["Homemade granola"],
            "an import-only food must not clutter My foods"
        );
    }

    /// `log_entries` as it stood at v10: five sources, no `cook_id`.
    ///
    /// Only the columns the migration reads. The FK targets are omitted so the
    /// fixture needs no other tables — with `foreign_keys` OFF during a rebuild
    /// this is exactly what the real arm sees.
    const SCHEMA_V10_LOG: &str = r#"
    CREATE TABLE log_entries (
      id TEXT PRIMARY KEY, logged_on TEXT NOT NULL,
      meal TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
      source_kind TEXT NOT NULL DEFAULT 'food'
        CHECK (source_kind IN ('food','recipe','custom','supplement','water')),
      fdc_id INTEGER, recipe_id TEXT, custom_food_id TEXT, supplement_id TEXT,
      bottle_id TEXT,
      description TEXT NOT NULL, grams REAL, units REAL,
      gross_g REAL, tare_g REAL, tare_note TEXT,
      origin TEXT CHECK (origin IS NULL OR
        origin IN ('home','ordered_in','eaten_out','packaged')),
      cuisine TEXT, cuisine_key TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
      CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
      CHECK ((source_kind = 'custom') = (custom_food_id IS NOT NULL)),
      CHECK ((source_kind = 'supplement') = (supplement_id IS NOT NULL)),
      CHECK ((source_kind = 'water') = (bottle_id IS NOT NULL)),
      CHECK ((source_kind = 'supplement') = (grams IS NULL)),
      CHECK ((source_kind = 'supplement') = (units IS NOT NULL)),
      CHECK (grams IS NULL OR grams > 0),
      CHECK (units IS NULL OR units > 0),
      CHECK (grams IS NOT NULL OR gross_g IS NULL),
      CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
      CHECK (gross_g IS NULL OR gross_g > tare_g),
      CHECK ((cuisine IS NULL) = (cuisine_key IS NULL))
    );
    -- A real v10 database already has both, built by the SCHEMA that shipped at
    -- the time. Their presence is what lets `CREATE INDEX IF NOT EXISTS` in the
    -- current SCHEMA skip past a column this table does not have yet.
    CREATE INDEX idx_log_day ON log_entries(logged_on) WHERE deleted_at IS NULL;
    CREATE INDEX idx_log_cuisine ON log_entries(cuisine_key)
      WHERE deleted_at IS NULL AND cuisine_key IS NOT NULL;"#;

    #[test]
    fn migrates_a_v10_database_without_losing_an_entry_and_only_then_accepts_a_pot() {
        // The upgrade that makes a cooked pot loggable. Before it there is no
        // `cook_id` at all; after it, every older entry reads back untouched and
        // a portion of a pot can be stored — while an entry claiming to be a
        // cook without naming one is still refused by the new biconditional.
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_V10_LOG).unwrap();
        c.execute(
            "INSERT INTO log_entries
               (id,logged_on,meal,source_kind,fdc_id,description,grams,
                origin,cuisine,cuisine_key,created_at,updated_at)
             VALUES ('e0','2026-09-04','lunch','food',1,'Cheddar',30.0,
                     'home','South Indian','south indian','t','t')",
            [],
        )
        .unwrap();

        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();

        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        assert!(columns(&c, "log_entries")
            .unwrap()
            .contains(&"cook_id".to_string()));

        // The pre-existing entry survived whole — every column, not just its id.
        let entries = day(&c, "2026-09-04").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].description, "Cheddar");
        assert_eq!(entries[0].grams, Some(30.0));
        assert_eq!(entries[0].origin.as_deref(), Some("home"));
        assert_eq!(entries[0].cuisine.as_deref(), Some("South Indian"));
        assert_eq!(entries[0].cook_id, None, "it was never a pot");

        // The bottle column the water feature added is still there: this
        // rebuild carries every other feature's columns forward, which is why
        // there is one arm per version and not one arm per feature.
        assert!(columns(&c, "log_entries")
            .unwrap()
            .contains(&"bottle_id".to_string()));

        // And the point of the migration.
        let cid = save_cook(
            &mut c,
            None,
            &CookInput {
                recipe_id: None,
                name: "Rajma".into(),
                cooked_on: "2026-09-04".into(),
                scale: 1.0,
                gross_g: None,
                vessel_ids: Vec::new(),
                weighed_yield_g: Some(900.0),
                notes: None,
                defaults: Tags::default(),
                ingredients: vec![CookIngredient {
                    id: String::new(),
                    position: 0,
                    fdc_id: Some(16033),
                    description: "kidney beans".into(),
                    planned_g: 900.0,
                    raw_g: 300.0,
                    cooked_g: 900.0,
                    substituted_for: None,
                }],
            },
        )
        .unwrap();
        add(
            &c, "2026-09-04", Some("dinner"), Source::Cook(&cid), "Rajma",
            Quantity::Grams(300.0), None, &Tags::default(),
        )
        .unwrap();
        let after = day(&c, "2026-09-04").unwrap();
        assert_eq!(after.len(), 2);
        let pot = after.iter().find(|e| e.source_kind == "cook").unwrap();
        assert_eq!(pot.cook_id.as_deref(), Some(cid.as_str()));
        assert_eq!(pot.recipe_id, None, "a cook entry names a pot, not a recipe");

        // A row claiming to be a cook and naming none is unrepresentable, not
        // merely discouraged — the same guarantee the other five sources have.
        assert!(
            c.execute(
                "INSERT INTO log_entries
                   (id,logged_on,meal,source_kind,description,grams,created_at,updated_at)
                 VALUES ('bad','2026-09-04','lunch','cook','nothing',10.0,'t','t')",
                [],
            )
            .is_err(),
            "a cook entry must name a cook"
        );
    }

    /// The recipe tables as they stood at v8: `servings` demanded, and no way
    /// to say an ingredient could be skipped.
    const SCHEMA_V8_RECIPES: &str = r#"
    CREATE TABLE recipes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      yield_g REAL NOT NULL CHECK (yield_g > 0),
      servings REAL NOT NULL CHECK (servings > 0),
      notes TEXT, default_origin TEXT, default_cuisine TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE recipe_ingredients (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, fdc_id INTEGER, description TEXT NOT NULL,
      raw_g REAL NOT NULL CHECK (raw_g > 0),
      cooked_g REAL NOT NULL CHECK (cooked_g > 0)
    );
    CREATE INDEX idx_ri_recipe ON recipe_ingredients(recipe_id, position);
    CREATE TABLE recipe_servings (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      label TEXT NOT NULL, grams REAL NOT NULL CHECK (grams > 0)
    );"#;

    #[test]
    fn migrates_a_v8_recipe_without_discarding_the_servings_it_was_given() {
        // The upgrade that turns a recipe from a batch into a set of
        // proportions. The count stops being demanded, but a user who already
        // answered must keep their answer: the app no longer asking is not a
        // reason to delete something they said.
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_V8_RECIPES).unwrap();
        c.execute(
            "INSERT INTO recipes (id,name,yield_g,servings,notes,created_at,updated_at)
             VALUES ('r0','Rajma chawal',1212.0,4.0,NULL,'t','t')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO recipe_ingredients
               (id,recipe_id,position,fdc_id,description,raw_g,cooked_g)
             VALUES ('i0','r0',0,16033,'Kidney beans, dry',128.0,384.0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO recipe_servings (id,recipe_id,label,grams)
             VALUES ('s0','r0','1 katori',303.0)",
            [],
        )
        .unwrap();

        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();

        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        assert!(
            !column_is_not_null(&c, "recipes", "servings").unwrap(),
            "servings must have stopped being mandatory"
        );

        let r = get_recipe(&c, "r0").unwrap();
        assert_eq!(r.name, "Rajma chawal");
        assert_eq!(
            r.servings,
            Some(4.0),
            "an answer the user already gave survives the migration"
        );
        assert_eq!(r.yield_g, 1212.0);
        assert_eq!(r.ingredients.len(), 1);
        assert_eq!(r.ingredients[0].description, "Kidney beans, dry");
        assert_eq!(r.ingredients[0].cooked_g, 384.0);
        assert!(
            !r.ingredients[0].optional,
            "a recipe written before the flag existed said nothing about which \
             lines could be skipped, so every one of them stays required"
        );
        assert_eq!(r.serving_options.len(), 1, "named portions are untouched");

        // And the point of the migration: a recipe need not answer at all.
        let id = save_recipe(
            &mut c,
            "Sambar",
            600.0,
            None,
            None,
            &[ing("Toor dal", Some(16101), 100.0, 300.0)],
            &[],
            &Tags::default(),
        )
        .unwrap();
        assert_eq!(get_recipe(&c, &id).unwrap().servings, None);
    }

    /// The shape log_entries had at v9: exactly the v3→v4 rebuild, unchanged
    /// since — nothing between v4 and v9 touched this table.
    const SCHEMA_V9: &str = r#"
    CREATE TABLE log_entries (
      id          TEXT PRIMARY KEY,
      logged_on   TEXT NOT NULL,
      meal        TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
      source_kind TEXT NOT NULL DEFAULT 'food'
                    CHECK (source_kind IN ('food','recipe','custom','supplement')),
      fdc_id      INTEGER,
      recipe_id   TEXT REFERENCES recipes(id),
      custom_food_id TEXT REFERENCES custom_foods(id),
      supplement_id  TEXT REFERENCES supplements(id),
      description TEXT NOT NULL,
      grams       REAL,
      units       REAL,
      gross_g     REAL,
      tare_g      REAL,
      tare_note   TEXT,
      origin      TEXT CHECK (origin IS NULL OR
                    origin IN ('home','ordered_in','eaten_out','packaged')),
      cuisine     TEXT,
      cuisine_key TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
      CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
      CHECK ((source_kind = 'custom') = (custom_food_id IS NOT NULL)),
      CHECK ((source_kind = 'supplement') = (supplement_id IS NOT NULL)),
      CHECK ((source_kind = 'supplement') = (grams IS NULL)),
      CHECK ((source_kind = 'supplement') = (units IS NOT NULL)),
      CHECK (grams IS NULL OR grams > 0),
      CHECK (units IS NULL OR units > 0),
      CHECK (grams IS NOT NULL OR gross_g IS NULL),
      CHECK ((gross_g IS NULL) = (tare_g IS NULL)),
      CHECK (gross_g IS NULL OR gross_g > tare_g),
      CHECK ((cuisine IS NULL) = (cuisine_key IS NULL))
    );
    CREATE INDEX idx_log_day ON log_entries(logged_on) WHERE deleted_at IS NULL;
    CREATE INDEX idx_log_cuisine ON log_entries(cuisine_key)
      WHERE deleted_at IS NULL AND cuisine_key IS NOT NULL;"#;

    #[test]
    fn migrates_a_v9_database_and_only_then_accepts_water() {
        // The upgrade every existing user takes for this feature. Before it, a
        // water row is impossible; after it, one is storable and an entry that
        // predates the feature still reads exactly as it did.
        // Foreign keys stay off for the setup: `log_entries` at this shape
        // still references `recipes`/`custom_foods`/`supplements`, which this
        // minimal fixture does not create, and this app only ever turns
        // enforcement on once the real schema is in place.
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "OFF").unwrap();
        c.execute_batch(SCHEMA_V9).unwrap();
        c.execute(
            "INSERT INTO log_entries
               (id,logged_on,meal,source_kind,fdc_id,description,grams,
                gross_g,tare_g,tare_note,origin,cuisine,cuisine_key,created_at,updated_at)
             VALUES ('e0','2026-09-04','lunch','food',1000,'Rajma',300.0,
                     420.0,120.0,'steel katori','home','North Indian','north indian','t','t')",
            [],
        )
        .unwrap();

        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();

        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);

        // The pre-existing entry survived with its provenance intact.
        let e = &day(&c, "2026-09-04").unwrap()[0];
        assert_eq!(e.grams, Some(300.0));
        assert_eq!(e.gross_g, Some(420.0));
        assert_eq!(e.tare_note.as_deref(), Some("steel katori"));
        assert_eq!(e.origin.as_deref(), Some("home"));
        assert_eq!(e.cuisine.as_deref(), Some("North Indian"));
        // ...and gained the new field as "not recorded" rather than as a value.
        assert_eq!(e.bottle_id, None);

        // The point of the migration: water is now representable.
        let bid = save_bottle(&c, None, "1L steel bottle", 1050.0).unwrap();
        add(
            &c, "2026-09-04", None, Source::Water(&bid), "1L steel bottle",
            Quantity::Grams(650.0), None, &Tags::default(),
        )
        .unwrap();
        let entries = day(&c, "2026-09-04").unwrap();
        let water = entries.iter().find(|e| e.source_kind == "water").unwrap();
        assert_eq!(water.grams, Some(650.0));
        assert_eq!(water.bottle_id.as_deref(), Some(bid.as_str()));
    }

    /// The shape every existing water user's database is actually in: meal
    /// NOT NULL, bottles already loggable, and no rule tying the two.
    const SCHEMA_V11_LOG: &str = r#"
    CREATE TABLE log_entries (
      id          TEXT PRIMARY KEY,
      logged_on   TEXT NOT NULL,
      meal        TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
      source_kind TEXT NOT NULL DEFAULT 'food'
                    CHECK (source_kind IN ('food','recipe','cook','custom','supplement','water')),
      fdc_id      INTEGER,
      recipe_id   TEXT,
      cook_id     TEXT,
      custom_food_id TEXT,
      supplement_id  TEXT,
      bottle_id      TEXT,
      description TEXT NOT NULL,
      grams       REAL,
      units       REAL,
      gross_g     REAL,
      tare_g      REAL,
      tare_note   TEXT,
      origin      TEXT CHECK (origin IS NULL OR
                    origin IN ('home','ordered_in','eaten_out','packaged')),
      cuisine     TEXT,
      cuisine_key TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      CHECK ((source_kind = 'food')   = (fdc_id    IS NOT NULL)),
      CHECK ((source_kind = 'water')  = (bottle_id IS NOT NULL)),
      CHECK (grams IS NULL OR grams > 0)
    );
    "#;

    #[test]
    fn migrating_to_v12_clears_the_meal_a_bottle_never_had_and_keeps_what_it_held() {
        // v11 logged water through the food screen, meal picker included, so
        // every bottle already on disk carries whatever sitting the clock had
        // defaulted that picker to. It was the form's answer, never the user's.
        //
        // What must survive the upgrade is everything about the drink itself:
        // the mass, the bottle, and the full/remaining readings it was derived
        // from. Only the invented field goes — and the dish logged beside it
        // must keep the sitting it really was part of.
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "OFF").unwrap();
        c.execute_batch(SCHEMA_V11_LOG).unwrap();
        c.execute(
            "INSERT INTO log_entries
               (id,logged_on,meal,source_kind,bottle_id,description,grams,
                gross_g,tare_g,tare_note,created_at,updated_at)
             VALUES ('w1','2026-09-04','breakfast','water','b1','Steel flask',650.0,
                     1050.0,400.0,'','t','t')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO log_entries
               (id,logged_on,meal,source_kind,fdc_id,description,grams,origin,created_at,updated_at)
             VALUES ('e1','2026-09-04','lunch','food',1000,'Rajma',300.0,'home','t','t')",
            [],
        )
        .unwrap();
        assert!(column_is_not_null(&c, "log_entries", "meal").unwrap());

        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();

        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        assert!(!column_is_not_null(&c, "log_entries", "meal").unwrap());

        let entries = day(&c, "2026-09-04").unwrap();

        let water = entries.iter().find(|e| e.source_kind == "water").unwrap();
        assert_eq!(water.meal, None, "the sitting a bottle never had is gone");
        assert_eq!(water.grams, Some(650.0), "what was drunk is untouched");
        assert_eq!(water.gross_g, Some(1050.0));
        assert_eq!(water.tare_g, Some(400.0));
        assert_eq!(water.bottle_id.as_deref(), Some("b1"));

        let dish = entries.iter().find(|e| e.source_kind == "food").unwrap();
        assert_eq!(
            dish.meal.as_deref(),
            Some("lunch"),
            "a dish really was had at a sitting, and keeps it",
        );
        assert_eq!(dish.grams, Some(300.0));
        assert_eq!(dish.origin.as_deref(), Some("home"));
    }

    #[test]
    fn a_meal_is_refused_for_water_and_required_for_everything_else() {
        // Both directions, because the constraint is a biconditional. Letting
        // a meal through for water would store a fact nobody supplied;
        // letting one be omitted for a dish would lose one that was.
        let c = db();
        let bid = save_bottle(&c, None, "Steel flask", 1050.0).unwrap();

        let with_meal = add(
            &c, "2026-09-04", Some("breakfast"), Source::Water(&bid), "Steel flask",
            Quantity::Grams(650.0), None, &Tags::default(),
        );
        assert!(
            with_meal.unwrap_err().contains("across the day"),
            "water logged against a sitting has to be refused, and say why",
        );

        let without_meal = add(
            &c, "2026-09-04", None, Source::Food(1), "Rajma",
            Quantity::Grams(300.0), None, &Tags::default(),
        );
        assert!(
            without_meal.unwrap_err().contains("which meal"),
            "a dish with no sitting has to be refused",
        );

        // And the pair that is actually allowed.
        add(
            &c, "2026-09-04", None, Source::Water(&bid), "Steel flask",
            Quantity::Grams(650.0), None, &Tags::default(),
        )
        .unwrap();
        add(
            &c, "2026-09-04", Some("lunch"), Source::Food(1), "Rajma",
            Quantity::Grams(300.0), None, &Tags::default(),
        )
        .unwrap();
    }

    #[test]
    fn an_optional_ingredient_is_remembered_as_optional() {
        // The flag is a note to the person at the stove and changes nothing
        // about the recipe's own weights — but it has to round-trip, because
        // it is what the cook sheet reads to offer "leave this out".
        let mut c = db();
        let mut hing = ing("Asafoetida", None, 1.0, 1.0);
        hing.optional = true;
        let id = save_recipe(
            &mut c,
            "Dal tadka",
            900.0,
            None,
            None,
            &[ing("Toor dal", Some(16101), 200.0, 600.0), hing],
            &[],
            &Tags::default(),
        )
        .unwrap();

        let r = get_recipe(&c, &id).unwrap();
        assert!(!r.ingredients[0].optional);
        assert!(r.ingredients[1].optional);
        assert_eq!(r.yield_g, 900.0, "the flag moves no weight");
    }

    #[test]
    fn a_supplement_round_trips_and_an_edit_replaces_its_panel() {
        let mut c = db();
        let id = save_supplement(&mut c, None, &multivit()).unwrap();
        let got = get_supplement(&c, &id).unwrap();
        assert_eq!(got.name, "Multivitamin");
        assert_eq!(got.unit_noun, "tablet");
        assert_eq!(got.serving_units, 1.0);
        assert!(!got.panel_complete);
        assert_eq!(got.nutrients.len(), 1);
        assert_eq!(got.nutrients[0].nutrient_id, 1178);
        assert_eq!(got.nutrients[0].label_amount, 1000.0);

        // Editing replaces the panel wholesale, so removing a line removes it.
        let mut edited = multivit();
        edited.panel_complete = true;
        edited.nutrients = vec![SupplementNutrient {
            nutrient_id: 1114, // vitamin D instead
            position: 0,
            label_amount: 1000.0,
            label_unit: "IU".into(),
            label_form: "vitamin_d".into(),
            kind: "measured".into(),
            amount: Some(25.0),
            upper: None,
            convert_note: None,
        }];
        save_supplement(&mut c, Some(&id), &edited).unwrap();
        let got = get_supplement(&c, &id).unwrap();
        assert!(got.panel_complete);
        assert_eq!(got.nutrients.len(), 1);
        assert_eq!(got.nutrients[0].nutrient_id, 1114);
    }

    #[test]
    fn a_line_this_app_cannot_convert_is_stored_with_its_reason_not_dropped() {
        // 400 IU of vitamin E with no form named. The pack said something; the
        // app cannot say what it means here, and losing the row would make the
        // panel look silent on a nutrient it actually declares.
        let mut c = db();
        let mut sup = multivit();
        sup.nutrients = vec![SupplementNutrient {
            nutrient_id: 1109,
            position: 0,
            label_amount: 400.0,
            label_unit: "IU".into(),
            label_form: "unspecified".into(),
            kind: "not_converted".into(),
            amount: None,
            upper: None,
            convert_note: Some("the pack does not say whether it is d- or dl-".into()),
        }];
        let id = save_supplement(&mut c, None, &sup).unwrap();
        let got = get_supplement(&c, &id).unwrap();
        assert_eq!(got.nutrients[0].label_amount, 400.0);
        assert_eq!(got.nutrients[0].label_unit, "IU");
        assert!(got.nutrients[0].amount.is_none());
        assert!(got.nutrients[0].convert_note.is_some());

        // And such a row must not be storable without its reason.
        let mut silent = sup.clone();
        silent.nutrients[0].convert_note = None;
        assert!(save_supplement(&mut c, None, &silent).is_err());
    }

    #[test]
    fn deleting_a_supplement_does_not_break_a_day_that_already_took_it() {
        let mut c = db();
        let id = save_supplement(&mut c, None, &multivit()).unwrap();
        add(
            &c, "2026-09-04", Some("breakfast"), Source::Supplement(&id), "Multivitamin",
            Quantity::Units(1.0), None, &Tags::default(),
        )
        .unwrap();
        delete_supplement(&c, &id).unwrap();

        assert!(get_supplement(&c, &id).is_err(), "gone from the live list");
        assert!(
            get_supplement_for_history(&c, &id).is_ok(),
            "but a day that took it must still resolve"
        );
        assert_eq!(day(&c, "2026-09-04").unwrap().len(), 1);
    }

    // ── origin and cuisine ──────────────────────────────────────────────

    #[test]
    fn a_dish_records_the_users_own_answer_and_nothing_when_they_have_not_given_one() {
        let c = db();
        add(
            &c, "2026-09-04", Some("lunch"), Source::Food(1), "Dal",
            Quantity::Grams(200.0), None,
            &Tags { origin: Some("home".into()), cuisine: Some("South Indian".into()) },
        )
        .unwrap();
        add(
            &c, "2026-09-04", Some("dinner"), Source::Food(2), "Noodles",
            Quantity::Grams(300.0), None, &Tags::default(),
        )
        .unwrap();

        let entries = day(&c, "2026-09-04").unwrap();
        assert_eq!(entries[0].origin.as_deref(), Some("home"));
        assert_eq!(entries[0].cuisine.as_deref(), Some("South Indian"));
        // Not recorded stays not recorded. Nothing may fill it in.
        assert_eq!(entries[1].origin, None);
        assert_eq!(entries[1].cuisine, None);
    }

    #[test]
    fn an_origin_the_app_does_not_record_is_refused_with_a_sentence() {
        let c = db();
        let bad = Tags { origin: Some("takeaway".into()), cuisine: None };
        let err = add(
            &c, "2026-09-04", Some("lunch"), Source::Food(1), "Dal",
            Quantity::Grams(200.0), None, &bad,
        )
        .unwrap_err();
        assert!(err.contains("takeaway"), "the message names the bad value: {err}");
    }

    #[test]
    fn spellings_of_one_cuisine_fold_into_one_group() {
        // "South Indian", "south indian" and "SOUTH  Indian" are one bar, not
        // three, and the label shown is the user's own most recent spelling.
        let c = db();
        for (i, spelling) in ["South Indian", "south indian", "SOUTH  Indian"]
            .iter()
            .enumerate()
        {
            add(
                &c, "2026-09-04", Some("lunch"), Source::Food(i as i64 + 1), "Dish",
                Quantity::Grams(100.0), None,
                &Tags { origin: None, cuisine: Some((*spelling).into()) },
            )
            .unwrap();
        }
        let counts = cuisine_counts(&c, "2026-09-01", "2026-09-30").unwrap();
        assert_eq!(counts.len(), 1, "one cuisine, however it was spelled");
        assert_eq!(counts[0].entries, 3);
        assert_eq!(counts[0].days, 1);

        let cuisines = list_cuisines(&c, 10).unwrap();
        assert_eq!(cuisines.len(), 1);
    }

    #[test]
    fn the_untagged_group_is_reported_rather_than_hidden() {
        // How much you have not said is part of what the chart is showing.
        let c = db();
        add(
            &c, "2026-09-04", Some("lunch"), Source::Food(1), "Dal",
            Quantity::Grams(200.0), None,
            &Tags { origin: Some("home".into()), cuisine: None },
        )
        .unwrap();
        add(
            &c, "2026-09-04", Some("dinner"), Source::Food(2), "Noodles",
            Quantity::Grams(300.0), None, &Tags::default(),
        )
        .unwrap();

        let origins = origin_counts(&c, "2026-09-01", "2026-09-30").unwrap();
        let untagged = origins.iter().find(|o| o.key.is_none()).expect("untagged group");
        assert_eq!(untagged.entries, 1);
        let home = origins.iter().find(|o| o.key.as_deref() == Some("home")).unwrap();
        assert_eq!(home.entries, 1);
    }

    #[test]
    fn a_supplement_is_not_a_dish_and_never_appears_in_the_cuisine_chart() {
        let mut c = db();
        let sid = save_supplement(&mut c, None, &multivit()).unwrap();
        add(
            &c, "2026-09-04", Some("breakfast"), Source::Supplement(&sid), "Multivitamin",
            Quantity::Units(1.0), None, &Tags::default(),
        )
        .unwrap();
        // Counting it as untagged would invent a gap that is not there.
        assert!(cuisine_counts(&c, "2026-09-01", "2026-09-30").unwrap().is_empty());
        assert!(origin_counts(&c, "2026-09-01", "2026-09-30").unwrap().is_empty());
    }

    #[test]
    fn a_supplement_only_day_is_not_counted_as_a_day_of_food() {
        // The divisor for a period average must not include a day on which
        // nothing was eaten, or the average understates intake — the same
        // reasoning that makes it days-logged rather than calendar length.
        let mut c = db();
        let sid = save_supplement(&mut c, None, &multivit()).unwrap();
        add(
            &c, "2026-09-04", Some("breakfast"), Source::Supplement(&sid), "Multivitamin",
            Quantity::Units(1.0), None, &Tags::default(),
        )
        .unwrap();
        add(
            &c, "2026-09-05", Some("lunch"), Source::Food(1), "Dal",
            Quantity::Grams(200.0), None, &Tags::default(),
        )
        .unwrap();

        let days = logged_days_between(&c, "2026-09-01", "2026-09-30").unwrap();
        assert_eq!(days.len(), 2, "both days hold something");
        let pill_day = days.iter().find(|d| d.date == "2026-09-04").unwrap();
        assert_eq!(pill_day.food_items, 0);
        assert_eq!(pill_day.supplement_items, 1);
        assert_eq!(pill_day.grams, 0.0);
        let food_day = days.iter().find(|d| d.date == "2026-09-05").unwrap();
        assert_eq!(food_day.food_items, 1);
        assert_eq!(food_day.supplement_items, 0);
    }

    #[test]
    fn a_water_entry_is_not_a_dish_and_never_appears_in_the_cuisine_chart() {
        let c = db();
        let bid = save_bottle(&c, None, "Steel bottle", 1050.0).unwrap();
        add(
            &c, "2026-09-04", None, Source::Water(&bid), "Steel bottle",
            Quantity::Grams(650.0), None, &Tags::default(),
        )
        .unwrap();
        // Counting it as untagged would invent a gap that is not there.
        assert!(cuisine_counts(&c, "2026-09-01", "2026-09-30").unwrap().is_empty());
        assert!(origin_counts(&c, "2026-09-01", "2026-09-30").unwrap().is_empty());
    }

    #[test]
    fn a_water_only_day_is_not_counted_as_a_day_of_food() {
        // Finishing a bottle is not a claim about what, or whether, anything
        // was eaten — the same reasoning that excludes a supplement-only day
        // from the divisor a period average uses.
        let c = db();
        let bid = save_bottle(&c, None, "Steel bottle", 1050.0).unwrap();
        add(
            &c, "2026-09-04", None, Source::Water(&bid), "Steel bottle",
            Quantity::Grams(650.0), None, &Tags::default(),
        )
        .unwrap();
        add(
            &c, "2026-09-05", Some("lunch"), Source::Food(1), "Dal",
            Quantity::Grams(200.0), None, &Tags::default(),
        )
        .unwrap();

        let days = logged_days_between(&c, "2026-09-01", "2026-09-30").unwrap();
        assert_eq!(days.len(), 2, "both days hold something");
        let water_day = days.iter().find(|d| d.date == "2026-09-04").unwrap();
        assert_eq!(water_day.food_items, 0);
        assert_eq!(water_day.water_items, 1);
        assert_eq!(
            water_day.grams, 0.0,
            "a bottle's mass is not the mass of food eaten"
        );
        let food_day = days.iter().find(|d| d.date == "2026-09-05").unwrap();
        assert_eq!(food_day.food_items, 1);
        assert_eq!(food_day.water_items, 0);
        assert_eq!(food_day.grams, 200.0);
    }

    #[test]
    fn a_tag_is_recalled_from_the_users_own_last_answer_and_never_from_a_name() {
        let c = db();
        add(
            &c, "2026-09-01", Some("lunch"), Source::Food(16033), "Rajma",
            Quantity::Grams(200.0), None,
            &Tags { origin: Some("home".into()), cuisine: Some("North Indian".into()) },
        )
        .unwrap();

        let recalled = recall_tags(&c, Source::Food(16033)).unwrap();
        assert_eq!(recalled.origin.as_deref(), Some("home"));
        assert_eq!(recalled.cuisine.as_deref(), Some("North Indian"));

        // A food they have never tagged gets nothing. There is no inference
        // from the description, and no default.
        let unknown = recall_tags(&c, Source::Food(99999)).unwrap();
        assert_eq!(unknown.origin, None);
        assert_eq!(unknown.cuisine, None);
    }

    #[test]
    fn the_two_tags_are_recalled_independently() {
        // The last entry may have carried an origin and no cuisine; recalling
        // them together would lose the older cuisine answer.
        let c = db();
        add(
            &c, "2026-09-01", Some("lunch"), Source::Food(1), "Dal",
            Quantity::Grams(200.0), None,
            &Tags { origin: Some("home".into()), cuisine: Some("Gujarati".into()) },
        )
        .unwrap();
        add(
            &c, "2026-09-02", Some("lunch"), Source::Food(1), "Dal",
            Quantity::Grams(200.0), None,
            &Tags { origin: Some("ordered_in".into()), cuisine: None },
        )
        .unwrap();

        let r = recall_tags(&c, Source::Food(1)).unwrap();
        assert_eq!(r.origin.as_deref(), Some("ordered_in"), "the newer answer");
        assert_eq!(r.cuisine.as_deref(), Some("Gujarati"), "the older one survives");
    }

    #[test]
    fn an_entry_can_be_retagged_afterwards_and_cleared_again() {
        let c = db();
        let id = add(
            &c, "2026-09-04", Some("lunch"), Source::Food(1), "Dal",
            Quantity::Grams(200.0), None, &Tags::default(),
        )
        .unwrap();
        set_tags(
            &c, &id,
            &Tags { origin: Some("eaten_out".into()), cuisine: Some("Indo-Chinese".into()) },
        )
        .unwrap();
        let e = &day(&c, "2026-09-04").unwrap()[0];
        assert_eq!(e.origin.as_deref(), Some("eaten_out"));
        assert_eq!(e.cuisine.as_deref(), Some("Indo-Chinese"));

        // Clearing puts it back to "not recorded", not to a blank string.
        set_tags(&c, &id, &Tags::default()).unwrap();
        let e = &day(&c, "2026-09-04").unwrap()[0];
        assert_eq!(e.origin, None);
        assert_eq!(e.cuisine, None);
    }

    #[test]
    fn an_absent_profile_reads_as_an_empty_one_rather_than_failing() {
        // "No profile yet" and "a profile with nothing in it" mean the same
        // thing to every caller, so they are one shape.
        let c = db();
        let p = get_profile(&c).unwrap();
        assert_eq!(p.sex, None);
        assert_eq!(p.birth_year, None);
        assert_eq!(p.life_stage, "standard");
        assert_eq!(p.energy_kcal, None);
    }

    #[test]
    fn a_profile_round_trips_and_saving_again_replaces_it_wholesale() {
        let c = db();
        save_profile(
            &c,
            &Profile {
                sex: Some("female".into()),
                birth_year: Some(1990),
                height_cm: Some(165.0),
                weight_kg: Some(60.0),
                activity: Some("moderate".into()),
                life_stage: "pregnant".into(),
                energy_kcal: Some(2100.0),
            },
        )
        .unwrap();
        let p = get_profile(&c).unwrap();
        assert_eq!(p.sex.as_deref(), Some("female"));
        assert_eq!(p.height_cm, Some(165.0));
        assert_eq!(p.life_stage, "pregnant");
        assert_eq!(p.energy_kcal, Some(2100.0));

        // Clearing a field really clears it. A partial update would make "leave
        // my height alone" and "I no longer want to say" the same request, and
        // the second is what turns the energy estimate back off.
        save_profile(
            &c,
            &Profile {
                sex: Some("female".into()),
                birth_year: Some(1990),
                height_cm: None,
                weight_kg: None,
                activity: None,
                life_stage: "standard".into(),
                energy_kcal: None,
            },
        )
        .unwrap();
        let p = get_profile(&c).unwrap();
        assert_eq!(p.height_cm, None);
        assert_eq!(p.weight_kg, None);
        assert_eq!(p.activity, None);
        assert_eq!(p.energy_kcal, None);
        assert_eq!(p.life_stage, "standard");
        // ...and there is still exactly one row.
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM profile", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn a_profile_field_the_app_does_not_know_is_refused_with_a_sentence() {
        let c = db();
        let bad = |p: Profile| save_profile(&c, &p).unwrap_err();
        let base = Profile {
            life_stage: "standard".into(),
            ..Default::default()
        };
        assert!(bad(Profile { sex: Some("other".into()), ..base.clone() }).contains("other"));
        assert!(bad(Profile { activity: Some("olympian".into()), ..base.clone() }).contains("olympian"));
        assert!(bad(Profile { life_stage: "menopausal".into(), ..base.clone() }).contains("menopausal"));
        assert!(bad(Profile { height_cm: Some(-5.0), ..base.clone() }).contains("height"));
        assert!(bad(Profile { weight_kg: Some(0.0), ..base.clone() }).contains("weight"));
        assert!(bad(Profile { birth_year: Some(3000), ..base.clone() }).contains("birth year"));
    }

    #[test]
    fn a_target_is_set_changed_and_cleared() {
        let c = db();
        assert!(list_targets(&c).unwrap().is_empty());

        set_target(&c, 1089, Some(25.0), Some("what my haematologist said")).unwrap();
        let t = list_targets(&c).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].nutrient_id, 1089);
        assert_eq!(t[0].amount, 25.0);
        assert_eq!(t[0].note.as_deref(), Some("what my haematologist said"));

        // Setting it again replaces rather than duplicating.
        set_target(&c, 1089, Some(30.0), None).unwrap();
        let t = list_targets(&c).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].amount, 30.0);
        assert_eq!(t[0].note, None);

        // Clearing removes the row, which returns the nutrient to whichever
        // published figure applies.
        set_target(&c, 1089, None, None).unwrap();
        assert!(list_targets(&c).unwrap().is_empty());
    }

    #[test]
    fn a_target_that_is_not_a_positive_number_is_refused() {
        let c = db();
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(set_target(&c, 1089, Some(bad), None).is_err(), "{bad} was accepted");
        }
        assert!(list_targets(&c).unwrap().is_empty());
    }

    #[test]
    fn migrates_a_v5_profile_without_losing_what_was_already_in_it() {
        // The profile table shipped in every earlier version but nothing ever
        // wrote to it. The migration still has to carry a row across, because
        // "in practice empty" is not the same as "guaranteed empty".
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE profile (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               sex TEXT CHECK (sex IN ('female','male')),
               birth_year INTEGER,
               height_cm REAL,
               updated_at TEXT
             );
             INSERT INTO profile (id,sex,birth_year,height_cm,updated_at)
             VALUES (1,'male',1985,180.0,'t');",
        )
        .unwrap();
        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();

        let p = get_profile(&c).unwrap();
        assert_eq!(p.sex.as_deref(), Some("male"));
        assert_eq!(p.birth_year, Some(1985));
        assert_eq!(p.height_cm, Some(180.0));
        // The new fields arrive as "not said", not as a value.
        assert_eq!(p.weight_kg, None);
        assert_eq!(p.activity, None);
        assert_eq!(p.energy_kcal, None);
        assert_eq!(p.life_stage, "standard");

        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        // Starting from v0 so the arms actually run the first time round; a
        // second pass over the same file must change nothing.
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_V0).unwrap();
        c.execute(
            "INSERT INTO log_entries
               (id,logged_on,meal,fdc_id,description,grams,created_at,updated_at)
             VALUES ('e0','2026-09-04','lunch',1000,'Cheddar',30.0,'t','t')",
            [],
        )
        .unwrap();
        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();
        let before = columns(&c, "log_entries").unwrap();
        let n_before: i64 = c
            .query_row("SELECT COUNT(*) FROM log_entries", [], |r| r.get(0))
            .unwrap();

        migrate(&mut c).unwrap();
        let after = columns(&c, "log_entries").unwrap();
        let n_after: i64 = c
            .query_row("SELECT COUNT(*) FROM log_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(n_before, n_after);
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }

    #[test]
    fn migrates_a_v1_database_keeping_recipe_backed_entries_intact() {
        // The realistic upgrade path: a user already on recipes.
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_V1).unwrap();
        c.execute(
            "INSERT INTO recipes (id,name,yield_g,servings,created_at,updated_at)
             VALUES ('r0','Rajma chawal',1212.0,4.0,'t','t')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO log_entries
               (id,logged_on,meal,source_kind,fdc_id,recipe_id,description,grams,
                created_at,updated_at,deleted_at)
             VALUES ('e0','2026-08-16','lunch','recipe',NULL,'r0','Rajma chawal',303.0,
                     't','t',NULL),
                    ('e1','2026-08-16','dinner','food',1000,NULL,'Cheddar',30.0,'t','t','t')",
            [],
        )
        .unwrap();

        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();

        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM log_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "the soft-deleted row must survive too");
        let (kind, rid): (String, String) = c
            .query_row(
                "SELECT source_kind, recipe_id FROM log_entries WHERE id='e0'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((kind.as_str(), rid.as_str()), ("recipe", "r0"));
        // Pre-v2 rows were all typed in by hand, so they carry no provenance.
        let entries = day(&c, "2026-08-16").unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].gross_g.is_none() && entries[0].tare_note.is_none());
    }

    #[test]
    fn a_vessel_is_saved_then_re_weighed_under_the_same_id() {
        let c = db();
        let id = save_vessel(&c, None, "Steel katori", 118.0).unwrap();
        // Re-weighing is the same entry point, so the object keeps its identity
        // and the days that used it keep pointing at something real.
        let same = save_vessel(&c, Some(&id), "Steel katori (small)", 121.5).unwrap();
        assert_eq!(same, id);

        let vs = list_vessels(&c).unwrap();
        assert_eq!(vs.len(), 1, "an update must not insert a second row");
        assert_eq!(vs[0].name, "Steel katori (small)");
        assert_eq!(vs[0].grams, 121.5);
        assert!(vs[0].last_used_at.is_none());
    }

    #[test]
    fn rejects_a_vessel_that_cannot_be_tared_with() {
        let c = db();
        assert!(save_vessel(&c, None, "   ", 118.0).is_err());
        assert!(save_vessel(&c, None, "Katori", 0.0).is_err());
        assert!(save_vessel(&c, None, "Katori", -118.0).is_err());
        assert!(save_vessel(&c, None, "Katori", f64::NAN).is_err());
        assert!(save_vessel(&c, Some("nope"), "Katori", 118.0).is_err());
        assert!(list_vessels(&c).unwrap().is_empty());
    }

    #[test]
    fn the_vessel_you_used_last_comes_first_and_a_deleted_one_is_gone() {
        let c = db();
        save_vessel(&c, None, "Steel thali", 612.0).unwrap();
        let katori = save_vessel(&c, None, "Steel katori", 118.0).unwrap();
        let bowl = save_vessel(&c, None, "Glass bowl", 240.0).unwrap();

        touch_vessels(&c, &[katori.clone()]).unwrap();
        let names: Vec<String> = list_vessels(&c).unwrap().into_iter().map(|v| v.name).collect();
        // Used first, then the never-used ones alphabetically.
        assert_eq!(names, vec!["Steel katori", "Glass bowl", "Steel thali"]);

        delete_vessel(&c, &bowl).unwrap();
        let names: Vec<String> = list_vessels(&c).unwrap().into_iter().map(|v| v.name).collect();
        assert_eq!(names, vec!["Steel katori", "Steel thali"]);
        let still_there: i64 = c
            .query_row("SELECT COUNT(*) FROM vessels WHERE id = ?1", [&bowl], |r| r.get(0))
            .unwrap();
        assert_eq!(still_there, 1, "the row must survive for sync to see the deletion");
    }

    #[test]
    fn vessels_by_id_keeps_the_order_and_refuses_an_id_it_cannot_resolve() {
        let c = db();
        let thali = save_vessel(&c, None, "Steel thali", 612.0).unwrap();
        let katori = save_vessel(&c, None, "Steel katori", 118.0).unwrap();

        // Order is the caller's, because the note reads in the order ticked.
        let vs = vessels_by_id(&c, &[katori.clone(), thali.clone()]).unwrap();
        assert_eq!(
            vs.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(),
            vec!["Steel katori", "Steel thali"]
        );
        let total: f64 = vs.iter().map(|v| v.grams).sum();
        assert_eq!(total, 730.0, "a katori on a thali tares as both");

        assert!(vessels_by_id(&c, &["nope".to_string()]).is_err());
        // A client holding a deleted vessel must fail loudly rather than log a
        // weight with that vessel silently left in it.
        delete_vessel(&c, &thali).unwrap();
        assert!(vessels_by_id(&c, &[katori, thali]).is_err());
    }

    #[test]
    fn a_bottle_is_saved_then_re_weighed_under_the_same_id() {
        let c = db();
        let id = save_bottle(&c, None, "1L steel bottle", 1050.0).unwrap();
        // Re-weighing is the same entry point, so the object keeps its
        // identity and the days that used it keep pointing at something real.
        let same = save_bottle(&c, Some(&id), "1L steel bottle (dented)", 1030.0).unwrap();
        assert_eq!(same, id);

        let bs = list_bottles(&c).unwrap();
        assert_eq!(bs.len(), 1, "an update must not insert a second row");
        assert_eq!(bs[0].name, "1L steel bottle (dented)");
        assert_eq!(bs[0].full_g, 1030.0);
        assert!(bs[0].last_used_at.is_none());
    }

    #[test]
    fn rejects_a_bottle_that_cannot_be_registered() {
        let c = db();
        assert!(save_bottle(&c, None, "   ", 1050.0).is_err());
        assert!(save_bottle(&c, None, "Bottle", 0.0).is_err());
        assert!(save_bottle(&c, None, "Bottle", -1050.0).is_err());
        assert!(save_bottle(&c, None, "Bottle", f64::NAN).is_err());
        assert!(save_bottle(&c, Some("nope"), "Bottle", 1050.0).is_err());
        assert!(list_bottles(&c).unwrap().is_empty());
    }

    #[test]
    fn the_bottle_you_used_last_comes_first_and_a_deleted_one_is_gone() {
        let c = db();
        save_bottle(&c, None, "Kitchen jug", 2100.0).unwrap();
        let steel = save_bottle(&c, None, "Steel bottle", 1050.0).unwrap();
        let sipper = save_bottle(&c, None, "Gym sipper", 750.0).unwrap();

        touch_bottle(&c, &steel).unwrap();
        let names: Vec<String> = list_bottles(&c).unwrap().into_iter().map(|b| b.name).collect();
        // Used first, then the never-used ones alphabetically.
        assert_eq!(names, vec!["Steel bottle", "Gym sipper", "Kitchen jug"]);

        delete_bottle(&c, &sipper).unwrap();
        let names: Vec<String> = list_bottles(&c).unwrap().into_iter().map(|b| b.name).collect();
        assert_eq!(names, vec!["Steel bottle", "Kitchen jug"]);
        let still_there: i64 = c
            .query_row("SELECT COUNT(*) FROM bottles WHERE id = ?1", [&sipper], |r| r.get(0))
            .unwrap();
        assert_eq!(still_there, 1, "the row must survive for sync to see the deletion");
    }

    #[test]
    fn get_bottle_refuses_an_unknown_or_deleted_id() {
        let c = db();
        let id = save_bottle(&c, None, "Steel bottle", 1050.0).unwrap();
        assert_eq!(get_bottle(&c, &id).unwrap().full_g, 1050.0);

        assert!(get_bottle(&c, "nope").is_err());
        // A client holding a deleted bottle must fail loudly rather than log
        // against a full weight the library no longer stands behind.
        delete_bottle(&c, &id).unwrap();
        assert!(get_bottle(&c, &id).is_err());
    }

    #[test]
    fn a_tare_whose_arithmetic_does_not_agree_with_the_net_is_refused() {
        let c = db();
        let ok = Tare { gross_g: 850.0, tare_g: 730.0, note: "Steel katori + Steel thali".into() };
        let id = add(&c, "2026-09-04", Some("lunch"), Source::Food(1), "Rajma",
            Quantity::Grams(120.0), Some(&ok), &Tags::default()).unwrap();
        // Within the 0.05 g slack a scale's own rounding produces.
        let rounded = Tare { gross_g: 850.0, tare_g: 730.0, note: "Steel katori".into() };
        assert!(add(&c, "2026-09-04", Some("lunch"), Source::Food(1), "Rajma",
            Quantity::Grams(120.04), Some(&rounded), &Tags::default()).is_ok());
        // Outside it, the row is not written: the invariant lives here, not
        // only in the UI that did the subtraction.
        let wrong = Tare { gross_g: 850.0, tare_g: 730.0, note: "Steel katori".into() };
        assert!(add(&c, "2026-09-04", Some("lunch"), Source::Food(1), "Rajma",
            Quantity::Grams(300.0), Some(&wrong), &Tags::default()).is_err());
        let inverted = Tare { gross_g: 100.0, tare_g: 730.0, note: "Steel thali".into() };
        assert!(add(&c, "2026-09-04", Some("lunch"), Source::Food(1), "Rajma",
            Quantity::Grams(-630.0), Some(&inverted), &Tags::default()).is_err());

        assert_eq!(day(&c, "2026-09-04").unwrap().len(), 2, "only the two valid rows landed");
        let e = day(&c, "2026-09-04").unwrap().into_iter().find(|e| e.id == id).unwrap();
        assert_eq!(e.gross_g, Some(850.0));
        assert_eq!(e.tare_g, Some(730.0));
        assert_eq!(e.tare_note.as_deref(), Some("Steel katori + Steel thali"));
    }

    #[test]
    fn deleting_a_vessel_does_not_change_a_day_that_used_it() {
        let c = db();
        let katori = save_vessel(&c, None, "Steel katori", 118.0).unwrap();
        let vs = vessels_by_id(&c, &[katori.clone()]).unwrap();
        let tare = Tare {
            gross_g: 418.0,
            tare_g: vs[0].grams,
            note: vs[0].name.clone(),
        };
        add(&c, "2026-09-04", Some("lunch"), Source::Food(1), "Rajma",
            Quantity::Grams(300.0), Some(&tare), &Tags::default()).unwrap();
        touch_vessels(&c, &[katori.clone()]).unwrap();

        delete_vessel(&c, &katori).unwrap();
        // The note is denormalised for exactly this: the day still says what
        // was under the food, and the weight it was logged with is unchanged.
        let entries = day(&c, "2026-09-04").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].grams, Some(300.0));
        assert_eq!(entries[0].tare_g, Some(118.0));
        assert_eq!(entries[0].tare_note.as_deref(), Some("Steel katori"));
    }

    #[test]
    fn recipe_round_trips_with_ingredients_and_servings() {
        let mut c = db();
        let id = save_recipe(
            &mut c,
            "Rajma chawal",
            1212.0,
            Some(4.0),
            None,
            &[
                ing("Kidney beans, dry", Some(16033), 128.0, 384.0),
                ing("Rice, dry", Some(20044), 210.0, 630.0),
                ing("Garam masala", None, 8.0, 8.0),
            ],
            &[RecipeServing { id: String::new(), label: "1 katori + 1 cup".into(), grams: 303.0 }],
            &Tags::default(),
        )
        .unwrap();

        let r = get_recipe(&c, &id).unwrap();
        assert_eq!(r.name, "Rajma chawal");
        assert_eq!(r.ingredients.len(), 3);
        assert_eq!(r.serving_options.len(), 1);
        // Order must survive, since a recipe reads as a list.
        assert_eq!(r.ingredients[0].description, "Kidney beans, dry");
        assert_eq!(r.ingredients[2].position, 2);
    }

    #[test]
    fn an_ingredient_without_composition_data_is_kept_not_dropped() {
        // The gap has to stay visible. Dropping the row would make the recipe
        // look fully measured and silently overstate confidence in the day.
        let mut c = db();
        let id = save_recipe(
            &mut c, "Sambar", 600.0, Some(4.0), None,
            &[ing("Toor dal", Some(16101), 100.0, 300.0), ing("Sambar powder", None, 6.0, 6.0)],
            &[],
            &Tags::default(),
        )
        .unwrap();
        let r = get_recipe(&c, &id).unwrap();
        assert_eq!(r.ingredients.len(), 2);
        assert!(r.ingredients.iter().any(|i| i.fdc_id.is_none()));
    }

    #[test]
    fn a_log_entry_references_exactly_one_source() {
        let mut c = db();
        let rid = save_recipe(
            &mut c, "Rajma chawal", 1212.0, Some(4.0), None,
            &[ing("Kidney beans, dry", Some(16033), 128.0, 384.0)], &[], &Tags::default(),
        )
        .unwrap();

        let cid = save_custom_food(&mut c, None, &pack("Hershey's milk chocolate", 43.0, vec![]))
            .unwrap();
        let sid = save_supplement(&mut c, None, &multivit()).unwrap();

        assert!(add(&c, "2026-09-04", Some("lunch"), Source::Food(1), "Cheddar",
            Quantity::Grams(30.0), None, &Tags::default()).is_ok());
        assert!(add(&c, "2026-09-04", Some("lunch"), Source::Recipe(&rid), "Rajma",
            Quantity::Grams(303.0), None, &Tags::default()).is_ok());
        assert!(add(&c, "2026-09-04", Some("snack"), Source::Custom(&cid), "Hershey's",
            Quantity::Grams(43.0), None, &Tags::default()).is_ok());
        // Counted, not weighed — and the only kind of entry that may be.
        assert!(add(&c, "2026-09-04", Some("snack"), Source::Supplement(&sid), "Multivitamin",
            Quantity::Units(1.0), None, &Tags::default()).is_ok());
        // The two halves of that rule, both refused with a sentence rather than
        // a constraint code.
        assert!(add(&c, "2026-09-04", Some("snack"), Source::Supplement(&sid), "Multivitamin",
            Quantity::Grams(1.2), None, &Tags::default()).is_err());
        assert!(add(&c, "2026-09-04", Some("lunch"), Source::Food(1), "Cheddar",
            Quantity::Units(2.0), None, &Tags::default()).is_err());
        // "No source" and "more than one source" used to be runtime errors
        // here. `Source` is an enum, so they are now unrepresentable — the
        // compiler refuses what this test used to assert at runtime, which is
        // strictly the stronger guarantee. The table still enforces it
        // independently; `migrates_a_v0_database_...` drives that through raw
        // SQL, which is the only way left to write the malformed row.
        // And an id that does not exist must be refused, not stored.
        assert!(add(&c, "2026-09-04", Some("lunch"), Source::Recipe("nope"), "Ghost",
            Quantity::Grams(10.0), None, &Tags::default()).is_err());
        assert!(add(&c, "2026-09-04", Some("lunch"), Source::Custom("nope"), "Ghost",
            Quantity::Grams(10.0), None, &Tags::default()).is_err());

        let kinds: Vec<String> = day(&c, "2026-09-04")
            .unwrap()
            .into_iter()
            .map(|e| e.source_kind)
            .collect();
        assert_eq!(kinds, vec!["food", "recipe", "custom", "supplement"]);
    }

    #[test]
    fn a_water_entry_requires_a_real_bottle_and_a_weight() {
        let c = db();
        let bid = save_bottle(&c, None, "Steel bottle", 1050.0).unwrap();

        assert!(add(&c, "2026-09-04", None, Source::Water(&bid), "Steel bottle",
            Quantity::Grams(650.0), None, &Tags::default()).is_ok());
        // A bottle is weighed, not counted — the same rule a supplement gets
        // in the other direction.
        assert!(add(&c, "2026-09-04", None, Source::Water(&bid), "Steel bottle",
            Quantity::Units(1.0), None, &Tags::default()).is_err());
        // An id that does not exist must be refused, not stored.
        assert!(add(&c, "2026-09-04", None, Source::Water("nope"), "Ghost bottle",
            Quantity::Grams(650.0), None, &Tags::default()).is_err());

        let entries = day(&c, "2026-09-04").unwrap();
        let water: Vec<&LogEntry> = entries.iter().filter(|e| e.source_kind == "water").collect();
        assert_eq!(water.len(), 1, "only the valid entry must have been stored");
        assert_eq!(water[0].bottle_id.as_deref(), Some(bid.as_str()));
        assert_eq!(water[0].grams, Some(650.0));
    }

    #[test]
    fn rejects_a_recipe_that_cannot_be_scaled() {
        let mut c = db();
        assert!(save_recipe(&mut c, "x", 0.0, Some(4.0), None, &[ing("a", Some(1), 1.0, 1.0)], &[], &Tags::default()).is_err());
        // A count the user did offer still has to be usable. NULL is fine and
        // is tested a line below; zero is a number that would divide something.
        assert!(save_recipe(&mut c, "x", 100.0, Some(0.0), None, &[ing("a", Some(1), 1.0, 1.0)], &[], &Tags::default()).is_err());
        assert!(save_recipe(&mut c, "x", 100.0, None, None, &[ing("a", Some(1), 1.0, 1.0)], &[], &Tags::default()).is_ok());
        assert!(save_recipe(&mut c, "  ", 100.0, Some(4.0), None, &[ing("a", Some(1), 1.0, 1.0)], &[], &Tags::default()).is_err());
        assert!(save_recipe(&mut c, "x", 100.0, Some(4.0), None, &[], &[], &Tags::default()).is_err());
    }

    #[test]
    fn deleting_a_recipe_is_soft_so_a_future_sync_can_propagate_it() {
        let mut c = db();
        let id = save_recipe(&mut c, "x", 100.0, None, None, &[ing("a", Some(1), 1.0, 1.0)], &[], &Tags::default()).unwrap();
        delete_recipe(&c, &id).unwrap();
        assert!(list_recipes(&c).unwrap().is_empty());
        let still_there: i64 = c
            .query_row("SELECT COUNT(*) FROM recipes WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(still_there, 1, "the row must survive for sync to see the deletion");
    }

    #[test]
    fn migrates_a_v2_database_keeping_the_provenance_of_a_weighed_entry() {
        // The realistic upgrade path for anyone already tareing on a scale.
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_V2).unwrap();
        c.execute(
            "INSERT INTO log_entries
               (id,logged_on,meal,source_kind,fdc_id,recipe_id,description,grams,
                gross_g,tare_g,tare_note,created_at,updated_at,deleted_at)
             VALUES ('e0','2026-08-16','lunch','food',1000,NULL,'Rajma',300.0,
                     418.0,118.0,'Steel katori','t','t',NULL),
                    ('e1','2026-08-16','dinner','food',1001,NULL,'Cheddar',30.0,
                     NULL,NULL,NULL,'t','t','t')",
            [],
        )
        .unwrap();

        c.execute_batch(SCHEMA).unwrap();
        migrate(&mut c).unwrap();

        assert!(columns(&c, "log_entries")
            .unwrap()
            .contains(&"custom_food_id".to_string()));
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM log_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "the soft-deleted row must survive too");

        // The whole point of the rebuild: what was under the food is still
        // recorded, and the entry still knows it came off a scale.
        let entries = day(&c, "2026-08-16").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].gross_g, Some(418.0));
        assert_eq!(entries[0].tare_g, Some(118.0));
        assert_eq!(entries[0].tare_note.as_deref(), Some("Steel katori"));
        assert!(entries[0].custom_food_id.is_none());

        // And the third polymorphism CHECK came across with the columns, not
        // just the column itself — ALTER TABLE ADD COLUMN could not have.
        assert!(c
            .execute(
                "INSERT INTO log_entries
                   (id,logged_on,meal,source_kind,fdc_id,recipe_id,custom_food_id,
                    description,grams,created_at,updated_at)
                 VALUES ('bad','2026-09-04','lunch','custom',1000,NULL,'x','Both',10.0,'t','t')",
                []
            )
            .is_err());
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }

    #[test]
    fn a_custom_food_round_trips_and_an_edit_replaces_its_nutrient_rows() {
        let mut c = db();
        let mut f = pack(
            "Milk chocolate bar",
            43.0,
            vec![
                measured(1008, 210.0),
                measured(1004, 13.0),
                measured(1258, 8.0),
                bounded(1257, "label_zero", 0.5),
                measured(1003, 3.0),
            ],
        );
        f.brand = Some("  Hershey's  ".into());
        f.overrides_fdc_id = Some(19120);
        f.serving_label = Some("1 bar (43 g)".into());
        f.barcode = Some("034000002405".into());
        f.ingredients = Some("Sugar, milk, chocolate, cocoa butter".into());
        f.photo_label = Some("aa.jpg".into());

        let id = save_custom_food(&mut c, None, &f).unwrap();
        let got = get_custom_food(&c, &id).unwrap();
        assert_eq!(got.name, "Milk chocolate bar");
        assert_eq!(got.brand.as_deref(), Some("Hershey's"), "trimmed, not padded");
        assert_eq!(got.overrides_fdc_id, Some(19120));
        assert_eq!(got.serving_g, 43.0);
        assert_eq!(got.serving_label.as_deref(), Some("1 bar (43 g)"));
        assert_eq!(got.photo_label.as_deref(), Some("aa.jpg"));
        assert_eq!(got.nutrients.len(), 5);
        // Stored exactly as the pack prints them, per serving. Converting to the
        // app's per-100 g basis is the panel's job, not the table's — storing the
        // converted figure would lose what the label actually said.
        let energy = got.nutrients.iter().find(|n| n.nutrient_id == 1008).unwrap();
        assert_eq!(energy.amount, Some(210.0));

        // An edit that drops a line must really drop it, not leave a row behind
        // still asserting a value the pack no longer says.
        let mut edited = got.clone();
        edited.nutrients = vec![measured(1008, 220.0), measured(1093, 35.0)];
        let same = save_custom_food(&mut c, Some(&id), &edited).unwrap();
        assert_eq!(same, id, "editing keeps the food's identity");

        let after = get_custom_food(&c, &id).unwrap();
        assert_eq!(after.nutrients.len(), 2);
        assert!(after.nutrients.iter().all(|n| n.nutrient_id != 1258));
        assert_eq!(
            after.nutrients.iter().find(|n| n.nutrient_id == 1008).unwrap().amount,
            Some(220.0)
        );
        assert_eq!(list_custom_foods(&c).unwrap().len(), 1, "an edit is not a second food");
    }

    #[test]
    fn rejects_a_custom_food_no_pack_could_have_described() {
        let mut c = db();
        assert!(save_custom_food(&mut c, None, &pack("   ", 43.0, vec![])).is_err());
        // Without a serving weight every transcribed figure is unscalable, so
        // the food is not storable at all.
        assert!(save_custom_food(&mut c, None, &pack("Bar", 0.0, vec![])).is_err());
        assert!(save_custom_food(&mut c, None, &pack("Bar", -43.0, vec![])).is_err());
        assert!(save_custom_food(&mut c, None, &pack("Bar", f64::NAN, vec![])).is_err());

        // A pack cannot assert a true zero, so that kind is not offered.
        assert!(save_custom_food(
            &mut c,
            None,
            &pack("Bar", 43.0, vec![bounded(1004, "measured_zero", 0.5)])
        )
        .is_err());
        assert!(save_custom_food(
            &mut c,
            None,
            &pack("Bar", 43.0, vec![measured(1004, -1.0)])
        )
        .is_err());
        // A label prints each line once; two rows for one nutrient means one of
        // them is wrong and nothing here can tell which.
        assert!(save_custom_food(
            &mut c,
            None,
            &pack("Bar", 43.0, vec![measured(1004, 13.0), measured(1004, 12.0)])
        )
        .is_err());
        assert!(save_custom_food(&mut c, Some("nope"), &pack("Bar", 43.0, vec![])).is_err());

        assert!(list_custom_foods(&c).unwrap().is_empty(), "nothing partial landed");
        let orphans: i64 = c
            .query_row("SELECT COUNT(*) FROM custom_food_nutrients", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0, "a rejected save must roll its nutrient rows back");
    }

    #[test]
    fn a_declared_zero_is_stored_as_a_bound_never_as_a_measured_zero() {
        // 21 CFR 101.9 lets a pack print "0 g" of fat for anything under 0.5 g.
        // Reading that back as a measurement of absence is the exact laundering
        // this app exists to prevent.
        let mut c = db();
        let id = save_custom_food(
            &mut c,
            None,
            &pack(
                "Milk chocolate bar",
                43.0,
                vec![bounded(1257, "label_zero", 0.5), bounded(1079, "trace", 0.5)],
            ),
        )
        .unwrap();

        let got = get_custom_food(&c, &id).unwrap();
        let trans = got.nutrients.iter().find(|n| n.nutrient_id == 1257).unwrap();
        assert_eq!(trans.kind, "label_zero");
        assert_eq!(trans.amount, None);
        assert_eq!(trans.upper, Some(0.5));

        match trackit_core::NutrientValue::from_db(&trans.kind, trans.amount, trans.upper) {
            trackit_core::NutrientValue::LabelZero { upper } => assert_eq!(upper, 0.5),
            other => panic!("a declared zero must read as a bound, got {other:?}"),
        }
        let fiber = got.nutrients.iter().find(|n| n.nutrient_id == 1079).unwrap();
        assert!(matches!(
            trackit_core::NutrientValue::from_db(&fiber.kind, fiber.amount, fiber.upper),
            trackit_core::NutrientValue::Trace { .. }
        ));

        // And the kind cannot be smuggled past the table either.
        assert!(c
            .execute(
                "UPDATE custom_food_nutrients SET kind = 'measured_zero' WHERE nutrient_id = 1257",
                []
            )
            .is_err());
    }

    #[test]
    fn search_ranks_an_exact_name_above_a_prefix_and_a_prefix_above_a_substring() {
        let mut c = db();
        for (name, brand) in [
            ("Chocolate", None),
            ("Chocolate chip cookies", None),
            ("Dark milk chocolate", None),
            ("Malted drink", Some("Chocolate House")),
        ] {
            let mut f = pack(name, 43.0, vec![]);
            f.brand = brand.map(String::from);
            save_custom_food(&mut c, None, &f).unwrap();
        }

        let names: Vec<String> = search_custom_foods(&c, "  CHOCOLATE ", 20)
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(
            names,
            vec![
                "Chocolate",
                "Chocolate chip cookies",
                "Dark milk chocolate",
                "Malted drink",
            ],
            "exact, then name prefix, then word inside the name, then brand"
        );

        // Barcode is how you find a food you never named memorably.
        let mut coded = pack("Bar", 43.0, vec![]);
        coded.barcode = Some("034000002405".into());
        let cid = save_custom_food(&mut c, None, &coded).unwrap();
        let hits = search_custom_foods(&c, "034000002405", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, cid);

        // A wildcard typed into the box is a character, not a pattern.
        save_custom_food(&mut c, None, &pack("100% cocoa", 10.0, vec![])).unwrap();
        let hits = search_custom_foods(&c, "100%", 20).unwrap();
        assert_eq!(
            hits.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["100% cocoa"]
        );

        assert!(search_custom_foods(&c, "   ", 20).unwrap().is_empty());
        assert_eq!(search_custom_foods(&c, "chocolate", 2).unwrap().len(), 2);

        // A deleted food is not a food you can log.
        delete_custom_food(&c, &cid).unwrap();
        assert!(search_custom_foods(&c, "034000002405", 20).unwrap().is_empty());
    }

    /// Packs are set in capitals, and an accented capital used to make a food
    /// unfindable by its own name: the query was folded by Rust with full
    /// Unicode and the column by SQLite's ASCII-only `lower()`, so the two never
    /// met on the É.
    #[test]
    fn a_name_with_an_accented_capital_is_found_by_typing_that_name() {
        let mut c = db();
        save_custom_food(&mut c, None, &pack("CAFÉ BUSTELO", 10.0, vec![])).unwrap();
        save_custom_food(&mut c, None, &pack("Éclair", 60.0, vec![])).unwrap();

        for q in ["CAFÉ BUSTELO", "café bustelo", "Café", "Éclair", "éclair"] {
            assert!(
                !search_custom_foods(&c, q, 20).unwrap().is_empty(),
                "“{q}” must find the food it names"
            );
        }

        let mut branded = pack("Crunch", 40.0, vec![]);
        branded.brand = Some("NESTLÉ".into());
        save_custom_food(&mut c, None, &branded).unwrap();
        assert_eq!(search_custom_foods(&c, "nestlé", 20).unwrap().len(), 1);
    }

    #[test]
    fn overridden_fdc_ids_reports_only_live_overrides() {
        let mut c = db();
        let mut bar = pack("Milk chocolate bar", 43.0, vec![]);
        bar.overrides_fdc_id = Some(19120);
        let bar_id = save_custom_food(&mut c, None, &bar).unwrap();

        let mut plain = pack("Trail mix", 40.0, vec![]);
        plain.overrides_fdc_id = None;
        save_custom_food(&mut c, None, &plain).unwrap();

        assert_eq!(overridden_fdc_ids(&c).unwrap(), vec![19120]);

        // Deleting the custom food must give the generic entry back, or the user
        // is left with no way to log the food at all.
        delete_custom_food(&c, &bar_id).unwrap();
        assert!(overridden_fdc_ids(&c).unwrap().is_empty());
    }

    /// An imported row is never expected to set `overrides_fdc_id` — nothing in
    /// the import flow offers that — but the filter has to hold regardless of
    /// what a row happens to contain, not just for the shapes the importer
    /// itself produces.
    #[test]
    fn the_override_queries_ignore_an_import_only_food_even_if_it_sets_one() {
        let mut c = db();
        let mut imported = pack("Imported — 2024-01-15", 100.0, vec![]);
        imported.import_only = true;
        imported.overrides_fdc_id = Some(19120);
        save_custom_food(&mut c, None, &imported).unwrap();

        assert!(
            overridden_fdc_ids(&c).unwrap().is_empty(),
            "an import-only food must never suppress a generic reference entry"
        );
        assert!(
            custom_food_overriding(&c, 19120).unwrap().is_none(),
            "an import-only food must never stand in as the replacement search shows"
        );
    }

    /// The whole point of `import_only`: a bulk-imported row must not clutter
    /// search or "My foods" (13,694 reference foods and a growing pile of
    /// imported ones would otherwise swarm both), but a day that already
    /// logged one must still be able to expand it.
    #[test]
    fn import_only_foods_are_invisible_to_search_and_the_picker_but_still_resolve_in_history() {
        let mut c = db();
        let mut imported = pack("Imported — 2024-01-15", 100.0, vec![measured(1008, 210.0)]);
        imported.import_only = true;
        let id = save_custom_food(&mut c, None, &imported).unwrap();
        add(&c, "2024-01-15", Some("snack"), Source::Custom(&id), "Imported — 2024-01-15",
            Quantity::Grams(100.0), None, &Tags::default())
            .unwrap();

        assert!(list_custom_foods(&c).unwrap().is_empty(), "must not appear in My foods");
        assert!(
            search_custom_foods(&c, "Imported", 20).unwrap().is_empty(),
            "must not appear in search"
        );

        // But the day that already logged it must still expand.
        let f = get_custom_food_for_history(&c, &id)
            .expect("a day that already used an imported entry must still resolve it");
        assert_eq!(f.nutrients.len(), 1);
        assert_eq!(day(&c, "2024-01-15").unwrap().len(), 1);
    }

    /// The departure from the label-import path: a manufacturer's panel cannot
    /// assert a true zero, but a person typing 0 into their own tracking
    /// spreadsheet is asserting exactly that — so it must round-trip as a real,
    /// present measurement, not as absence and not as a rounding bound.
    #[test]
    fn a_measured_zero_round_trips_as_a_real_present_zero() {
        let mut c = db();
        let id = save_custom_food(
            &mut c,
            None,
            &pack("Imported — 2024-02-01", 100.0, vec![measured(1093, 0.0)]), // sodium
        )
        .unwrap();

        let got = get_custom_food(&c, &id).unwrap();
        let sodium = got.nutrients.iter().find(|n| n.nutrient_id == 1093).unwrap();
        assert_eq!(sodium.kind, "measured");
        assert_eq!(sodium.amount, Some(0.0));
        assert_eq!(sodium.upper, None);

        match trackit_core::NutrientValue::from_db(&sodium.kind, sodium.amount, sodium.upper) {
            trackit_core::NutrientValue::Measured { amount } => assert_eq!(amount, 0.0),
            other => panic!("a typed zero must read as a real measurement, got {other:?}"),
        }
    }

    #[test]
    fn dates_with_existing_imports_reports_only_dates_with_a_live_import_only_entry() {
        let mut c = db();

        // An imported entry on 2024-01-15.
        let mut imported = pack("Imported — 2024-01-15", 100.0, vec![]);
        imported.import_only = true;
        let imported_id = save_custom_food(&mut c, None, &imported).unwrap();
        add(&c, "2024-01-15", Some("snack"), Source::Custom(&imported_id), "Imported — 2024-01-15",
            Quantity::Grams(100.0), None, &Tags::default())
            .unwrap();

        // An ordinary (non-import) custom food logged on a different date must
        // not count as "already imported".
        let ordinary_id = save_custom_food(
            &mut c, None, &pack("Milk chocolate bar", 43.0, vec![measured(1008, 210.0)]),
        )
        .unwrap();
        add(&c, "2024-01-16", Some("snack"), Source::Custom(&ordinary_id), "Milk chocolate bar",
            Quantity::Grams(43.0), None, &Tags::default())
            .unwrap();

        // A soft-deleted import entry must not count either — it is no longer
        // part of that day's total.
        let mut deleted = pack("Imported — 2024-01-17", 100.0, vec![]);
        deleted.import_only = true;
        let deleted_food_id = save_custom_food(&mut c, None, &deleted).unwrap();
        add(&c, "2024-01-17", Some("snack"), Source::Custom(&deleted_food_id), "Imported — 2024-01-17",
            Quantity::Grams(100.0), None, &Tags::default())
            .unwrap();
        let deleted_entry_id = day(&c, "2024-01-17").unwrap()[0].id.clone();
        remove(&c, &deleted_entry_id).unwrap();

        let dates = vec![
            "2024-01-15".to_string(),
            "2024-01-16".to_string(),
            "2024-01-17".to_string(),
            "2024-01-18".to_string(), // never logged at all
        ];
        assert_eq!(
            dates_with_existing_imports(&c, &dates).unwrap(),
            vec!["2024-01-15".to_string()]
        );

        assert!(dates_with_existing_imports(&c, &[]).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_custom_food_does_not_break_a_day_that_already_used_it() {
        let mut c = db();
        let id = save_custom_food(
            &mut c,
            None,
            &pack("Milk chocolate bar", 43.0, vec![measured(1008, 210.0)]),
        )
        .unwrap();
        add(&c, "2026-08-16", Some("snack"), Source::Custom(&id), "Milk chocolate bar",
            Quantity::Grams(43.0), None, &Tags::default())
            .unwrap();
        delete_custom_food(&c, &id).unwrap();

        // Gone from the list and the picker...
        assert!(list_custom_foods(&c).unwrap().is_empty());
        assert!(get_custom_food(&c, &id).is_err());
        // ...but a day that already used it must still expand, or history
        // vanishes because of an edit made today.
        let f = get_custom_food_for_history(&c, &id).expect("past days must still expand");
        assert_eq!(f.name, "Milk chocolate bar");
        assert_eq!(f.serving_g, 43.0);
        assert_eq!(f.nutrients.len(), 1, "the pack's figures must come with it");

        let entries = day(&c, "2026-08-16").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].custom_food_id.as_deref(), Some(id.as_str()));
        assert_eq!(entries[0].grams, Some(43.0));

        let still_there: i64 = c
            .query_row("SELECT COUNT(*) FROM custom_foods WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(still_there, 1, "the row must survive for sync to see the deletion");
    }
}
