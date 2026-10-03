//! Reading a "% Daily Value" off a nutrition panel.
//!
//! A percentage is only a figure once you know what it is a percentage *of*,
//! and US panels have used two different sets of answers:
//!
//! - **Current labels** (the 2016 rule, on packs from 2020 onward) use the
//!   Daily Values in [`crate::targets`], and print the amount beside the
//!   percentage for every vitamin and mineral.
//! - **Older labels** use the 1993 Reference Daily Intakes and Daily Reference
//!   Values, and print vitamins and minerals as a percentage *only* — the
//!   familiar "Vitamin A 10% • Vitamin C 4%" rows, above a footnote table for
//!   2,000 and 2,500 calorie diets.
//!
//! The two disagree by enough to matter. Milk's "Calcium 30%" is 300 mg on an
//! older label and would be 390 mg read against today's 1,300 mg; its "Vitamin
//! D 25%" is 100 IU, which is 2.5 µg, and would be 5 µg today. So the basis is
//! the person's statement about the pack in front of them, made once per food,
//! and never inferred.
//!
//! Older labels also state vitamins A, D and E in International Units, and
//! folate as plain micrograms rather than today's dietary folate equivalents.
//! Converting those needs the compound, exactly as on a supplement panel
//! (`docs/decisions.md` D6), so the arithmetic is the supplement module's and
//! an unnamed compound is a refusal rather than a default.

use crate::supplement::{self, Form, LabelUnit};
use crate::targets;
use serde::{Deserialize, Serialize};

/// Which Daily Values a panel's percentages are of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    /// The 2016 rule's Daily Values, on packs from 2020 onward.
    Current,
    /// The 1993 Reference Daily Intakes and Daily Reference Values.
    Older,
}

impl Basis {
    pub fn parse(s: &str) -> Option<Basis> {
        match s {
            "current" => Some(Basis::Current),
            "older" => Some(Basis::Older),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Basis::Current => "current",
            Basis::Older => "older",
        }
    }
}

/// The reference amounts behind an older panel's percentages: 21 CFR
/// 101.9(c)(8)(iv) and (c)(9) as they stood before the 2016 revision, for
/// adults and children four and over. Chloride is left out because this app
/// does not track it.
const OLDER: &[(i64, f64, LabelUnit)] = &[
    (1004, 65.0, LabelUnit::G),     // Total fat
    (1258, 20.0, LabelUnit::G),     // Saturated fat
    (1253, 300.0, LabelUnit::Mg),   // Cholesterol
    (1093, 2400.0, LabelUnit::Mg),  // Sodium
    (1092, 3500.0, LabelUnit::Mg),  // Potassium
    (1005, 300.0, LabelUnit::G),    // Total carbohydrate
    (1079, 25.0, LabelUnit::G),     // Dietary fibre
    (1003, 50.0, LabelUnit::G),     // Protein
    (1106, 5000.0, LabelUnit::Iu),  // Vitamin A
    (1162, 60.0, LabelUnit::Mg),    // Vitamin C
    (1087, 1000.0, LabelUnit::Mg),  // Calcium
    (1089, 18.0, LabelUnit::Mg),    // Iron
    (1114, 400.0, LabelUnit::Iu),   // Vitamin D
    (1109, 30.0, LabelUnit::Iu),    // Vitamin E
    (1185, 80.0, LabelUnit::Ug),    // Vitamin K
    (1165, 1.5, LabelUnit::Mg),     // Thiamin
    (1166, 1.7, LabelUnit::Mg),     // Riboflavin
    (1167, 20.0, LabelUnit::Mg),    // Niacin
    (1175, 2.0, LabelUnit::Mg),     // Vitamin B6
    (1190, 400.0, LabelUnit::Ug),   // Folate, as plain µg — see `forms`
    (1178, 6.0, LabelUnit::Ug),     // Vitamin B12
    (1176, 300.0, LabelUnit::Ug),   // Biotin
    (1170, 10.0, LabelUnit::Mg),    // Pantothenic acid
    (1091, 1000.0, LabelUnit::Mg),  // Phosphorus
    (1100, 150.0, LabelUnit::Ug),   // Iodine
    (1090, 400.0, LabelUnit::Mg),   // Magnesium
    (1095, 15.0, LabelUnit::Mg),    // Zinc
    (1103, 70.0, LabelUnit::Ug),    // Selenium
    (1098, 2.0, LabelUnit::Mg),     // Copper
    (1101, 2.0, LabelUnit::Mg),     // Manganese
    (1096, 120.0, LabelUnit::Ug),   // Chromium
    (1102, 75.0, LabelUnit::Ug),    // Molybdenum
];

/// How each nutrient that carries a Daily Value is named on a panel, in the
/// order a panel lists it.
pub const NAMES: &[(i64, &str)] = &[
    (1004, "Total fat"),
    (1258, "Saturated fat"),
    (1253, "Cholesterol"),
    (1093, "Sodium"),
    (1005, "Total carbohydrate"),
    (1079, "Dietary fiber"),
    (1235, "Added sugars"),
    (1003, "Protein"),
    (1106, "Vitamin A"),
    (1162, "Vitamin C"),
    (1114, "Vitamin D"),
    (1087, "Calcium"),
    (1089, "Iron"),
    (1092, "Potassium"),
    (1109, "Vitamin E"),
    (1185, "Vitamin K"),
    (1165, "Thiamin"),
    (1166, "Riboflavin"),
    (1167, "Niacin"),
    (1175, "Vitamin B6"),
    (1190, "Folate"),
    (1178, "Vitamin B12"),
    (1176, "Biotin"),
    (1170, "Pantothenic acid"),
    (1091, "Phosphorus"),
    (1100, "Iodine"),
    (1090, "Magnesium"),
    (1095, "Zinc"),
    (1103, "Selenium"),
    (1098, "Copper"),
    (1101, "Manganese"),
    (1096, "Chromium"),
    (1102, "Molybdenum"),
    (1180, "Choline"),
];

pub fn name(nutrient_id: i64) -> Option<&'static str> {
    NAMES.iter().find(|(id, _)| *id == nutrient_id).map(|(_, n)| *n)
}

/// What an older panel's 100% was, as it printed it.
pub fn older_reference(nutrient_id: i64) -> Option<(f64, LabelUnit)> {
    OLDER
        .iter()
        .find(|(id, _, _)| *id == nutrient_id)
        .map(|(_, amount, unit)| (*amount, *unit))
}

/// The magnitude this app stores a nutrient in, read off the Daily Value
/// table rather than restated, so the two cannot disagree.
fn stored_unit(nutrient_id: i64) -> Option<&'static str> {
    targets::all()
        .into_iter()
        .find(|d| d.nutrient_id == nutrient_id)
        .map(|d| d.unit)
}

/// The compounds a percentage has to be told about before it can be counted.
///
/// Empty means none: the percentage converts as it stands. Only an older panel
/// ever asks, because only there is the reference amount in a unit that
/// depends on the compound — IU for vitamins A and E, and plain micrograms of
/// folate where today's labels count dietary folate equivalents.
pub fn forms(nutrient_id: i64, basis: Basis) -> &'static [Form] {
    match (basis, nutrient_id) {
        (Basis::Older, supplement::VITAMIN_A) => &[
            Form::Retinol,
            Form::BetaCaroteneSupplemental,
            Form::BetaCaroteneDietary,
        ],
        (Basis::Older, supplement::VITAMIN_E) => {
            &[Form::AlphaTocopherolNatural, Form::AlphaTocopherolSynthetic]
        }
        (Basis::Older, supplement::FOLATE_DFE) => &[Form::FolicAcid, Form::FoodFolate],
        _ => &[],
    }
}

/// What 1% of the Daily Value is, in the magnitude this app stores the
/// nutrient in, per serving.
///
/// `form` is consulted only where [`forms`] lists some, and must be one of
/// them; elsewhere it is ignored. The refusals are sentences, because the
/// screen shows them on the line they belong to.
pub fn per_percent(nutrient_id: i64, basis: Basis, form: Form) -> Result<f64, String> {
    let label = name(nutrient_id).unwrap_or("This nutrient");
    let stored = stored_unit(nutrient_id);
    match basis {
        Basis::Current => targets::for_nutrient(nutrient_id)
            .map(|dv| dv / 100.0)
            .ok_or_else(|| format!("{label} has no Daily Value, so a percentage of it is not a figure.")),
        Basis::Older => {
            let (amount, unit) = older_reference(nutrient_id).ok_or_else(|| {
                format!("{label} had no Daily Value on older labels; enter the amount instead.")
            })?;
            let stored = stored.ok_or_else(|| {
                format!("{label} is not stored in a unit this app can convert a percentage into.")
            })?;
            let allowed = forms(nutrient_id, basis);
            let form = if allowed.is_empty() {
                Form::Unspecified
            } else if allowed.contains(&form) {
                form
            } else {
                return Err(match nutrient_id {
                    supplement::VITAMIN_A => "Older labels give vitamin A as a share of 5,000 IU, and an IU of retinol \
                         is six times the vitamin A of an IU of beta-carotene from food. Say \
                         which this is — milk is fortified with retinol, as vitamin A palmitate."
                        .to_string(),
                    supplement::VITAMIN_E => "Older labels give vitamin E as a share of 30 IU, and an IU is 0.67 mg if \
                         natural (d-alpha) and 0.45 mg if synthetic (dl-alpha). Say which this is."
                        .to_string(),
                    _ => "Older labels count folate as plain micrograms; folic acid added to a food \
                         counts 1.7 times over in today's terms. Say whether this is added folic \
                         acid or folate the food has naturally."
                        .to_string(),
                });
            };
            supplement::convert(nutrient_id, stored, amount / 100.0, unit, form)
        }
    }
}

/// The amount below which a percentage may be printed as 0: 2% of the Daily
/// Value, under the basis the panel uses (21 CFR 101.9(c)(8)(iii), then and
/// now). Per serving, in the stored magnitude.
pub fn zero_ceiling(nutrient_id: i64, basis: Basis, form: Form) -> Result<f64, String> {
    per_percent(nutrient_id, basis, form).map(|p| p * 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn of(pct: f64, id: i64, basis: Basis, form: Form) -> f64 {
        pct * per_percent(id, basis, form).unwrap()
    }

    #[test]
    fn an_older_milk_label_reads_as_the_milk_it_describes() {
        // One cup of fortified milk, older panel: Vitamin A 10% • Vitamin C 4%,
        // Vitamin D 25% • Calcium 30%.
        assert!(close(of(10.0, 1106, Basis::Older, Form::Retinol), 150.0)); // 500 IU retinol
        assert!(close(of(4.0, 1162, Basis::Older, Form::Unspecified), 2.4));
        assert!(close(of(25.0, 1114, Basis::Older, Form::Unspecified), 2.5)); // 100 IU
        assert!(close(of(30.0, 1087, Basis::Older, Form::Unspecified), 300.0));
    }

    #[test]
    fn the_same_percentages_mean_more_against_current_values() {
        assert!(close(of(30.0, 1087, Basis::Current, Form::Unspecified), 390.0));
        assert!(close(of(25.0, 1114, Basis::Current, Form::Unspecified), 5.0));
        // Current labels already count vitamin A in µg RAE, so no form is
        // needed, and one offered is ignored.
        assert!(close(of(10.0, 1106, Basis::Current, Form::Unspecified), 90.0));
        assert!(close(of(10.0, 1106, Basis::Current, Form::BetaCaroteneDietary), 90.0));
    }

    #[test]
    fn older_vitamin_a_is_refused_until_its_form_is_named() {
        let err = per_percent(1106, Basis::Older, Form::Unspecified).unwrap_err();
        assert!(err.contains("retinol"), "{err}");
        assert!(close(of(10.0, 1106, Basis::Older, Form::BetaCaroteneDietary), 25.0));
        // A form that does not belong to the nutrient is no answer.
        assert!(per_percent(1106, Basis::Older, Form::FolicAcid).is_err());
    }

    #[test]
    fn older_vitamin_e_and_folate_ask_too() {
        assert!(per_percent(1109, Basis::Older, Form::Unspecified).is_err());
        assert!(close(of(100.0, 1109, Basis::Older, Form::AlphaTocopherolSynthetic), 13.5));
        assert!(per_percent(1190, Basis::Older, Form::Unspecified).is_err());
        assert!(close(of(25.0, 1190, Basis::Older, Form::FolicAcid), 170.0));
        assert!(close(of(25.0, 1190, Basis::Older, Form::FoodFolate), 100.0));
        // Today's folate DV is already in DFE: nothing to ask.
        assert!(forms(1190, Basis::Current).is_empty());
    }

    #[test]
    fn a_percentage_of_nothing_is_refused() {
        // Energy, trans fat and total sugars have no Daily Value; added sugars
        // had none before 2016.
        assert!(per_percent(1008, Basis::Current, Form::Unspecified).is_err());
        assert!(per_percent(1257, Basis::Older, Form::Unspecified).is_err());
        assert!(per_percent(2000, Basis::Current, Form::Unspecified).is_err());
        assert!(per_percent(1235, Basis::Older, Form::Unspecified).is_err());
        assert!(per_percent(1235, Basis::Current, Form::Unspecified).is_ok());
    }

    #[test]
    fn every_older_reference_converts_into_the_unit_the_app_stores() {
        for (id, _, _) in OLDER {
            let form = forms(*id, Basis::Older).first().copied().unwrap_or(Form::Unspecified);
            let p = per_percent(*id, Basis::Older, form)
                .unwrap_or_else(|e| panic!("{id} does not convert: {e}"));
            assert!(p > 0.0, "{id}");
            assert!(name(*id).is_some(), "{id} has no panel name");
        }
    }

    #[test]
    fn every_current_daily_value_has_a_panel_name() {
        for d in targets::all() {
            assert!(name(d.nutrient_id).is_some(), "{} has no panel name", d.nutrient_id);
        }
    }

    #[test]
    fn a_printed_zero_percent_is_under_two_percent_of_the_basis() {
        assert!(close(zero_ceiling(1087, Basis::Older, Form::Unspecified).unwrap(), 20.0));
        assert!(close(zero_ceiling(1087, Basis::Current, Form::Unspecified).unwrap(), 26.0));
    }
}
