//! Reading a Supplement Facts panel onto this app's nutrient bases.
//!
//! A supplement panel differs from a nutrition panel in three ways that all
//! have to be handled here rather than in the UI or the store:
//!
//! 1. **Its figures are per label serving and scale by count**, not by mass.
//!    There is no per-100 g step; see [`crate::aggregate::Contribution::Dose`].
//! 2. **It routinely prints International Units**, and an IU converts only when
//!    the chemical compound is known (`docs/decisions.md` D6). FDA states it
//!    outright: "There is no direct conversion factor from the vitamin A
//!    declared on labels in IU to mcg RAE." A form left unnamed is therefore a
//!    refusal, never a default — guessing retinol on a beta-carotene product
//!    fires exactly the false toxicity warning D5 exists to prevent.
//! 3. **Its silence means different things in different places.** A US panel
//!    must not declare one of the fifteen mandatory nutrients below the
//!    declarable-zero threshold, so omitting one is a bounded assertion. Every
//!    other nutrient is voluntary and its omission bounds nothing. See
//!    [`omission`].
//!
//! Factors are from FDA, *Converting Units of Measure for Folate, Niacin, and
//! Vitamins A, D, and E on the Nutrition and Supplement Facts Labels: Guidance
//! for Industry* (August 2019), and 21 CFR 101.9(c)(8)(iv). They confirm the
//! three figures `docs/decisions.md` D6 already records.

use crate::label;
use crate::NutrientValue;
use serde::{Deserialize, Serialize};

/// The magnitude a panel prints a figure in.
///
/// `Iu` is deliberately one of these rather than a separate concept: on a real
/// pack it sits in the same position as `mg`, and treating it as just another
/// magnitude is what would let it be scaled arithmetically. It cannot be — it
/// is a basis, and [`convert`] refuses it unless the compound is named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelUnit {
    G,
    Mg,
    /// Micrograms. A panel writes this "mcg"; the two micro-sign codepoints
    /// (U+00B5 and U+03BC) and "ug" all normalise here at parse time.
    Ug,
    Iu,
    Kcal,
}

impl LabelUnit {
    /// Grams per one of these, for the mass units. `None` for IU and kcal,
    /// which are not masses and have no such ratio.
    fn grams(self) -> Option<f64> {
        match self {
            LabelUnit::G => Some(1.0),
            LabelUnit::Mg => Some(1e-3),
            LabelUnit::Ug => Some(1e-6),
            LabelUnit::Iu | LabelUnit::Kcal => None,
        }
    }

    pub fn parse(s: &str) -> Option<LabelUnit> {
        match s.trim().to_lowercase().as_str() {
            "g" => Some(LabelUnit::G),
            "mg" => Some(LabelUnit::Mg),
            // U+00B5 MICRO SIGN and U+03BC GREEK SMALL LETTER MU are distinct
            // codepoints and both appear on real packs.
            "ug" | "mcg" | "\u{b5}g" | "\u{3bc}g" => Some(LabelUnit::Ug),
            "iu" => Some(LabelUnit::Iu),
            "kcal" => Some(LabelUnit::Kcal),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LabelUnit::G => "g",
            LabelUnit::Mg => "mg",
            LabelUnit::Ug => "ug",
            LabelUnit::Iu => "IU",
            LabelUnit::Kcal => "kcal",
        }
    }
}

/// The chemical compound a panel names, where naming it changes the arithmetic.
///
/// Only the forms that carry a *different factor* are enumerated. Magnesium
/// oxide versus citrate is not here, because 21 CFR 101.36(b)(3)(ii) makes both
/// declare elemental magnesium — the salt is named on the pack but never
/// applied as a fraction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Form {
    /// The pack does not say. For a form-dependent nutrient this is a refusal.
    Unspecified,

    /// Vitamin A as retinol or a retinyl ester (acetate, palmitate). The ester
    /// needs no extra correction: the declared weight is the weight of the
    /// vitamin, not of the ester (21 CFR 101.36(b)(3)(ii)).
    Retinol,
    /// Beta-carotene as a purified supplemental ingredient, in oil.
    BetaCaroteneSupplemental,
    /// Beta-carotene arriving as food — algae, carrot concentrate, a whole-food
    /// blend. Absorbed far less well, hence a factor 2.4x smaller.
    BetaCaroteneDietary,

    /// Vitamin D2 or D3, or an unstated mix. Vitamin D is the one case where an
    /// unstated form is safe: FDA treats D2 and D3 as bioequivalent **for unit
    /// conversion**, so the factor does not depend on which it is. That is a
    /// labelling equivalence and not a claim that they raise serum 25(OH)D
    /// equally — do not let the UI upgrade it into one.
    VitaminD,

    /// Natural vitamin E: RRR-alpha-tocopherol ("d-alpha"), including its
    /// acetate and succinate esters, which FDA folds into the same factor.
    AlphaTocopherolNatural,
    /// Synthetic vitamin E: all-rac-alpha-tocopherol ("dl-alpha"), including
    /// its esters. Only four of its eight stereoisomers count toward the RDA,
    /// which is why the factor is roughly half the natural one.
    AlphaTocopherolSynthetic,

    /// Folic acid (pteroylmonoglutamic acid), the synthetic form.
    FolicAcid,
    /// Folate occurring naturally in a whole-food or yeast ingredient.
    FoodFolate,
    /// L-5-methyltetrahydrofolate — "methylfolate", Metafolin, Quatrefolic.
    /// **Not folic acid**, so it must never count toward the folic-acid upper
    /// limit even though it does count toward the Daily Value.
    Methylfolate,
}

impl Form {
    pub fn as_str(self) -> &'static str {
        match self {
            Form::Unspecified => "unspecified",
            Form::Retinol => "retinol",
            Form::BetaCaroteneSupplemental => "beta_carotene_supplemental",
            Form::BetaCaroteneDietary => "beta_carotene_dietary",
            Form::VitaminD => "vitamin_d",
            Form::AlphaTocopherolNatural => "alpha_tocopherol_natural",
            Form::AlphaTocopherolSynthetic => "alpha_tocopherol_synthetic",
            Form::FolicAcid => "folic_acid",
            Form::FoodFolate => "food_folate",
            Form::Methylfolate => "methylfolate",
        }
    }

    pub fn parse(s: &str) -> Option<Form> {
        match s {
            "unspecified" => Some(Form::Unspecified),
            "retinol" => Some(Form::Retinol),
            "beta_carotene_supplemental" => Some(Form::BetaCaroteneSupplemental),
            "beta_carotene_dietary" => Some(Form::BetaCaroteneDietary),
            "vitamin_d" => Some(Form::VitaminD),
            "alpha_tocopherol_natural" => Some(Form::AlphaTocopherolNatural),
            "alpha_tocopherol_synthetic" => Some(Form::AlphaTocopherolSynthetic),
            "folic_acid" => Some(Form::FolicAcid),
            "food_folate" => Some(Form::FoodFolate),
            "methylfolate" => Some(Form::Methylfolate),
            _ => None,
        }
    }
}

/// Nutrient ids whose stored basis is not a plain mass, so a figure off a pack
/// has to be put onto that basis before it can be summed.
pub const VITAMIN_A: i64 = 1106;
pub const VITAMIN_D: i64 = 1114;
pub const VITAMIN_E: i64 = 1109;
pub const FOLATE_DFE: i64 = 1190;

/// The fifteen nutrients 21 CFR 101.36(b)(2)(i) makes mandatory on a US
/// Supplement Facts panel.
///
/// The paragraph closes the loop from both sides: these "shall be declared
/// when they are present ... in amounts that exceed the amount that can be
/// declared as zero", and "any (b)(2)-dietary ingredients that are not present,
/// or that are present in amounts that can be declared as zero ... shall not be
/// declared". Declaration above the threshold is compulsory and declaration
/// below it is forbidden, so leaving one of these out is a regulated assertion
/// with a known ceiling — which is what [`omission`] turns into a bound.
///
/// Every other nutrient is voluntary under 101.36(b)(2)(ii): it need be
/// declared only when added for supplementation or when a claim is made about
/// it. Its omission asserts nothing at all.
pub const US_MANDATORY: &[i64] = &[
    1008, // Energy
    1004, // Total fat
    1258, // Saturated fat
    1257, // Trans fat
    1253, // Cholesterol
    1093, // Sodium
    1005, // Total carbohydrate
    1079, // Dietary fibre
    2000, // Total sugars
    1235, // Added sugars
    1003, // Protein
    1114, // Vitamin D
    1087, // Calcium
    1089, // Iron
    1092, // Potassium
];

/// Which labelling regime a pack was printed under.
///
/// This is not bureaucratic detail: it decides what the panel's *silence*
/// means, and the two regimes differ completely. It is asked once per
/// supplement rather than inferred, because nothing about a bottle in a kitchen
/// says which market it was printed for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Regime {
    /// A US "Supplement Facts" panel under 21 CFR 101.36.
    Us,
    /// Anything else — an Indian FSSAI panel, or a pack whose regime is not
    /// known. FSSAI has no mandatory micronutrient list and no declarable-zero
    /// threshold, so an omission bounds nothing.
    Other,
}

/// What a panel's silence about a nutrient is worth.
///
/// `complete` is the user's own assertion that the panel lists everything in
/// the product. It is the **only** route to a true zero here, and it is a claim
/// the person makes, never one the regulation supports on its own: a nutrient
/// can be present from an undeclared route — a botanical extract, an algae or
/// yeast base, an oil carrier — and no rule requires that to be declared.
pub fn omission(nutrient_id: i64, regime: Regime, complete: bool) -> NutrientValue {
    if complete {
        // The user says the pack lists everything, so an absent line is an
        // asserted absence: bounded at zero, and counted as covered.
        return NutrientValue::AssumedZero;
    }
    if regime == Regime::Us && US_MANDATORY.contains(&nutrient_id) {
        // Omitting one of the fifteen asserts "below the declarable-zero
        // threshold" — an interval [0, ceiling], not the point zero. The
        // ceilings are the ones label.rs already derives from 21 CFR 101.9(c),
        // so there is no second table to drift.
        return match label::rounding_ceiling(nutrient_id) {
            Some(upper) => NutrientValue::LabelZero { upper },
            None => NutrientValue::ZeroUnknown,
        };
    }
    NutrientValue::Absent
}

/// Why a printed figure could not be put on this app's basis.
///
/// Carried rather than swallowed: the row keeps what the pack said, and the
/// screen says why it cannot be counted, so a panel this app cannot read never
/// looks like a panel that was silent.
pub type Refusal = String;

/// Put one printed figure onto the basis this app stores the nutrient in.
///
/// `target` is the nutrient's own magnitude from the reference database ("g",
/// "mg", "ug", "kcal"). The result is per **one label serving** — the count of
/// servings taken is applied later, by `aggregate`, and never here.
pub fn convert(
    nutrient_id: i64,
    target: &str,
    amount: f64,
    unit: LabelUnit,
    form: Form,
) -> Result<f64, Refusal> {
    if !amount.is_finite() || amount < 0.0 {
        return Err("A printed amount must be a number, zero or more.".into());
    }

    // ── International Units ──────────────────────────────────────────────
    // An IU is a measure of biological activity, so the mass it stands for
    // depends on the compound. There is no general IU-to-mass factor and this
    // function must never invent one.
    if unit == LabelUnit::Iu {
        let factor = match (nutrient_id, form) {
            // FDA Guidance Table 3; 21 CFR 101.9(c)(8)(iv) footnote 3.
            (VITAMIN_A, Form::Retinol) => 0.3,
            (VITAMIN_A, Form::BetaCaroteneSupplemental) => 0.3,
            (VITAMIN_A, Form::BetaCaroteneDietary) => 0.05,
            (VITAMIN_A, _) => {
                return Err(
                    "Vitamin A in IU converts by 0.3 µg RAE per IU if it is retinol or a \
                     retinyl ester, and by 0.05 if it is beta-carotene from a food \
                     ingredient — a sixfold difference. Name the form the pack gives, or \
                     leave this line out rather than guessing."
                        .into(),
                )
            }
            // 1 µg cholecalciferol = 40 IU, definitionally, and FDA treats D2
            // and D3 as bioequivalent for conversion — so the form does not
            // change the arithmetic here.
            (VITAMIN_D, _) => 0.025,
            // FDA Guidance Table 6. The ester forms are folded in: do not apply
            // a further molecular-weight correction for acetate or succinate.
            (VITAMIN_E, Form::AlphaTocopherolNatural) => 0.67,
            (VITAMIN_E, Form::AlphaTocopherolSynthetic) => 0.45,
            (VITAMIN_E, _) => {
                return Err(
                    "Vitamin E in IU converts by 0.67 mg per IU if it is natural \
                     (d-alpha-tocopherol) and by 0.45 if it is synthetic (dl-alpha) — the \
                     single letter is a 1.49x difference. Name the form the pack gives, or \
                     leave this line out rather than guessing."
                        .into(),
                )
            }
            _ => {
                return Err(
                    "IU is a measure of biological activity and has a different mass for \
                     every compound. This app knows the conversion only for vitamins A, D \
                     and E; enter this line in mg or µg instead."
                        .into(),
                )
            }
        };
        // Each factor above yields the nutrient's own canonical magnitude —
        // µg RAE for A, µg for D, mg alpha-tocopherol for E. Checked rather
        // than assumed: if a reference-data rebuild ever restated one of these
        // in another magnitude, silently returning the old one would be wrong
        // by a factor of a thousand with nothing to show for it.
        let expected = match nutrient_id {
            VITAMIN_A | VITAMIN_D => "ug",
            VITAMIN_E => "mg",
            _ => unreachable!("every IU factor above is one of these three"),
        };
        if target != expected {
            return Err(format!(
                "This app stores that nutrient in {target}, but its IU conversion yields \
                 {expected}. Refusing rather than guessing which is right."
            ));
        }
        return Ok(amount * factor);
    }

    // ── energy ───────────────────────────────────────────────────────────
    // Checked BEFORE the mass conversion below. kcal is not a mass and has no
    // grams-per-unit, so falling through would reject every calorie line a
    // panel prints on its way past the rescale.
    if unit == LabelUnit::Kcal || target == "kcal" {
        if unit != LabelUnit::Kcal || target != "kcal" {
            return Err(
                "Energy is printed in kcal and is not interchangeable with a mass.".into(),
            );
        }
        return Ok(amount);
    }

    // ── mass units ───────────────────────────────────────────────────────
    let from = unit
        .grams()
        .ok_or_else(|| format!("{} is not a mass and cannot be rescaled.", unit.as_str()))?;
    let to = LabelUnit::parse(target)
        .and_then(|u| u.grams())
        .ok_or_else(|| format!("This app stores that nutrient in {target}, which is not a mass."))?;
    let rescaled = amount * (from / to);

    // ── basis, where the printed figure is not already on the stored one ──
    //
    // On this path `form` names **what the typed figure measures**, not what is
    // in the pill. The distinction is load-bearing: 21 CFR 101.36 makes a
    // compliant panel print vitamin A as mcg RAE and folate as mcg DFE, so a
    // product containing beta-carotene still prints RAE and a product
    // containing folic acid still prints DFE. Applying the compound's factor to
    // the panel's own figure would convert a number that has already been
    // converted — the same double-count the vitamin E note below warns about.
    //
    // `Unspecified` therefore means "as the panel prints it" and takes no
    // factor. The alternatives are for a figure read off the ingredient
    // statement instead, where the compound really is what was measured.
    let basis = match (nutrient_id, form) {
        (_, Form::Unspecified) => 1.0,

        // 1 µg folic acid taken with food counts as 1.7 µg DFE. This is the
        // only factor a US panel uses, whatever time of day the pill is taken;
        // the 2.0 empty-stomach figure is physiological, is not a labelling
        // factor, and is deliberately not applied here.
        (FOLATE_DFE, Form::FolicAcid) => 1.7,
        // FDA's stated ceiling for any synthetic folate other than folic acid.
        // A manufacturer may use its own lower factor, so where the pack prints
        // µg DFE directly, prefer that line over this one.
        (FOLATE_DFE, Form::Methylfolate) => 1.7,
        (FOLATE_DFE, Form::FoodFolate) => 1.0,

        // µg retinol IS µg RAE, by the definition of the unit.
        (VITAMIN_A, Form::Retinol) => 1.0,
        // Supplemental beta-carotene: 2 µg per 1 µg RAE. Dietary: 12 µg.
        (VITAMIN_A, Form::BetaCaroteneSupplemental) => 0.5,
        (VITAMIN_A, Form::BetaCaroteneDietary) => 1.0 / 12.0,

        // A post-2020 panel's "Vitamin E __ mg" line is already the label-claim
        // milligram figure, so it needs no divisor. Applying Table 5's /2 for
        // all-rac here would halve a figure that has already had it applied.
        (VITAMIN_E, _) => 1.0,

        _ => 1.0,
    };

    Ok(rescaled * basis)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn vitamin_d_converts_from_iu_without_knowing_the_form() {
        // 1,000 IU of D3 is 25 µg. The factor is the same for D2, which is why
        // an unspecified form is safe here and nowhere else.
        assert!(close(
            convert(VITAMIN_D, "ug", 1000.0, LabelUnit::Iu, Form::Unspecified).unwrap(),
            25.0
        ));
        assert!(close(
            convert(VITAMIN_D, "ug", 1000.0, LabelUnit::Iu, Form::VitaminD).unwrap(),
            25.0
        ));
    }

    #[test]
    fn vitamin_e_in_iu_refuses_to_guess_between_natural_and_synthetic() {
        // The whole point of D6: one letter on the pack is a 1.49x difference,
        // so an unnamed form must refuse rather than pick a side.
        let refused = convert(VITAMIN_E, "mg", 400.0, LabelUnit::Iu, Form::Unspecified);
        assert!(refused.is_err(), "an unnamed vitamin E form must refuse");

        let natural =
            convert(VITAMIN_E, "mg", 400.0, LabelUnit::Iu, Form::AlphaTocopherolNatural).unwrap();
        let synthetic = convert(
            VITAMIN_E,
            "mg",
            400.0,
            LabelUnit::Iu,
            Form::AlphaTocopherolSynthetic,
        )
        .unwrap();
        assert!(close(natural, 268.0));
        assert!(close(synthetic, 180.0));
        assert!(natural > synthetic);
    }

    #[test]
    fn vitamin_a_in_iu_refuses_to_guess_between_retinol_and_carotene() {
        // Guessing retinol on a beta-carotene product is the false toxicity
        // warning D5 was written to prevent.
        assert!(convert(VITAMIN_A, "ug", 5000.0, LabelUnit::Iu, Form::Unspecified).is_err());
        assert!(close(
            convert(VITAMIN_A, "ug", 5000.0, LabelUnit::Iu, Form::Retinol).unwrap(),
            1500.0
        ));
        assert!(close(
            convert(
                VITAMIN_A,
                "ug",
                5000.0,
                LabelUnit::Iu,
                Form::BetaCaroteneDietary
            )
            .unwrap(),
            250.0
        ));
    }

    #[test]
    fn folic_acid_becomes_dietary_folate_equivalents() {
        // "400 mcg folic acid" is 680 µg DFE, which is what the app's 400 µg
        // DFE target must be read against.
        assert!(close(
            convert(FOLATE_DFE, "ug", 400.0, LabelUnit::Ug, Form::FolicAcid).unwrap(),
            680.0
        ));
        // A panel already printing µg DFE needs no factor.
        assert!(close(
            convert(FOLATE_DFE, "ug", 680.0, LabelUnit::Ug, Form::Unspecified).unwrap(),
            680.0
        ));
    }

    #[test]
    fn a_mineral_is_taken_as_elemental_and_never_scaled_by_its_salt() {
        // 21 CFR 101.36(b)(3)(ii): the declared weight is the weight of the
        // nutrient, not of magnesium oxide. Applying the 60.3% MgO fraction
        // here would understate the dose by 40%.
        assert!(close(
            convert(1090, "mg", 200.0, LabelUnit::Mg, Form::Unspecified).unwrap(),
            200.0
        ));
    }

    #[test]
    fn magnitudes_rescale() {
        // 1,000 µg of B12 stored in µg, and 1 mg of the same thing.
        assert!(close(
            convert(1178, "ug", 1.0, LabelUnit::Mg, Form::Unspecified).unwrap(),
            1000.0
        ));
        assert!(close(
            convert(1087, "mg", 1.0, LabelUnit::G, Form::Unspecified).unwrap(),
            1000.0
        ));
    }

    #[test]
    fn iu_is_refused_for_a_nutrient_that_has_no_iu_meaning() {
        assert!(convert(1087, "mg", 500.0, LabelUnit::Iu, Form::Unspecified).is_err());
    }

    #[test]
    fn micrograms_are_spelled_four_ways_on_real_packs() {
        for s in ["ug", "mcg", "MCG", "\u{b5}g", "\u{3bc}g"] {
            assert_eq!(LabelUnit::parse(s), Some(LabelUnit::Ug), "failed on {s:?}");
        }
    }

    // ── what a panel's silence is worth ─────────────────────────────────

    #[test]
    fn an_omitted_mandatory_nutrient_on_a_us_panel_is_a_bound_not_a_gap() {
        // Sodium is one of the fifteen. A US panel omitting it asserts "below
        // 5 mg", which is information — bounded and covered.
        match omission(1093, Regime::Us, false) {
            NutrientValue::LabelZero { upper } => assert!(close(upper, 5.0)),
            other => panic!("expected a bound for omitted sodium, got {other:?}"),
        }
        assert!(omission(1093, Regime::Us, false).is_covered());
    }

    #[test]
    fn an_omitted_voluntary_nutrient_bounds_nothing_even_on_a_us_panel() {
        // Selenium is voluntary under 101.36(b)(2)(ii). It need not be declared
        // if it was not added for supplementation, so its absence from the
        // panel says nothing about whether the product contains any.
        assert_eq!(omission(1103, Regime::Us, false), NutrientValue::Absent);
        assert!(!omission(1103, Regime::Us, false).is_covered());
    }

    #[test]
    fn an_indian_panel_bounds_nothing_by_omission() {
        // FSSAI has no mandatory micronutrient list and no declarable-zero
        // threshold, so even sodium's absence asserts nothing.
        assert_eq!(omission(1093, Regime::Other, false), NutrientValue::Absent);
        assert_eq!(omission(1103, Regime::Other, false), NutrientValue::Absent);
    }

    #[test]
    fn only_the_users_own_assertion_produces_a_true_zero() {
        // No regulation supports this; the person holding the bottle does.
        assert_eq!(omission(1103, Regime::Other, true), NutrientValue::AssumedZero);
        assert_eq!(omission(1103, Regime::Us, true), NutrientValue::AssumedZero);
        assert!(omission(1103, Regime::Other, true).is_covered());
    }

    #[test]
    fn the_mandatory_list_is_the_fifteen_the_regulation_names() {
        assert_eq!(US_MANDATORY.len(), 15);
        let mut seen = US_MANDATORY.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 15, "no duplicates");
    }

    #[test]
    fn energy_in_kcal_converts_rather_than_being_refused_as_a_non_mass() {
        // A supplement panel prints calories. This must not fall into the
        // "not a mass" rejection on its way past the magnitude branch.
        assert_eq!(convert(1008, "kcal", 5.0, LabelUnit::Kcal, Form::Unspecified), Ok(5.0));
    }

    #[test]
    fn a_compliant_panels_own_figure_needs_no_factor() {
        // 21 CFR 101.36 makes a US panel print vitamin A in mcg RAE and folate
        // in mcg DFE. Those figures are ALREADY on this app's basis, so an
        // unstated form must mean "as printed" and not a refusal.
        assert!(close(convert(VITAMIN_A, "ug", 900.0, LabelUnit::Ug, Form::Unspecified).unwrap(), 900.0));
        assert!(close(convert(FOLATE_DFE, "ug", 680.0, LabelUnit::Ug, Form::Unspecified).unwrap(), 680.0));
    }

    #[test]
    fn a_negative_or_nonsense_figure_is_rejected_rather_than_scaled() {
        assert!(convert(1087, "mg", -1.0, LabelUnit::Mg, Form::Unspecified).is_err());
        assert!(convert(1087, "mg", f64::NAN, LabelUnit::Mg, Form::Unspecified).is_err());
    }
}


