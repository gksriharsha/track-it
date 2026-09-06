> Produced by an adversarially fact-checked research pass on 2026-09-04, then spot-verified
> against the bundled database. The headline finding — that urad dal, drumstick and semolina
> are all already present in USDA under non-obvious names — was confirmed directly.

# Extending TrackIt with Indian Vegetarian Food Data

**Status:** plan, ready to implement. Every quantitative claim below was measured against `/Users/kgundu1/BioBalance/data/raw/extracted/` in this session, or carries a citation. Where a number could not be sourced it is marked **unavailable** rather than estimated.

**Date:** 2026-09-04. Licensing statements were re-verified against primary sources by the upstream research and are flagged where they remain unresolved.

---

## 0. Corrections to the incoming research that change the plan

Five findings I verified myself contradict the research tracks. They change what gets built, so they come first.

| # | Claim in research | Measured reality | Consequence |
|---|---|---|---|
| **C1** | "URAD DAL / BLACK GRAM IS ABSENT — `urad` and `black gram` both return 0" | **Urad dal is present.** SR Legacy carries *Vigna mungo* under its USDA name **"Mungo beans"**: `174259` raw (61 nutrients), `172427` cooked, boiled, without salt (**90 nutrients**), `175256` cooked with salt. `1 cup raw = 207 g`. | Idli, dosa, vada, medu vada, papad and dal makhani can all be built correctly from USDA data today. The single largest claimed gap does not exist — the search used the wrong lexeme. |
| **C2** | Drumstick/moringa listed as a gap ("no moringa") | **Present.** `168416` Drumstick leaves, raw (54 nutrients); `168417` Drumstick leaves, cooked, boiled, drained, without salt (**90**); `168532` Drumstick pods, cooked, with salt (36). `1 cup chopped leaves = 21 g`. | Sambar and South Indian greens are buildable. |
| **C3** | "semolina/rava exists only as Cream of Wheat" | **Refuted** (already corrected upstream, confirmed here): `168933` Semolina, unenriched (76 nutrients), `169715` Semolina, enriched (77). `1 cup = 167 g`. | Never use Cream of Wheat (`SR 8102`, fortified US cereal) for rava. FNDDS's own Upma recipe does exactly this — 175 g of it — and is disqualified on that basis. |
| **C4** | FNDDS `input_food` treated as a rollup source | **`input_food` gram weights are raw recipe weights at an arbitrary batch scale, not per-100 g.** Measured: *Dosa, plain* (`2708347`) sums to **1526.5 g** (711 g water + 555 g raw rice + 192 g raw lentils + 56 g oil + 12 g salt). *Vada* sums to 750.3 g, *Upma* 1240.6 g, *Pakora* 625.7 g. But *Chutney*, *Curry sauce* and *Vegetables as ingredient in curry* sum to exactly 100.0 g, and *Dal* to 100.8 g. | `input_food` is a **provenance and display** structure, not an arithmetic one. Normalising it by dividing by the ingredient sum is wrong for the dishes that lose the most water. Use it to *show* ingredients and to *seed* a recipe; never to recompute a FNDDS food's own nutrient values. |
| **C5** | `retention_factor.csv` in SR Legacy "covers fewer codes than the INDB copy" | **270 codes, same as INDB's file, but it carries no percentages at all.** Header is exactly `id,code,food_group_id,description`. | The local file is a code *dictionary*. The retention *values* must come from USDA's published Release 6 table, obtained separately. Do not plan around the bundled file as a values source. |

Net effect: **the USDA-only path is substantially stronger than the research concluded, and the licence-encumbered path is correspondingly less necessary.**

---

## 1. Sources, in priority order, with licensing stated plainly

### Tier 1 — ships in `usda_core.db` (already bundled, CC0)

**USDA FoodData Central**: Foundation 2026-04-30, SR Legacy 2018-04, FNDDS 2021-2023 (2024-10-31), plus the USDA/ARS Iodine Database Release 4 overlay. Public domain, CC0 1.0, no permission required, attribution requested. This is the entire nutrient substrate and it does not change.

What it actually supplies for an Indian vegetarian kitchen — measured nutrient counts per food:

| Ingredient | fdc_id | Nutrients | Note |
|---|---|---:|---|
| Lentils (masoor), raw / boiled | 172420 / 172421 | 104 / 90 | complete micronutrient panel |
| Mung beans (moong), raw / boiled | 174256 / 174257 | 91 / 90 | |
| **Mungo beans (urad/black gram), raw / boiled** | **174259 / 172427** | **61 / 90** | **C1 — cooked entry is full-depth** |
| Pigeon peas (toor/arhar), raw / boiled | 172436 / 172437 | 62 / 62 | thin: no vit E, K, choline |
| Chickpeas (chana), raw / boiled | 173756 / 173757 | 90 / 90 | |
| Lentils, pink/red (masoor dal), raw | 174284 | 79 | no E, K, choline |
| Kidney beans (rajma), raw / boiled | 175193 / 173740 | 86 / 98 | |
| Cowpeas (lobia), raw / boiled | 173758 / 173759 | — | present |
| Chickpea flour (besan) | 174288 | 70 | 1 cup = 92 g |
| Wheat flour, whole-grain (atta) | 168893 | 114 | 1 cup = 120 g |
| Semolina, unenriched (rava) | 168933 | 76 | 1 cup = 167 g |
| Rice, white long-grain, raw | 168877 | 95 | 1 cup = 185 g |
| Millet flour / Sorghum flour (bajra/jowar) | 172023 / 168943 | 115 / 118 | no D, B12, choline |
| Amaranth grain (rajgira) | 170682 | 108 | |
| Butter oil, anhydrous (**use this for ghee**) | 173412 | 91 | 1 tbsp = 12.8 g |
| Butter, Clarified butter (ghee) | 171314 | **18** | **too thin — do not use** |
| Milk, whole 3.25% / Milk, indian buffalo | 171265 / 171280 | 113 / 66 | |
| Yogurt, plain, whole milk (dahi) | 171284 | 91 | 1 cup = 245 g |
| Cottage cheese, creamed | 172179 | 110 | *not* paneer — see §6 |
| Spinach (palak), raw | 168462 | 105 | 1 cup = 30 g |
| **Drumstick leaves, raw / boiled** | **168416 / 168417** | **54 / 90** | **C2** |
| Tamarind, raw | 167763 | 74 | 1 cup pulp = 120 g |
| Coconut meat, raw | 170169 | 95 | 1 cup shredded = 80 g |
| Okra (bhindi), raw | 169260 | 105 | 1 cup = 100 g |
| Eggplant (baingan), raw / boiled | 169228 / 169229 | 94 / 90 | |
| Bottle gourd (lauki/calabash), raw | 169232 | 55 | no A, E, K, choline |
| Bitter gourd (karela), boiled | 168394 | 72 | |
| Amaranth leaves (chaulai), raw | 168385 | 63 | |
| Mustard greens (sarson), raw | 169256 | 71 | |
| Onion / Tomato / Garlic / Ginger | 170000 / 170457 / 169230 / 169231 | 118 / 108 / 90 / 91 | |
| Turmeric / Chilli powder / Cumin seed / Coriander seed / Mustard seed / Fenugreek | 172231 / 171319 / 170923 / 170922 / 170929 / 171324 | 123 / 124 / 71 / 43 / 121 / 55 | |
| Salt, table | 173468 | 92 | the iodine-overlay caveat, §6 |
| Papad | 168106 | 100 | |

### Tier 2 — build-time, not bundled: INDB recipe structures

**Indian Nutrient Databank** (Jaacks et al., *Curr Dev Nutr* 8:103790, 2024; `github.com/lindsayjaacks/Indian-Nutrient-Databank-INDB-`).

Licence status, stated plainly: **the GitHub repository has no LICENSE file.** The GitHub API returns `license: null`. The *journal article* is CC BY 4.0; that does not travel to a separately hosted dataset. Additionally ~866 of the 1,014 recipes are transcribed from two in-copyright textbooks (*The Art & Science of Cooking* 5th ed. 2007; *Basic Food Preparation* 4th ed. 2011). And the released `INDB.xlsx` contains **only the 1,014 recipes** — the 1,095-item ingredient composition table is *not* distributed, because it derives from IFCT and the README says IFCT "must be requested from the original source."

**Therefore: use INDB for recipe *structure* only — which ingredients, in what proportions — and never for its nutrient values.** Ingredient lists and quantities are closer to uncopyrightable fact than the compiled nutrient tables are; the nutrient numbers come from TrackIt's own USDA rollup regardless, so INDB's per-100 g and per-serving columns are never read. Treat INDB as a *reference to consult at authoring time*, cite it, and do not vendor `recipes.xlsx` into the repo until the authors add an explicit licence. Email them; it is one message and it settles this.

I did not verify any INDB gram weight in this session. Every INDB-derived quantity in §4 is therefore marked **must be read from the file at authoring time**, not asserted here.

### Tier 3 — do not bundle: IFCT 2017

**ICMR-NIN Indian Food Composition Tables 2017.** The copyright page (p. ii of `nin.res.in/ebooks/IFCT2017.pdf`) reads, verbatim:

> "The use and dissemination of the data in this book is encouraged. This publication can be reproduced for personal use with full acknowledgment of the source. However, no part of this publication can be stored or reproduced in any electronic format for creating a product without the prior written permission of the National Institute of Nutrition, Hyderabad."

**IFCT cannot lawfully be bundled into a distributable TrackIt.** Bundling into `usda_core.db` is literally "stored ... in electronic format for creating a product." A strictly private, never-shared personal build is plausibly inside the "personal use" grant, but that is a judgement call, not a clearance, and it detonates the moment the app is shared, open-sourced, or handed to a family member. The PDF is additionally AES-128 encrypted with `/P -3388` — text extraction explicitly denied.

**IFCT also does not contain what the user asked for.** From the Preface: *"Except for eggs, all other food component data are for foods in the raw form."* No cooked foods, no composite dishes, no serving sizes, no household measures, no refuse factors. It is an ingredient table, not a dish table.

**The best lawful alternative is the plan in this document: build Indian dishes as recipes over CC0 USDA ingredients.** That path is fully unencumbered, ships today, and — per C1/C2/C3 — covers far more of the Indian vegetarian pantry than the research assumed.

If IFCT's Indian-specific values are wanted later (regional dals, millets, Indian dairy at IFCT granularity), the legitimate route is a single email to `ifct2017@gmail.com` / `nin@ap.nic.in` asking for **both** (a) written permission for a non-commercial personal nutrition application and (b) the electronic region-specific database that IFCT's own General Information says NIN supplies on request. Until that returns, architect IFCT as a **separable overlay excluded from distributable builds by configuration** — the same pattern already used for the ARS iodine overlay — so the licence answer never forces a rewrite.

Route the distribution question to ASU counsel or the appropriate data steward before any release. This section is not legal advice.

### Tier 4 — explicitly rejected

- **`nodef/ifct2017` / `@ifct2017/compositions` / npm / Kaggle mirrors.** Third parties asserting MIT or AGPL over data they do not own — the grant conveys nothing. Independently, the package encodes missing data as literal `0`: *Palm fruit, tender* has calcium, iron, phosphorus and magnesium all exactly `0`, and all 14 edible oils and fats including **ghee** read zero calcium. Under TrackIt's model those become `MeasuredZero` when they are `BelowLoq`/`Absent`. A full row-comparison also found `L003 Paneer` with fat 14.78 where the NIN PDF reads 24.78 — a 40 % understatement in a staple vegetarian food, internally self-consistent enough that no sanity check would catch it. **Leave a named note in the repo warning future contributors off this package**; it is one `npm install` away and looks perfect.
- **Open Food Facts as a micronutrient source.** On a random live sample of 57 Indian food products, **0 of 57 carried any micronutrient value**; only 10 of 57 had a serving size; 10 % of India-tagged records were non-food and 6.5 % were cosmetics. It is a barcode-to-macros lookup, nothing more. Its ODbL share-alike would also contaminate the bundled file — which is exactly why the existing architecture already quarantines it in `cached_foods` inside `user.db` with a `licence` column as the export filter key. Keep it there.
- **Kaggle "Indian food nutrition" datasets** and scraped recipe corpora. Where they contain real data it is INDB with provenance stripped; one states in its own description that it "must not be used as a medical, clinical, or commercial nutrition reference."
- **OCR of the Pakistan FCT** (verified: 73 CCITTFax image streams, `/Font` count = 0 — pure bitmap). A misread decimal in a mineral column produces a value wrong by 10× carrying no signal that it is wrong.
- **`ifct2017.com` and `ninindia.org`.** Both URLs printed on IFCT's own copyright page now serve non-NIN content — `ifct2017.com` redirects through a chain to an unrelated anime site; `ninindia.org` is a GoDaddy parking lander. Purge both from any code, docs, comment or citation string. Cite `www.nin.res.in`. Note `ifct2017.github.io` is also not NIN despite the name.

---

## 2. The vegetarian classification scheme

### 2.1 Classes

Two axes, not one ordered scale.

**Axis 1 — diet class (mutually exclusive, stored per food):**

| Class | Meaning |
|---|---|
| `non_vegetarian` | Contains animal flesh, or a flesh/gelatin/rennet derivative |
| `contains_egg` | Vegetarian except for egg |
| `lacto_vegetarian` | Contains dairy, no egg, no flesh |
| `plant_only` | No animal term detected **and** the source has ingredient-level evidence |
| `uncertain` | The source cannot answer |

**Axis 2 — independent boolean flags that never change Axis 1:** `contains_honey`, `contains_allium`, `contains_root_vegetable`, plus `classification_evidence` (`category` | `description` | `ingredients` | `ontology` | `override`).

**Why egg gets its own class, with a citation.** India's own regulator draws exactly this line. Food Safety and Standards (Labelling and Display) Regulations 2020, reg. 2(1)(o): *"Non-vegetarian food means an article of food which contains whole or part of any animal including birds, insects, fresh water or marine animals or eggs or products of any animal origin, but does not include milk, milk products, honey or bees wax or carnauba wax or shellac."* Reg. 5(4)(a) adds a proviso letting a manufacturer declare separately *"where any article of food contains egg only as Non-Vegetarian ingredient"* — Indian law itself treats egg-only as a distinguishable sub-case.

Three consequences that fall straight out of that text and must be implemented as written:
1. **Honey is vegetarian.** It must never demote a food out of the vegetarian classes. It is Axis 2 only.
2. **Insects are non-vegetarian** → carmine/cochineal is non-vegetarian.
3. **Shellac is vegetarian under FSSAI** even though it is insect-derived — the opposite of most Western vegan lists. The app must not silently resolve this; state the definition on a "how we classify" screen.

Note the class is named `plant_only`, **not** `vegan`. It is computed as absence of evidence, and it is not defensible for SR Legacy composites (§2.4). Do not ship a "vegan" badge in v1.

### 2.2 How each food gets classified, per source

The signal quality differs enormously by source. Use the best each one actually has, and record which one fired.

**FNDDS — ingredients primary.** `input_food.csv` covers **5,431 of 5,432** foods (measured; the sole exception is *Milk, human*, `2705383`), with `sr_description` populated on all **18,584** rows. This is by far the strongest signal in the bundle.

Also fix the join, which is a documented trap: **FNDDS `food.csv.food_category_id` is fully populated but holds the 4-digit WWEIA number, not an FDC `food_category` id.** WWEIA codes run 1002–9999; FDC categories run 1–28. Joining to `food_category.csv` yields **zero rows and no error**. The correct path is `food.fdc_id → survey_fndds_food.fdc_id → wweia_category_number → wweia_food_category`.

The parallel trap in the same dataset, already documented in `architecture-data.md` §2.3 and re-confirmed here: **FNDDS `food_nutrient.nutrient_id` references `nutrient.nutrient_nbr` (200/300/400-series), not `nutrient.id` (1000-series).** I verified `301` present and `1087` absent in the FNDDS distinct-id set. Any rollup that joins on `nutrient.id` returns zero rows silently.

**SR Legacy and Foundation — category, then description.** `food_category.csv` is byte-identical in both drops. Six categories are unambiguously non-vegetarian: **5** Poultry, **7** Sausages and Luncheon Meats, **10** Pork, **13** Beef, **15** Finfish and Shellfish, **17** Lamb/Veal/Game. Measured: **2,568** SR Legacy foods and **84** Foundation foods (over the 469-row `data_type='foundation_food'` set the build actually ingests). Category **1** Dairy *and* Egg Products is mixed — 291 SR, 50 Foundation — and must never be treated as one class; it is precisely where the lacto/ovo boundary lives.

**Foundation additionally has an ontology signal no other source has.** `food_attribute.csv` carries paired `NCBI Taxon Parent` and `Ontology Name For Source` attributes for 363 of 395 foundation foods. `NCBI Taxon Parent` takes exactly four values with no food carrying more than one: Streptophyta 239, Metazoa 107, Fungi 11, NA 6. Taxon alone is *not* a vegetarian signal — cheddar and ground beef are both *Bos taurus* — but the sibling `Ontology Name For Source` separates `dairy food product` (20) and `milk or milk based food product` (13) and `chicken egg food product` (9) from `beef food product` (15), `fish food product` (18), `swine food product` (10), etc. Use the source ontology, not the taxon.

Correction to fold in: the 32 Foundation foods with no ontology term are **not** all composites — they include *Grapefruit, raw*, *Rhubarb, stalk, raw*, *Raisins, dark, seedless*, *Edamame, frozen, prepared*. Do not blanket-bias them to `uncertain`; fall through to description first.

### 2.3 The measured result

I ran the classifier described above and got these counts. The script is at `/private/tmp/claude-503/-Users-kgundu1-BioBalance/4d105f95-b676-40a9-9715-8e1333bdfbb7/scratchpad/classify.py` — **check it into the repo alongside the numbers so the figures are auditable.** Publishing counts without the regex is not reproducible.

| Class | Total | SR Legacy | FNDDS | Foundation |
|---|---:|---:|---:|---:|
| `non_vegetarian` | **5,260** | 3,225 | 1,940 | 95 |
| `no_animal_term` → `plant_only`/`uncertain` | **6,305** | 3,743 | 2,243 | 319 |
| `lacto_vegetarian` | **1,707** | 741 | 921 | 45 |
| `contains_egg` | **422** | 84 | 328 | 10 |
| **Total** | **13,694** | 7,793 | 5,432 | 469 |

The two numbers that justify the whole design:

- **200 FNDDS foods are non-vegetarian and invisible to *both* the WWEIA category *and* the food description** — caught only by tracing ingredients. Real measured cases, with the flesh share of recipe grams:

  | Share | Food | Offending ingredient |
  |---:|---|---|
  | 0.9 % | Tortellini, spinach-filled, with tomato sauce | Mortadella, beef, pork |
  | 0.9 % | Rice dressing | Soup, beef broth or bouillon, powder |
  | 1.0 % | Michelada | Sauce, worcestershire |
  | 1.8 % | Bloody Mary | Sauce, worcestershire |
  | 3.1 % | Greek Salad, no dressing | Fish, anchovy, european, canned in oil |
  | 3.2 % | **Pad Thai, meatless** | Sauce, fish, ready-to-serve |
  | 4.9 % | Potato salad, German style | Pork, cured, bacon |
  | 6.8 % | Spinach salad, no dressing | Pork, cured, bacon |

  Note `Pad Thai, meatless` — USDA's own name contradicts USDA's own recipe. The recipe is the more specific claim and the safer one for a dietary filter.

- **175 FNDDS foods contain egg with no hint in the name.** Measured examples: *Onion dip, regular / light*, *Ranch dip*, *Spinach dip*, *Chipotle dip*, *Vegetable dip* (all via mayonnaise), plus pancakes, muffins, custard, flan, brioche. For a lacto-vegetarian this is the failure that matters, and it is silent.

### 2.4 The rule that must not be broken

**SR Legacy has no `input_food.csv`.** I confirmed the directory listing: `food.csv, food_attribute.csv, food_category.csv, food_nutrient.csv, ... retention_factor.csv, sr_legacy_food.csv` — no ingredient table exists. Its `food_attribute.csv` is 1,074 rows, all type 1000 "Common Name."

So for SR Legacy composites, description is the only signal, and it is systematically silent: 85 % of Baked Products, 89 % of Breakfast Cereals and 94 % of Cereal Grains and Pasta mention neither egg nor dairy. *"Waffle, plain, frozen, ready-to-heat, microwave"* would classify `plant_only`.

> **Rule: never assert `plant_only` or `lacto_vegetarian` for an SR Legacy food in a multi-ingredient category** (Baked Products, Sweets, Beverages, Baby Foods, Fast Foods, Soups/Sauces/Gravies, Breakfast Cereals, Snacks, American Indian, Restaurant Foods, Meals/Entrees — ~3,045 foods). The honest output is `uncertain`: *"vegetarian; egg and dairy content unknown."*

### 2.5 How `uncertain` behaves in the UI

This reuses the discipline the nutrient model already has. `architecture-data.md` §3.4 renders three visually distinct things because `—`, `<0.4 mg` and `0 mg` mean three different things. Classification gets the same treatment.

| State | Filter behaviour | Badge |
|---|---|---|
| `plant_only` / `lacto_vegetarian` | shown | green leaf |
| `contains_egg` | shown, but **only when the profile's diet is ovo-lacto**; otherwise treated as excluded-but-visible | egg glyph |
| `uncertain` | **shown, and badged amber: "may contain animal ingredients"** | amber `?` |
| `non_vegetarian` | hidden by default, one tap to reveal | — |

**`uncertain` fails safe by being *visible and marked*, never by being hidden.** Hiding it teaches the user the filter is exhaustive, which is the exact false confidence that makes a later miss harmful. Showing it unmarked is worse. This is the same reasoning that gives `Absent` an em dash and no bar track rather than an empty bar that reads as 0 %.

**Surface the evidence, not just the verdict.** Because `input_food` carries gram weights, the app can say *"flagged non-vegetarian: chicken gravy, 20 % of recipe weight"* or *"contains egg: whole egg, 8 g."* That converts an unauditable label into an auditable one.

**Never delete meat foods from the database.** Three reasons: FNDDS composites reference SR Legacy meat foods as ingredients, so deleting them breaks the base-ingredient display the user explicitly asked for; 5,260 rows would be destroyed and no later classifier fix could resurrect them; and the user may need to log a dish for a family member. Filter, don't delete.

### 2.6 SQL / Python approach

Classification is **derived at build time** in `build-reference-db` and stored as a column. It is not computed at query time and not computed in TypeScript.

```sql
ALTER TABLE ref_foods ADD COLUMN diet_class TEXT NOT NULL DEFAULT 'uncertain'
  CHECK (diet_class IN ('non_vegetarian','contains_egg','lacto_vegetarian','plant_only','uncertain'));
ALTER TABLE ref_foods ADD COLUMN diet_evidence TEXT NOT NULL DEFAULT 'none'
  CHECK (diet_evidence IN ('none','category','description','ingredients','ontology','override'));
ALTER TABLE ref_foods ADD COLUMN contains_egg     INTEGER NOT NULL DEFAULT 0 CHECK (contains_egg IN (0,1));
ALTER TABLE ref_foods ADD COLUMN contains_dairy   INTEGER NOT NULL DEFAULT 0 CHECK (contains_dairy IN (0,1));
ALTER TABLE ref_foods ADD COLUMN contains_honey   INTEGER NOT NULL DEFAULT 0 CHECK (contains_honey IN (0,1));
ALTER TABLE ref_foods ADD COLUMN contains_allium  INTEGER NOT NULL DEFAULT 0 CHECK (contains_allium IN (0,1));

CREATE INDEX ref_foods_diet ON ref_foods(diet_class);
```

The pipeline, in order — **the ingredient lexicon is the whole design**:

1. **Build the lexicon over the 2,333 distinct `sr_description` strings**, not over 13,694 food names. Measured: `input_food.csv` contains exactly **2,333** distinct ingredient descriptions. That set is small enough to classify exhaustively by hand, is stable across FNDDS releases, and collapses the entire false-positive problem into one auditable, checked-in table with a `source` column. A wrong call becomes a one-line data fix, not a regex change with unknown blast radius.
2. **Hard exclusions by category** for SR/Foundation (categories 5, 7, 10, 13, 15, 17). Near-zero false positives — only ~6 SR and ~4 Foundation foods are mis-flagged this way. The problem with a category-only rule is the *other* direction: it misses 725 non-vegetarian FNDDS foods and 604 SR Legacy ones, and the failures are all in the unflagged set that nobody spot-checks.
3. **Ingredient trace for FNDDS**, recursing 3–4 levels. Nesting is real and shallow — measured: `Vegetable curry` (`2710067`) = 60 g `Vegetables as ingredient in curry` + 40 g `Curry sauce` + 2 g oil + 0.6 g salt, and `Vegetables as ingredient in curry` (`2710810`) itself expands to 8 vegetables.
4. **Ontology for Foundation**, then description, then `uncertain`.
5. **Curated override table**, applied last, for what the data structurally cannot answer.
6. **Assert the class counts in `assertions.toml`** so a future USDA release forces a visible re-review rather than silently shifting labels.

**The false-friend list is mandatory and must be unit-tested.** My own run produced two false positives that are instructive: *Soup, minestrone* flagged on `Beans, kidney, red, mature seeds` (my `kidney(?!\\s+bean)` lookahead does not match USDA's inverted `Beans, kidney` word order), and *Curry sauce* flagged at 7.0 % on `Nuts, coconut milk, raw (liquid expressed from grated meat and water)` — the word "meat" in a plant food. Eight FNDDS foods carry a coconut-meat ingredient. The confirmed exclusion list: `coconut meat`, `animal crackers`, `oyster crackers`, `oyster mushroom`, `vegetable oyster`/`salsify`, `Beans, kidney` (any word order), `hearts of palm`, `artichoke hearts`, `eggplant`, `egg substitute`, `peanut/almond/cocoa/apple/shea butter`, `butter bean`, `butternut`, `Cream of Wheat`, `cream of tartar`, `crabapple`, `honeydew`, `Sauce, duck` (contains no duck), `graham`, `hamburger bun`, and the negations `meatless`, `vegetarian`, `no meat`, `without meat`, `imitation`, `mock`, `vegetable broth/stock/gravy`.

**Curated overrides needed at minimum** (each `uncertain` by default, not guessed):
- **Cheese rennet is recorded nowhere in FDC** — not in description, `food_attribute`, `input_food`, or the FoodOn attributes. For Parmigiano Reggiano the PDO production specification mandates coagulation *"obtained exclusively by the use of calf rennet"*, so `Cheese, parmesan, hard` cannot honestly be labelled lacto-vegetarian. Foundation alone holds **19** cheese foods including provolone and swiss, not the 4 the research listed. Treat named traditional varieties as `uncertain` pending per-variety verification.
- **Gelatin in confectionery**: 139 of 142 SR Legacy candy foods never mention gelatin or marshmallow, and SR carries no ingredient statement for any of them.
- `Refried beans, canned (pinto)` (Foundation) — a sibling `...vegetarian` row implies but does not state lard. Its `market_acquisition.csv` rows do carry `brand_description` and `upc_code` for all six source samples (Old El Paso, Rosarita, La Preferida, Great Value, Safeway, Kroger), which is an in-dataset path to resolving it by UPC lookup.
- Caesar dressing (anchovy), kimchi (jeotgal), `Soup, broth` (species unstated), `Gravy, made with soy sauce`, `White sauce or gravy`.
- The two USDA self-contradictions: `Wonton, dumpling or pot sticker, fried, no meat` (95.2 % pork potsticker input) and `Pad Thai, meatless` (fish sauce).

**Jain / allium flagging: FNDDS only, positive assertions only.** 485 FNDDS foods carry an onion-family or garlic ingredient; only 43 mention it in the name, so 444 would be missed by description. But SR Legacy has no ingredient table and only ~58 of 7,793 descriptions mention allium — **"no onion/garlic" is unknowable for the other 7,735 and must never be displayed.** Label the feature *"contains onion/garlic per USDA recipe"*, never *"Jain-friendly"*, and note that practice varies on ginger and root vegetables.

**Structurally unanswerable in all three sources, at any confidence** — say so in the UI rather than pretending: animal rennet, gelatin in unlabelled confectionery, bone-char-filtered sugar, isinglass-fined beer and wine, L-cysteine in commercial bread, animal-source mono- and diglycerides, lanolin-derived vitamin D3 in fortified milk, and "natural flavors." The classification therefore carries a **systematic optimistic bias for processed foods** that no amount of better rule-writing removes.

---

## 3. The recipe model for Indian dishes

### 3.1 The existing schema is already right

`user.db` already has `recipes` (with `yield_grams`, `yield_servings`, `cook_method`) and `recipe_items` (polymorphic `component_kind` over `usda`/`cached`/`custom`/`recipe`, with `grams`). The additions in §5 are small. The hard part is already decided, and `architecture-data.md` §3.3 already states the governing rule:

> **Recipes never launder unknowns.** A recipe's rolled-up value for nutrient *n* is `Absent` unless **every** ingredient contributed a value for *n*. Eight known ingredients and one unknown produce `Absent`, not a confident sum.

That rule is correct and non-negotiable. §3.4 below strengthens it slightly for the interval case.

### 3.2 Log by serving mass, not by cooked-weight × per-100 g

This is the single most important structural decision, and it follows from C4 plus a fact about Indian dietary guidance.

**ICMR-NIN's entire diet-planning apparatus is raw-weight.** Every diet chart in *Dietary Guidelines for Indians* (2024) carries the note *"Quantities indicated are for raw ingredients"* (printed pp. 103–104), and Annexure II is headed *"Raw food item measures using household utensils"* with a column literally titled "Raw weight (g)." The balanced-diet table (Annexure V) is all raw: sedentary man 55 kg = cereals/millets 230 g, pulses 75 g, GLV 100 g, vegetables 200 g, roots/tubers 100 g, fruits 100 g, nuts 30 g, milk 300 ml, fats 30 g.

Storing recipes as raw-ingredient quantities and deriving the serving therefore keeps the user's totals directly comparable to the Indian national guideline they will actually be measured against. It also sidesteps the yield problem for the common case, because **nutrient mass is approximately conserved through cooking** (modulo retention losses), while nutrient *concentration* is not.

So: `log_entries.grams` for a recipe entry means grams of the **served portion**, and the rollup computes that portion's share of the recipe's total nutrient mass — never `cooked_weight × per_100g_of_something`.

### 3.3 Cooking yield, stated as an interval because the sources disagree

Yield factor = cooked mass ÷ raw mass. It is needed only to convert "I ate 200 g of cooked dal" back to a share of the raw ingredients.

**No published ICMR-NIN cooking-yield table exists.** The research searched the full 148-page DGI 2024 for retention, yield, cooking loss and leaching and found none. This is marked **unavailable**; the brief's premise that NIN publishes one is not supported.

Two USDA-derived methods, which **disagree by up to 22 %**:

| Pulse | Dry-matter method¹ | USDA empirical² |
|---|---:|---:|
| Lentil (masoor) | 3.02× | 2.47× |
| Mung (moong) | 3.33× | 2.54× |
| Mungo (urad) | 3.24× | 2.54× |
| Pigeon pea (toor) | 2.84× | 2.47× |
| Chickpea (chana) | 2.32× | 2.47× |
| Kidney bean (rajma) | 2.67× | 2.47× |
| Cowpea (lobia) | 2.94× | 2.47× |
| Rice, white long-grain | 2.80× | — |
| Rice, brown long-grain | 2.97× | — |

¹ Assumes solids are conserved: `(100 − water_raw) / (100 − water_cooked)` from SR Legacy nutrient 1051.
² USDA FNDDS `food_portion.csv`, portion `"1 oz dry, yield after cooking"`: **70.0 g** per 28.35 g dry for legumes with no added fat (= 2.47×), **72.0 g** with fat added (= 2.54×). Note this is one generic convention applied uniformly across species, not a species-specific measurement.

A protein-based derivation for lentils gives 2.73× and an iron-based one gives 1.96×, the spread reflecting differential leaching. **The sources genuinely do not agree, and picking a point estimate would manufacture precision.**

> **Design decision: `yield_factor` is stored as an interval `[lower, upper]` and routed into the existing `[lower, upper]` machinery, exactly as nutrient values are.** For dry pulses: `[2.3, 3.3]` with 2.47× as the display point estimate and a low-confidence marker. For rice: 2.80× (white) / 2.97× (brown), where two independent methods agree closely. A recipe with an unbounded yield contributes `Upper::AtLeast` to the day, which is already what `DailyNutrient` does for an absent value.

Nutrient **retention** (cooking loss) is separate from yield and is applied per nutrient per method. USDA's *Table of Nutrient Retention Factors, Release 6* (2007) maps cleanly onto Indian technique — 501/502 legumes boiled drained vs water used, 521/522 for 45/75 min, 541/542 for 2/2.5 hr, 505 legumes fried, 550 legumes reheated, 431/432 rice drained vs water-used, 433 rice sautéed-then-simmered (pulao/biryani), 306 flour toasted (chapati on a tawa — FNDDS itself assigns 306 to *Bread, chappatti or roti*), 3460/3465 roots sautéed/stir-fried, 3004/3006 greens boiled. The drained-vs-water-used distinction alone moves folate by ~10 percentage points and is exactly the South Indian drained-rice vs absorption-method distinction.

**But (C5) the bundled `retention_factor.csv` has no percentages** — 270 codes, columns `id, code, food_group_id, description` only. The values must be obtained from USDA's published Release 6 table and vendored separately. Until they are, `cook_method` is stored and displayed but **no retention adjustment is applied**, and the recipe is marked as such. Applying no retention is a known, disclosed overstatement of water-soluble vitamins; applying a guessed retention is fabrication.

### 3.4 How provenance survives the rollup

The rollup is per nutrient, over the recipe's items. Let item *i* contribute `grams_i` and a `NutrientValue`.

```rust
// Roll one nutrient across a recipe's items.
// Returns the recipe's NutrientValue on a per-100g-of-recipe basis.
fn roll_up(items: &[(f64 /*grams*/, Option<NutrientValue>)]) -> NutrientValue {
    // RULE 1 — no laundering. One missing contributor makes the whole thing Absent.
    if items.iter().any(|(_, v)| v.is_none()) {
        return NutrientValue::Absent;
    }
    let mut lower = 0.0;
    let mut upper = 0.0;
    let mut any_censored = false;      // below_loq | label_zero | trace present
    let mut all_assumed_zero = true;
    let mut worst: Derivation = Derivation::Measured;

    for (g, v) in items {
        let v = v.unwrap();
        let f = g / 100.0;
        lower += v.lower() * f;
        upper += v.upper() * f;
        match v {
            NutrientValue::BelowLoq{..} | NutrientValue::LabelZero{..} | NutrientValue::Trace{..} =>
                any_censored = true,
            NutrientValue::AssumedZero => {}
            _ => all_assumed_zero = false,
        }
        worst = worst.min(v.derivation());   // calculated beats measured; unattributed beats calculated
    }

    // RULE 2 — a censored contributor makes the SUM censored, not measured.
    if any_censored && lower == 0.0 {
        return NutrientValue::BelowLoq { upper: upper /* scaled to 100 g below */ };
    }
    if all_assumed_zero { return NutrientValue::AssumedZero; }
    NutrientValue::Measured { amount: lower, derivation: worst }
}
```

Four properties this guarantees, each of which is a way the naive version lies:

1. **One `Absent` ingredient ⇒ the recipe's value for that nutrient is `Absent`.** Already the stated rule; this is where it lives.
2. **A `BelowLoq` ingredient cannot become a measured zero.** Sum a `BelowLoq{0.4}` with two real zeros and you get `BelowLoq`, which renders `<x mg` with a bound — *more* information than `0`, and visually distinct from it. Summing the lower bounds alone would render `0 mg`, an assertion the data does not support.
3. **`derivation` degrades monotonically.** A recipe built from one FNDDS ingredient (whose entire 65-nutrient panel is `calculated` — imputed by construction, never `measured`) can never present as measured. This matters enormously here, because Indian dishes are disproportionately FNDDS-sourced.
4. **Nutrients outside the FNDDS 65 stay `Absent`.** The FNDDS panel is a perfectly dense 65 × 5,431 matrix with zero missing cells — which means it can *never* mark a nutrient `Absent` on its own, and the 65 exclude **manganese, iodine, chromium, molybdenum, fluoride, biotin, pantothenic acid, added sugars, trans fat, MK-4 and dihydrophylloquinone**. For a FNDDS-sourced food those must render `—`, not `0`. (Note SR Legacy has **zero rows** for biotin and zero for iodine too, so switching to SR ingredients gains manganese and B5 but not those two — the earlier "SR strictly dominates" framing overstates the win.)

**A recipe carries a `coverage` fraction of its own**, computed the same mass-weighted way `DailyNutrient::coverage` already is, and it is shown in the recipe editor: *"Zinc: 7 of 9 ingredients measured — 2 ingredients have no zinc data."* That makes the missing-data state visible at authoring time, where the user can fix it by picking a better ingredient, rather than only at rollup time.

### 3.5 Serving sizes and the katori

**ICMR standardises the katori by volume, not by weight, and publishes no gram equivalent for a katori of cooked dal, rice or sabzi.** DGI 2024 Annexure I (printed p. 111) defines four sizes — Large C6 360 ml, Medium C7 200 ml, Small C8 155 ml, Small C9 115 ml — plus tablespoon 15 g and teaspoon 5 g. Printed p. 112 lists twelve standard cups (C1 1500 ml … C12 25 ml) and states only C6–C9 were used *"as these are most commonly used in households."*

**Every "1 katori dal = 150 g" figure circulating online traces to SEO content with no primary source. Do not hard-code one.**

> **Model the katori as a volume unit with a per-food density.** Offer the four ICMR sizes by name, default to medium (200 ml), and let the user calibrate their own katori once against a kitchen scale. Store the calibration on the profile.

ICMR does supply raw-basis gram↔katori anchors in the diet charts (printed pp. 121–122), which are usable and citable: *Rice 75 g = ½ medium (200 ml) katori*; *Pulses 30 g = ¼ small (115 ml) katori*; *Cereals 40 g = ¼ medium katori*; *Millets (nutricereals) 65 g = ¾ small (115 ml) katori (ragi)*; *Vegetables 100 g = 1 full medium katori*; and Annexure II's *spinach 20 g = ¾ medium katori*, *amaranth leaves 20 g = 1 full medium katori*, *bottle gourd 25 g = ½ small (115 ml) katori*.

Three rows in that source are internally inconsistent and must be quarantined, not propagated: *"Banana or steamed and mashed apple 40 g = ¼ of a small (115 ml) katori"* (implies 1.39 g/ml); *"Oil 15 g = one and a half teaspoon"* (implies 10 g/tsp, contradicting Annexure I's flat 5 g); *"Rice 100 g = ¾ small (115 ml) katori"* (implies 1.16 g/ml against a real bulk density near 0.85). The 150 ml/155 ml discrepancy is **not** an error — p. 112 says explicitly *"A difference of 5g in weight is not very apparent in the katori."*

**FNDDS household portions are the strongest serving-weight source available and are CC0.** Measured directly from `food_portion.csv`:

| Dish | Portions (grams) |
|---|---|
| Bread, chappatti or roti | small 6" **27**, medium 7" **40**, large 8" **52**, unspecified 40 |
| Bread, paratha | **70** |
| Bread, puri | **36** |
| Bread, naan | 10" naan **177**, ¼ of 10" **44** |
| Idli | 1 item **38**, unspecified 76 (i.e. 2) |
| Dosa, plain | small **35**, medium **80**, large **155** |
| Dosa, with filling | small **113**, medium **267**, large **523** |
| Vada | 1 item any size **30** |
| Samosa | small **25**, regular/large **100** |
| Pakora | 1 pakora **12** |
| Papad, grilled or broiled | 1 papad **9** |
| Dal | 1 cup **240** |
| Sambar, vegetable stew | 1 cup **248** |
| Vegetable curry / Lentil curry | 1 cup **240** |
| Biryani with vegetables | 1 cup **172** |
| Upma | 1 cup cooked **170** |
| Palak Paneer | 1 cup **200** |
| Channa Saag | 1 cup **245** |
| Cheese, paneer | 1 cup **246** |
| Ghee, clarified butter | 1 tbsp **14** |
| Chutney | 1 tablespoon **16** |

**Take serving weights from FNDDS. Take ingredient composition from elsewhere.** That split is the core recommendation of §4.

---

## 4. Seed list

### 4.1 Two provenance tiers, never mixed

- **SOURCED** — quantities taken directly from USDA FNDDS `input_food.csv` (CC0, citable by `fdc_id`). These ship with numbers.
- **REPRESENTATIVE** — dishes with no USDA recipe. These ship as an **ingredient skeleton with `fdc_id`s and no quantities**, flagged `needs_quantities`, with the recipe editor prompting the user to enter grams. Where INDB carries a recipe I name its code so the author can read the real file; **I did not verify any INDB gram weight in this session and therefore assert none here.**

That asymmetry is deliberate. Shipping an unsourced gram weight that renders as a nutrition number is exactly the failure this project exists to prevent.

### 4.2 SOURCED — FNDDS recipes, imported as-is and shown to the user

These four are ethnically correct enough to seed directly. All gram weights below are measured from `input_food.csv`.

**Sambar, vegetable stew** — `fdc 2707430` · serving 1 cup = **248 g** · recipe totals 1,289.0 g

| g | fdc_id | Ingredient |
|---:|---:|---|
| 495.0 | 172421 | Lentils, cooked, boiled, without salt |
| 474.0 | 173647 | Water, tap, drinking |
| 72.0 | *FNDDS 99997410* | Tomatoes, cooked, as ingredient |
| 63.0 | *FNDDS 99997510* | Onions, cooked, as ingredient |
| 48.0 | 169263 | Okra, frozen, cooked, boiled, drained |
| 46.8 | 170093 | Potatoes, baked, flesh and skin |
| 38.0 | *FNDDS 99997545* | Green beans, cooked, as ingredient |
| 28.0 | *FNDDS 82101000* | Vegetable oil, NFS |
| 13.75 | **167763** | Tamarinds, raw |
| 6.0 | 173468 | Salt, table |
| 2.1 | 170929 | Spices, mustard seed, ground |
| 1.25 | 171319 | Spices, chili powder |
| 1.133 | 172231 | Spices, turmeric, ground |

*Author's note to ship with it:* uses masoor, not toor; no drumstick, no curry leaf, no asafoetida, no coconut. Substitute `172437` (pigeon peas, cooked) for the lentils and add `168417` drumstick leaves to make it South Indian. Flag as **editable representative**.

**Channa Saag** — `fdc 2709632` · serving 1 cup = **245 g** · recipe totals 854.5 g
540.0 g Spinach, cooked as ingredient (ret 3018) · 164.0 g Chickpeas from dried, no added fat (ret 550) · 110.0 g **170000** Onions, raw (ret 3465) · 28.0 g Vegetable oil NFS · 3.0 g **169230** Garlic, raw (ret 3465) · 3.0 g **173468** Salt · 2.5 g **171319** Chilli powder · 2.0 g **170923** Cumin seed · 2.0 g **169231** Ginger root, raw. — *Structurally sound; the closest thing to a correct Indian recipe in FNDDS.*

**Dal** — `fdc 2707427` · serving 1 cup = **240 g** · recipe totals 100.8 g
96.0 g **172421** Lentils, cooked, boiled · 4.0 g **173412** Butter oil, anhydrous · 0.8 g **173468** Salt. — *One generic lentil; no toor/moong/urad/chana/masoor distinction and no tempering spices at all. Ships as a skeleton to edit, not as an answer.*

**Papad, grilled or broiled** — `fdc 2707429` · 1 papad = **9 g** · SR entry `168106` Papad (100 nutrients). Ships as-is.

### 4.3 SOURCED but DISQUALIFIED — import the structure, correct the substitutions

These FNDDS recipes are structurally usable and ethnically wrong. Seed the *shape*, fix the named substitution, and mark the fix in the recipe notes. All defects verified firsthand.

| Dish | fdc_id | The defect (measured) | The fix |
|---|---:|---|---|
| **Idli** | 2708346 | 98.0 g **Peas, split, cooked** + 87.0 g **Rice, white, glutinous** + 1.0 g salt. Urad dal is not used. Fermentation is not modelled — relevant because fermentation is the plausible B12 pathway. | Replace with **`174259` Mungo beans (urad), raw** and `168877` Rice, white long-grain, raw. **(C1)** |
| **Dosa, plain** | 2708347 | 711.0 g water + 555.0 g `168877` rice + **192.0 g `172420` Lentils, raw** + 56 g oil + 12 g salt + 0.53 g mustard. Lentils, not urad. Recipe sums to **1,526.5 g** while a medium dosa is 80 g — see C4. | Swap the 192 g lentils → `174259` urad. Do **not** normalise by the ingredient sum. |
| **Vada** | 2709130 | 384.0 g **Lentils, raw** + 237 g water + 68.2 g oil + 45 g `168576` jalapeño + 6 g salt + 6 g ginger + 2.13 g black pepper + 2 g cumin. | Lentils → `174259` urad. Jalapeño → `169395` Peppers, serrano, raw (76 nutrients). |
| **Upma** | 2709128 | **175.0 g Cream of Wheat** (`SR 8102`, fortified US breakfast cereal) for rava; 246 g tomato; 220 g onion; 90 g jalapeño. | Cream of Wheat → **`168933` Semolina, unenriched** (76 nutrients). **(C3)** — the enrichment materially changes iron and B-vitamin values. |
| **Pakora** | 2710066 | 355.5 g water + 141.75 g `173756` chickpeas raw + 30 g potato + 30 g onion + 21 g oil + 20 g cauliflower + 15 g eggplant + 6 g salt + 5 g plantain + spices including **0.43 g `SR 2029` dried PARSLEY**. | Chickpeas → **`174288` Chickpea flour (besan)**. Parsley → `169997` Coriander (cilantro) leaves, raw. |
| **Palak Paneer** | 2709631 | **500.0 g Cottage cheese, full fat (`SR 1012` → `172179`)** standing in for paneer, even though FNDDS has its own `2705740` Cheese, paneer. Also 500 g spinach, 182 g tomato, 150 g onion, 70 g oil. | Cottage cheese → `2705740`. The material difference is **calcium** (paneer 597 vs cottage cheese 83 mg/100 g, 7.2×) and fat (15.52 vs 4.3 g) — **not** sodium, which differs least (185 vs 315 mg). For a vegetarian tracker calcium is the consequential one. |
| **Chutney** | 2709309 | **88.0 g Jams and preserves + 10.0 g Vinegar + 2.0 g Salt.** That is British sweet mango chutney. It is not the coconut or coriander chutney served with idli and dosa. | **Do not ship.** Author a coconut chutney from `170169` coconut meat raw + `174259` urad + `169395` serrano + `173468` salt. |
| **Vegetable curry** | 2710067 | Resolves to a fixed 8-vegetable blend that is 25 % potato + 25 % onion, plus a `Curry sauce` (`2710178`) that is **80 % canned tomato sauce**, 7 % yogurt, 7 % coconut milk. | Usable as a generic placeholder only. Flag prominently as a US survey average. |
| **Biryani with vegetables** | 2708985 | 56 g salted butter, no yogurt, no saffron; rice only 18 % of raw mass against 46 % water. | Author from scratch. |

### 4.4 REPRESENTATIVE — ingredient skeletons, quantities entered by the user

Ships as an ordered ingredient list with `fdc_id`s and `needs_quantities = 1`. The dish appears in search, opens in the recipe editor, and cannot be logged until the user sets grams. Named INDB codes are pointers for the author to read from the file, not values.

| Dish | Ingredients (fdc_id) | Quantity source to consult |
|---|---|---|
| **Toor dal / arhar dal** | 172437 toor cooked · 173412 ghee · 170923 cumin · 172231 turmeric · 171319 chilli · 170000 onion · 170457 tomato · 173468 salt | INDB `ASC151` (moong analogue) |
| **Moong dal (washed)** | 174257 mung cooked · 173412 · 170923 · 172231 · 173468 | INDB `ASC151` |
| **Rajma** | 173740 kidney beans cooked · 170457 · 170000 · 169230 · 169231 · 170924 curry powder · 173468 | INDB `ASC165` — **note: `ASC165` lists no cooking water at all**, inconsistent with every other INDB dal; quarantine and re-derive |
| **Chana masala / kabuli chana** | 173757 chickpeas cooked · 170457 · 170000 · 169231 · 171284 yogurt · 173468 | INDB `BFP185` |
| **Dal makhani** | 172427 mungo/urad cooked · 173740 rajma cooked · 173410 butter · 170457 · 170000 · 173412 | INDB `OSR139` — **note INDB maps "low fat cream" to a *cream cheese* code**; cream and cream cheese differ ~2× in fat and are not substitutable |
| **Khichdi** | 168877 rice raw · 174257 mung cooked · 173412 ghee · 170923 · 172231 · 173468 | INDB `BFP144` |
| **Chapati / roti** | 168893 atta (1 cup = 120 g) · water · 173412 ghee | serving **27 / 40 / 52 g** from FNDDS `2707713` |
| **Bajra roti / jowar bhakri** | 172023 millet flour *or* 168943 sorghum flour · water · 173468 | **unavailable** — no INDB entry; ICMR DGI 2024 asks for 20–30 % of adult cereal intake (raw) from millets, so this gap matters |
| **Sarson ka saag** | 169256 mustard greens raw · 168462 spinach · 172023 maize/millet flour · 173412 ghee · 170000 | INDB `ASC217` |
| **Baingan bharta** | 169228 eggplant raw · 170457 · 170000 · 169231 · 173468 | INDB `ASC177` |
| **Bhindi sabzi** | 169260 okra raw (1 cup = 100 g) · 170000 · 172231 · 173468 | INDB `ASC184` |
| **Aloo gobi** | 169986 cauliflower raw · potato · 169231 · 172231 · 173468 | INDB `ASC171` |
| **Lauki / bottle gourd sabzi** | 169232 calabash raw · 170923 · 172231 · 173468 | — |
| **Karela sabzi** | 168394 bitter gourd boiled · 170000 · 173468 | — |
| **Drumstick-leaf poriyal** | **168417** drumstick leaves boiled · 170169 coconut · 174259 urad · 173468 | **(C2)** |
| **Curd rice** | 168877 rice · 171284 yogurt · 174259 urad · 169395 serrano · 173468 | INDB `ASC126` |
| **Lemon rice** | 168877 rice · 174259 urad · 172231 · 173468 | INDB `ASC124` |
| **Rava dosa** | 168933 semolina · 168877 rice · 171284 · 173468 | INDB `ASC147` |
| **Dhokla** | 174288 besan · 171284 yogurt · 173468 | INDB `ASC474` |
| **Rice kheer** | 168877 rice · 171265 milk whole · sugar · nuts | INDB `ASC282` |
| **Sooji halwa** | 168933 semolina · 173412 ghee · sugar · 171265 milk | — |

### 4.5 Gaps I could not close, stated as gaps

No USDA entry exists and **no value is supplied**: **jaggery/gur, curry leaf, asafoetida/hing, ajwain, kalonji, ridge gourd, ivy gourd, kokum, amchur, ragi/finger millet, poha/flattened rice, khoya/mawa, garam masala** (only generic `170924` curry powder). Dishes with no entry: rasam, raita, lassi, kadhi, jalebi, gulab jamun, uttapam, appam, pav bhaji, thepla, bhel/chaat, sev.

**Paneer exists only as the FNDDS 65-nutrient entry `2705740`**, itself modelled as 97 g whole milk + 3 g vinegar rather than analysed. There is no SR-grade paneer.

**East and Northeast India are genuinely thin** across every source examined — litti chokha, sattu, shukto, aloo posto, ghugni, pakhala, pitha, khar. Closing these requires a licensed source or hand-authored recipes over the USDA ingredients above; do not fill them by generation.

**SR Legacy is frozen at April 2018 and will never be updated.** No USDA release will add jaggery or curry leaf. Until an external source is secured, let those foods be honestly absent rather than approximated from a similar item.

---

## 5. Schema changes

### 5.1 `usda_core.db` — reference (rebuilt by `build-reference-db`, not migrated)

```sql
-- Classification, derived at build time (§2.6). Bump meta.schema_version.
ALTER TABLE ref_foods ADD COLUMN diet_class TEXT NOT NULL DEFAULT 'uncertain'
  CHECK (diet_class IN ('non_vegetarian','contains_egg','lacto_vegetarian','plant_only','uncertain'));
ALTER TABLE ref_foods ADD COLUMN diet_evidence TEXT NOT NULL DEFAULT 'none'
  CHECK (diet_evidence IN ('none','category','description','ingredients','ontology','override'));
ALTER TABLE ref_foods ADD COLUMN contains_egg    INTEGER NOT NULL DEFAULT 0 CHECK (contains_egg    IN (0,1));
ALTER TABLE ref_foods ADD COLUMN contains_dairy  INTEGER NOT NULL DEFAULT 0 CHECK (contains_dairy  IN (0,1));
ALTER TABLE ref_foods ADD COLUMN contains_honey  INTEGER NOT NULL DEFAULT 0 CHECK (contains_honey  IN (0,1));
ALTER TABLE ref_foods ADD COLUMN contains_allium INTEGER NOT NULL DEFAULT 0 CHECK (contains_allium IN (0,1));
CREATE INDEX ref_foods_diet ON ref_foods(diet_class);

-- FNDDS base ingredients: the "show composite dishes' ingredients" feature.
-- Display and provenance ONLY. See C4: gram_weight is a raw recipe weight at an
-- arbitrary batch scale and does NOT sum to the food's own 100 g basis.
CREATE TABLE ref_food_inputs (
  fdc_id            INTEGER NOT NULL REFERENCES ref_foods(fdc_id),
  seq_num           INTEGER NOT NULL,
  ingredient_label  TEXT    NOT NULL,   -- input_food.sr_description, populated on 100% of rows
  resolved_fdc_id   INTEGER,            -- NULL when the sr_code is an FNDDS-internal pseudo-food
  gram_weight       REAL    NOT NULL CHECK (gram_weight > 0),
  batch_grams       REAL    NOT NULL CHECK (batch_grams > 0),  -- sum over the food; C4
  retention_code    INTEGER,            -- 0 => none
  PRIMARY KEY (fdc_id, seq_num)
) WITHOUT ROWID, STRICT;
CREATE INDEX ref_food_inputs_resolved ON ref_food_inputs(resolved_fdc_id);

-- USDA Table of Nutrient Retention Factors, Release 6. NOT the bundled
-- retention_factor.csv, which carries codes and descriptions but NO percentages (C5).
CREATE TABLE retention_factors (
  retention_code INTEGER NOT NULL,
  nutrient_id    INTEGER NOT NULL REFERENCES nutrients(nutrient_id),
  pct_retained   REAL    NOT NULL CHECK (pct_retained > 0 AND pct_retained <= 100),
  PRIMARY KEY (retention_code, nutrient_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE retention_codes (
  retention_code INTEGER PRIMARY KEY,
  description    TEXT NOT NULL          -- from the bundled retention_factor.csv, which is fine for this
) STRICT;

-- Cooking yield as an INTERVAL, never a scalar (§3.3).
CREATE TABLE cooking_yields (
  food_class   TEXT PRIMARY KEY,        -- 'dry_pulse' | 'rice_white' | 'rice_brown' | ...
  point        REAL NOT NULL CHECK (point > 0),
  lower        REAL NOT NULL CHECK (lower > 0),
  upper        REAL NOT NULL CHECK (upper >= lower),
  method       TEXT NOT NULL,           -- 'usda_empirical_portion' | 'dry_matter_conservation'
  source       TEXT NOT NULL,
  CHECK (point BETWEEN lower AND upper)
) STRICT;
```

Add to `meta`: `diet_classifier_version`, `retention_release`, `indb_consulted_version`.

Add to `assertions.toml` — **fail the build, don't warn**:
- `ref_food_inputs` covers ≥ 5,430 FNDDS foods (measured 5,431 of 5,432).
- `ingredient_label` non-empty on 100 % of rows (measured 18,584/18,584).
- distinct `ingredient_label` count ≤ 2,500 (measured 2,333) — a jump means the lexicon needs review.
- FNDDS `food_nutrient.nutrient_id` values all resolve via `nutrient_nbr`, none via `nutrient.id`.
- `diet_class` counts within ±3 % of the §2.3 table.
- `retention_factors` row count > 0 before any retention adjustment is applied anywhere.
- **`174259` and `172427` exist and are non-empty** — a regression guard on C1, so a future release that drops "Mungo beans" breaks the build rather than silently losing urad dal.

### 5.2 `user.db` — additive migration

```sql
-- Diet preference on the profile.
ALTER TABLE profiles ADD COLUMN diet_preference TEXT NOT NULL DEFAULT 'none'
  CHECK (diet_preference IN ('none','lacto_vegetarian','ovo_lacto_vegetarian','plant_only','jain_advisory'));
ALTER TABLE profiles ADD COLUMN show_uncertain_foods INTEGER NOT NULL DEFAULT 1
  CHECK (show_uncertain_foods IN (0,1));
ALTER TABLE profiles ADD COLUMN katori_ml REAL CHECK (katori_ml > 0);  -- user calibration; NULL = ICMR C7 200 ml

-- Recipes gain yield-as-interval, cuisine/provenance, and the honesty flag.
ALTER TABLE recipes ADD COLUMN yield_factor_lower REAL CHECK (yield_factor_lower > 0);
ALTER TABLE recipes ADD COLUMN yield_factor_upper REAL CHECK (yield_factor_upper > 0);
ALTER TABLE recipes ADD COLUMN yield_basis TEXT NOT NULL DEFAULT 'measured'
  CHECK (yield_basis IN ('measured','yield_factor','raw_sum'));
ALTER TABLE recipes ADD COLUMN retention_code INTEGER;         -- NULL = none applied, and say so
ALTER TABLE recipes ADD COLUMN provenance TEXT NOT NULL DEFAULT 'user'
  CHECK (provenance IN ('user','seed_usda','seed_representative','forked'));
ALTER TABLE recipes ADD COLUMN source_citation TEXT;           -- 'USDA FNDDS 2024-10-31 fdc 2709632'
ALTER TABLE recipes ADD COLUMN needs_quantities INTEGER NOT NULL DEFAULT 0
  CHECK (needs_quantities IN (0,1));                            -- §4.4 skeletons
ALTER TABLE recipes ADD COLUMN cuisine TEXT;
ALTER TABLE recipes ADD COLUMN forked_from TEXT REFERENCES recipes(id);

-- Per-ingredient: was this quantity sourced or is it a placeholder?
ALTER TABLE recipe_items ADD COLUMN quantity_basis TEXT NOT NULL DEFAULT 'user'
  CHECK (quantity_basis IN ('user','sourced','representative','placeholder'));
ALTER TABLE recipe_items ADD COLUMN source_citation TEXT;
ALTER TABLE recipe_items ADD COLUMN prep_note TEXT;            -- 'for tempering', 'soaked 4 h'
ALTER TABLE recipe_items ADD COLUMN excluded_from_rollup INTEGER NOT NULL DEFAULT 0
  CHECK (excluded_from_rollup IN (0,1));                        -- deep-frying oil bath, steaming water

-- Named servings per recipe, so "1 katori" and "2 idli" are first-class.
CREATE TABLE recipe_servings (
  id          TEXT PRIMARY KEY,
  recipe_id   TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,                                    -- '1 medium roti', '1 katori (200 ml)'
  grams       REAL NOT NULL CHECK (grams > 0),
  basis       TEXT NOT NULL CHECK (basis IN ('sourced','user_measured','representative')),
  source_citation TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
) STRICT;
CREATE UNIQUE INDEX recipe_servings_default
  ON recipe_servings(recipe_id) WHERE is_default = 1 AND deleted_at IS NULL;

-- Ingredient-level allowlist/denylist for what the data cannot answer (§2.6).
CREATE TABLE diet_overrides (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('fdc_id','ingredient_label')),
  key          TEXT NOT NULL,
  diet_class   TEXT NOT NULL CHECK (diet_class IN
                 ('non_vegetarian','contains_egg','lacto_vegetarian','plant_only','uncertain')),
  reason       TEXT NOT NULL,                                   -- required, not optional
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  UNIQUE (scope, key)
) STRICT;
```

`nutrient_snapshots` needs **no change**. Its existing contract — the numbers are copied into the log at write time, `snapshot_id` is the only non-dangling FK — already makes a recipe edit, a USDA release update and a classifier correction all non-events for historical totals. That is exactly the property wanted here: correcting the palak-paneer substitution next month must not silently rewrite what the user ate last month. It won't.

`recipe_items.excluded_from_rollup` deserves a note: it exists because of a real, verified defect in INDB, where the **entire deep-frying oil bath is counted as an ingredient** — 240–480 g of "oil, for frying" in poori, bhatura, samosa, pakora, medu vada, besan kadhi, and (erroneously) griddle-cooked uttapam. Unfiltered, INDB's poori reports 96.93 g fat and 921.3 kcal *per poori*. The same column also handles steaming water (INDB's puttu counts 600 g) and discarded coconut kernel (appam counts 500 g). Any importer must filter ingredient rows matching `/for frying|for deep|deep fry|for soak|to steam|for boiling/` before they reach the rollup.

---

## 6. What NOT to do

Each of these is tempting, cheap, and produces confidently wrong nutrition.

**1. Do not ingest `@ifct2017/compositions`, `nodef/ifct2017`, or the Kaggle mirror.** It is one `npm install` away, MIT-labelled, 542 foods × 421 columns, with ready-made CSV and SQL exports. It encodes missing data as literal `0` — *Palm fruit, tender* reads calcium, iron, phosphorus and magnesium all exactly zero, and **all 14 edible oils and fats including ghee read zero calcium**. Under TrackIt's model every one becomes `MeasuredZero`. Its `L003 Paneer` row also has fat 14.78 where NIN reads 24.78 — a 40 % error in a vegetarian staple, internally consistent with its own wrong energy figure so no sanity check catches it. Leave a named warning in the repo.

**2. Do not threshold trace ingredients.** "Ignore ingredients under 5 % of recipe weight" would pass *Greek Salad* (3.1 % anchovy), *Tortellini, spinach-filled* (0.9 % mortadella), *Bloody Mary* (1.8 % Worcestershire) and *Pad Thai, meatless* (3.2 % fish sauce) — every one of them. For a vegetarian, any amount is disqualifying.

**3. Do not ship a category-only vegetarian filter.** It looks like it works because its false-positive rate is near zero. Its failure mode is 725 missed FNDDS foods and 604 missed SR Legacy foods, all in the *unflagged* set that spot-checking never examines.

**4. Do not sum `input_food.amount`.** Summing `amount` gives Idli = 2 g and Palak Paneer = 1344 g; summing `gram_weight` gives 186.0 g and 1420.5 g, which are right. Both columns are numeric and both look plausible, so this bug does not throw — it just produces confident wrong nutrition. `portion_description` inside `input_food` is also frequently stale: Palak Paneer's garlic reads `amount=2.0 unit=TS portion_description='1 cup'` with `gram_weight=5.625`. **Trust `gram_weight` only.** (`food_portion.portion_description`, by contrast, is reliable and is the right serving-size source.)

**5. Do not normalise `input_food` gram weights to derive a food's nutrient values.** *Dosa, plain* sums to 1,526.5 g of raw ingredients against an 80 g medium dosa. USDA has already applied its own yield and retention to reach the published per-100 g panel. Dividing the ingredient sum re-does that arithmetic wrongly. **(C4)**

**6. Do not join FNDDS `food_nutrient` on `nutrient.id`.** It references `nutrient_nbr`. All 65 lookups return zero rows, with no error — dishes would silently show as having no data at all.

**7. Do not join FNDDS `food.food_category_id` to `food_category.csv`.** It holds the WWEIA number. Ranges don't overlap, so you get zero matches rather than a failure.

**8. Do not average the disagreeing yield factors.** USDA's empirical legume portion says 2.47×; dry-matter conservation says 2.3–3.3× depending on species; protein-based says 2.73× for lentils and iron-based 1.96×. The spread is real leaching behaviour, not noise. Carry the interval.

**9. Do not write `mean − SD` into the same `[lower, upper]` field as USDA's observed min/max.** If IFCT is ever licensed, note that ±1 SD is a ~68 % dispersion band around a central estimate while min/max are observed extremes — mixing them makes IFCT foods look spuriously precise next to USDA ones. And at least 9 IFCT cells have `mean − SD < 0` (e.g. `P034` retinol 16.34 ± 16.88 → −0.54 µg), so any such interval must be clamped at zero. Record which *kind* of interval it is.

**10. Do not treat all IFCT blanks alike, if IFCT is ever licensed.** A blank in a row that *is* in a table means below detectable limit → `BelowLoq`. A food **absent from a whole table** was never analysed → `Absent`. Table 4 (carotenoids) covers only 329 of 528 foods and Table 6 (starch/sugars) only 314. Conflating them misreports several hundred foods. And IFCT publishes no zeros and no trace symbol at all, so **no** IFCT blank ever maps to `AssumedZero`, `MeasuredZero`, `LabelZero` or `Trace`.

**11. Do not use `171314` for ghee.** SR Legacy's *"Butter, Clarified butter (ghee)"* carries **18 nutrients**. `173412` *Butter oil, anhydrous* carries **91** and is the same food.

**12. Do not use Cream of Wheat for rava, or cottage cheese for paneer, or dried parsley for coriander leaf.** These are USDA's substitutions, not yours, and they are the same laundering failure as fabricating a value — a number that looks measured but describes a different food. The paneer case is worth stating precisely: the dominant error is **calcium** (597 vs 83 mg/100 g, 7.2×), not sodium, which differs least of the five nutrients checked.

**13. Do not present the iodised-salt overlay contribution as `Measured`.** The Iodine Database Release 4 row reads "Salt, table, iodized" at 5,213.1 µg/100 g and keys to SR `02047`, which SR Legacy describes plainly as *"Salt, table"* (`173468`). At realistic salt fractions this is **not** a magnitude problem — computed from the actual recipes it yields 11–104 µg per 100 g of dish and 10.7–99.3 µg per USDA portion, all below the 150 µg RDA and an order of magnitude below the 1,100 µg UL. It is a **provenance** problem: it is an inference about the salt, not a measurement of the dish. Give it its own tag, and ask the user whether they use iodised salt rather than inferring it.

**14. Do not display "no onion/garlic" for any SR Legacy food.** There is no ingredient table; only ~58 of 7,793 descriptions mention allium. Positive flags only, FNDDS only.

**15. Do not ship a "vegan" badge in v1.** The class is computed as absence of evidence and is undefensible for the 3,045 SR Legacy composites. Ship `plant_only` with the evidence level visible, or ship nothing.

**16. Do not delete meat foods.** §2.5.

**17. Do not quote the classifier counts without shipping the classifier.** The §2.3 numbers are engineering estimates from a regex I wrote and audited by reading the matched strings — not ground truth. My own run passes minestrone as non-vegetarian on kidney beans and flags curry sauce on coconut "meat." Check the script in, publish the lexicon, unit-test the false-friend list, and treat every count as good to a few percent.

**18. Do not bundle IFCT-derived values into anything that leaves this machine without written NIN permission.** And do not route around it by way of a third-party mirror asserting a licence it has no standing to grant. §1, Tier 3 and Tier 4.

---

## 7. Build order

1. **Classification** — lexicon over the 2,333 ingredient strings; `diet_class` columns; filter default-on with the amber `uncertain` badge. Ships value immediately and depends on nothing.
2. **`ref_food_inputs`** — the base-ingredient display for all 5,431 FNDDS composites. Already in the bundle, no new source, directly answers half the user's request.
3. **Recipe rollup** — `roll_up()` with the four provenance rules, `recipe_servings`, katori as volume + calibration.
4. **Seed recipes** — the four SOURCED, then the corrected DISQUALIFIED set, then the REPRESENTATIVE skeletons.
5. **Retention factors** — obtain USDA Release 6 values; until then store `cook_method` and apply nothing, disclosed.
6. **Two emails**, both cheap, both unblocking: NIN (permission + the electronic database they say they supply on request) and the INDB authors (an explicit `LICENSE` on the repo).

---

**Files referenced:** `/Users/kgundu1/BioBalance/docs/architecture-data.md` (§2.3, §2.4, §3.1, §3.3, §3.4, §5.3, §5.4), `/Users/kgundu1/BioBalance/docs/decisions.md` (D1, D2), `/Users/kgundu1/BioBalance/data/raw/extracted/`. Classification script written this session: `/private/tmp/claude-503/-Users-kgundu1-BioBalance/4d105f95-b676-40a9-9715-8e1333bdfbb7/scratchpad/classify.py` — move it into the repo before quoting its output anywhere.",
    "tracks": 5
  },
  "workflowProgress": [
    {
      "type": "workflow_phase",
      "index": 1,
      "title": "Research"
    },
    {
      "type": "workflow_phase",
      "index": 2,
      "title": "Verify"
    },
    {
      "type": "workflow_phase",
      "index": 3,
      "title": "Plan"
    },
    {
      "type": "workflow_agent",
      "index": 1,
      "label": "research:ifct",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "aca5654f1331c2fd9",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788535451467,
      "queuedAt": 1788535448873,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "IFCT 2017 (Indian Food Composition Tables, ICMR-NIN) — scop…",
      "promptPreview": "# TrackIt

A personal nutrition tracker (macOS desktop + Android, Tauri v2 + Rust + React) that already
ships a 37 MB bundled reference database built from USDA FoodData Central:

- Foundation Foods 2026-04-30 (395 foods), SR Legacy 2018-04 (7,793), FNDDS 2024-10-31 (5,432)
- Plus the USDA/ARS Iodine Database Release 4 as an overlay (372 foods matched)
- 13,694 foods, 1,018,922 nutrient values,…",
      "lastProgressAt": 1788536498517,
      "tokens": 114627,
      "toolCalls": 55,
      "durationMs": 1046282,
      "resultPreview": "{"topic":"IFCT 2017 (Indian Food Composition Tables, ICMR-NIN) — scope, machine-readability, licensing, data conventions, and derived datasets, assessed for bundling into TrackIt","summary":"IFCT 2017 is real, authoritative, current (no newer edition as of 2026-09-04), and technically an excellent fit for TrackIt's interval model — it publishes mean±SD per value with a sample-count column, w…"
    },
    {
      "type": "workflow_agent",
      "index": 2,
      "label": "research:usda-indian",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "ad9cf8d060f108c9e",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788535450850,
      "queuedAt": 1788535448873,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Indian vegetarian food coverage in the bundled USDA FoodDat…",
      "promptPreview": "# TrackIt

A personal nutrition tracker (macOS desktop + Android, Tauri v2 + Rust + React) that already
ships a 37 MB bundled reference database built from USDA FoodData Central:

- Foundation Foods 2026-04-30 (395 foods), SR Legacy 2018-04 (7,793), FNDDS 2024-10-31 (5,432)
- Plus the USDA/ARS Iodine Database Release 4 as an overlay (372 foods matched)
- 13,694 foods, 1,018,922 nutrient values,…",
      "lastProgressAt": 1788536166583,
      "tokens": 137251,
      "toolCalls": 40,
      "durationMs": 714348,
      "resultPreview": "{"topic":"Indian vegetarian food coverage in the bundled USDA FoodData Central data (Foundation 2026-04-30, SR Legacy 2018-04, FNDDS 2021-2023 rel. 2024-10-31) — what exists, its quality, and the genuine gaps","summary":"USDA's Indian coverage is real but shallow and lopsided. Roughly 30 distinctly Indian vegetarian entries exist, and almost all of them live in FNDDS 2021-2023, not SR Legacy. FNDD…"
    },
    {
      "type": "workflow_agent",
      "index": 3,
      "label": "research:other-sources",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "afb1e99d12d6a2808",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788535450839,
      "queuedAt": 1788535448873,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Non-IFCT Indian / South Asian food composition sources for …",
      "promptPreview": "# TrackIt

A personal nutrition tracker (macOS desktop + Android, Tauri v2 + Rust + React) that already
ships a 37 MB bundled reference database built from USDA FoodData Central:

- Foundation Foods 2026-04-30 (395 foods), SR Legacy 2018-04 (7,793), FNDDS 2024-10-31 (5,432)
- Plus the USDA/ARS Iodine Database Release 4 as an overlay (372 foods matched)
- 13,694 foods, 1,018,922 nutrient values,…",
      "lastProgressAt": 1788536575659,
      "tokens": 126874,
      "toolCalls": 67,
      "durationMs": 1124819,
      "resultPreview": "{"topic":"Non-IFCT Indian / South Asian food composition sources for TrackIt (vegetarian Indian coverage, composite dishes, custom recipes)","summary":"One source is clearly worth adopting and one is clearly worth refusing. The Indian Nutrient Databank (INDB, Jaacks group, Current Developments in Nutrition 2024) is the only open, machine-readable dataset I found that gives 1,014 Indian composit…"
    },
    {
      "type": "workflow_agent",
      "index": 4,
      "label": "research:dishes",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "a16301fff14eab307",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788535451062,
      "queuedAt": 1788535448873,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Composition and standard serving sizes of common Indian veg…",
      "promptPreview": "# TrackIt

A personal nutrition tracker (macOS desktop + Android, Tauri v2 + Rust + React) that already
ships a 37 MB bundled reference database built from USDA FoodData Central:

- Foundation Foods 2026-04-30 (395 foods), SR Legacy 2018-04 (7,793), FNDDS 2024-10-31 (5,432)
- Plus the USDA/ARS Iodine Database Release 4 as an overlay (372 foods matched)
- 13,694 foods, 1,018,922 nutrient values,…",
      "lastProgressAt": 1788536428562,
      "tokens": 197172,
      "toolCalls": 57,
      "durationMs": 976327,
      "resultPreview": "{"topic":"Composition and standard serving sizes of common Indian vegetarian dishes: sourced recipe seed set, katori portion standards, and raw-to-cooked yield/retention factors for TrackIt","summary":"I did not write a recipe seed set from memory. Instead I located two machine-readable, citable recipe databases that already carry ingredient quantities by weight, and extracted 63 Indian vegetar…"
    },
    {
      "type": "workflow_agent",
      "index": 5,
      "label": "research:classification",
      "phaseIndex": 1,
      "phaseTitle": "Research",
      "agentId": "a2dc9f0f3fa965ceb",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788535451052,
      "queuedAt": 1788535448874,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Reliable vegetarian/vegan classification of the bundled USD…",
      "promptPreview": "# TrackIt

A personal nutrition tracker (macOS desktop + Android, Tauri v2 + Rust + React) that already
ships a 37 MB bundled reference database built from USDA FoodData Central:

- Foundation Foods 2026-04-30 (395 foods), SR Legacy 2018-04 (7,793), FNDDS 2024-10-31 (5,432)
- Plus the USDA/ARS Iodine Database Release 4 as an overlay (372 foods matched)
- 13,694 foods, 1,018,922 nutrient values,…",
      "lastProgressAt": 1788536371139,
      "tokens": 158093,
      "toolCalls": 53,
      "durationMs": 918904,
      "resultPreview": "{"topic":"Reliable vegetarian/vegan classification of the bundled USDA FoodData Central reference database (SR Legacy 2018-04, Foundation 2026-04-30, FNDDS 2024-10-31) for a lacto-vegetarian Indian user","summary":"Three sources, three different classification signals, and they are not equally trustworthy. SR Legacy and Foundation carry `food_category_id` joining to `food_category.csv` (28 categor…"
    },
    {
      "type": "workflow_agent",
      "index": 6,
      "label": "verify:usda-indian",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "a06ab3c6e3926ca50",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788536174083,
      "queuedAt": 1788536169974,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "What Indian food USDA already covers — adversarial verifica…",
      "promptPreview": "CRITICAL — this is a nutrition tracker. **NEVER invent, estimate from memory, or interpolate a
nutrition value.** A fabricated micronutrient number is worse than no number, because the app
renders it with the same confidence as a measured one. Every quantitative nutrition claim you
report must carry a citable source (URL, publication, table number). If you cannot source it,
say so explicitly and m…",
      "lastProgressAt": 1788536896396,
      "tokens": 130772,
      "toolCalls": 43,
      "durationMs": 722313,
      "resultPreview": "{"topic":"What Indian food USDA already covers — adversarial verification of Indian vegetarian coverage in the bundled FoodData Central data (Foundation 2026-04-30, SR Legacy 2018-04, FNDDS 2021-2023 rel. 2024-10-31) plus the ARS Iodine Release 4 overlay","verifiedSummary":"This research holds up unusually well on its quantitative core and fails in a small number of specific, correctable places. I…"
    },
    {
      "type": "workflow_agent",
      "index": 7,
      "label": "verify:classification",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "a635544e7ace61940",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788536376073,
      "queuedAt": 1788536373005,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Adversarial fact-check of "Reliable vegetarian classificati…",
      "promptPreview": "CRITICAL — this is a nutrition tracker. **NEVER invent, estimate from memory, or interpolate a
nutrition value.** A fabricated micronutrient number is worse than no number, because the app
renders it with the same confidence as a measured one. Every quantitative nutrition claim you
report must carry a citable source (URL, publication, table number). If you cannot source it,
say so explicitly and m…",
      "lastProgressAt": 1788537050833,
      "tokens": 127200,
      "toolCalls": 46,
      "durationMs": 674760,
      "resultPreview": "{"topic":"Adversarial fact-check of \\"Reliable vegetarian classification of the existing food database\\" (USDA FoodData Central SR Legacy 2018-04, Foundation 2026-04-30, FNDDS 2024-10-31)","verifiedSummary":"I re-derived the report's numbers independently from the CSVs at /Users/kgundu1/BioBalance/data/raw/extracted/ and fetched every external URL. The schema and join findings are exact, the licen…"
    },
    {
      "type": "workflow_agent",
      "index": 8,
      "label": "verify:dishes",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "ae505b172a21f71a1",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788536433444,
      "queuedAt": 1788536431387,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Adversarial verification of research on composition and sta…",
      "promptPreview": "CRITICAL — this is a nutrition tracker. **NEVER invent, estimate from memory, or interpolate a
nutrition value.** A fabricated micronutrient number is worse than no number, because the app
renders it with the same confidence as a measured one. Every quantitative nutrition claim you
report must carry a citable source (URL, publication, table number). If you cannot source it,
say so explicitly and m…",
      "lastProgressAt": 1788537459081,
      "tokens": 150677,
      "toolCalls": 44,
      "durationMs": 1025637,
      "resultPreview": "{"topic":"Adversarial verification of research on composition and standard serving sizes of common Indian vegetarian dishes (INDB recipe corpus, ICMR-NIN katori standards, USDA yield/retention factors) for TrackIt","corrections":[{"originalClaim":"Deriving the lentil yield factor from iron (7.54 -> 3.33 mg/100 g) gives 2.26x; therefore the true lentil yield is somewhere in ~2.3-3.0x. Source cit…"
    },
    {
      "type": "workflow_agent",
      "index": 9,
      "label": "verify:ifct",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "a811cd35a9f82ddeb",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788536503323,
      "queuedAt": 1788536501151,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "IFCT 2017 and Indian national food composition data — adver…",
      "promptPreview": "CRITICAL — this is a nutrition tracker. **NEVER invent, estimate from memory, or interpolate a
nutrition value.** A fabricated micronutrient number is worse than no number, because the app
renders it with the same confidence as a measured one. Every quantitative nutrition claim you
report must carry a citable source (URL, publication, table number). If you cannot source it,
say so explicitly and m…",
      "lastProgressAt": 1788537432732,
      "tokens": 138834,
      "toolCalls": 63,
      "durationMs": 929409,
      "resultPreview": "{"topic":"IFCT 2017 and Indian national food composition data — adversarial verification of research findings for TrackIt","verifiedSummary":"I verified the findings against the primary source (both official NIN PDFs, downloaded and text-extracted), the actual nodef and INDB files, the local USDA CSVs, and live HTTP checks. The two load-bearing conclusions survive: the copyright clause is quote…"
    },
    {
      "type": "workflow_agent",
      "index": 10,
      "label": "verify:other-sources",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "a86524d6b6acb2618",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788536579475,
      "queuedAt": 1788536577413,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Adversarial verification of "Other usable Indian / South As…",
      "promptPreview": "CRITICAL — this is a nutrition tracker. **NEVER invent, estimate from memory, or interpolate a
nutrition value.** A fabricated micronutrient number is worse than no number, because the app
renders it with the same confidence as a measured one. Every quantitative nutrition claim you
report must carry a citable source (URL, publication, table number). If you cannot source it,
say so explicitly and m…",
      "lastProgressAt": 1788537487834,
      "tokens": 130594,
      "toolCalls": 52,
      "durationMs": 908358,
      "resultPreview": "{"topic":"Adversarial verification of \\"Other usable Indian / South Asian food composition sources\\" for TrackIt — INDB, @ifct2017/compositions, Open Food Facts, FAO/INFOODS, and regional South Asian FCTs","verifiedSummary":"I independently re-ran essentially every measurable claim. The report is unusually disciplined about nutrition values — its stated commitment that it \\"did not extract, est…"
    },
    {
      "type": "workflow_agent",
      "index": 11,
      "label": "ingestion-plan",
      "phaseIndex": 3,
      "phaseTitle": "Plan",
      "agentId": "affd1ee5d6f13984a",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788537493328,
      "queuedAt": 1788537489919,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd /Users/kgundu1/BioBalance/data/raw/extracted/FoodData_Ce…",
      "promptPreview": "# TrackIt

A personal nutrition tracker (macOS desktop + Android, Tauri v2 + Rust + React) that already
ships a 37 MB bundled reference database built from USDA FoodData Central:

- Foundation Foods 2026-04-30 (395 foods), SR Legacy 2018-04 (7,793), FNDDS 2024-10-31 (5,432)
- Plus the USDA/ARS Iodine Database Release 4 as an overlay (372 foods matched)
- 13,694 foods, 1,018,922 nutrient values,…",
      "lastProgressAt": 1788538050057,
      "tokens": 198164,
      "toolCalls": 21,
      "durationMs": 556728,
      "resultPreview": "I have verified the load-bearing facts firsthand against the local data. Writing the plan.

---

# Extending TrackIt with Indian Vegetarian Food Data

**Status:** plan, ready to implement. Every quantitative claim below was measured against `/Users/kgundu1/BioBalance/data/raw/extracted/` in this session, or carries a citation. Where a number could not be sourced it is marked **unavailable** rat…"
    }
  ],
  "totalTokens": 1610258,
  "totalToolCalls": 541
}