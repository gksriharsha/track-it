# Food data: measured findings

Numbers below were measured directly against the USDA bulk downloads in `data/raw/`
on 2026-09-03, not taken from documentation. They drive the schema design.

## Dataset sizes (as downloaded)

| Dataset | Release | Foods | Nutrient rows | Portions |
|---|---|---:|---:|---:|
| Foundation Foods | 2026-04-30 | **395** | 170,469 | 10,951 |
| SR Legacy | 2018-04 (frozen) | **7,793** | 644,125 | 14,449 |
| FNDDS / Survey | 2024-10-31 | **5,432** | 353,015 | 22,046 |
| Iodine DB (separate) | Release 4 | ~475 (381 keyed) | — | — |

Zipped total: 12.6 MB. Branded Foods (~2.0 M foods, ~2.9 GB CSV) is deliberately
excluded — it is not bundleable and must be online-with-cache.

## Foundation Foods is small, but not as thin as a naive count suggests

Foundation Foods contains only **395 foods**, so it is a supplement to SR Legacy, never a
replacement. **SR Legacy (7,793 foods) is the backbone.**

Its nutrient depth is fine, though: `derivation_id` is populated (13,864 analytical,
1,454 calculated, 1,268 other, only 422 blank), so provenance is available.

### The multi-energy-id trap

Energy coverage looks catastrophic if you count only nutrient id 1008:

| Energy nutrient id | Foundation coverage |
|---|---:|
| 1008 "Energy" (kcal) | 24.1% |
| 2047 "Energy (Atwater General Factors)" | 81.5% |
| 2048 "Energy (Atwater Specific Factors)" | 72.9% |
| **any of 1008 / 2047 / 2048** | **81.8%** |

Foundation reports energy predominantly under **2047**, not 1008. An ingest that reads
1008 alone silently loses calories for three quarters of Foundation foods. Resolve energy
through a documented fallback chain (1008 → 2047 → 2048) and record which id was used —
they disagree by up to 23% on the same food, so they must never be averaged or coalesced
blindly. The same trap applies to fiber (1079 vs 2033), carbohydrate (1005 vs 1050),
sugars (2000 vs 1063), and ALA (1270 "18:3 undifferentiated" vs 1404), where
undifferentiated 18:3 overstates true ALA by ~3.7x on butter.

## Coverage and zero rates (measured)

`cov%` = share of that dataset's foods having any row for the nutrient.
`zero%` = share of those present rows whose amount is exactly 0.

| Nutrient | SR cov% | SR zero% | FF cov% | FF zero% |
|---|---:|---:|---:|---:|
| Protein | 100.0 | 4.3 | 89.4 | 1.1 |
| Energy (id 1008 only) | 100.0 | 0.5 | 24.1 | 0.0 |
| Energy (1008/2047/2048) | 100.0 | 0.5 | **81.8** | 0.0 |
| Calcium | 98.9 | 2.9 | 92.9 | 1.6 |
| Iron | 99.0 | 3.0 | 92.9 | 11.7 |
| Magnesium | 95.2 | 2.9 | 92.9 | 0.5 |
| Potassium | 96.4 | 1.9 | 92.9 | 0.3 |
| Zinc | 95.0 | 2.5 | 92.9 | 0.3 |
| Selenium | 88.1 | 5.5 | 38.7 | 17.6 |
| **Iodine** | **0.0** | — | 11.9 | 21.3 |
| **Chromium** | **0.0** | — | **0.0** | — |
| **Molybdenum** | **0.0** | — | 17.2 | 5.9 |
| **Biotin** | **0.0** | — | 29.9 | 12.7 |
| **Added sugars** | **0.0** | — | **0.0** | — |
| Vitamin B12 | 91.3 | **39.0** | 18.5 | 4.1 |
| Folate, total | 87.9 | 8.8 | 34.7 | 8.0 |
| Folic acid | 83.4 | **84.1** | 0.0 | — |
| Vitamin C | 94.1 | **51.9** | 29.9 | 11.0 |
| Vitamin D (D2+D3) | 66.5 | **63.6** | 13.4 | 37.7 |
| Vitamin K | 64.9 | 21.1 | 19.0 | 13.3 |
| Vitamin A RAE | 88.8 | 34.8 | 13.4 | 5.7 |
| Choline | 59.2 | 3.5 | 9.9 | 0.0 |
| Fiber | 92.8 | **46.6** | 50.1 | 3.5 |

### What this means

1. **Four nutrients have literally zero rows in SR Legacy**: iodine, chromium,
   molybdenum, biotin (also added sugars). Absent, not sparse. The UI must say
   "no data in any bundled source", never "0".
2. **High coverage hides high zero rates.** Vitamin C is 94% "covered" but 52% of
   those values are 0. Some are true (beef genuinely has ~no vitamin C); others are
   censored measurements. **Bulk data cannot distinguish them** — the limit-of-
   quantification field exists only in the live per-food API, and is stripped from
   every bulk download.
3. Therefore a nutrient value must carry provenance, not just a number.

## Iodine gap is fixable

USDA publishes a standalone Iodine database (ARS, Release 4) that FDC does not fold in.
The per-100g sheet has 520 spreadsheet rows, but only ~475 are foods (the rest are a
title row, a header row, 20 category section headers and 20 footnote rows). Of those,
only ~381 carry an NDB/FDC code in column B — note the join key is column B
("Standard Reference (Foundation Foods) FDC NDB No."), **not** column A `DB_ID`, which is
an internal identifier and will silently mismatch if used.

Joining on column B, **369 foods gain a real measured iodine value** (n, SD, min and max
per food), taking iodine from 0% coverage to usable. Highest: NDB 02047 (iodized table
salt), 5,213 mcg/100g.

## Consequence for the value type

A nutrient amount is not a nullable float. It needs at minimum:
`measured` | `below_limit_of_quantification(upper_bound)` | `label_rounded_zero(upper_bound)`
| `absent`.

The decisive argument: **%RDA must be computed from the lower bound of what was
actually measured, while %UL must be computed from the upper bound.** "Am I deficient?"
and "am I over the safe limit?" read opposite ends of the same interval. One scalar
cannot answer both, so aggregates carry `[lower, upper]` plus a coverage fraction and an
explicit set of unmeasured items.


## FNDDS uses `nutrient_nbr`, not FDC ids — silent total data loss if missed

**The single most dangerous ingest trap found.** In the Survey/FNDDS archive, the
`food_nutrient.nutrient_id` column does not contain FDC nutrient ids. It contains legacy
`nutrient_nbr` values.

Measured over the 65 distinct values FNDDS uses:

| Join attempt | Matches |
|---|---:|
| FNDDS `nutrient_id` → SR `nutrient.nutrient_nbr` | **65 of 65** |
| FNDDS `nutrient_id` → SR `nutrient.id` | **0 of 65** |

FDC ids occupy 1001–2069 and FNDDS numbers occupy 203–646, so the ranges do not overlap and a
naive join produces **zero rows rather than wrong rows** — silently discarding all 353,015 FNDDS
nutrient rows. The ingest must translate FNDDS through `nutrient_nbr`, and must assert a non-zero
join cardinality so this fails loudly if a future release changes convention.

Correct mappings (verified): 203→1003 protein, 208→1008 energy, 291→1079 fiber, 301→1087 calcium,
307→1093 sodium, 317→1103 selenium, 418→1178 B12, 435→1190 folate DFE, 601→1253 cholesterol,
618→1269 PUFA 18:2, 619→1270 PUFA 18:3.

### What FNDDS does and does not have

Once translated, FNDDS is the **most consistently covered** dataset: 65 nutrients on
5,431 of 5,432 foods (only "Milk, human", fdcId 2705383, has no rows at all). That matters because
FNDDS is the "as consumed" mixed-dish data users log from most.

Genuine gaps, not artifacts of the id trap:

- **Trans fat (nbr 605 / id 1257) is entirely absent** from FNDDS.
- FNDDS carries only the **undifferentiated** 18:2 (1269) and 18:3 (1270), never LA (1316) or
  ALA (1404). Combined with the finding below that 1270 is not a reliable proxy for ALA, omega-3
  reporting on FNDDS foods is approximate at best and must be labelled as such.

## Never coalesce competing nutrient ids (measured)

FDC carries multiple ids for the same concept. They are different measurement methods, not
duplicates, and they disagree enormously. Measured on Foundation Foods 2026-04-30:

| Concept | ids | Foods with both | Worst disagreement |
|---|---|---:|---|
| Energy | 1008 vs 2047 (Atwater General) | 104 | Broccoli, raw: 31 → 39 kcal (**+25.8%**) |
| Fiber | 1079 vs 2033 (AOAC 2011.25) | 19 | White rice, raw: 0.149 → 2.771 g (**+1762%**) |
| Carbohydrate | 1005 (by difference) vs 1050 (by summation) | 47 | Soy milk: 1.293 → 0 g (**−100%**) |
| ALA | 1404 vs 1270 (18:3 undifferentiated) | 1,963 | 24 foods have ALA > total 18:3 |

Three consequences:

1. **Resolve through an explicit, ordered fallback chain and record which id was used.** Never
   average, never `COALESCE` blindly across ids.
2. **1270 is not a safe upper bound for ALA.** ALA is chemically a subset of total 18:3, yet 24 of
   1,963 SR Legacy foods report ALA *greater* than the total — so the data itself is inconsistent
   and clamping logic must handle it rather than assuming the containment holds.
3. **The carbohydrate case is itself a fake zero.** Nutrient 1050 is `0` for soy and almond milk,
   which means "not summable from components", not "contains no carbohydrate". Treating a 1050
   zero as a real measurement would report unsweetened soy milk as carbohydrate-free.

## Proxy values that look like measurements

USDA has **no independently measured ghee**. Its `Ghee, clarified butter` entry (2710168) is
**85% value-identical to `Butter oil, anhydrous` (173412)** across the 60 nutrients they share —
it is derived from that anhydrous-milk-fat profile rather than measured. A third row,
`Butter, Clarified butter (ghee)` (171314), is an older, sparser record carrying only 18
nutrients and different values again (900 kcal vs 876, 100 g fat vs 99.48).

These are not the same food. Traditional ghee — particularly the bilona method — cultures milk
into curd, churns that to makkhan, and simmers it until the milk solids brown before straining.
Clarified butter omits both the culturing and the browning. Anhydrous milk fat is an industrial
concentrate of cream that never goes through the ghee process at all. Any difference the
fermentation or the Maillard browning makes to the fatty-acid detail is invisible here, because
the underlying measurement is of neither product.

The rule this establishes: **an alias must resolve to the food actually searched for, and a proxy
must be labelled as a proxy.** Silently resolving one food to a compositionally similar different
food is the same class of error as rendering missing data as zero.

## Corrections applied

These were caught by an adversarial verification pass and are recorded so the errors are
not reintroduced:

- **Foundation energy coverage.** An earlier revision of this document reported "energy
  for just 24.1% of Foundation foods" as evidence the dataset was thin. That measured
  nutrient id 1008 in isolation; true coverage across the Atwater ids is 81.8%. The
  conclusion that Foundation is small stands on its food count (395), not on energy.
- **Foundation `derivation_id` is not blank.** An earlier claim that all 17,008 Foundation
  rows lacked provenance is false; the field is populated on all but 422 rows.
- **Vitamin A UL applies to preformed retinol only** (3,000 mcg/day), not to total RAE.
  Comparing FDC "Vitamin A, RAE" against that UL produces false toxicity warnings for
  people eating carrots. The same footnote restriction applies to the folate UL (folic
  acid only), niacin and vitamin E (synthetic forms only), and magnesium (supplemental
  only).
- **Chromium and biotin have AIs, not RDAs** (chromium 35/25 mcg, biotin 30 mcg for
  adults). The UI must not label an AI as an RDA.
- **Nutrient name changes run the opposite direction** from what was first recorded:
  SR Legacy 2018 id 1063 is "Sugars, Total NLEA" and becomes "Sugars, Total" in
  Foundation 2026, not the reverse.
- **"Ghee is chemically identical to butter oil, anhydrous."** Wrong, and corrected after the
  user pushed back. They are different products made by different processes; USDA simply has no
  measured ghee and reuses the milk-fat profile for it. The search alias now resolves to an entry
  actually named ghee and carries a note that the numbers are a proxy.
