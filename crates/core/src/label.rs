//! Reading a nutrition panel without laundering its rounding into measurement.
//!
//! Two things separate a pack from the reference database, and both are handled
//! here rather than in the UI or the store:
//!
//! 1. A panel prints figures rounded under 21 CFR 101.9, so a declared `0` is
//!    an *upper bound* — "less than the threshold" — and never a measurement of
//!    absence. The reference data has [`NutrientValue::MeasuredZero`] for a lab
//!    that looked and found nothing; a pack can never earn that.
//! 2. A panel's figures are per serving, while every other amount in this app is
//!    per 100 g. The conversion belongs next to the rounding rules, because both
//!    have to happen exactly once and in that order.

use crate::targets;
use crate::NutrientValue;
use serde::{Deserialize, Serialize};

/// What a nutrition panel can actually say about a nutrient.
///
/// A pack is not a laboratory: it prints rounded figures under FDA rules, so a
/// declared "0" is an upper bound and not a measurement of absence. Modelling
/// that here keeps the distinction out of the UI's hands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LabelEntry {
    /// A number, as printed, per serving.
    Printed { amount: f64 },
    /// The pack prints 0 — below the rounding threshold, not absence.
    DeclaredZero,
    /// The pack prints "less than X", e.g. "Contains less than 1 g".
    LessThan { upper: f64 },
}

/// Fixed ceilings from 21 CFR 101.9(c). Each is the amount *below* which the
/// nutrient may be declared as zero, so it is the tightest bound a declared
/// zero supports.
const FIXED_CEILINGS: &[(i64, f64)] = &[
    // 101.9(c)(1): calories below 5 may be expressed as zero.
    (1008, 5.0),
    // 101.9(c)(2): fat, saturated fat and trans fat below 0.5 g.
    (1004, 0.5),
    (1258, 0.5),
    (1257, 0.5),
    // 101.9(c)(3): cholesterol below 2 mg.
    (1253, 2.0),
    // 101.9(c)(4): sodium below 5 mg.
    (1093, 5.0),
    // 101.9(c)(6): carbohydrate, fibre, total sugars and added sugars below 0.5 g.
    (1005, 0.5),
    (1079, 0.5),
    (2000, 0.5),
    (1235, 0.5),
    // 101.9(c)(7): protein below 0.5 g.
    (1003, 0.5),
    // Potassium (1092), calcium (1087), iron (1089) and vitamin D (1114) are
    // deliberately absent even though they are mandatory on the panel: they are
    // declared as %DV, so their floor is the 2%-of-DV rule below and inventing a
    // fixed gram figure for them would be a bound the regulation does not give.
];

/// The value below which a nutrient may be declared as 0 on a US nutrition
/// panel (21 CFR 101.9). Where the regulation expresses the floor as a
/// percentage of the Daily Value, that is what is computed, so the table stays
/// honest instead of carrying invented constants.
pub fn rounding_ceiling(nutrient_id: i64) -> Option<f64> {
    if let Some((_, ceiling)) = FIXED_CEILINGS.iter().find(|(id, _)| *id == nutrient_id) {
        return Some(*ceiling);
    }
    // 101.9(c)(8)(iii): vitamins and minerals are declared in percent of the
    // Daily Value and may be declared as zero below 2% of it. That makes the
    // ceiling a function of the DV table rather than a constant of its own.
    targets::for_nutrient(nutrient_id).map(|dv| dv * 0.02)
}

/// Convert one transcribed entry to the app's nutrient value, on the app's
/// per-100 g basis. `serving_g` is what the label's figures are per.
pub fn to_value(
    entry: &LabelEntry,
    nutrient_id: i64,
    serving_g: f64,
) -> Result<NutrientValue, String> {
    if !serving_g.is_finite() || serving_g <= 0.0 {
        return Err("Serving size in grams must be a positive number.".into());
    }
    let per_100 = 100.0 / serving_g;

    match entry {
        LabelEntry::Printed { amount } => {
            // A non-finite or negative figure would propagate into every daily
            // total silently, so it is rejected at the boundary instead.
            if !amount.is_finite() || *amount < 0.0 {
                return Err("A printed amount must be zero or more.".into());
            }
            Ok(NutrientValue::Measured {
                amount: amount * per_100,
            })
        }
        LabelEntry::LessThan { upper } => {
            if !upper.is_finite() || *upper <= 0.0 {
                return Err("A \"less than\" amount must be greater than zero.".into());
            }
            Ok(NutrientValue::BelowLoq {
                upper: upper * per_100,
            })
        }
        LabelEntry::DeclaredZero => match rounding_ceiling(nutrient_id) {
            Some(ceiling) => Ok(NutrientValue::LabelZero {
                upper: ceiling * per_100,
            }),
            // No fixed ceiling and no Daily Value means the regulation gives us
            // nothing to bound this zero with. `BelowLoq` would need a limit we
            // do not have, so the value stays an unbounded zero — which is the
            // truth, and keeps it out of the day's upper bound.
            None => Ok(NutrientValue::ZeroUnknown),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Hershey's-sized bar: the serving the contract's example uses.
    const BAR: f64 = 43.0;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn declared_zero_fat_is_a_bound_not_a_measured_zero() {
        let v = to_value(&LabelEntry::DeclaredZero, 1004, BAR).unwrap();
        match v {
            NutrientValue::LabelZero { upper } => {
                assert!(close(upper, 0.5 * 100.0 / BAR), "got {upper}");
            }
            other => panic!("a pack's 0 g of fat must be LabelZero, got {other:?}"),
        }
        assert_ne!(
            v,
            NutrientValue::MeasuredZero,
            "only a laboratory earns MeasuredZero"
        );
        // The point of all of this: it still has a ceiling, so the day stays
        // bounded, but its lower bound is 0 rather than a claim of absence.
        assert_eq!(v.lower(), 0.0);
        assert!(v.upper().is_some());
    }

    #[test]
    fn printed_amounts_scale_to_per_100g() {
        let v = to_value(&LabelEntry::Printed { amount: 13.0 }, 1004, BAR).unwrap();
        match v {
            NutrientValue::Measured { amount } => {
                assert!((amount - 30.2325581).abs() < 1e-6, "got {amount}");
            }
            other => panic!("expected Measured, got {other:?}"),
        }
    }

    #[test]
    fn a_100g_serving_is_the_identity() {
        let v = to_value(&LabelEntry::Printed { amount: 7.5 }, 1003, 100.0).unwrap();
        assert_eq!(v, NutrientValue::Measured { amount: 7.5 });
    }

    #[test]
    fn less_than_becomes_a_censored_value() {
        let v = to_value(&LabelEntry::LessThan { upper: 1.0 }, 1079, 50.0).unwrap();
        assert_eq!(v, NutrientValue::BelowLoq { upper: 2.0 });
        assert_eq!(v.lower(), 0.0, "\"less than 1 g\" asserts no floor");
    }

    #[test]
    fn micronutrient_ceilings_come_from_two_percent_of_the_daily_value() {
        // Calcium's DV is 1300 mg, and a panel may print 0% below 2% of it.
        assert_eq!(rounding_ceiling(1087), Some(26.0));
        let v = to_value(&LabelEntry::DeclaredZero, 1087, BAR).unwrap();
        match v {
            NutrientValue::LabelZero { upper } => {
                assert!(close(upper, 26.0 * 100.0 / BAR), "got {upper}");
            }
            other => panic!("expected LabelZero, got {other:?}"),
        }
    }

    #[test]
    fn macronutrient_ceilings_are_the_regulations_fixed_figures() {
        assert_eq!(rounding_ceiling(1008), Some(5.0), "5 kcal");
        assert_eq!(rounding_ceiling(1257), Some(0.5), "trans fat, 0.5 g");
        assert_eq!(rounding_ceiling(1253), Some(2.0), "cholesterol, 2 mg");
        assert_eq!(rounding_ceiling(1093), Some(5.0), "sodium, 5 mg");
        // Trans fat has no Daily Value at all, so the 2% rule could not have
        // supplied this one — the fixed table has to.
        assert_eq!(targets::for_nutrient(1257), None);
    }

    #[test]
    fn a_zero_we_cannot_bound_stays_unbounded() {
        // DHA (1272) has no fixed ceiling and no Daily Value, so a declared zero
        // for it carries no ceiling we are entitled to invent.
        assert_eq!(rounding_ceiling(1272), None);
        let v = to_value(&LabelEntry::DeclaredZero, 1272, BAR).unwrap();
        assert_eq!(v, NutrientValue::ZeroUnknown);
        assert_eq!(v.upper(), None);
        assert!(!v.is_covered());
    }

    #[test]
    fn a_serving_size_that_cannot_scale_is_rejected() {
        for bad in [0.0, -43.0, f64::NAN, f64::INFINITY] {
            assert!(
                to_value(&LabelEntry::Printed { amount: 1.0 }, 1004, bad).is_err(),
                "serving_g {bad} must be rejected"
            );
            assert!(to_value(&LabelEntry::DeclaredZero, 1004, bad).is_err());
        }
    }

    #[test]
    fn nonsense_figures_are_rejected_rather_than_scaled() {
        assert!(to_value(&LabelEntry::Printed { amount: -1.0 }, 1004, BAR).is_err());
        assert!(to_value(&LabelEntry::Printed { amount: f64::NAN }, 1004, BAR).is_err());
        // A "less than 0" bound would be a ceiling of zero, i.e. a claim of
        // absence dressed as a bound.
        assert!(to_value(&LabelEntry::LessThan { upper: 0.0 }, 1004, BAR).is_err());
        assert!(to_value(&LabelEntry::LessThan { upper: -0.5 }, 1004, BAR).is_err());
    }

    #[test]
    fn every_label_nutrient_can_bound_its_declared_zero() {
        // The 15 rows the frontend's LABEL_NUTRIENTS spine offers. If any of
        // these fell through to ZeroUnknown, a pack printing 0 would make the
        // whole day's total for it unbounded.
        for id in [
            1008, 1004, 1258, 1257, 1253, 1093, 1005, 1079, 2000, 1235, 1003, 1114, 1087, 1089,
            1092,
        ] {
            let ceiling = rounding_ceiling(id).unwrap_or_else(|| panic!("no ceiling for {id}"));
            assert!(ceiling > 0.0, "ceiling for {id} must be positive");
        }
    }

    #[test]
    fn no_duplicate_ceilings() {
        let mut ids: Vec<i64> = FIXED_CEILINGS.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(
            before,
            ids.len(),
            "duplicate nutrient id in the ceiling table"
        );
    }
}
