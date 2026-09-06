//! Reference intake targets, and the order in which one is decided.
//!
//! Two reference systems live in this app and they answer different questions.
//!
//! - The **FDA Daily Values** below, from 21 CFR 101.9 (the 2016 labelling
//!   revision), are a single adult column — the figures printed on a Nutrition
//!   Facts panel. They are what a pack is labelled against, and what this app
//!   falls back to when it does not know who is eating.
//! - The **DRIs** in [`crate::dri`] vary by age, sex, and pregnancy or
//!   lactation, and are what a person actually needs.
//!
//! The two diverge substantially, which is the whole reason for keeping both:
//! the DV for iron is 18 mg for everybody, against an adult male RDA of 8 mg
//! and an adult woman's 18 mg that drops back to 8 mg after 50.
//!
//! [`resolve`] decides which applies, in one place, and every target it returns
//! carries the basis it came from so no screen can print a percentage without
//! being able to say what it is a percentage *of*.
//!
//! See `docs/decisions.md` D5 for the upper-limit form restrictions that keep
//! this module to targets and out of toxicity warnings.

use crate::dri;
use serde::Serialize;


#[derive(Debug, Clone, Serialize)]
pub struct DailyValue {
    pub nutrient_id: i64,
    /// Amount in the nutrient's own unit, as stored in the reference database.
    pub amount: f64,
    pub unit: &'static str,
}

/// (FDC nutrient id, amount, unit) for the adults-and-children-4-plus column.
const DV: &[(i64, f64, &str)] = &[
    (1003, 50.0, "g"),      // Protein
    (1004, 78.0, "g"),      // Total fat
    (1258, 20.0, "g"),      // Saturated fat
    (1253, 300.0, "mg"),    // Cholesterol
    (1005, 275.0, "g"),     // Carbohydrate
    (1079, 28.0, "g"),      // Fiber
    (1235, 50.0, "g"),      // Added sugars
    (1093, 2300.0, "mg"),   // Sodium
    (1092, 4700.0, "mg"),   // Potassium
    (1087, 1300.0, "mg"),   // Calcium
    (1089, 18.0, "mg"),     // Iron
    (1114, 20.0, "ug"),     // Vitamin D
    (1106, 900.0, "ug"),    // Vitamin A, RAE
    (1162, 90.0, "mg"),     // Vitamin C
    (1109, 15.0, "mg"),     // Vitamin E
    (1185, 120.0, "ug"),    // Vitamin K
    (1165, 1.2, "mg"),      // Thiamin
    (1166, 1.3, "mg"),      // Riboflavin
    (1167, 16.0, "mg"),     // Niacin
    (1175, 1.7, "mg"),      // Vitamin B6
    (1190, 400.0, "ug"),    // Folate, DFE
    (1178, 2.4, "ug"),      // Vitamin B12
    (1176, 30.0, "ug"),     // Biotin
    (1170, 5.0, "mg"),      // Pantothenic acid
    (1091, 1250.0, "mg"),   // Phosphorus
    (1100, 150.0, "ug"),    // Iodine
    (1090, 420.0, "mg"),    // Magnesium
    (1095, 11.0, "mg"),     // Zinc
    (1103, 55.0, "ug"),     // Selenium
    (1098, 0.9, "mg"),      // Copper
    (1101, 2.3, "mg"),      // Manganese
    (1096, 35.0, "ug"),     // Chromium
    (1102, 45.0, "ug"),     // Molybdenum
    (1180, 550.0, "mg"),    // Choline
];

/// Nutrients where the Daily Value is a CEILING, not a goal. Exceeding these is
/// the finding; exceeding a target is not. Rendering both in alarm colour is
/// what turns a dashboard into noise you learn to ignore.
///
/// Note this is the FDA labelling limit, which is a different thing from a
/// Tolerable Upper Intake Level — a UL applies to a specific chemical form
/// (preformed retinol, folic acid) and needs the DRI tables, not this table.
const LIMITS: &[i64] = &[
    1093, // Sodium
    1258, // Saturated fat
    1235, // Added sugars
    1253, // Cholesterol
    // Trans fat (1257) is deliberately NOT here. FDA established no Daily Value
    // for it — a Nutrition Facts panel prints "Trans Fat 0g" with no %DV — so
    // there is no reference value to exceed. Listing it would mean inventing a
    // denominator, which is the failure this app exists to avoid. The UI shows
    // its amount and says there is no established limit.
];

pub fn is_limit(nutrient_id: i64) -> bool {
    LIMITS.contains(&nutrient_id)
}

pub fn all() -> Vec<DailyValue> {
    DV.iter()
        .map(|(nutrient_id, amount, unit)| DailyValue {
            nutrient_id: *nutrient_id,
            amount: *amount,
            unit,
        })
        .collect()
}

pub fn for_nutrient(nutrient_id: i64) -> Option<f64> {
    DV.iter()
        .find(|(id, _, _)| *id == nutrient_id)
        .map(|(_, amount, _)| *amount)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_values_are_present() {
        assert_eq!(for_nutrient(1089), Some(18.0), "iron DV is 18 mg");
        assert_eq!(for_nutrient(1103), Some(55.0), "selenium DV is 55 mcg");
    }

    #[test]
    fn unknown_nutrient_has_no_target() {
        // Must be None, never a default like 0 or 100 — a bogus denominator
        // would render a confident and meaningless percentage.
        assert_eq!(for_nutrient(999_999), None);
    }

    #[test]
    fn limits_are_a_ceiling_not_a_goal() {
        assert!(is_limit(1093), "sodium is a limit");
        assert!(is_limit(1258), "saturated fat is a limit");
        assert!(!is_limit(1079), "fiber is a goal, not a ceiling");
        assert!(!is_limit(1089), "iron is a goal, not a ceiling");
        // Every limit must have a reference value, or nothing can be exceeded.
        for id in LIMITS {
            assert!(for_nutrient(*id).is_some(), "limit {id} has no daily value");
        }
    }

    #[test]
    fn no_duplicate_nutrients() {
        let mut ids: Vec<i64> = DV.iter().map(|(id, _, _)| *id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate nutrient id in the DV table");
    }
}


/// One nutrient's target, and where the number came from.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Goal {
    pub nutrient_id: i64,
    pub amount: f64,
    pub basis: dri::Basis,
    /// True when the figure is a ceiling to stay under rather than a goal to
    /// reach. Only a breach of one of these earns alarm colour.
    pub is_limit: bool,
}

/// Decide every nutrient's target, in one place.
///
/// The order is the design, and each step is a stronger claim about this
/// particular person than the one after it:
///
/// 1. **What the user set.** Their own figure wins over any table. Someone
///    given a target by a clinician has better information than this app does.
/// 2. **The DRI for their life-stage group**, when the profile places them in
///    one. Age and sex change these enough that using the wrong column is a
///    real error, not a rounding one.
/// 3. **The FDA Daily Value**, when it does not. This is the honest fallback
///    for an unknown person: it is what the label on the pack means.
/// 4. **Nothing.** A nutrient with no figure in any of the three gets no
///    target, no percentage and no bar — never an invented denominator.
///
/// Limits are deliberately NOT taken from the DRIs. Saturated fat, added sugars
/// and cholesterol have no DRI at all — the reports say "as low as possible",
/// which is not a number — and sodium's DRI is an Adequate Intake of 1,500 mg,
/// which is a floor and would put a "reach this much sodium" bar on the
/// dashboard. They keep the Daily Value ceiling, which is what a pack is
/// labelled against, unless the user sets their own.
pub fn resolve(group: Option<dri::Group>, overrides: &[(i64, f64)]) -> Vec<Goal> {
    let mut goals: Vec<Goal> = Vec::new();
    let mut seen: Vec<i64> = Vec::new();

    // 1. The user's own figures.
    for (id, amount) in overrides {
        if seen.contains(id) || !(amount.is_finite() && *amount > 0.0) {
            continue;
        }
        seen.push(*id);
        goals.push(Goal {
            nutrient_id: *id,
            amount: *amount,
            basis: dri::Basis::UserSet,
            is_limit: is_limit(*id),
        });
    }

    // 2. The DRIs for their group, where one applies and the nutrient is not a
    //    ceiling.
    if let Some(g) = group {
        for r in dri::for_group(g) {
            if seen.contains(&r.nutrient_id) || is_limit(r.nutrient_id) {
                continue;
            }
            seen.push(r.nutrient_id);
            goals.push(Goal {
                nutrient_id: r.nutrient_id,
                amount: r.amount,
                basis: r.basis,
                is_limit: false,
            });
        }
    }

    // 3. The Daily Values, for everything still without a figure.
    for (id, amount, _) in DV {
        if seen.contains(id) {
            continue;
        }
        seen.push(*id);
        goals.push(Goal {
            nutrient_id: *id,
            amount: *amount,
            basis: dri::Basis::DailyValue,
            is_limit: is_limit(*id),
        });
    }

    goals
}

#[cfg(test)]
mod resolve_tests {
    use super::*;
    use crate::dri::{Basis, Group};

    fn find(goals: &[Goal], id: i64) -> Option<Goal> {
        goals.iter().copied().find(|g| g.nutrient_id == id)
    }

    #[test]
    fn with_no_profile_everything_falls_back_to_the_daily_value() {
        let goals = resolve(None, &[]);
        let iron = find(&goals, 1089).unwrap();
        assert_eq!(iron.amount, 18.0);
        assert_eq!(iron.basis, Basis::DailyValue);
        // And every DV nutrient is present, so nothing silently loses a target
        // just because the profile is empty.
        assert_eq!(goals.len(), DV.len());
    }

    #[test]
    fn a_profile_replaces_the_daily_value_with_this_persons_own_requirement() {
        // The headline case: the DV says 18 mg of iron for everybody.
        let man = resolve(Some(Group::Male31To50), &[]);
        let iron = find(&man, 1089).unwrap();
        assert_eq!(iron.amount, 8.0);
        assert_eq!(iron.basis, Basis::Rda);

        let woman = resolve(Some(Group::Female31To50), &[]);
        assert_eq!(find(&woman, 1089).unwrap().amount, 18.0);

        let older = resolve(Some(Group::Female51To70), &[]);
        assert_eq!(find(&older, 1089).unwrap().amount, 8.0);
    }

    #[test]
    fn a_user_figure_beats_both_tables() {
        let goals = resolve(Some(Group::Male31To50), &[(1089, 25.0)]);
        let iron = find(&goals, 1089).unwrap();
        assert_eq!(iron.amount, 25.0);
        assert_eq!(iron.basis, Basis::UserSet);
    }

    #[test]
    fn a_nonsense_override_is_ignored_rather_than_stored_as_a_target() {
        for bad in [0.0, -5.0, f64::NAN, f64::INFINITY] {
            let goals = resolve(Some(Group::Male31To50), &[(1089, bad)]);
            let iron = find(&goals, 1089).unwrap();
            assert_eq!(iron.basis, Basis::Rda, "a bad override must not win");
            assert_eq!(iron.amount, 8.0);
        }
    }

    #[test]
    fn limits_keep_the_daily_value_and_stay_limits() {
        // Saturated fat, added sugars and cholesterol have no DRI at all, and
        // sodium's DRI is a floor. All four must keep the labelling ceiling.
        for id in [1258, 1235, 1253, 1093] {
            let g = find(&resolve(Some(Group::Male31To50), &[]), id).unwrap();
            assert_eq!(g.basis, Basis::DailyValue, "nutrient {id}");
            assert!(g.is_limit, "nutrient {id} must remain a ceiling");
        }
        // Sodium in particular must never become a 1,500 mg goal to reach.
        let sodium = find(&resolve(Some(Group::Male31To50), &[]), 1093).unwrap();
        assert_eq!(sodium.amount, 2300.0);
    }

    #[test]
    fn a_user_may_set_their_own_ceiling_and_it_stays_a_ceiling() {
        let goals = resolve(Some(Group::Male31To50), &[(1093, 1800.0)]);
        let sodium = find(&goals, 1093).unwrap();
        assert_eq!(sodium.amount, 1800.0);
        assert_eq!(sodium.basis, Basis::UserSet);
        assert!(sodium.is_limit, "changing the number does not change its kind");
    }

    #[test]
    fn a_dri_nutrient_with_no_daily_value_still_gets_a_target() {
        // Linoleic and α-linolenic acid have DRIs but no Daily Value, so a
        // profile is the only way they ever get a target at all. (Vitamin K
        // has both, and is deliberately not in this list.)
        for id in [1316, 1404] {
            assert!(find(&resolve(None, &[]), id).is_none(), "no DV for {id}");
            assert!(
                find(&resolve(Some(Group::Male31To50), &[]), id).is_some(),
                "the DRI supplies {id}"
            );
        }
    }

    #[test]
    fn no_nutrient_is_returned_twice() {
        let goals = resolve(Some(Group::Pregnancy19To30), &[(1089, 30.0), (1093, 1500.0)]);
        let mut ids: Vec<i64> = goals.iter().map(|g| g.nutrient_id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len());
    }

    #[test]
    fn an_ai_keeps_its_basis_through_resolution() {
        // So the UI can still say "adequate intake" rather than implying the
        // authority of an RDA.
        let goals = resolve(Some(Group::Male31To50), &[]);
        assert_eq!(find(&goals, 1092).unwrap().basis, Basis::Ai); // potassium
        assert_eq!(find(&goals, 1079).unwrap().basis, Basis::Ai); // fibre
    }
}
