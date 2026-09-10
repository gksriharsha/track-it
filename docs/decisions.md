# Architecture decisions (authoritative)

This document **supersedes** `architecture-data.md` and `architecture-app.md` wherever they
conflict with it. Those two remain useful drafts, but they were written independently and
disagree with each other in places; a completeness critique (`architecture-critique.md`) found
22 defects by running their DDL and SQL against the real data. The blocking ones are resolved
here. Every number below was measured against `data/raw/extracted/`.

---

## D1 — Portions keep `amount` and `gram_weight` as separate columns

**Defect.** Both drafts derive a single scalar `grams_per_unit = gram_weight / amount`.

**Measured reality.**

| Dataset | Portion rows | `amount` blank | `amount = 1` | `amount` other |
|---|---:|---:|---:|---:|
| Foundation | 10,951 | 0 | 10,789 | 162 |
| SR Legacy | 14,449 | 0 | 10,985 | **3,464** |
| FNDDS | 22,046 | **22,046** | 0 | 0 |

The division is undefined for all 22,046 FNDDS rows — 60% of the bundled portions — and on
SR Legacy it silently rewrites the meaning of the label. A row reading
`amount=240, gram_weight=240, modifier='ml'` means "240 ml weighs 240 g"; dividing yields
1 g, so a picker entry labelled "ml" would log **one gram** when the user selects one serving.

**Decision.**

```sql
portion_amount   REAL NOT NULL,   -- FNDDS forced to 1.0 at ingest
portion_unit     TEXT,            -- SR `modifier`, FNDDS parsed from portion_description
gram_weight      REAL NOT NULL CHECK (gram_weight > 0)
```

- Selecting one portion logs **`gram_weight` grams**, never a derived per-unit value.
- The label renders `"{portion_amount} {portion_unit} — {gram_weight} g"`, so the text can never
  name a quantity different from the value it encodes.
- FNDDS carries its quantity inside `portion_description` ("1 cup", "1 fl oz"); set
  `portion_amount = 1.0` explicitly and parse the unit from the description.

**Ingest assertions** (fail the build, don't warn):
`amount` non-blank and `> 0` on every Foundation and SR row; `amount` blank on every FNDDS row.
A future release that changes either convention must break the build rather than silently
rescale every portion.

---

## D2 — One `NutrientValue` type, defined once, in `crates/core`

**Defect.** The drafts define two incompatible types — 8 variants in one, 4 in the other, in
different crates, with different rules for the lower bound. Rows read from the DB had nowhere
to go in the app-side enum.

**Decision.** This is the only definition. It lives in `crates/core/src/nutrient_value.rs`.

```rust
pub enum NutrientValue {
    /// A real measurement or a documented calculation.
    Measured { amount: f64, derivation: Derivation },
    /// USDA stored 0 because the result was under the limit of quantification.
    BelowLoq { upper: f64 },
    /// A label-rounded zero (21 CFR 101.9 permits declaring zero below a threshold).
    LabelZero { upper: f64 },
    /// Source explicitly designates a trace amount.
    Trace { upper: f64 },
    /// Source asserts a true zero (USDA derivation code Z).
    AssumedZero,
    /// No data. Distinct from every kind of zero above.
    Absent,
}
```

Interval semantics — the whole point of the type:

| Variant | lower | upper | counts as covered? |
|---|---|---|---|
| `Measured { amount }` | `amount` | `amount` | yes |
| `BelowLoq { upper }` | 0.0 | `upper` | yes |
| `LabelZero { upper }` | 0.0 | `upper` | yes |
| `Trace { upper }` | 0.0 | `upper` | yes |
| `AssumedZero` | 0.0 | 0.0 | **yes** |
| `Absent` | 0.0 | **unbounded** | **no** |

`AssumedZero` is bounded on both ends. USDA is asserting the nutrient is genuinely absent from
the food, which is knowledge, not ignorance. Treating it as unbounded was making a confident
statement read as a gap.

**%RDA is computed from `lower`. %UL is computed from `upper`.** This is why a scalar cannot
work: the two features read opposite ends of the same interval. A day is `Unbounded` for a
nutrient if and only if at least one logged item is `Absent` for it.

The SQL never re-implements these rules. It projects them: the stored `value_kind` and
`amount`/`upper_bound` columns map one-to-one onto the variants above, and `lower`/`upper` are
computed by the same Rust code that defines them.

---

## D3 — Negative and blank source amounts have an explicit rule

**Defect.** `CHECK (amount >= 0)` and `NOT NULL` are both contradicted by the bundled data.

**Measured.** Foundation Foods has **10 negative amounts** — all nutrient 1005, carbohydrate by
difference — and **33 blank amounts**. SR Legacy has neither. Carbohydrate by difference is
`100 − (water + protein + fat + ash + alcohol)` and legitimately goes negative on fatty meats
(e.g. pork belly, chicken drumstick with skin). This is normal FDC output, not corruption.

**Decision.**

- Blank `amount` → **emit no row** → the nutrient reads `Absent` for that food.
- Negative `amount` → store `Measured { amount: 0.0 }` with `clamped = 1`, and retain the source
  value in `raw_amount` so the clamp is auditable and reversible.
- The `CHECK (amount >= 0)` constraint applies to the normalized column only; `raw_amount` is
  unconstrained.
- **Assertion:** negative-row count ≤ 25 at ingest. A release where this explodes indicates an
  upstream change and must fail the build.

Neither clamping silently nor dropping the food is acceptable: dropping would make every day
containing chicken permanently unbounded for carbohydrate.

---

## D4 — "No UL established" must be representable

**Defect.** The draft's `upper_limits` CHECK constraints are a biconditional that forces a
non-NULL `source_nutrient_id` for a UL that does not exist. Inserting thiamin — which has no UL —
fails. This breaks precisely the feature the design calls load-bearing.

Nutrients with **no UL established**: vitamin K, thiamin, riboflavin, pantothenic acid, biotin,
B12, chromium, potassium. Sodium has no UL either — the 2019 NASEM revision replaced it with a
CDRR of 2,300 mg, which is a different kind of limit and must be labelled as one.

**Decision.** Replace the biconditional with one-way implications:

```sql
status TEXT NOT NULL CHECK (status IN ('established','none_established','cdrr')),
CHECK (status <> 'none_established'
       OR (amount IS NULL AND applies_to = 'not_applicable' AND source_nutrient_id IS NULL)),
CHECK (status <> 'established'
       OR (amount IS NOT NULL AND source_nutrient_id IS NOT NULL))
```

A NULL `amount` renders as **"no upper limit established"** — never as "unlimited", and never as
a satisfied constraint.

---

## D5 — UL comparisons must target the right chemical form

The UL footnotes are restrictions, not annotations, and ignoring them fires false toxicity
warnings at people eating vegetables.

| Nutrient | UL applies to | Must NOT be evaluated against |
|---|---|---|
| Vitamin A | preformed retinol (1105), 3,000 µg/d | Vitamin A RAE (1106) |
| Folate | folic acid (1186), 1,000 µg/d | Folate DFE (1190) or total (1177) |
| Niacin | synthetic/added (1245) | Niacin (1167) or NE (1169) |
| Vitamin E | synthetic/supplemental | α-tocopherol from food (1109) |
| Magnesium | supplemental only | Total food magnesium (1090) |

**Caveat that must be surfaced in the UI, not hidden:** nutrient 1245 (added niacin) has **zero
rows in all three bundled datasets**, and Foundation provides folate largely as DFE rather than
folic acid. So for niacin the UL is structurally unevaluable from bundled data, and for folate it
is evaluable only where 1186 exists. The app must render these as **"cannot be evaluated"**, not
as "within limits". A UL check that silently always passes is worse than no UL check.

---

## D6 — Units carry a basis, not just a magnitude

**Defect.** `CHECK (unit IN ('g','mg','ug','kcal','kJ','IU'))` cannot distinguish µg RAE from
µg retinol from µg DFE, nor mg α-tocopherol from mg NE. Nothing then prevents summing folate DFE
with folic acid, or "fixing" a UL to read the wrong one because the units matched.

**Decision.** Unit is a pair:

```
magnitude ∈ {g, mg, ug, kcal, kJ, IU}
basis     ∈ {mass, energy, rae, retinol, dfe, folic_acid, alpha_te, ne, iu_a, iu_d, iu_e}
```

Arithmetic between differing bases is rejected in Rust, not by convention. IU conversion is
compound-dependent and therefore never a single constant — vitamin A alone needs four factors
(retinol 0.3, supplemental β-carotene 0.3, dietary β-carotene 0.05 µg RAE per IU, and the
α-carotene/β-cryptoxanthin case), so an IU value converts only when the source compound is known.

---

## D7 — Two-tier nutrient panel with a coverage threshold

*(Product decision, confirmed with the user.)*

**Problem.** Applied literally, "any `Absent` contributor makes the day unbounded" makes almost
every nutrient read "unknown" on almost every day, because barcode-scanned and custom foods carry
little micronutrient data. The mechanism is correct and the result is unusable.

**What makes a tiered split possible:** FNDDS carries **65 nutrients on 5,431 of its 5,432 foods**
— complete, consistent coverage on exactly the mixed dishes people log most.

**Decision.**

- **Core panel** — the 65 nutrients FNDDS covers. Rendered as ordinary values with a small
  coverage indicator. These resolve to a point value on any all-FNDDS day.
- **Extended panel** — iodine, chromium, biotin, molybdenum, added sugars, trans fat. Presented in
  a visually separate section that states plainly that bundled coverage is limited or absent, so a
  missing value reads as a known limitation rather than a personal deficiency.
- **Coverage threshold.** Let `coverage` be the fraction of the day's logged mass that has data
  for that nutrient.
  - `coverage ≥ 0.8` → render the point value from `lower`, with the coverage indicator.
  - `coverage < 0.8` → render the interval `≥ lower`, and **suppress the bar track entirely**.

The bar's presence keys off `coverage`, never off whether `lower` happens to be numerically
non-NULL. An empty or zero-filled track reads as "0% of target", which is the exact lie the whole
design exists to prevent.

---

## D8 — Only `role = 'primary'` nutrients render as dashboard rows

**Defect.** With no role column, anything stored for the UL evaluator or as a resolution-chain
member also becomes a dashboard row. Measured: on **100% of FNDDS foods**, four folate rows and
five vitamin A rows co-occur — ten dashboard rows for two nutrients, each with its own bar and
its own %RDA, inviting exactly the double-count the design guards against elsewhere.

**Decision.** Add to `nutrients`:

```sql
role TEXT NOT NULL CHECK (role IN ('primary','component','alternate','ul_source'))
```

Only `primary` renders. Folate displays once (DFE); folic acid is `ul_source`; total and food
folate are `component`. Vitamin A displays once (RAE); retinol is `ul_source`; the carotenes are
`component`.

---

## D9 — The `nutrients` dimension is copied into `user.db`

**Defect.** The two drafts disagree: one requires `ATTACH` of the reference DB for the rollup's
`FROM ref.nutrients`, the other forbids cross-file joins in hot queries. Both cannot hold, and
without the dimension table the rollup has nothing to join to, so every tracked nutrient vanishes
on an empty day.

**Decision.** Copy `nutrients` (a few dozen small rows) into `user.db` at migration time, stamped
with `meta.dataset_version`. Hot queries touch only `user.db`. The reference database stays
independently replaceable; the cost is one refresh step on a dataset version bump.

---

## D10 — Rollup and trend queries need a spine

Both must return a row for **every tracked nutrient**, and the trend must return a row for
**every day in range**, including days with no entries. The draft's rollup used
`FROM nutrients CROSS JOIN day`, which yields zero rows when the day CTE is empty — making every
nutrient disappear precisely when the user has logged nothing. The trend inherits the same bug
plus a missing date spine, so unlogged days produce no row and a client index-aligning the series
draws values on the wrong dates.

**Decision.** Both queries start from the dimension(s) and LEFT JOIN the facts inward:
`nutrients` for the day rollup, and `nutrients CROSS JOIN date_series(:from, :to)` for trends,
with a recursive CTE generating the date spine. Days with no data yield explicit NULLs, which the
chart renders as gaps — never as zeros.

---

## D11 — FNDDS nutrient ids must be translated

FNDDS `food_nutrient.nutrient_id` holds legacy `nutrient_nbr` values, not FDC ids: **65 of 65
match `nutrient_nbr`, 0 of 65 match `id`**. The ranges do not overlap, so a naive join silently
discards all 353,015 FNDDS rows. Translate through `nutrient_nbr` and assert non-zero join
cardinality. See `data-findings.md` for the mapping table and the genuine FNDDS gaps.

---

## D12 — A dose is a different scaling law from a mass, not a food with a small weight

*(Added with supplement logging.)*

**Problem.** `aggregate::sum` scaled every contribution by `grams / 100` and computed coverage as
`mass_covered / mass_total`. A supplement breaks both halves. A 1.2 g multivitamin can carry 100%
of the Daily Value for twenty micronutrients, so:

- **Per-100 g is meaningless for it.** 1,000 mg of calcium in a 1.2 g tablet is 83,333 mg/100 g of
  nothing. The arithmetic would come out right if the tablet were logged at its own weight, but
  the stored number would no longer denote anything real, and a user correcting the weight would
  silently rescale the dose.
- **Mass-weighted coverage is meaningless for it.** A tablet's mass is not the basis of its
  content, so whatever it contributed to the denominator would move the D7 0.8 threshold by an
  amount with no interpretation.

**Decision.** `Contribution` is an enum over the two **scaling laws**, not over product categories:

```rust
pub enum Contribution {
    Food { value: NutrientValue, grams: f64 },   // per 100 g, scales with mass
    Dose { value: NutrientValue, units: f64 },   // per label serving, scales with count
}
```

The variant follows how the *source states its amounts*, not what kind of thing it is: a greens
powder with a weighed serving is a `Food`, because its figures really are per a mass and its
coverage really is mass-based. A capsule of the same powder is a `Dose`.

Consequences, each load-bearing:

- **`DailyTotal::coverage` becomes `Option<f64>`.** `None` means nothing with a mass was logged.
  `0.0` would render as "nothing is known" on a day whose amounts are known exactly — the
  unknown-rendered-as-zero failure of D2, one level up.
- **Mass coverage and dose coverage are reported separately and both required**
  (`is_confident`). Grams and pill counts are incommensurable; a single blended fraction would
  need an invented exchange rate between them, which is the move `targets::for_nutrient` refuses
  when it returns `None` rather than a default.
- **`DailyTotal::from_supplements` carries the supplemental subtotal**, as
  `Option<SupplementSubtotal>`. `None` means no dose was logged, which is distinct from a dose of
  zero. This is what makes four of D5's upper limits evaluable at all — see D13.
- **`log_entries.grams` is NULL for exactly one kind of row.** A supplement is counted, not
  weighed. Because SQLite treats a CHECK evaluating to NULL as *passing*, the positivity rule had
  to be restated explicitly (`grams IS NULL OR grams > 0`) alongside a presence rule; leaving
  `grams REAL CHECK (grams > 0)` would have silently stopped enforcing positivity for food too.
- **A supplement-only day is not a day of food.** `RangeView::days_logged` counts days with at
  least one food entry, and days holding only a vitamin are counted separately. Dividing a
  period's nutrient totals by a day nothing was eaten on understates intake in exactly the way
  that divisor exists to prevent.

---

## D13 — What a supplement panel's SILENCE is worth depends on the regime, and only the user can assert a zero

**Problem.** A supplement lists about twenty nutrients and this app displays forty-seven. Treating
every unlisted nutrient as `Absent` means one bottle makes a well-measured day read as uncertain
— logging more information makes the display worse, punishing exactly the behaviour the feature
exists to encourage. Treating them all as `AssumedZero` is the opposite error and is not
supportable.

**Measured against the regulations.**

- **21 CFR 101.36(b)(2)(i)** makes fifteen nutrients mandatory on a US Supplement Facts panel —
  calories, total fat, saturated fat, trans fat, cholesterol, sodium, total carbohydrate, fibre,
  total sugars, added sugars, protein, vitamin D, calcium, iron, potassium. They "shall be
  declared when they are present ... in amounts that exceed the amount that can be declared as
  zero", and any that are absent or below that threshold "shall not be declared". Declaration
  above the threshold is compulsory and below it is *forbidden*, so omitting one is a two-sided,
  regulated assertion with a known ceiling.
- **21 CFR 101.36(b)(2)(ii)** makes every other vitamin and mineral voluntary: declared only when
  added for supplementation or when a claim is made. A nutrient present from an undeclared route —
  a botanical extract, an algae or yeast base, an oil carrier — need not be declared at any
  amount.
- **FSSAI** (HSN Regulations 2016 reg. 6(3)(iii); Labelling and Display Regulations 2020 reg.
  5(3)(b)) has **no** mandatory micronutrient list and **no** declarable-zero threshold. An Indian
  panel's silence bounds nothing at all.

**Decision.** `supplement::omission(nutrient_id, regime, complete)`:

| case | value | covered? |
|---|---|---|
| user asserts the panel lists everything | `AssumedZero` | yes |
| US panel, one of the fifteen omitted | `LabelZero { upper }` from `label::rounding_ceiling` | yes |
| US panel, any other nutrient omitted | `Absent` | no |
| any non-US panel, anything omitted | `Absent` | no |

`LabelZero` rather than `AssumedZero` for the mandatory fifteen: the regulation asserts "below the
threshold", which is the interval `[0, ceiling]` and not the point 0. The ceilings are the ones
`label.rs` already derives from 21 CFR 101.9(c), so there is no second table to drift.

The `panel_complete` flag is stored as **the user's claim and shown back to them as one**. No
regulation supports it; the person holding the bottle can.

**Consequence for D5.** Logging supplements makes the supplemental-form upper limits evaluable for
the first time — the limit was never the unknown, the *supplemental fraction of intake* was, and a
logged dose observes it directly off a printed label. Magnesium (350 mg, supplemental only) and
added niacin (1245, which D5 measured as having **zero rows in all three bundled datasets**) go
from structurally unevaluable to evaluable. `from_supplements` is that numerator. Two cautions
that must survive into any UI built on it: a *breach* is sound but a *pass* is not (under-logging
can only make the truth larger, so the wording is "within limits for the supplements you logged"),
and vitamin A stays unevaluable whenever the panel does not name the chemical form.

---

## D14 — IU converts only when the compound is named; the refusal is stored, not the guess

**Confirmed against** FDA, *Converting Units of Measure for Folate, Niacin, and Vitamins A, D and
E on the Nutrition and Supplement Facts Labels* (Aug 2019), and 21 CFR 101.9(c)(8)(iv). The three
factors D6 already recorded are correct: retinol 0.3, supplemental beta-carotene 0.3, dietary
beta-carotene 0.05 µg RAE per IU. FDA states the principle outright — "There is no direct
conversion factor from the vitamin A declared on labels in IU to mcg RAE."

| nutrient | from | form | factor |
|---|---|---|---|
| Vitamin D (1114) | IU | D2, D3 or unstated | 0.025 µg — **the one form-independent case** |
| Vitamin A (1106) | IU | retinol / retinyl ester | 0.3 µg RAE |
| Vitamin A (1106) | IU | beta-carotene, dietary source | 0.05 µg RAE |
| Vitamin E (1109) | IU | natural, d-alpha (incl. esters) | 0.67 mg |
| Vitamin E (1109) | IU | synthetic, dl-alpha (incl. esters) | 0.45 mg |
| Folate (1190) | µg folic acid | — | ×1.7 µg DFE |
| Minerals | mg | any salt | **×1** — 101.36(b)(3)(ii) declares the element, never the salt |

**Decision.** Where the factor depends on the compound and the pack does not name it, `convert`
**refuses** and the row is stored with `kind = 'not_converted'`, keeping the printed figure, its
unit and a sentence saying why. It reaches the day as unknown and unbounded.

Dropping the row instead would lose the transcription and make the pack look silent about a
nutrient it actually declares. Guessing would be worse: the single letter between "d-alpha" and
"dl-alpha" is a 1.49× difference, and attributing an unspecified vitamin A to retinol would fire
the false toxicity warning D5 exists to prevent.

Three traps recorded so they are not re-introduced:

- **Never apply a salt fraction to a mineral line.** Applying the 60.3% MgO fraction to an
  already-elemental 200 mg figure understates the dose by 40%. Where an Indian label names only
  the compound ("Magnesium Oxide 400 mg") that is a source weight, not a nutrient line — treat the
  elemental amount as unknown rather than deriving it.
- **Never apply an ester correction on top of the vitamin E IU factors.** FDA folds acetate and
  succinate into 0.67 / 0.45 already; a further molecular-weight correction double-counts.
- **Never back-compute folic acid from a DFE figure by dividing by 1.7.** The parenthetical
  folic-acid amount is mandatory when folic acid is added, so its *absence* is informative — it
  means the folate is L-5-methylfolate or food folate. Dividing would fabricate a folic-acid dose
  and fire a false upper-limit warning.

---

## D15 — Cuisine is free text; origin is a closed set; neither is ever inferred from a name

*(Product decision. The user asked to see "made at home, ordered from outside, indian, chinese and
other cuisine type" on the calendar, with a frequency chart for the period.)*

**Origin** is a closed enum — `home`, `ordered_in`, `eaten_out`, `packaged` — because "who cooked
it and where" has few stable answers. `ordered_in` and `eaten_out` stay separate in the data and
are only collapsed for display: they differ in portion control and in whether leftovers exist.

**Cuisine is free text**, stored alongside `cuisine_key = folded(cuisine)` so that "South Indian",
"south indian" and "SOUTH  Indian" are one bar rather than three. A fixed `{Indian, Chinese,
Other}` list forces a wrong answer on the dishes this user eats most:

- **Indo-Chinese** — gobi manchurian, chilli paneer, hakka noodles — is not Chinese food and is not
  what "Indian" means to the person eating it. A fixed list forces a choice between two answers
  that are both false, weekly.
- **One "Indian" bar covering four fifths of every period is a constant, not a chart.** The signal
  worth seeing is inside it: a month reading "26 Indian" hides that 22 were rice-heavy South
  Indian and 4 wheat-heavy North Indian.
- Hybrid dishes (pav bhaji, bread omelette) and restaurant-diaspora dishes have no correct fixed
  label at all.

This is the same reasoning `custom_foods` already embodies: a fixed reference list forces a wrong
answer for the thing in your hand. Starter suggestions exist in the picker for cold start and
**are never written anywhere until chosen**, so they cannot appear in a chart as a cuisine the
user never ate.

**Both tags are NULL until the user answers**, and NULL is never filled in. A typed "Other" is a
positive claim; not recorded is the absence of one — the same distinction as `AssumedZero` versus
`Absent`, and the chart shows the untagged group rather than hiding it.

**Nothing infers a cuisine from a name.** Specifically forbidden as oracles: the dish description,
the `food_aliases` table (an alias says "this USDA row is what 'urad dal' means", not "anything
containing urad dal is Indian"), FNDDS food categories, and `source_kind = 'custom'` implying
`packaged`. Pre-fill comes only from **the user's own most recent non-NULL answer for that exact
food**, recalled per dimension, and is shown as a recalled value to confirm rather than written
silently. A recipe may carry a default from its builder — the user's own statement about their own
construct — and reference foods get no default at all.

Tags live on the **log entry**, not on the food: a lunch of home-made dal and an ordered naan is
two entries, and the same recipe is made at home on Monday and ordered on Wednesday.

---

## D16 — Two reference systems, one resolution order, and the basis travels with the number

*(Added with the profile and settings screens.)*

**Defect.** Every percentage in the app was against the FDA Daily Value, and the energy hero was
against a hard-coded **2,200 kcal** with a progress rail drawn under it. Both are the failure this
app exists to prevent, one level up from `NutrientValue`: a confident number whose denominator
describes nobody. The DV says 18 mg of iron for everyone, against an adult man's RDA of 8 mg; and
2,200 kcal was not derived from anything at all.

**Decision.** [`targets::resolve`] decides every target in one place, in this order. Each step is a
stronger claim about *this* person than the one after it:

1. **What the user set.** Someone given a figure by a clinician has better information than a
   table does.
2. **The DRI for their life-stage group**, from `crates/core/src/dri.rs`, when age and sex place
   them in one.
3. **The FDA Daily Value**, when they do not. The honest fallback for an unknown person: it is what
   the label on the pack means.
4. **Nothing** — no target, no percentage, no bar. Never an invented denominator.

**Every target carries its `Basis`**, and it is rendered. An RDA meets the needs of 97–98% of a
group; an Adequate Intake is used where the evidence could not support an RDA and is usually just
the observed median intake of a healthy population. Falling short of the two supports very
different conclusions, and a bare "62%" cannot tell them apart. `NutrientTotal.daily_value` was
therefore renamed to `target` and gained `target_basis`.

**Limits are deliberately excluded from the DRI path.** Saturated fat, added sugars and cholesterol
have no DRI — the reports say "as low as possible", which is not a number — and sodium's DRI is an
*Adequate Intake of 1,500 mg*, a floor. Taking it would have put a "reach this much sodium" bar on
the dashboard, which is the opposite of the advice. They keep the labelling ceiling (sodium at the
2019 CDRR of 2,300 mg) unless the user sets their own, and a user-set ceiling stays a ceiling.

**Energy is estimated, or it is absent.** `dri::energy_estimate` returns `None` unless sex, age,
height, weight and activity are *all* known — there is no partial answer, because filling in a
missing weight with a guess produces a fiction with a plausible number attached. With no estimate
and no figure of the user's own, the hero reports what was eaten and draws no rail.

**Macronutrients are ranges, not points.** The AMDRs (carbohydrate 45–65%, fat 20–35%, protein
10–35% of energy, wider for young children) are shown as gram ranges at the day's energy figure,
and the dashboard says whether the day landed inside one. Rendering the midpoint of 20–35% as "the
fat target" would invent a precision the evidence does not have.

**Sources, transcribed rather than recalled.** Vitamin, element and macronutrient DRIs from the
NASEM summary tables (NCBI Bookshelf NBK545442, appendix J). Two traps found while transcribing:
the asterisks against adult female folate and against B12 over 50 are **footnote markers, not AI
markers** — both are RDAs, verified against the NIH ODS fact sheets. And two published magnitudes
differ from the ones this app stores: copper is published in µg and stored in mg, fluoride the
other way. Both conversions are applied once, in the table, with the published figure in the
comment, and a test pins them.

**Known limitation, stated rather than fudged.** The DRI for niacin is in mg NE while this app
stores nutrient 1167 as mg of niacin. The Daily Value already carried the same mismatch, and D6
forbids converting between the two bases without knowing the tryptophan contribution, so the figure
is carried across unchanged and flagged in the module rather than silently converted.

**Energy equation.** Mifflin–St Jeor times a conventional activity factor, not the NASEM EER
equations. The 2023 EER tables were not retrievable in full, and an equation this app cannot state
precisely is one it should not be using; Mifflin–St Jeor can be written down, checked, and is
pinned by a test against a worked example. The UI carries both caveats: the equation predicts
resting expenditure to roughly ±10% at best, and the activity factors are round numbers standing in
for something that genuinely varies day to day.

---

## D17 — An exported cell holds a number the entry was frozen with, or it holds nothing

*(Added with the log export.)*

**Defect it prevents.** A day's total for a nutrient is an interval, and the app shows it as one:
`412 mg` where every contributor said something, `≥ 340 mg` where one of them did not. A
spreadsheet cell cannot hold that. Faced with an entry whose added sugars are known for fourteen
ingredients and unknown for the fifteenth, the obvious export writes the fourteen-ingredient
subtotal — a figure that is *smaller than the truth*, in a file that will be summed, averaged and
charted by whatever opens it. That is the same failure `NutrientValue` exists to prevent (D2), one
level up and outside this app's reach.

**Decision.** A cell is written only when the entry's frozen value for that nutrient is exactly
known: `trackit_core::aggregate::sum` over the entry's own components must return an upper bound
equal to its lower bound. Anything else — a trace, a label-rounded zero, a below-LOQ figure, a
missing row, one silent ingredient among many — is a BLANK cell. `parseSpreadsheet` and
`import_log_rows` already read a blank as "not tracked that day" and never as a zero, so a gap
survives the whole round trip as a gap.

A lab that looked and found nothing is a different fact and does export a `0`: `MeasuredZero` and
`AssumedZero` are bounded at both ends, so they *are* numbers. A `0` with no provenance
(`ZeroUnknown`) is not, and exports blank.

**The equality is exact, not approximate.** `sum` accumulates both bounds in one pass over the
same slice, adding the same expression in the same order for every kind whose bounds coincide, so
either they are bitwise equal or the interval is real. An epsilon would let a genuine trace with a
tiny upper bound through as a measurement.

**Nothing is recomputed, and the signature says so.** `export_log` takes the user database and
not the reference database, so there is no path through it that could value an entry against
today's data. An entry with no snapshot at all is counted and left out, and the screen says how
many — freezing it on sight would make reading a file a write to history.

**Figures are rounded once, to three decimals in the nutrient's own unit.** Vitamin D is printed
in micrograms and sodium in milligrams, so that is already finer than any pack this app has read.
Generation one loses sub-milli precision; from generation two the cycle is exact, because
re-exporting an imported file reproduces the same rounded figures. The FILE is the authority.
