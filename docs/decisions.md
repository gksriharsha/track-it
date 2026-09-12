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
## D18 — The log is encrypted on Android, and exactly one sealed file may leave the phone

*(Added with the Backup screen. Android only.)*

**Defect, and it was live.** `android:allowBackup` was **unset** in the manifest, which is not the
same as off: it defaults to true. Every file under the app's data directory was therefore eligible
to be uploaded to the user's Google account — and that directory is where `user.db` sat in plain
SQLite, next to `photos/` full of pack photographs. There was a second, quieter fault in the same
default: `db::resolve` copies the 39 MB `usda_core.db` into that directory, Auto Backup carries
25 MB per app, and Android's answer to being over quota is to stop backing the app up and tell
nobody. So the app was probably leaking nothing only because it was probably backing up nothing.

**Decision — the live database.** `user.db` is **SQLCipher-encrypted on Android**, through a
target-scoped `[target.'cfg(target_os = "android")'.dependencies]` block. That block was chosen over
a single plain dependency after measuring: it builds all four ABIs, leaves the macOS build
byte-for-byte plain SQLite (zero openssl and zero sqlcipher symbols), and costs about 3.79 MB on the
one ABI the release workflow ships. `db.rs` needed no change at all, because an **unkeyed** SQLCipher
connection still opens a plaintext file — so the bundled reference database keeps opening, FTS5
included, and only the user's own log ever takes a key.

The honest cost, since a decision record that hides one is worthless: vendored OpenSSL 3.6.3 is now
security-critical C in a build that previously had none, and watching its advisories is a standing
obligation.

**Decision — encryption is opt-in, and cannot be switched on without a recovery passphrase.** This
one rule removes every data-loss path from the design, and it is why the earlier plan's rejection of
SQLCipher does not apply. That plan reasoned that a SQLCipher database keyed from the Android
Keystore is either carried by the backup and then unopenable after a restore, or excluded and
therefore pointless — a false dilemma, because Keystore is not the only key source. Here there are
**two wraps of one data key**: one under an Argon2id key derived from the user's passphrase, which is
what a fresh phone uses, and one under a Keystore AES-GCM key with
`setUserAuthenticationRequired(false)`, which is what makes the daily launch silent. A Keystore key
the operating system throws away therefore costs one passphrase prompt and can never cost history.

`setUserAuthenticationRequired(false)` is the load-bearing line. A key that requires authentication
is exactly the key Android invalidates when a fingerprint is enrolled or a lock screen is removed,
and this key opens the user's log — so requiring authentication would let the OS destroy a year of
meals as a side effect of somebody changing their thumb. The key consequently guards nothing on its
own, deliberately.

**Decision — whether the log is encrypted is asked of the file, not of a flag.** A plaintext SQLite
database begins with `SQLite format 3`; a SQLCipher one begins with ciphertext. `backup::is_plain_sqlite`
reads those sixteen bytes, in the same spirit as every migration arm in `store.rs` asking the
database what shape it is in rather than trusting a version a half-finished upgrade may have written.
A settings file claiming "encrypted" over a plaintext database is precisely what a crash mid-conversion
leaves behind, and trusting it would mean keying a plaintext file and reporting the user's log as
corrupt.

**Decision — the sealed file is self-describing.** The passphrase-wrapped key, the salt and the exact
Argon2id cost parameters used are in the file's own 162-byte header, so no interleaving of a crash on
disk can produce a blob nobody can open, and a build that later lowers the cost for slow phones still
opens a backup sealed today. Bytes 0..38 authenticate the wrap — it stops there because a wrap cannot
authenticate a header containing itself — and bytes 0..162 authenticate the payload. The whole header,
not part of it: a shorter span would leave the sealing date unauthenticated, and the Backup screen
prints that date.

Every field read out of that header is **bounded before anything allocates**. `m_cost` is in KiB and
cannot be authenticated before it is used, because deriving the key is what authentication requires —
so one flipped high bit turns 64 MiB into roughly 2 TiB, and Argon2 would ask for it at the exact
moment somebody is restoring. The decompressed length is bounded too, on bytes actually read rather
than on the length the header claims, because a header figure that sizes an allocation is a gzip bomb
with a polite interface.

**Decision — one directory travels, and it is not the one the key is in.** `android:allowBackup` is
now explicitly `true`, with `dataExtractionRules` (API 31+) and `fullBackupContent` (24–30) that each
contain a single `<include>`. One include is what makes a rules file restrictive: the moment a section
has any, only those paths travel. The sealed file is written to `getFilesDir()/backup/`, which is what
`domain="file"` addresses — and Tauri's `app_data_dir()` is **not** that directory but its parent, so
the key material under `app_data_dir()/keys` is not merely excluded; there is no path a rules file
could name that would reach it.

**Decision — two consents, not one.** Setting a passphrase encrypts the log. Sealing a copy is a
separate button, because making a file eligible to leave the phone is a separate decision, and
collapsing them into one act with the consequence explained in a paragraph above the field is implied
consent. Deleting the sealed file is how the consent is withdrawn; what Google has already taken is
Google's to expire, and the screen says so rather than implying the button reaches into the cloud.

**Decision — the restore path ships with the feature.** Auto Backup delivers the sealed file to a
fresh install and says nothing. First launch notices a sealed copy beside an empty log and offers the
restore, rather than opening an empty log and letting somebody conclude the backup never worked.

**Not done, and stated rather than left to be discovered.** Photographs of packs are neither
encrypted nor carried: `MAX_PHOTO_BYTES` allows 6 MB each, so four labels would exhaust the 25 MB
quota and cost the user the backup of the thing that actually matters — and a pack can be
photographed again where a meal eaten in March cannot be eaten again. Changing the passphrase
re-wraps the same data key rather than rotating it, so a copy already carried elsewhere still opens
with the old passphrase; that is a worse secret than a rotation would give, and a better one than a
rekey that crashes halfway with the new wrap not yet on disk.

---

## D19 — A widget renders strings; nothing crosses to the launcher that this app did not already write down

Two Android home-screen tiles: the aggregate readout and quick add. Both are plain `RemoteViews`
fed by two JSON files of already-formatted strings, and the shape of that arrangement is where
every decision worth recording lives.

**A widget cannot read the log, so it must not try.** An `AppWidgetProvider` is a
`BroadcastReceiver`. It runs in this app's own process — it is not a separate widget process —
but when the system starts that process to deliver an update the app is closed: there is no
Activity, no Tauri runtime, and none of `app.manage(…)` done. Every aggregation this app performs
lives behind `tauri::State`. Booting a Tauri runtime inside a receiver with a ten-second budget is
not a thing to attempt, and once `user.db` is encrypted a background receiver may have no key at
all. So Rust computes and formats, and Kotlin renders. That is D2's rule — a nutrient value is a
tagged union and JavaScript never does arithmetic on one — applied to a second language: a median
belongs in `trackit_core::spread`, and a figure the data does not support arrives as the words
"not recorded", never as a zero somebody's `?? 0` invented.

**Rust writes the file itself, with no bridge of any kind.** The obvious design has Rust call a
Tauri Android plugin to publish the snapshot. It was rejected, and the reason is worth keeping.
Release builds set `panic = "abort"`, and `run_mobile_plugin` ends in wry's `MainPipe::send`, which
panics once the last Activity has been destroyed. Since the publish is scheduled off the calling
thread — a mutating command holds both database mutexes for its whole body — the sequence "log a
dish, then swipe TrackIt out of recents" would abort the process from a thread whose only job was
to redraw a home screen. Writing two files is `std::fs` and needs no JNI, so the panic site simply
does not exist. Telling the launcher to redraw is left to `MainActivity`, which watches the
directory with a `FileObserver` and, being an Activity, knows by definition that it is alive. When
the app is closed nothing needs telling: the system re-sends its own update after a reboot, on
placement and on resize, and the providers read whatever is on disk then.

**The aggregate is the Statistics screen's own arithmetic, not a second copy of it.** `get_range`
was a `#[tauri::command]` taking `State<'_, T>`, and a `State` cannot be constructed outside a
running app — so a widget could only have had a middle day by reimplementing the period rollup,
which is precisely the drift this document exists to prevent. Its body moved into
`range_view(&db::Db, &store::Store, from, to)` and the command became a one-line delegate. The
widget and the screen now cannot disagree about what a middle day was, and there is a test that
says so.

**The refusal is per measure, from that measure's own day count.** Energy is measured on every day
with food on it and water only on days a bottle was logged, so an ordinary month holds
twenty-two days of energy and three of water. Gating the whole tile on one figure would have
printed a water median from three days — a pattern claimed from noise, and one the screen it
transcribes explicitly refuses to print.

**Nothing on either tile fills, ranks or scores.** No bar, no ring, no arc, no percentage, no run
of days, and no word that appraises what it found. The amount is printed with its reference figure
NAMED beside it, and where nothing publishes one — energy is in no DRI table and no Daily Value
table — that line VANISHES rather than being invented. Coverage is stated as coverage of a sample
and anchored to the date the period starts from, which is also what stops a window that never
recomputes from drifting silently: a tile carries the moment it was written, with its year, so a
fortnight-old snapshot reads as a fortnight old rather than as this evening's. The quick-add tile
prints names and nothing else; the frequency that ordered them stays in the database that computed
it, because how many times somebody logged a food is a figure about the person.

**A tap opens the amount step and stops there.** The tile carries which food and nothing more —
there is no weight on it and no way to send one — so nothing is ever logged without a second,
deliberate tap inside the app. Its water button goes to the Foods screen's own water tab rather
than to the bottle library, which is where a jug's full weight is recorded and not where a drink
is.

**The Intent is treated as hostile at three boundaries.** `MainActivity` is
`android:exported="true"` because it carries LAUNCHER, so any installed app can start it with
extras of its choosing. Kotlin checks the route against its own two-entry whitelist and the pick
token against a three-shape grammar before writing anything; Rust checks both again as it reads;
TypeScript checks the route a third time against the router's own table and parses the token
before either reaches `location.hash`. A whitelist on one side of a bridge is not a whitelist, and
a bad token is thrown away WHOLE rather than trimmed into something that looks valid.

**The parked tap is a file, and reading it deletes it.** `launchMode` is `singleTask`, so a warm
relaunch arrives at `onNewIntent` — and neither the generated `WryActivity` nor `TauriActivity`
calls `setIntent`, so without an override every later read of `intent` would replay the previous
tap. `MainActivity` now calls it. That fix opens the opposite hole: `android:configChanges` lists
neither `density` nor `fontScale`, so a font-size change rebuilds the Activity, `onCreate` re-reads
`getIntent()` and would offer the same tap again. Two guards close it — the offer is made only when
there is no saved instance state, and the file is gone the moment Rust reads it.

**The snapshot lives in `no_backup/`.** Android documents `getNoBackupFilesDir()` as never
automatically backed up. `SharedPreferences` would have been the obvious home and is exactly
wrong: it IS swept into Auto Backup by default, which would put a person's figures on a Google
server because their phone was set up with backup on. The files are plaintext and become the
softest target in the app the day the database is encrypted, which is why the aggregate file holds
no food name and neither file holds anything per nutrient or per entry — what is not in them
cannot leak from them.

**`RemoteViews`, not Glance, and no new Gradle dependency at all.** Glance is a 1.21 MiB AAR
carrying 913 generated layouts that `isShrinkResources` cannot prune, plus the Compose runtime and
four DataStore artifacts, and at this project's Kotlin 1.9.25 it forces either a compiler that
stopped shipping in August 2024 or a Kotlin bump inside a Tauri-generated root Gradle file. What it
would buy is nothing: both tiles are static text with a few tap targets. The practical consequence
is the one that matters most here — this feature touches only `AndroidManifest.xml` and
`MainActivity.kt`, both already hand-edited and both tracked, so a future `tauri android init`
cannot silently undo it.

**The serif is a deliberate near-miss.** The app fetches Newsreader from Google's CDN and there is
no font file in the tree, and `RemoteViews` cannot use a downloadable font. The amounts are set in
`serif`, which resolves to Noto Serif — the last item of the same fallback chain the CSS declares.
Committing a TTF and its licence into a hand-maintained Android project for one 20sp figure is a
poor trade; discovering the difference on a home screen would have been worse than choosing it.

---

## D20 — What a household shares, how a conflict is settled, and what a helping publishes

*(Added with the sync transport.)*

**Defect.** The database half of household sync shipped first — `row_version`, the fourteen
change-tracking triggers, `sync_pending`, `sync_control` — and the five commands that would have
used it returned a sentence saying the transport was not built. The kitchen was tracked and
nothing carried it anywhere. Two smaller defects came out with it: `peers` had no address column
at all, so a device was unreachable for good after its DHCP lease turned over; and
`queued_for_peers` compared `peers.applied_through`, which counts the PEER'S feed in the PEER'S
numbering, against our own `row_version.seq` — arithmetic on two unrelated counters, printed on
the Household screen as a backlog.

**Decision.**

**One Noise pattern for both jobs: `Noise_XX_25519_ChaChaPoly_BLAKE2s`.** `KK` was the obvious
choice for a resync, since both static keys are already known and two messages would do, and it
is unbuildable here: snow gives KK pre-message statics for both sides, so `build_responder`
refuses without the remote key — and a device answering an inbound connection does not yet know
who is dialling. Under XX the responder learns the initiator's static during the handshake, and
every entry point asserts it against `peers.static_pk` afterwards and hangs up on a key the
household does not know. Authenticating a connection and authorising it are two steps, and
keeping them apart is what lets the pairing path — where the key is deliberately new — share the
code with the resync path, where it must not be.

**The pairing code is bound to the session twice.** The prologue is a domain string plus the
EXACT bytes of the payload on both sides, so a phone that read a different code fails at the
handshake rather than reaching the digits; and the initiator hard-asserts the responder's static
key against the key printed in the code before any digits are shown. The six digits — SHA256 over
the handshake hash, mod 10^6 — are a second, human line of defence, not the only one. They are
about twenty bits, which is plenty for a comparison a person makes once and worth nothing to
somebody who gets retries, so a live offer serves one connection at a time and derives fresh
digits for each. A refused comparison returns the offer to waiting rather than ending it:
ending it would have made anybody who could reach the announced port a denial of pairing.

**The merge rule, decided identically on every device.** Higher `version` wins; at equal version
the lexicographically greater `device_id` wins. That is what makes the merge CONVERGE rather than
merely stop — two devices that saw the same pair of edits end on the same row without having
talked about which. `updated_at` is deliberately not an input: two household clocks disagree and
`now_iso` is accurate only to the second, so a wall-clock comparison would decide real conflicts
by whose phone runs fast.

**The unit of replication is a parent row and all of its children, and the parent is written in
place.** Never a delete-and-reinsert. `foreign_keys` is ON and `log_entries.recipe_id`,
`cook_id`, `custom_food_id`, `supplement_id` and `bottle_id`, plus `cooks.recipe_id` and
`cook_draws.cook_id`, all reference these parents with NO ACTION — so deleting a recipe you have
cooked from would abort the apply transaction and wedge the sync on one row for good. Making
those keys CASCADE to get around it is forbidden: it would reach back into frozen history, which
is the one thing this app promises never to do. Children are still replaced wholesale, and only
because nothing references them.

**Two field-level exceptions, and they generalise.** A column whose value is a HANDLE INTO ONE
DEVICE is not a fact about the kitchen. `vessels.last_used_at` and `bottles.last_used_at` order
one person's picker; `custom_foods.photo_label`, `custom_foods.photo_ingredients`,
`supplements.photo_panel` and `supplements.photo_ingredients` are filenames in one device's own
photos directory. Both are excluded in BOTH directions — an aggregate arriving without a photo
name must not erase the name already here, or a peer that edits a food and syncs it back would
silently strip the photograph off the device that took it. Shipping photo bytes as a second,
content-addressed channel is deliberately out of scope.

**`applied_through` advances only when the apply transaction commits.** Advancing it on receipt
loses rows to a crash with no way to notice afterwards: the feed is self-compacting, so the row
has already moved under the watermark and will never be sent again. An aggregate whose dependency
has not arrived is parked whole in `sync_pending` and the watermark moves past it anyway — the
row is durably recorded and will be retried — so `SyncOutcome.detail` has to name what is still
held. A green line over a fridge that is missing a pot is the same failure as a nutrient bar
drawn at zero because nobody measured it.

**What a helping publishes, stated plainly.** `cook_draws` is in the shared set, and it carries
the authoring device's entry id, the pot, which device took it, the grams, and the local date and
instant. That is what makes the pot say the same thing in two kitchens. It is never part of
anybody's day: the receiving device has no `log_entries` row for it, no nutrition off it and
nothing about it in any total, and the nutrition arm cannot reach it because it does not join to
that table. The Household screen says both halves rather than leaving the second to be
discovered.

**Not a daemon.** No foreground service, no notification, no wake lock; on Android the sockets die
with the process. That is agreement with Doze and App Standby rather than a shortcut around them
— Doze suspends network access for every app regardless of target API, so a listener that fought
it would be an app running behind your back for no benefit. The consequence is honest and belongs
on screen: a phone can be reached while TrackIt is open on it, and not otherwise.

---

## D21 — On a phone the navigation is a bar, a camera is a route, and the insets come from Kotlin

**Defect.** The whole of the mobile navigation was one drawer behind a hamburger: eleven
destinations, three interactions to reach any of them, and no standing indication of where you
were. Because the app opens on Trends — an *aside* rather than a tab — the floating add button
was suppressed on exactly the screen every cold start lands on, so a new session had no way to
log food at all without opening the menu. Separately, every capability the camera provides
(barcode, nutrition panel, ingredient list) was reachable only from inside the custom-food
editor, whose own doors were a text link that appeared *after* a search returned results, a
library two levels down that menu, and a desktop-only keyboard shortcut.

**Decision — three contracts, in the order a future change is most likely to break them.**

**1. The bottom bar carries places; the centre button carries the one action.**
`Trends | Today | [ + ] | Days | More`. Add food is not a tab and must not become one: it is
wanted *from* every destination rather than navigated to. `BAR_HIDDEN` names the screens that
are a task rather than a place — they hide the bar and are left by finishing them or by the
system back gesture. Nutrients is not a destination; it is the same day counted differently,
reached by the switch on Today (`DayTabs`), and Today stays lit in the bar while it is showing.

**2. A camera is a hash route, never component state.** `useCameraRoute` in
`src/lib/camera.ts`. Every screen change in this app is a hash change precisely so the Android
back gesture works (D19's sibling concern); a lens held in `useState` is invisible to that, so
the gesture navigates the screen out from under an open camera instead of closing it. On the
editors that was merely jarring, because the screen unmounts and takes the `MediaStream` with
it. On Add food it would be a leak: `Foods` is deliberately kept **mounted** behind its asides
(`hidden`, not unmounted) to preserve an in-progress search, so a backed-out-of lens would go on
holding the camera open, indicator light and all, behind a hidden div. A reload carrying `cam=`
strips it rather than handing back a live lens at depth zero, where the gesture that closes the
sheet would close the app.

**3. Window insets are measured in Kotlin, not read from `env(safe-area-inset-*)`.**
Measured on the emulator: with `enableEdgeToEdge()` set and with and without
`viewport-fit=cover`, all four CSS insets report `0px`. Android WebView maps those values to the
**display cutout** alone and never to the status or navigation bar, so every inset rule in the
stylesheet had been a silent no-op on the platform it mattered on — a bar pinned to the bottom of
the screen lands underneath the navigation pill. `MainActivity.publishInsets` reads the real
`systemBars() | displayCutout()` insets and sets them as `--sys-*`; the `--safe-*` tokens take
`max()` of the two sources, so iOS and a browser keep using `env()` and neither platform needs to
know about the other.

**Consequences that are not optional.**

- **One tap may log a repeat food, because the write is visible before it happens and reversible
  after.** This overturns the stance previously argued in `pickFrequent`'s own comment — that a
  one-tap row would be "a button that writes to somebody's history out of a list they never asked
  to have built". The objection is answered rather than overruled: the weight is printed *on* the
  control, and an Undo stands over the bottom bar for eight seconds (`QuickLog.tsx`). A shortcut
  still carries a weight and never a count, a rank or a streak.
- **A barcode is a search, not a lookup.** There is no product database on the device and nothing
  leaves it, so no control may imply scan-and-it-is-identified. A read fills the search field
  over the user's own transcribed foods and deliberately does not pick anything — an auto-pick
  would be a write the back gesture cannot undo. Where it matches nothing the screen says so
  plainly, including that the digits were looked up nowhere.
- **Every camera surface offers a photo instead.** `scan_barcode` passes the same `decode_photo`
  gate a stored photo does and never cared whether the bytes came from a live frame, so a denied
  permission is not a dead end. The failure panel's standing advice to "pick a photo you already
  have" is now a button (`onPickInstead`) wherever the caller can honour it, and is not printed
  where it cannot.
- **`canStream()` is a function.** As a module-level constant it was evaluated once at import, so
  a WebView that gained `getUserMedia` after the bundle loaded hid every camera control until a
  reload.

---

## D22 — An ingredient is weighed once, raw; the cooked side of the arithmetic is one weighing of one pot

Every line of a recipe and of a cook used to carry **two** weights, `raw_g` and `cooked_g`, and
`cooked_g` was the one the nutrition arithmetic read: a portion was `grams / yield_g` of the
dish, and that fraction of each line's cooked weight, valued against the reference food's per-100 g
composition.

That asked for a number nobody can produce. Ingredients go on a kitchen scale one at a time
*before* they are cooked. Once they are cooked they are one mixed dish — there is no way to lift
the rajma back out of a finished curry and weigh it apart from the onions and the water it took
up. So the second figure was always going to be typed rather than measured, and a typed figure was
driving every calorie in the app. The evidence is in the only recipe the app had ever been used to
write: both weights were 100 g, the same number entered twice, because the second box had no
answer.

**Decision. A recipe ingredient and a cook ingredient carry exactly one weight, `raw_g`, and it is
what the ingredient weighed before it went in. The raw-to-cooked change is derived, not
collected.**

The derivation is a mass balance, and it is the rule `indian-foods-plan.md` §3.2 already
mandated while the shipped code did the opposite. **Nutrient mass is conserved through cooking;
concentration is not.** 300 g of dry rajma carries the same protein whether it is still dry or has
swollen to 900 g in a pot — what changed is the mass that protein is now dissolved in. So:

- an ingredient's whole contribution is `raw_g` against the **raw** food's composition;
- a portion is `grams / yield_g` of the dish, and that same fraction of every ingredient's raw
  weight;
- `yield_g` is the one cooked measurement in the model.

This also keeps the app's totals directly comparable to ICMR-NIN's diet charts, which are raw
throughout — Annexure II of *Dietary Guidelines for Indians* (2024) is headed "Raw food item
measures" with a column titled "Raw weight (g)".

**Where the one cooked weight comes from, in order.**

1. **What the pot weighed** (`cooks.weighed_yield_g`), a reading off a scale with the vessel tared.
   A measurement always wins.
2. **What the recipe says the dish comes out at** (`recipes.yield_g`), times the batch scale,
   frozen onto the pot as `cooks.expected_yield_g` when the pot is opened. Frozen rather than read
   back through `recipe_id` for the same reason `planned_g` is: rewriting the recipe next month
   must not silently re-portion food already in the fridge.

**The summed ingredient weights are not a candidate and never appear as one.** They are raw. A pot
of rajma weighs roughly three times its dry beans, so dividing a katori by them would read it as
though it were still dry — the threefold overstatement this app exists to avoid, reintroduced at
the last step.

**Why `recipes.yield_g` is asked for rather than estimated.** A yield factor could be derived —
`indian-foods-plan.md` §3.3 works two of them out, and they disagree by up to 22 %, which is why
it recommends storing an interval. Applying one here would put a manufactured number under every
figure in the app in exchange for saving the user a single weighing they already do every time
they cook. One number per *dish* is a fair trade for one number per *ingredient per dish*; one
fabricated number is not. The builder offers "same as what goes in" as a one-tap for dishes that
neither absorb water nor cook down — a chutney, a raita, a salad — and otherwise asks.

**Consequences.**

- **Schema v16.** `recipe_ingredients.cooked_g` and `cook_ingredients.cooked_g` are dropped;
  `cooks.expected_yield_g` is added, NOT NULL. The migration fills it from each pot's own summed
  cooked weights, which is exactly what the old fallback divisor computed, so **no existing pot
  changes what its portions divide by**. `recipes.yield_g` is not touched: it already held the
  cooked batch weight and already meant what it now means.
- The two halves of the migration are guarded independently, on `cooks.expected_yield_g` and on
  each ingredient table's `cooked_g`. `SCHEMA` runs before `migrate` and creates *missing* tables
  in their current shape, so a database can arrive with a new `cooks` and an old
  `recipe_ingredients`; one guard over both would have failed on the duplicate column.
- **Nothing already logged moves.** An entry's nutrition was frozen when it was written and no
  read path reaches back through these tables (D17 and the immutability rule stand unchanged).
- Future portions of an *existing* pot are valued on `raw_g` where they were valued on `cooked_g`.
  Where the user picked a raw reference food this is a correction; where they picked a cooked one
  and entered the same number twice it changes nothing.
- The cook sheet's per-line dial now moves the raw weight, and the ratio bookkeeping it carried —
  a `ratios` ref held outside React state precisely because a line dialled to zero lost both
  weights — is gone rather than ported.
- **Picking the raw form of an ingredient now matters.** "Beans, kidney, red, mature seeds, raw"
  and "…, cooked, boiled" differ about threefold per 100 g, and a raw weight against a cooked
  food's composition understates by the same factor the old model overstated. The builder says
  the weight is raw at the column, the field's label and the note under the yield; detecting the
  state of a reference food from its description is left undone rather than guessed at.

---

## D23 — An ingredient may be one of your own foods, and the food named by a search outranks the dish that contains it

A recipe line could only ever be a reference food. `recipe_ingredients.fdc_id` was an INTEGER and
nothing else, the ingredient search filtered the user's own foods out (`h.kind === "reference"`),
and a footnote told them so: *"N of your own foods matched and are not listed here."*

That is backwards, and the user said why: *"I search for tofu, I see a lot of options… I get my
tofu from Costco, the extra firm one. None of these actually match to it. So this only causes more
confusion."*

They are right about the data. USDA has **42 rows matching "tofu"**. Eight are one American brand
(Vitasoy Nasoya), four more another (MORI-NU), several are not tofu at all — *Mayonnaise, made
with tofu*; *Soup, miso or tofu*; *Beef, tofu, and vegetables including carrots, broccoli…* — and
none of them is the block sold at Costco. Forcing a choice among them makes somebody who has
already transcribed their own pack pick a stranger's brand instead, and then carry that guess
through every dish built on it.

**Decision one: an ingredient is a reference food, one of the user's own foods, or neither.**

`recipe_ingredients` and `cook_ingredients` each gain `custom_food_id TEXT REFERENCES
custom_foods(id)` beside `fdc_id`, with `CHECK (fdc_id IS NULL OR custom_food_id IS NULL)`.
Neither set remains legal and still means a line with no composition data, which contributes
nothing and keeps its mass in the day's coverage denominator.

Two sibling columns rather than a polymorphic `kind` + `id` pair, because `fdc_id` is an INTEGER
with an index behind it and a custom id is a TEXT uuid: one column could hold either only by
giving up both. The CHECK is what makes "one or the other" unrepresentable rather than merely
discouraged.

Nothing about the arithmetic changes shape. A custom food already resolves to a **per-100 g**
panel through `resolve_panel`, which is what the directly-logged path has always used, so an
ingredient line valued at `raw_g × panel / 100` is the same sum a reference line does. The
provenance travels with it: a breakdown row reads *"Costco extra-firm tofu — 14 of 34 values off
the pack, 9 borrowed from 'Tofu, raw, firm', 11 unmeasured"*, because a dish assembled out of
packs is mostly gaps and a row that did not say so would look as solid as a lab measurement.

**Decision two: a food NAMED by the query comes before a dish that merely contains it.**

`db::search`'s second pass ordered by `bm25(foods_fts), length(description)`. bm25 cannot separate
*Tofu, firm, prepared with calcium sulfate* from *Soup, miso or tofu* — each mentions the word
once — and the short ones then win on length, which is how *Tofu yogurt* outranked plain tofu. USDA
writes descriptions as the food first and the preparation after, so a description **starting with**
what was typed is the generic entry for that food. The order becomes
`(lower(description) LIKE query || '%') DESC, bm25, length`.

The same rule pushes the eight Vitasoy rows below plain "Tofu", which is right for anyone who does
not shop that brand — and anyone who does can still type it.

**Consequences.**

- **Schema v17**, both ingredient tables rebuilt (not ALTERed: SQLite cannot add a CHECK in place,
  and `ADD COLUMN` would leave nothing stopping a row from setting both). Every existing line is a
  reference food and stays one, with the new column NULL.
- **A household sync can now carry a dish that depends on a food.** `missing_dependency` gained a
  child-row check: a `recipes` or `cooks` aggregate whose lines name a `custom_food_id` this device
  does not have is **held whole** until the food arrives, exactly as a pot is held for its recipe.
  Without it the child INSERT fails its foreign key, aborts the apply batch, and sticks that peer's
  sync permanently — the unrecoverable failure `replace_aggregate` documents at length.
- `save_recipe` and `save_cook` reject a line naming both **and say which line**, so a constraint
  violation reaches the user as a sentence.
- The ingredient search no longer filters and no longer apologises. Own foods are marked "yours",
  and the builder says where to add one.
