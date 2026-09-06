//! Summing nutrient values across what was logged in a day.
//!
//! The whole point of this module is that a daily total is an **interval plus a
//! coverage fraction**, never a single number. See `docs/decisions.md` D7.
//!
//! Two things are logged, and they scale by different laws. A food's values are
//! stated per 100 g and scale with the mass eaten. A supplement's values are
//! stated per label serving and scale with the number of units taken — a
//! tablet's content is not a function of its weight, so its mass is not the
//! basis of anything. [`Contribution`] is an enum over exactly that difference,
//! which is what keeps a pill out of the mass-weighted coverage denominator.
//! See `docs/decisions.md` D12.

use crate::NutrientValue;
use serde::{Deserialize, Serialize};

/// One logged thing's contribution to a nutrient.
///
/// The variant is chosen by **how the source states its amounts**, not by what
/// kind of product it is: a greens powder with a weighed serving is a `Food`,
/// because its figures really are per a mass and its coverage really is
/// mass-based. A capsule of the same powder is a `Dose`.
#[derive(Debug, Clone, PartialEq)]
pub enum Contribution {
    /// Values are per 100 g, and `grams` were eaten. That mass is both the
    /// scale factor and this item's share of the coverage denominator.
    Food { value: NutrientValue, grams: f64 },
    /// Values are per one label serving, and `units` of that serving were
    /// taken. Deliberately carries no mass: a 1.2 g tablet holding 1,000 mg of
    /// calcium is not 83,333 mg/100 g of anything, and letting it into the mass
    /// denominator would move the D7 confidence threshold by an amount that has
    /// no meaning.
    Dose { value: NutrientValue, units: f64 },
}

impl Contribution {
    pub fn value(&self) -> &NutrientValue {
        match self {
            Contribution::Food { value, .. } | Contribution::Dose { value, .. } => value,
        }
    }

    /// What the stored value is multiplied by to get the amount consumed.
    fn scale(&self) -> f64 {
        match self {
            Contribution::Food { grams, .. } => grams / 100.0,
            Contribution::Dose { units, .. } => *units,
        }
    }
}

/// What supplements alone contributed to one nutrient.
///
/// Present only when at least one dose was logged, so that a supplemental-form
/// upper limit can never be evaluated against a zero that merely means "nothing
/// was taken". `docs/decisions.md` D5 lists four limits — magnesium, folic
/// acid, added niacin and supplemental vitamin E — that apply to the
/// supplemental fraction of intake and are therefore unevaluable from food
/// composition data. This is that fraction, observed directly off a label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SupplementSubtotal {
    /// Already included in [`DailyTotal::lower`]; this is the part of it that
    /// came from a pill rather than from food.
    pub lower: f64,
    /// The supplemental-form upper limits read THIS, not the day's total.
    pub upper: Option<f64>,
    pub doses_total: usize,
    pub doses_covered: usize,
}

/// A day's total for one nutrient.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyTotal {
    /// Sum of the lower bounds — what we can positively account for, food and
    /// supplements together. **%DV is computed from this.**
    pub lower: f64,
    /// Sum of the upper bounds, or `None` if any contributor is unbounded.
    /// **%UL is computed from this**, so an unbounded day cannot trigger a
    /// false "within limits" verdict.
    pub upper: Option<f64>,
    /// Fraction of the day's logged **food mass** that had data for this
    /// nutrient, or `None` when nothing with a mass basis was logged.
    ///
    /// `None` rather than `0.0`: on a day where only a multivitamin was logged
    /// there is no mass to have covered, and a zero here would render as
    /// "nothing is known" when in fact the amounts are known exactly. That is
    /// the same unknown-rendered-as-zero failure `NutrientValue` exists to
    /// prevent, one level up.
    pub coverage: Option<f64>,
    pub items_total: usize,
    pub items_covered: usize,
    /// What supplements contributed, or `None` if none were logged.
    pub from_supplements: Option<SupplementSubtotal>,
}

impl DailyTotal {
    /// Whether the value is solid enough to show as a point number rather than
    /// a range. Below the threshold the UI suppresses the progress bar entirely
    /// — an empty track reads as "0% of target", which is the exact lie the
    /// whole design exists to prevent.
    ///
    /// Mass coverage and dose coverage are reported and required **separately**
    /// rather than blended. Grams and pill counts are incommensurable, and any
    /// single combined figure would need an exchange rate between them that
    /// would have to be invented — the move `targets::for_nutrient` refuses
    /// when it returns `None` instead of a default.
    pub fn is_confident(&self, threshold: f64) -> bool {
        if self.items_total == 0 {
            return false;
        }
        let mass_ok = self.coverage.map_or(true, |c| c >= threshold);
        let doses_ok = self
            .from_supplements
            .as_ref()
            .map_or(true, |s| s.doses_covered == s.doses_total);
        mass_ok && doses_ok
    }
}

/// Sum contributions into a coverage-aware interval.
///
/// Coverage is weighted by mass, not by item count: a 300 g serving with no
/// selenium data leaves far more unaccounted for than a 5 g one. Doses stay out
/// of that weighting entirely and are counted on their own terms.
pub fn sum(contributions: &[Contribution]) -> DailyTotal {
    let mut lower = 0.0;
    let mut upper = Some(0.0);
    let mut mass_total = 0.0;
    let mut mass_covered = 0.0;
    let mut items_covered = 0;

    let mut doses_total = 0usize;
    let mut doses_covered = 0usize;
    let mut sup_lower = 0.0;
    let mut sup_upper = Some(0.0);

    for c in contributions {
        let value = c.value();
        let scale = c.scale();
        let covered = value.is_covered();

        lower += value.lower() * scale;

        // One unbounded contributor makes the whole day unbounded above.
        upper = match (upper, value.upper()) {
            (Some(acc), Some(u)) => Some(acc + u * scale),
            _ => None,
        };

        if covered {
            items_covered += 1;
        }

        match c {
            Contribution::Food { grams, .. } => {
                mass_total += grams;
                if covered {
                    mass_covered += grams;
                }
            }
            Contribution::Dose { .. } => {
                doses_total += 1;
                sup_lower += value.lower() * scale;
                sup_upper = match (sup_upper, value.upper()) {
                    (Some(acc), Some(u)) => Some(acc + u * scale),
                    _ => None,
                };
                if covered {
                    doses_covered += 1;
                }
            }
        }
    }

    DailyTotal {
        lower,
        upper,
        coverage: if mass_total > 0.0 {
            Some(mass_covered / mass_total)
        } else {
            None
        },
        items_total: contributions.len(),
        items_covered,
        from_supplements: if doses_total > 0 {
            Some(SupplementSubtotal {
                lower: sup_lower,
                upper: sup_upper,
                doses_total,
                doses_covered,
            })
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(value: NutrientValue, grams: f64) -> Contribution {
        Contribution::Food { value, grams }
    }

    fn dose(value: NutrientValue, units: f64) -> Contribution {
        Contribution::Dose { value, units }
    }

    #[test]
    fn scales_per_100g_values_by_grams_eaten() {
        let t = sum(&[c(NutrientValue::Measured { amount: 10.0 }, 250.0)]);
        assert_eq!(t.lower, 25.0);
        assert_eq!(t.upper, Some(25.0));
        assert_eq!(t.coverage, Some(1.0));
        assert!(t.from_supplements.is_none(), "no dose was logged");
    }

    #[test]
    fn one_absent_contributor_makes_the_day_unbounded() {
        let t = sum(&[
            c(NutrientValue::Measured { amount: 20.0 }, 100.0),
            c(NutrientValue::Absent, 100.0),
        ]);
        assert_eq!(t.lower, 20.0, "we can still account for the measured part");
        assert_eq!(t.upper, None, "but the total has no ceiling");
        assert_eq!(t.coverage, Some(0.5));
    }

    #[test]
    fn asserted_zeros_do_not_poison_the_upper_bound() {
        // The regression this guards: treating "USDA says none" as unknown made
        // almost every nutrient unbounded, which made the dashboard useless.
        let t = sum(&[
            c(NutrientValue::Measured { amount: 20.0 }, 100.0),
            c(NutrientValue::AssumedZero, 100.0),
        ]);
        assert_eq!(t.upper, Some(20.0));
        assert_eq!(t.coverage, Some(1.0), "an assertion of absence is coverage");
    }

    #[test]
    fn coverage_is_weighted_by_mass_not_item_count() {
        // A 5 g garnish with no data should barely dent confidence in a 495 g meal.
        let t = sum(&[
            c(NutrientValue::Measured { amount: 1.0 }, 495.0),
            c(NutrientValue::Absent, 5.0),
        ]);
        assert_eq!(t.items_covered, 1);
        assert_eq!(t.items_total, 2);
        let coverage = t.coverage.expect("food was logged, so coverage exists");
        assert!(
            (coverage - 0.99).abs() < 1e-9,
            "mass-weighted coverage should be 0.99, got {coverage}"
        );
    }

    // ── doses ───────────────────────────────────────────────────────────────

    #[test]
    fn a_dose_scales_by_units_taken_not_by_any_mass() {
        // 1,000 µg of B12 per tablet, two tablets. Nothing here is per 100 g,
        // and no mass is involved at any point.
        let t = sum(&[dose(NutrientValue::Measured { amount: 1000.0 }, 2.0)]);
        assert_eq!(t.lower, 2000.0);
        assert_eq!(t.upper, Some(2000.0));
    }

    #[test]
    fn a_supplement_only_day_has_no_coverage_rather_than_zero_coverage() {
        // The failure this guards: coverage 0.0 would render every nutrient as
        // "—" on a day whose amounts are in fact known exactly.
        let t = sum(&[dose(NutrientValue::Measured { amount: 25.0 }, 1.0)]);
        assert_eq!(t.coverage, None, "there was no mass to cover");
        assert!(
            t.is_confident(0.8),
            "a fully transcribed dose is confident despite having no mass"
        );
        let s = t.from_supplements.expect("a dose was logged");
        assert_eq!(s.lower, 25.0);
        assert_eq!(s.doses_total, 1);
        assert_eq!(s.doses_covered, 1);
    }

    #[test]
    fn a_dose_raises_the_total_without_moving_food_coverage() {
        // The point of the whole design: a multivitamin must be able to add
        // 1,000 µg of B12 to the day without changing how well the FOOD is
        // measured, in either direction.
        let food_only = sum(&[
            c(NutrientValue::Measured { amount: 1.0 }, 495.0),
            c(NutrientValue::Absent, 5.0),
        ]);
        let with_pill = sum(&[
            c(NutrientValue::Measured { amount: 1.0 }, 495.0),
            c(NutrientValue::Absent, 5.0),
            dose(NutrientValue::Measured { amount: 1000.0 }, 1.0),
        ]);
        assert_eq!(
            with_pill.coverage, food_only.coverage,
            "a pill has no mass and must not touch the mass denominator"
        );
        assert!((with_pill.lower - (food_only.lower + 1000.0)).abs() < 1e-9);
    }

    #[test]
    fn the_supplement_subtotal_is_the_part_of_the_total_that_came_from_a_pill() {
        let t = sum(&[
            c(NutrientValue::Measured { amount: 10.0 }, 200.0), // 20 mg from food
            dose(NutrientValue::Measured { amount: 350.0 }, 1.0), // 350 mg from a pill
        ]);
        assert!((t.lower - 370.0).abs() < 1e-9);
        let s = t.from_supplements.expect("a dose was logged");
        assert!(
            (s.lower - 350.0).abs() < 1e-9,
            "the supplemental-only upper limit reads this, not the 370 total"
        );
        assert_eq!(s.upper, Some(350.0));
    }

    #[test]
    fn an_untranscribed_dose_line_leaves_the_nutrient_unconfident() {
        // A supplement whose panel was not fully transcribed is genuinely an
        // unknown quantity of this nutrient, however well the food was measured.
        let t = sum(&[
            c(NutrientValue::Measured { amount: 1.0 }, 500.0),
            dose(NutrientValue::Absent, 1.0),
        ]);
        assert_eq!(t.coverage, Some(1.0), "the food side is fully measured");
        assert_eq!(t.upper, None, "but the day has no ceiling");
        assert!(
            !t.is_confident(0.8),
            "an uncovered dose must not be smoothed over by good food coverage"
        );
    }

    #[test]
    fn nothing_logged_is_not_confident_and_has_no_coverage() {
        let t = sum(&[]);
        assert_eq!(t.coverage, None);
        assert_eq!(t.items_total, 0);
        assert!(!t.is_confident(0.8));
        assert!(t.from_supplements.is_none());
    }

    #[test]
    fn two_tablets_are_one_item_not_two() {
        // `units` carries the count so that items_total keeps counting log
        // entries. Pushing one contribution per pill would make the UI's
        // "N items unmeasured" note describe pills instead of things logged.
        let t = sum(&[dose(NutrientValue::Measured { amount: 5.0 }, 2.0)]);
        assert_eq!(t.items_total, 1);
        assert_eq!(t.lower, 10.0);
    }

    #[test]
    fn unprovenanced_zero_is_not_treated_as_zero() {
        let t = sum(&[c(NutrientValue::ZeroUnknown, 100.0)]);
        assert_eq!(t.lower, 0.0);
        assert_eq!(t.upper, None, "a bare 0 bounds nothing");
        assert_eq!(t.coverage, Some(0.0));
        assert_eq!(t.items_covered, 0);
    }
}
