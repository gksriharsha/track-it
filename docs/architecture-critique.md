# Architecture critique (round 1)

Produced by an adversarial completeness pass that ran the proposed DDL and SQL against the real
USDA data and scratch SQLite databases. Findings are ranked by severity. **These defects are NOT
yet fixed in `architecture-data.md` / `architecture-app.md`** — treat both documents as drafts
pending this list.

{
  "summary": "Synthesize verified research into TrackIt data + app architecture docs, then critique them",
  "agentCount": 3,
  "logs": [
    "Synthesis done; running completeness critic"
  ],
  "result": {
    "critique": "Verification complete. Here is the critique.

---

# Completeness critique: `architecture-data.md` + `architecture-app.md`

All measurements below were run today against `/Users/kgundu1/BioBalance/data/raw/extracted/` and against scratch SQLite databases under `/private/tmp/bb/`. Where I quote a number, I produced it.

---

## SEVERITY 1 — Blocking. These produce wrong nutrition numbers or cannot be built as written.

### 1.1 `grams_per_unit = gram_weight / amount` is undefined for 60% of the bundled portions

`architecture-data.md` §2.5 makes this the single portion scalar, computed at build time, and warns that "forgetting the division is a silent 3× mass error." The actual hazard is the opposite. Measured:

```
FNDDS food_portion.amount value counts: [("''", 22046)]     # 100% blank, not "1"
SR   amount top: [('1',10985), ('3',1556), ('4',669), ('0.5',467), ...]
FF   amount top: [('1.0',10789), ('2.0',52), ('0.5',39), ...]
```

`amount` is the **empty string on all 22,046 FNDDS portion rows** — 22,046 of the 36,679 portions the doc bundles. §2.5 states "FNDDS has none," which is true only in the sense that there are no `amount ≠ 1` rows; there are no `amount = 1` rows either. `gram_weight / amount` is `x/NULL` (→ NULL, then `REAL NOT NULL` abort) or, if the parser does `float('' or 0)`, `x/0` → `inf` → `serde_json` → `null` → `Number(null) === 0`. That is precisely the failure mode `architecture-app.md` §1.6 layer 3 claims to have eliminated, sitting inside the one arithmetic both docs say is safe because it happens at build time. And it lands on the dataset §1.1 calls "the best household portions in FDC."

**Fix.** Treat FNDDS as `amount = 1` explicitly (the quantity is inside `portion_description`: `1 cup`, `1 fl oz`), and add an ingest assertion that `amount` is non-blank and > 0 for every SR/FF row and blank for every FNDDS row, so a future release that starts populating it fails the build instead of silently changing every FNDDS portion.

### 1.2 The SR Legacy portion label and `amount` are split, so the documented label rule under-counts by up to 11×

§2.5 says: SR Legacy uses `modifier` as the label, and the runtime column is `grams_per_unit = gram_weight / amount`. Real rows:

```
amount=11  gw=31.0  modifier='crackers (1 NLEA serving)'   Crackers, cream, Gamesa Sabrosas
amount=10  gw=32.0  modifier='crackers (1 NLEA serving)'   Crackers, cream, La Moderna
amount=10  gw=60.0  modifier='twists'                      Snacks, pretzels, hard, plain, salted
amount=0.12 gw=131.0 modifier='pie 1 pie (1/8 of 9" pie)'  Pie, Dutch Apple
amount=4   gw=113.0 modifier='oz'                          Cream puff, eclair
```

The `modifier` is a bare **plural** unit noun with the count stripped into `amount`. Under the documented rule the picker renders `crackers (1 NLEA serving)` bound to `31/11 = 2.82 g`. A user selecting "1 × crackers (1 NLEA serving)" logs **2.82 g instead of 31 g — an 11× under-count**, and the label explicitly asserts it is one NLEA serving. The Dutch apple pie row is a 8.3× *over*-count in the other direction.

Foundation is worse, because §2.5's fallback is `"{gram_weight} g"`: 17 of the 187 bundled Foundation portions have `amount ≠ 1`, e.g. `amount=2.0, gw=33.9`, so the label reads "33.9 g" while the bound value is 16.95 g. The label directly contradicts the number.

**Fix.** A single `grams_per_unit` scalar cannot carry this. Keep both columns (`portion_amount`, `gram_weight`) and render `"{amount} {modifier} — {gram_weight} g"` with one selection = `gram_weight`. Never render a label whose text names a quantity different from the quantity the value encodes.

### 1.3 The two documents specify two mutually incompatible `NutrientValue` types

| | `architecture-data.md` §3.2 | `architecture-app.md` §1.2 |
|---|---|---|
| Variants | 8: `Measured`, `Calculated`, `Unattributed`, `AssumedZero`, `BelowLoq`, `LabelZero`, `Trace`, `Absent` | 4: `Measured`, `BelowLoq`, `LabelRoundedZero`, `Absent` |
| Fields | `{amount}` / `{upper}` only | `{amount, unit, derivation}` / `{loq, unit}` |
| Location | `src-tauri/src/nutrition/value.rs` | `crates/core/src/value.rs` (and §2 forbids domain code in `src-tauri`) |
| `lower` for a day | SQL sums `sn.amount` over **every** `value_kind` | "Σ of **Measured** amounts only" |

The DDL's `CHECK (value_kind IN (…7 kinds…))` is enumerated verbatim in four tables. Four of those kinds — `calculated`, `unattributed`, `assumed_zero`, `trace` — have **no representation in the app document's Rust enum**. The claim that the type system makes the bad state unrepresentable end to end is false as written: rows read out of the DB have nowhere to go.

The `lower` disagreement is the dangerous half. FNDDS is 100% blank-derivation, which §2.4 maps to `calculated`:

```
FNDDS food_nutrient rows: 353015   derivation blank: 353015   data_points blank: 353015
```

Under the app document's definition, **every one of the 5,432 FNDDS foods contributes 0 to `lower` for every nutrient** — the "as consumed" mixed dishes a real user logs most. SR Legacy adds another 28.2% of rows in the same state. Whichever definition wins, only one document can be right, and neither says which.

**Fix.** Delete one of the two type definitions. Keep the 8-variant one in `crates/core/src/value.rs`; define `lower()` once, in Rust, and make the SQL a projection of that definition rather than a second implementation of it.

### 1.4 `CHECK (amount >= 0)` is contradicted by the bundled source data, and `NOT NULL` by 33 rows

```
negative amounts: [('FF', 10)]
  Chicken, drumstick, meat and skin, raw   1005 Carbohydrate, by difference  -0.47505
  Pork, belly, with skin, raw              1005 Carbohydrate, by difference  -0.705
  ... 8 more, all foundation_food, all nutrient 1005
rows with NULL amount by ds: [('FF', 33)]   # all nutrient 2066, all in bundled foundation foods
```

Carbohydrate-by-difference is `100 − (water + protein + fat + ash + alcohol)` and goes negative on fatty meats; this is normal FDC output, not corruption. Nutrient 1005 is tracked. The build therefore has three unspecified options and all three are wrong by default: abort (10 foods block the build), clamp to 0 (a manufactured zero on the nutrient the doc's own §2.2 flags for manufactured zeros), or drop the row (chicken breast reports carbohydrate `Absent`, which makes every day containing chicken permanently `Unbounded` for carbs). Neither document mentions negative or blank amounts.

**Fix.** Add an explicit rule and an assertion: `1005 < 0` → store `Measured { amount: 0.0 }` with a `clamped` provenance flag *and* keep the raw value in a `raw_amount` column; blank `amount` → no row (`Absent`). Assert the negative count is ≤ 15 so a release where this explodes fails.

### 1.5 The `upper_limits` DDL makes "no UL established" impossible to insert

This is the exact feature §4.3 calls load-bearing ("a NULL amount is impossible to render as 'unlimited'"). Run against the DDL verbatim:

```sql
-- thiamin: no UL established
INSERT INTO upper_limits VALUES(1,1165,'none_established',NULL,NULL,'not_applicable',NULL,'no_ul','x');
-- Runtime error: CHECK constraint failed:
--   (applies_to = 'supplemental_only') = (source_nutrient_id IS NULL)
```

`status='none_established'` forces `applies_to='not_applicable'` (third CHECK), which is not `'supplemental_only'`, so the biconditional demands a **non-NULL `source_nutrient_id` for a UL that does not exist**. The eight nutrients §4.3 names by hand — vitamin K, thiamin, riboflavin, pantothenic acid, biotin, B12, chromium, potassium — plus sodium's CDRR-only row, cannot be represented. The only way to insert is to invent a meaningless source nutrient, which destroys the biconditional's purpose.

**Fix.** Replace the biconditional with two one-way implications:
```sql
CHECK (applies_to <> 'supplemental_only' OR source_nutrient_id IS NULL),
CHECK (status = 'none_established' OR applies_to = 'supplemental_only'
       OR source_nutrient_id IS NOT NULL),
```

---

## SEVERITY 2 — Correctness holes in the missing-vs-zero enforcement.

### 2.1 The CHECK constraints do not make the bad state unrepresentable

The seven states §3.1 lists *are* rejected — I confirmed all seven. But the table is a list of states someone thought of, not a proof. Seven intent-violating rows insert cleanly into `ref_food_nutrients` as specified:

```
inserted rows that pass all CHECKs: 7
2|1103|9999.0||assumed_zero      <-- AssumedZero carrying 9999 µg selenium
2|1104|40.0|50.0|trace           <-- Trace with a non-zero lower bound
2|1105|0.0|1.0e+308|below_loq    <-- no sanity ceiling on upper_bound anywhere
2|1008|412.0||measured           <-- source_nutrient_id=1270 for nutrient 1008 (not in any chain)
2|1162|10.0||measured            <-- low=900.0, high=0.0 (low/high wholly unconstrained)
2|999999|5.0||measured           <-- nutrient_id in no `nutrients` row (no FK: different file)
```

The first two matter because **the SQL and the Rust then disagree about the same row**. `NutrientValue::AssumedZero` has no numeric field (`lower()` → 0.0, `upper()` → `Some(0.0)`); `Trace{upper}` has no lower field (`lower()` → 0.0). The rollup reads `sn.amount` and `COALESCE(sn.upper_bound, sn.amount)`. So an `assumed_zero` row with `amount = 9999` is 0 in Rust and 9999 in the dashboard, and a `trace` row with `amount = 40` is 0 in Rust and 40 in the dashboard. Two implementations of `lower()`, no test that they agree.

Note the third CHECK deliberately omits `'trace'` — that is what opens hole 2, and it is not explained.

**Fix.** `CHECK (value_kind NOT IN ('below_loq','label_zero','trace','assumed_zero') OR amount = 0.0)`. Add `CHECK (upper_bound IS NULL OR upper_bound <= 1e6)`. Add `CHECK (low IS NULL OR high IS NULL OR low <= high)`. And add a property test asserting `rollup_sql(row) == NutrientValue::from(row).lower()` over a generated corpus — that is the test that would have caught this class, and neither document has it.

### 2.2 A nutrient whose only contributor is `assumed_zero` renders as a zero-filled bar

Reproduced. Day with 4 entries, one of which carries `assumed_zero` vitamin C:

```
(1162, 'Vitamin C', lower=0.0, upper=0.0, items_with_data=1, items_total=4, bounded=0)
```

`lower` is a real `0.0`, not NULL, so the formatter takes the numeric branch. Per §7.2 that renders `≥0 mg` with a bar filled to 0% of the RDA. §3.4 argues at length that `Absent` gets **no bar track** because "an empty track reads as '0%', which is exactly the lie." The identical argument applies to `≥0` with 1-of-4 coverage, and neither §3.4 nor §7.2 has a row for it.

**Fix.** The label/geometry rules must key off `coverage`, not off whether `lower` is NULL. Below the coverage threshold, suppress the bar track entirely regardless of whether `lower` happens to be numeric.

### 2.3 The trend query, as described, is wrong in two ways — demonstrated

§6.2 closes with: *"Trend queries are the same CTEs with `logged_on BETWEEN :from AND :to` and `GROUP BY logged_on, nutrient_id`."* I wrote exactly that and ran it over a 10-day window with entries on two days:

```
Naive 'same CTEs' trend for selenium 2026-09-01..09-10:
   ('2026-09-03', 1103, 29.394999999999996, 2, 7)
   ('2026-09-05', 1103, 5.0, 4, 7)
Expected: 10 rows, one per calendar day, with NULL on the 8 unlogged days.
```

1. **The §6.1 bug is reintroduced.** There is no date spine, so unlogged days produce no row. Phase 9's acceptance criterion is *"days with no data are gaps in the line, not zeros"* — a client handed 2 points for a 10-day axis will either compress them or index-align them and draw 09-05's value at 09-02. The bare-aggregate trick that fixes the day query does not generalise; a trend needs `nutrients CROSS JOIN date_series(:from,:to)`, which nothing in the document provides.
2. **`items_total` is 7 — the range total, not the per-day total.** The real per-day denominators are 3 and 5. So `upper_is_bounded` is 0 on every day of every trend, including days with 100% coverage. `%UL` is therefore never displayable on a trend, silently.

**Fix.** Write and commit the trend query as its own artifact with a recursive `date_series` CTE and a per-day `day_totals` grouped by `logged_on`, and give it the same empty-range test the day query got.

### 2.4 Four tracked nutrients have zero rows in all three bundled datasets, not two — and one of them is a golden assertion

§2.1 states: *"chromium (1096) and added sugars (1235) have zero rows in Foundation, SR Legacy and FNDDS."* Measured across the bundled set:

```
*** TRACKED NUTRIENTS WITH ZERO ROWS IN ALL THREE BUNDLED DATASETS ***
    (1235, 'Sugars, added')
    (1096, 'Chromium, Cr')
    (1245, 'Niacin, added')                 <-- not documented
    (1169, 'Niacin equivalent N406 +N407')  <-- not documented
```

`1245` is one of the four "golden assertions" in `assertions.toml`: `niacin = { target = 1167, ul_source = 1245 }`. That assertion will pass forever while the niacin UL is **structurally unevaluable**, because the nutrient it reads has no rows anywhere. §4.3 defends wiring niacin to 1245 on the grounds that "restricting to user-entered supplements would under-warn" — it under-warns 100% of the time as designed. `1169` is listed in §2.1 as the niacin-equivalent display value; it can never render.

The companion numbers for the other special-basis ULs:

```
1242 Vitamin E, added : SR 4616 rows (96% zero), FNDDS 5431 rows (96% zero), FF 0
1186 Folic acid       : SR 6500 (74% zero), FNDDS 5431, FF 0
1090 Magnesium        : supplemental_only -> "not evaluated" in v1 (no supplement log)
```

So of the five special-basis ULs that §4.3 presents as a headline correctness feature, **only vitamin A (1105 retinol) has a live path in v1**. Vitamin E's UL evaluates to ~0 always, folate's has no Foundation coverage, niacin's and magnesium's cannot fire at all. The architecture is right and inert; neither document says so.

**Fix.** Add `1245` and `1169` to §2.1's zero-rows list and to `[coverage]` in `assertions.toml`. Change the niacin UL row to `status='none_established'` with a `note_key` explaining that fortification data is unavailable offline, rather than shipping an assertion that guards a dead path.

### 2.5 `nutrients.unit` cannot distinguish RAE from retinol from DFE from α-TE from NE

`CHECK (unit IN ('g','mg','ug','kcal','kJ','IU'))`, and §4.4 declares this column "the single authority" for units. But the tracked set contains, all as `ug` or `mg`:

- 1106 µg **RAE**, 1105 µg **retinol**, 1104 **IU**
- 1190 µg **DFE**, 1177 µg total folate, 1186 µg **folic acid**, 1187 µg food folate
- 1109 mg **α-tocopherol**, 1242 mg added
- 1167 mg **niacin**, 1169 mg **NE**

The folate UL is 1,000 µg **of folic acid**, not 1,000 µg DFE — a 1.7× difference, and both columns say `ug`. Nothing in the type system, the DDL, or the Rust prevents summing 1190 + 1186, converting between them, or someone later "fixing" the UL to read 1190 because it is the target nutrient and the units match. This is exactly the class of error §4.4 spends a whole table guarding against in the scraper, left unguarded in the model.

**Fix.** `Unit` must be `(magnitude, basis)` where basis ∈ {mass, RAE, DFE, retinol, α-TE, NE, IU}. Cross-basis arithmetic is then a compile error rather than a review question. Add a `basis` column to `nutrients` with a NOT NULL CHECK.

### 2.6 Folate appears four times and vitamin A six times as sibling dashboard rows

There is no `role` or `is_displayed` column. `nutrients` has `is_tracked`, `is_limit`, `display_group`, `display_order` — so anything stored for the UL evaluator or as a chain member is also a dashboard row. Measured co-occurrence:

```
FNDDS folate family: total1177=5431  DFE1190=5431  folicacid1186=5431  foodfolate1187=5431
FNDDS vitA family:   RAE=5431 retinol=5431 bcar=5431 acar=5431 cryp=5431
SR    folate all four present on 6,476 foods
```

On **100% of FNDDS foods**, §7.3's "water-soluble vitamins" section renders four folate rows whose values are components and re-expressions of each other, and "fat-soluble" renders five vitamin A rows. Ten of ~72 rows for two nutrients, each with its own bar and its own %RDA, inviting exactly the double-count the document is careful about elsewhere. Vitamin D is worse: 1110 and 1114 disagree on **1,405 of the 1,888 SR foods that carry both** (measured, tolerance 0.51 IU), so the user sees two contradictory vitamin D numbers.

**Fix.** Add `role TEXT NOT NULL CHECK (role IN ('primary','chain_alternate','ul_basis','component','display_only'))` to `nutrients`, and make the dashboard query filter `role='primary'`. Components belong behind the food-detail disclosure, not in the daily panel.

### 2.7 The rollup query cannot run under the app document's own rule

`architecture-data.md` §6.2: *"Runs on `user.db` with `usda_core.db` ATTACHed as `ref`"* — and the query's `FROM ref.nutrients n` is what makes every tracked nutrient appear on an empty day. `architecture-app.md` §4.2: *"The dashboard and trends queries touch **only** `user.db`. No cross-file join, no ATTACH."*

Both cannot be true. Without the attach there is no source for the 74-row nutrient dimension inside `user.db`, and the CROSS JOIN fix of §6.1 has nothing to join to.

**Fix.** Copy `nutrients` (74 small rows) into `user.db` at migration time, keyed to `meta.dataset_version`, and drop the attach. That preserves §4.2's rule and keeps the reference DB replaceable, at the cost of one refresh step on version bump.

### 2.8 The UL 7-day trailing mean has no command, no query, and no phase

§3.3 states, correctly, that *"UL warnings fire on a trailing 7-day mean, not a single day"* — it is the difference between a warning users trust and a banner they learn to ignore. Nothing else implements it. The command surface (§3) has `get_day_dashboard` and `get_nutrient_trend(nutrient_id, …)` — one nutrient per call. §7.3's "Needs attention" section ranks "certainly-over-UL first" from a day dashboard. Phase 6 delivers verdicts against the day. There is no query that computes a 7-day mean across all tracked nutrients, no DTO carrying it, and no phase that builds one.

**Fix.** Either add `get_ul_status(profile_id, on: LocalDate) -> Vec<UlStatus>` computing the trailing-7-day interval per nutrient, and put it in Phase 6, or delete the 7-day claim and say the UL check is per-day. Do not ship a rule that only one of the two documents believes.

### 2.9 `Unbounded` swallows the product: one custom food or one barcode scan poisons ~65 nutrients

The rule is right — `Upper::AtLeast` whenever `items_with_data < items_total`, and §3.3's "recipes never launder unknowns." The consequence is unaddressed. `custom_foods` has no nutrient-entry UI in any phase and no user will enter 72 values; §1.4 of the data doc measures OFF's real micronutrient presence at 2.5%–85%. So:

- One scanned yogurt → ~65 nutrients `Unbounded` for that day.
- One custom "protein shake" → the same.
- Any FNDDS food → ALA (1404), LA (1316) and **trans fat (1257)** are `Absent`, measured: all three have **0 rows in FNDDS**. Trans fat is an `is_limit` nutrient, so its ceiling bar never resolves on the dataset users log from most.
- Iodine coverage after the overlay is 382/13,694 = 2.8%, so iodine is `Unbounded` essentially every day, and with the 0.5 mass-coverage threshold its %RDA is suppressed essentially every day.

The net effect: `Verdict::CertainlyBelow` (which reads `upper`) and "safely under the UL" (which requires coverage 1.0) are **unreachable in normal use**. The app can say "at least X" and "certainly over" and nothing else. That may be the honest answer, but it is a product decision that neither document states, and §7.1's four-channel bar design assumes a bounded upper is the common case.

**Fix.** State it explicitly and design for it: make the open-edge chevron the default rendering rather than the exception, and add a per-nutrient "assume typical for this food category" opt-in as §8 question 9 anticipates — but decide it now, because it changes what the dashboard looks like on day one.

### 2.10 `LabelZero`'s upper bound rule is underspecified and off by ~1000× if read literally

§3.2's ingest table says: *"the 21 CFR 101.9(c) rounding increment as the bound."* §3.4's example is `LabelZero{0.5}` with the caption "21 CFR 101.9 permits rounding below 0.5 g" — that is the **fat and protein** rule. For vitamins and minerals, 21 CFR 101.9(c)(8)(iii) permits declaring zero when the amount is **below 2% of the DV**, which is a per-nutrient value, not an increment. The §6.3 fixture happens to use `0.36` for iron (2% of the 18 mg DV) — correct — but the prose says something different from what the fixture does.

**Fix.** Write the rule as a table keyed on nutrient class: macros → the §101.9(c) increment; sodium → 5 mg; vitamins/minerals → `0.02 × daily_values.amount` for the `adults_and_children_4plus` population. Store it in the reference DB so it is one lookup, not a constant in the ingest code.

---

## SEVERITY 3 — Phase-ordering bugs, unverified constants, and doc-vs-doc drift.

### 3.1 Phase ordering: three dependencies on things earlier phases do not deliver

1. **Phase 2 cannot complete.** `architecture-data.md` §7.2 step 6 makes the DRI tables (`life_stage_groups`, `reference_intakes`, `upper_limits`, `daily_values`) part of the *reference DB build* — they are in the §5.3 `usda_core.db` DDL. Phase 2's file list is `crates/usda-ingest/src/main.rs` and `scripts/schema_reference.sql`; `scripts/scrape-dri.py` and `data/reference/dri.json` appear in no phase. §4.1 budgets them at "one to two days." Phase 6 is where targets land, four phases later. So Phase 2's `cargo run -p usda-ingest --release` cannot produce the documented file.
2. **Phase 4/5 cannot draw the bar.** `BarGeometry` carries `target_tick_pct` and `ul_marker`. Phase 5's verify criterion is *"its %RDA must be indeterminate."* Both require targets, delivered in Phase 6.
3. **`export_day_csv` is orphaned.** §3 assigns it to "Phase 9; needs `tauri-plugin-dialog`" and §5.1 says dialog is "Phase 9 only." Phase 9's file list and verify steps are entirely trends; CSV export appears nowhere. **Resolved.** Export shipped as `export_log` + `save_exported_file` and is no longer tied to a phase; §3 and §5.1 of `architecture-app.md` now describe what was built. It is a period rather than a day, and its contract is stronger than the one this line was about: the file it writes re-enters through the app's own importer, which is proved by `src/lib/exportSheet.test.ts`.

Also, Phase 1 delivers `migrations/001_init.sql` "(from `docs/architecture-data.md`)" — but that document's §5.4 is the complete `user.db` DDL including `log_entries`, `nutrient_snapshots`, `recipes`, `recipe_items` and `nutrient_targets`, which Phases 5, 6 and 7 then create again in `002_targets.sql` and `003_recipes.sql`. The split is never stated, and §5.4's rule "never edit a shipped migration" makes getting it wrong permanent.

**Fix.** Insert a Phase 2a for the DRI scrape+verification before Phase 2, or move the DRI tables out of `usda_core.db` into `user.db` migrations (they are ~2 KB and profile-dependent anyway). Move the target tick out of `BarGeometry` into an optional field so Phase 4/5 can ship without it. Specify exactly which tables each numbered migration creates.

### 3.2 The tracked-nutrient list is simultaneously an open question and a build-failing constant

`architecture-app.md` §12 open question 4: *"Which ~50 nutrients does v1 track? … Needed before Phase 2 finalises the ingest."* `architecture-data.md` §2 opens with *"74 tracked nutrient ids"* and `assertions.toml` commits `bundled_tracked_rows = 649113`, which fails the build on drift. The app document says "~50" in four places (§3 `get_day_dashboard`, §6.4 "50 interval bars", §7 heading, §7.3 "Fifty rows is ~2,300 px").

I enumerated 72 ids from §2.1's tables — the tables do not actually contain 74. My 72-id set yields 627,545 tracked rows, not 649,113, so the doc's tracked set is not the one §2.1 lists.

**Fix.** Commit the list as `data/reference/tracked-nutrients.json` with one row per nutrient (`id`, `unit`, `basis`, `role`, `chain_position`), make it the single input to both the ingest and the dashboard, and recompute `bundled_tracked_rows` from it. Right now the assertion pins a number no artifact in the repo can regenerate.

### 3.3 `iodine_overlay_foods = 382` is a build-failing assertion that three sources disagree about

- `data-findings.md`: *"369 foods gain a real measured iodine value."*
- `architecture-data.md` §1.3 and `assertions.toml`: *"370 SR Legacy + 12 Foundation = 382 distinct bundled foods."*
- My reproduction, implementing §1.3's five-form matcher against the real sheet: **368 SR + 5 FF = 373**, with 4 asterisk rows and 1 slash row skipped and 6 unresolved (`43379, 03170, 21140, 32037, 21112, 21092` — §1.3 says "seven codes do not resolve" and names `43379`).

The sheet structure otherwise checks out exactly: 520 rows, header row 2, column B is `'Standard Reference (Foundation FoodsA) \
FDC NDB No.'`, 367 plain + 7 `ndb (paren)` + 5 `(paren only)` + 4 asterisk + 1 slash = 384 with an identifier ✓, `Min`/`Max` really are columns H and I ✓, and the maximum is `('02047', 5213.1, 'Salt, table, iodized')` ✓.

So the matcher spec is right and the yield constant is not reproducible from it. Committing 382 as a hard assertion means the first `cargo run -p usda-ingest` fails and someone edits the assertion to whatever came out — which destroys the point of the assertion.

**Fix.** Re-derive the number from the committed matcher, record the exact resolution rule for `(paren only)` codes (that is where my 5 vs the doc's 12 diverges), and assert `>= 365` rather than an exact equality on a join whose fifth form is documented as ambiguous.

### 3.4 "Exactly one collision" is four

§3.1: *"the bundled set contains exactly **one** collision (fdc 2768188 Alaska Pollock, raw, nutrient 1106, both rows 2.61)."* Measured:

```
dup (ds,fdc,nutrient) pairs: 4
  ('FF', 2758990, 2066, 2)   amounts: NULL, NULL
  ('FF', 2758991, 2066, 2)   amounts: NULL, NULL
  ('FF', 2758992, 2066, 2)   amounts: NULL, NULL
  ('FF', 2768188, 1106, 2)   amounts: 2.61, 2.61   <-- the one documented
```

`max_duplicate_food_nutrient_pairs = 5` still passes, so the build won't catch it, but the stated fact is wrong and the three extra collisions are precisely the NULL-amount rows from §1.4 above. The dedup rule ("highest `data_points`, then lowest `food_nutrient.id`") is undefined when both `data_points` are blank — which is the case for all three.

### 3.5 Filename and file-count drift between the two documents

- `usda_core.db` (data doc, throughout, including `src-tauri/resources/usda_core.db` in §7) vs **`usdacore.db`** (app doc, with §4.3 rule 2 explicitly mandating no underscores). The data document violates the app document's rule in its own file listing.
- **Two files** (data §0 row 8: "Two.") vs **three** (app D3, §4.2: a separate disposable `cache.db`).
- That third file moves `cached_foods` / `cached_food_nutrients` out of `user.db`, which breaks the data document's §5.1 licensing argument ("OFF-derived rows live only in `user.db`" — they'd live in `cache.db`), relocates `ix_cached_gtin`, and orphans `user_foods_fts`, which §5.4 defines as a union index over `custom_foods + cached_foods + recipes` maintained by triggers — **SQLite triggers cannot span an ATTACH boundary**, so that index cannot be maintained if `cached_foods` moves.
- `Upper::{Bounded, AtLeast(f64)}` (data §3.3) vs `UpperBound::{Bounded{amount}, Unbounded}` (app §1.3). Different arity, different meaning.
- The app's `Coverage` DTO wants `items_measured`, `items_bounded`, `items_absent`. The documented SQL produces `items_with_data` (which lumps measured + calculated + unattributed + assumed_zero) and `items_censored`. **`items_measured` cannot be filled from the query as written.**
- Coverage suppression: data §3.3 suppresses the % below 0.5 mass coverage; the app's `Verdict` enum has no state for "insufficient data" — `Indeterminate` means the interval straddles the threshold, which is a different fact — and `BarGeometry` always carries `lower_pct`.

### 3.6 Version claims: the host header is accurate; the dependency pins are not verified

I checked every claim in the `architecture-app.md` header against disk. All correct: react 19.2.8, vite 7.3.6, typescript 5.8.3, `@tauri-apps/api` 2.11.1, cli 2.11.4, `@vitejs/plugin-react` 4.7.0, node v26.3.0, pnpm 10.28.2, rustc 1.98.1, tauri 2.11.5 in `Cargo.lock`, `tauri-plugin-opener` 2.5.5, `productName: "trackit"` lowercase, identifier `com.kgundu1.trackit`. Tauri's MSRV really is `rust-version = "1.77.2"`. The `sum()`/`total()` demonstration reproduces (`|0.0`).

Not installed and not verifiable from this host, but stated as fact:

| Claim | Status |
|---|---|
| `rusqlite 0.40` → `libsqlite3-sys 0.38.2` → SQLite **3.51.3** | **Unverified, and D2/§4.1 rest entirely on it.** The `links = "sqlite3"` exclusivity argument is sound in principle; the specific version numbers that make it a *hard* conflict are not checked |
| `tauri-plugin-sql 2.4.1` → `sqlx ^0.8` → `libsqlite3-sys ^0.30.1` (SQLite 3.45.3) | Unverified |
| `tauri-plugin-fs 2.5.2`, `-log 2.9.1`, `-barcode-scanner 2.4.6`, `-dialog 2.7.3` | Unverified. Local cargo cache holds fs **2.5.1** and dialog **2.7.1** |
| `ts-rs 12`, `rusqlite_migration 2.6` | Unverified |
| `@tanstack/react-query 5.102.8`, `zustand 5.0.15`, `wouter 3.10.0`, `visx 4.0.0` | Unverified — the `pnpm add` line in §6.1 pins exact versions that may not exist |
| "Recharts 3.10.1 measures 144 KB gzip", "visx 48.4 KB naively summed, 25–30 KB after dedupe" | Unverified measurements presented as measured |
| Chromium M136/M139/M144 safe-area-inset behaviour, "stable WebView is 152/153" | Unverified |

**Fix.** Run `cargo add --dry-run` / `pnpm view <pkg> version` for each before Phase 0, or mark them "as of 2026-09" rather than as pins. A wrong `rusqlite` version number does not change the decision but does turn Phase 1 into a debugging session.

### 3.7 Smaller data hazards neither document mentions

- **273 Foundation `food_portion.csv` rows have an empty `fdc_id`.** A `int(row['fdc_id'])` ingest crashes; a permissive one creates `fdc_id = 0`. They filter out via the 469-food join, so `foundation_portions = 187` still holds — but the parser must survive them.
- **`nutrient.csv` has 12 rows with an empty `nutrient_nbr`** (2052–2064: Total Tocopherols, Ergothioneine, Beta-glucan, Vitamin D4, …). §7.2 step 1 says "build both `id → row` and `nutrient_nbr → id`"; the naive map silently collapses those 12 to one entry under key `''`. Harmless today (FNDDS values are 203–646) but it is a landmine.
- **`reference_intakes.unit` and `upper_limits.unit` duplicate `nutrients.unit`**, which §4.4 declares "the single authority." Two sources of truth for the unit is the exact 1000× hazard that §4.4's mojibake table is defending against. Drop the columns.
- **`reference_intakes.kind` has no `'eer'`**, and `nutrient_targets.target_kind` doesn't either. §4.1 lists EER as a source and §7.3's first zone is an always-visible kcal tile — the calorie target has nowhere to live in the schema, and no command returns it.
- **No portion table for `custom_foods` or `recipes`.** `custom_foods` has only `basis_grams`; `recipes` has `yield_grams`/`yield_servings` but nothing maps "1 serving" or "1 slice" to grams at log time, and `log_entries.portion_label` is free text with `grams` supplied by the caller. So "1 scoop of my protein powder" and "1 slice of my banana bread" are unrepresentable — the user types grams every time. That is a direct gap against the confirmed v1 feature "custom foods and recipes."
- **Orphan snapshots are never collected.** `log_entries.snapshot_id` is a plain FK with no `ON DELETE`, entries are soft-deleted, and snapshots are content-addressed and immutable. Nothing removes a snapshot whose last referencing entry was deleted. Not urgent, but it is unbounded growth in the file that is supposed to stay small.
- **Fluoride (1099) has 538 rows, all SR Legacy, 0 in Foundation and FNDDS** — 3.9% coverage on a tracked nutrient with both an AI and a UL. It belongs in §7.3's "no data in any bundled source" zone in practice, not in "trace minerals."

---

## What I could not check

The DRI transcription itself (the risk register correctly calls it "the largest untested surface"), the NCBI Bookshelf and eCFR scrape hazards in §4.4, the Open Food Facts unit and zero-fill measurements in §1.4, the Android/WebView/R8/ML-Kit claims in §4.3–§5.5, and the crates.io versions above. All of §4.4's five scrape hazards are plausible and specific; none are verified here.",
    "synthSummaries": [
      "Written to `/Users/kgundu1/BioBalance/docs/architecture-data.md` (1,369 lines).

1. **Bundle Foundation(469, not 395) + SR Legacy(7,793) + FNDDS(5,432) = 13,694 foods — measured 17.88 MiB / 5.52 MiB gz** by actually building the DB; dropped the `(nutrient_id,fdc_id)` index after measuring it costs 7.47 MiB and made its own query 0.06 ms *slower*.
2. **Iodine overlay yields 382 foods, not 369** — joined column B with a five-form parser (`01001`, `01253 (100297)`, `(100299)`, `18069*`, `16123/16124`): 370 via SR `NDB_number` + 12 via `foundation_food.NDB_number`; parenthesised codes match 0/12 against `fdc_id` directly.
3. **New trap found empirically:** FNDDS `food_nutrient.nutrient_id` holds nutrient *numbers* (203–646, 65 distinct, 0 ≥1000), so FNDDS joins on `nutrient_nbr` while FF/SR join on `nutrient.id`; wrong join + `COALESCE` = an all-zero 5,432-food table.
4. **Value type: absence is an absent row**, `amount REAL NOT NULL` (no NULL to coalesce), 7-variant tagged union, 6 CHECKs — I verified SQLite rejects all 7 invalid states.
5. **Rollup verified**: 74 rows on a populated day *and* an empty day, 0.145 ms over a 2,193-entry year; the broken `CROSS JOIN` pattern reproduced returning 0 rows on an empty day. Safety comes from cross-joining a bare aggregate CTE (always exactly 1 row); `lower`/`upper` are left NULL, only counts/masses are coalesced.
6. **Two DB files, resolved explicitly** — the one-file argument was three properties of `tauri-plugin-sql`/sqlx (pool ATTACH, cross-DB FKs, unset `journal_mode`), all moot under rusqlite; plus `links="sqlite3"` makes plugin+rusqlite coexistence impossible anyway.
7. **UL wiring made structurally safe**: `upper_limits.source_nutrient_id` is what the evaluator sums, so vitamin A reads 1105 (retinol) not 1106, folate 1186, niacin 1245, vitamin E 1242, magnesium NULL — four golden build assertions.
8. **Provenance mapping measured**: SR derivation 68 = 'Z' is 57,711 rows all zero → `assumed_zero`; 31,989 zeros have blank derivation → `unattributed`; FNDDS has derivation *and* data_points blank on 100% of 353,015 rows → `calculated`, never `measured`. Foundation ships no `food_nutrient_derivation.csv`, so SR's copy is the map (asserted).
9. **Two findings that change the pipeline**: SR `portion_description` is empty on all 14,449 rows (text is in `modifier`), `measure_unit_id`=9999 on 100% of SR+FNDDS, 3,464 SR portions have `amount≠1`; and SR's `retention_factor.csv` is 270 rows of *code descriptions only* — no per-nutrient percentages — so cooking loss cannot be modelled from the bundle and recipes carry a raw-basis caption.
10. **Open**: coverage-suppression threshold (0.5 by mass is a judgement call, not measured); whether FDC supports exact `gtinUpc` lookup (unverified — decides the barcode resolution order); and whether to show the 12× vitamin-A IU interval (defaulted to "report unknown"). The built DB is **generated, not committed**; `sources.sha256`, `assertions.toml` and `data/reference/dri.json` are.",
      "Document written to `/Users/kgundu1/BioBalance/docs/architecture-app.md` (1,448 lines, 13 sections).

1. **rusqlite 0.40 bundled, no tauri-plugin-sql** — forced by the exclusive `links = "sqlite3"` key, decided on correctness: the plugin's decoder maps decode failures to `null`, `select<T>` is an unchecked assertion, and `create_if_missing` turns a failed extraction into a silently empty DB.
2. **No `null` anywhere in any DTO** — `NutrientValue` is a serde-tagged union whose `amount` field exists only inside `kind:"measured"`, so `v.amount ?? 0` is a TypeScript compile error, not a lint; six independent layers (type shape, CI grep on bindings, non-finite constructor guard, no-null serialization corpus test, ESLint, SQL/Rust grep) plus a committed `@ts-expect-error` negative compile test.
3. **Two types, not one** — per-food `NutrientValue` vs. day-total `NutrientTotal {lower, upper: Bounded|Unbounded, coverage}`; verdicts are three-valued interval comparisons, so %RDA reads the lower bound and %UL reads the upper, and UL basis rules (retinol not RAE, folic acid not folate) live in Rust.
4. **Rust emits normalised geometry and formatted labels, not numbers** — percentages and tick labels cross IPC, which makes "no arithmetic operator may touch a nutrient field in JS" a rule with zero exceptions, and eliminates the charting library entirely (visx 4.0.0 kept as a lazy escape hatch).
5. **Workspace split**: `crates/core` (zero tauri dep, ~1 s tests), `crates/net`, `crates/usda-ingest`, thin `src-tauri`; ts-rs bindings committed and CI-diffed.
6. **Two DB files + disposable cache**, with log-time content-addressed nutrient snapshots so hot queries never join across files, cache eviction is safe, and a USDA refresh cannot rewrite history.
7. **APK bundling**: keep `.db` *compressed* (adding `noCompress` routes through `openFd`, which discards `getStartOffset()` and returns the APK from byte 0); stream-copy via `app.fs().open()` with SHA-256 → `.partial` → `rename`, stamp-file update detection, `SQLITE_OPEN_READ_ONLY` without CREATE so failure is loud; plus Auto-Backup exclusion XML and an assets-clean step.
8. **Minimal plugin set** — opener, fs (Rust-side only), log, barcode-scanner (target-gated); dropped http/store/os because the webview needs none of them and each is an ACL surface. FDC key is write-only across IPC.
9. **UI**: one interval-bar atom (solid lower / hatched bounded / open unbounded edge sized by *mass* coverage), one `<NutrientAmount>` renderer, four zones ending in an always-collapsed "no data in any bundled source" list, one shell with container queries and only `<AppChrome>` swapping.
10. **Open questions**: whether Android `app.fs().open()` needs an fs capability grant (Phase 3 resolves it); final DB size / whether FNDDS ships in v1; the exact ~50-nutrient tracked set (blocks Phase 2); `below_loq` is currently unassignable from any bulk source; cooking-loss modelling; Play vs. sideload."
    ]
  },
  "workflowProgress": [
    {
      "type": "workflow_phase",
      "index": 1,
      "title": "Synthesize"
    },
    {
      "type": "workflow_phase",
      "index": 2,
      "title": "Critique"
    },
    {
      "type": "workflow_agent",
      "index": 1,
      "label": "synth:data",
      "phaseIndex": 1,
      "phaseTitle": "Synthesize",
      "agentId": "aaaaf229a75221d6c",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788489973576,
      "queuedAt": 1788489972007,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "wc -l docs/architecture-data.md && ls -l docs/ && grep -c '…",
      "promptPreview": "# TrackIt — context

A personal nutrition tracker at /Users/kgundu1/BioBalance: **macOS desktop + Android from one Tauri v2 codebase**,
tracking calories, macros, and the FULL micronutrient panel. Today is 2026-09-03.

## Already DONE and verified on this host — do not re-plan these
- rustup installed (rustc 1.98.1) taking PATH precedence over Homebrew rust 1.96.0 (user chose to
  KEEP both rat…",
      "lastProgressAt": 1788491102862,
      "tokens": 202952,
      "toolCalls": 43,
      "durationMs": 1128213,
      "resultPreview": "Written to `/Users/kgundu1/BioBalance/docs/architecture-data.md` (1,369 lines).

1. **Bundle Foundation(469, not 395) + SR Legacy(7,793) + FNDDS(5,432) = 13,694 foods — measured 17.88 MiB / 5.52 MiB gz** by actually building the DB; dropped the `(nutrient_id,fdc_id)` index after measuring it costs 7.47 MiB and made its own query 0.06 ms *slower*.
2. **Iodine overlay yields 382 foods, not 369** — j…"
    },
    {
      "type": "workflow_agent",
      "index": 2,
      "label": "synth:app",
      "phaseIndex": 1,
      "phaseTitle": "Synthesize",
      "agentId": "a269c45496817eae5",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788489973498,
      "queuedAt": 1788489972007,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "wc -l /Users/kgundu1/BioBalance/docs/architecture-app.md &&…",
      "promptPreview": "# TrackIt — context

A personal nutrition tracker at /Users/kgundu1/BioBalance: **macOS desktop + Android from one Tauri v2 codebase**,
tracking calories, macros, and the FULL micronutrient panel. Today is 2026-09-03.

## Already DONE and verified on this host — do not re-plan these
- rustup installed (rustc 1.98.1) taking PATH precedence over Homebrew rust 1.96.0 (user chose to
  KEEP both rat…",
      "lastProgressAt": 1788490793838,
      "tokens": 167072,
      "toolCalls": 17,
      "durationMs": 820338,
      "resultPreview": "Document written to `/Users/kgundu1/BioBalance/docs/architecture-app.md` (1,448 lines, 13 sections).

1. **rusqlite 0.40 bundled, no tauri-plugin-sql** — forced by the exclusive `links = "sqlite3"` key, decided on correctness: the plugin's decoder maps decode failures to `null`, `select<T>` is an unchecked assertion, and `create_if_missing` turns a failed extraction into a silently empty DB.
2. **…"
    },
    {
      "type": "workflow_agent",
      "index": 3,
      "label": "completeness-critic",
      "phaseIndex": 2,
      "phaseTitle": "Critique",
      "agentId": "a42d705010cea7e81",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788491113962,
      "queuedAt": 1788491106517,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd /private/tmp/bb && rm -f ul.db && sqlite3 ul.db <<'EOF' …",
      "promptPreview": "# TrackIt — context

A personal nutrition tracker at /Users/kgundu1/BioBalance: **macOS desktop + Android from one Tauri v2 codebase**,
tracking calories, macros, and the FULL micronutrient panel. Today is 2026-09-03.

## Already DONE and verified on this host — do not re-plan these
- rustup installed (rustc 1.98.1) taking PATH precedence over Homebrew rust 1.96.0 (user chose to
  KEEP both rat…",
      "lastProgressAt": 1788492053436,
      "tokens": 183927,
      "toolCalls": 41,
      "durationMs": 939473,
      "resultPreview": "Verification complete. Here is the critique.

---

