//! Domain logic for TrackIt.
//!
//! This crate deliberately has no Tauri, no SQL and no I/O, so the nutrient
//! arithmetic can be unit-tested without a running app.
//!
//! The central type is [`NutrientValue`]. See `docs/decisions.md` D2 for why a
//! nutrient amount is a tagged union rather than an `Option<f64>`: **%RDA is
//! computed from the lower bound of an interval and %UL from the upper bound**,
//! so a single scalar cannot answer both "am I deficient?" and "am I over the
//! safe limit?".

use serde::{Deserialize, Serialize};

pub mod aggregate;
pub mod dri;
pub mod barcode;
pub mod ingredients;
pub mod label;
pub mod panel;
pub mod supplement;
pub mod suppanel;
pub mod targets;
pub mod water;

/// How a single food's value for a single nutrient is known.
///
/// Serialises to a TypeScript discriminated union (`{ kind: "measured", amount }`),
/// so the frontend cannot read a number without first narrowing on `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NutrientValue {
    /// A real measurement, or a documented calculation from one.
    Measured { amount: f64 },
    /// A laboratory measured and found nothing above its detection limit.
    /// Bounded at zero: the lab looked.
    MeasuredZero,
    /// The source asserts the nutrient is genuinely absent (USDA derivation `Z`).
    /// This is knowledge, not ignorance, so it is bounded on both ends.
    AssumedZero,
    /// The source reported `0` with no provenance at all. We cannot claim the
    /// food contains none, and the limit of quantification that would bound it
    /// is stripped from every USDA bulk download.
    ZeroUnknown,
    /// Below the limit of quantification, with the limit known.
    BelowLoq { upper: f64 },
    /// A label-rounded zero. 21 CFR 101.9 permits declaring zero below a
    /// threshold, so the true value lies somewhere in `[0, upper]`.
    LabelZero { upper: f64 },
    /// The source explicitly designates a trace amount.
    Trace { upper: f64 },
    /// No data at all. Never stored as a row; represented by absence.
    Absent,
}

impl NutrientValue {
    /// Lower bound of the interval this value denotes.
    pub fn lower(&self) -> f64 {
        match self {
            NutrientValue::Measured { amount } => *amount,
            _ => 0.0,
        }
    }

    /// Upper bound, or `None` when the value places no ceiling on the amount.
    pub fn upper(&self) -> Option<f64> {
        match self {
            NutrientValue::Measured { amount } => Some(*amount),
            NutrientValue::MeasuredZero | NutrientValue::AssumedZero => Some(0.0),
            NutrientValue::BelowLoq { upper }
            | NutrientValue::LabelZero { upper }
            | NutrientValue::Trace { upper } => Some(*upper),
            // Both mean "we do not know", and neither may be treated as zero.
            NutrientValue::ZeroUnknown | NutrientValue::Absent => None,
        }
    }

    /// Whether this value counts as *covered* — i.e. the source told us something
    /// definite. `AssumedZero` counts: an assertion of absence is information.
    pub fn is_covered(&self) -> bool {
        !matches!(self, NutrientValue::ZeroUnknown | NutrientValue::Absent)
    }

    /// The three columns that reconstruct this value through [`from_db`].
    ///
    /// Reading a value back out of the reference database has always been
    /// possible; writing one had not been needed until a logged entry started
    /// keeping its own frozen copy. The pair must stay exactly inverse, because
    /// a snapshot that round-trips imperfectly would silently rewrite history
    /// -- which is the one thing the snapshot exists to prevent.
    ///
    /// [`NutrientValue::Absent`] has no row: absence is represented by the
    /// absence of a row, in the snapshot exactly as in `food_nutrients`.
    ///
    /// [`from_db`]: NutrientValue::from_db
    pub fn to_db(&self) -> Option<(&'static str, Option<f64>, Option<f64>)> {
        match self {
            NutrientValue::Measured { amount } => Some(("measured", Some(*amount), None)),
            NutrientValue::MeasuredZero => Some(("measured_zero", None, None)),
            NutrientValue::AssumedZero => Some(("assumed_zero", None, None)),
            NutrientValue::ZeroUnknown => Some(("zero_unknown", None, None)),
            NutrientValue::BelowLoq { upper } => Some(("below_loq", None, Some(*upper))),
            NutrientValue::LabelZero { upper } => Some(("label_zero", None, Some(*upper))),
            NutrientValue::Trace { upper } => Some(("trace", None, Some(*upper))),
            NutrientValue::Absent => None,
        }
    }

    pub fn from_db(kind: &str, amount: Option<f64>, upper: Option<f64>) -> Self {
        match kind {
            "measured" => NutrientValue::Measured {
                amount: amount.unwrap_or(0.0),
            },
            "measured_zero" => NutrientValue::MeasuredZero,
            "assumed_zero" => NutrientValue::AssumedZero,
            "zero_unknown" => NutrientValue::ZeroUnknown,
            "below_loq" => NutrientValue::BelowLoq {
                upper: upper.unwrap_or(0.0),
            },
            "label_zero" => NutrientValue::LabelZero {
                upper: upper.unwrap_or(0.0),
            },
            "trace" => NutrientValue::Trace {
                upper: upper.unwrap_or(0.0),
            },
            _ => NutrientValue::Absent,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_stored_value_survives_a_round_trip_through_the_database() {
        // A snapshot is only worth taking if it comes back identical. Each arm
        // is listed explicitly rather than generated, so adding a variant to
        // NutrientValue fails to compile here until its columns are decided.
        let all = [
            NutrientValue::Measured { amount: 12.5 },
            NutrientValue::Measured { amount: 0.0 },
            NutrientValue::MeasuredZero,
            NutrientValue::AssumedZero,
            NutrientValue::ZeroUnknown,
            NutrientValue::BelowLoq { upper: 0.4 },
            NutrientValue::LabelZero { upper: 1.16 },
            NutrientValue::Trace { upper: 0.05 },
        ];
        for v in all {
            let (kind, amount, upper) = v.to_db().expect("only Absent has no row");
            assert_eq!(
                NutrientValue::from_db(kind, amount, upper),
                v,
                "{v:?} did not survive the round trip"
            );
        }
    }

    #[test]
    fn absence_is_stored_as_the_absence_of_a_row() {
        assert!(NutrientValue::Absent.to_db().is_none());
        // And an unknown kind read back is Absent, so a row this app did not
        // write cannot become a number.
        assert_eq!(
            NutrientValue::from_db("something_else", Some(9.0), Some(9.0)),
            NutrientValue::Absent
        );
    }

    #[test]
    fn measured_is_a_point_interval() {
        let v = NutrientValue::Measured { amount: 12.5 };
        assert_eq!(v.lower(), 12.5);
        assert_eq!(v.upper(), Some(12.5));
        assert!(v.is_covered());
    }

    #[test]
    fn asserted_absence_is_bounded_but_unknown_zero_is_not() {
        // USDA saying "this food has none" is knowledge...
        assert_eq!(NutrientValue::AssumedZero.upper(), Some(0.0));
        assert!(NutrientValue::AssumedZero.is_covered());
        // ...but a bare 0 with no provenance is not, and must never be
        // treated as if the food contained none.
        assert_eq!(NutrientValue::ZeroUnknown.upper(), None);
        assert!(!NutrientValue::ZeroUnknown.is_covered());
    }

    #[test]
    fn absent_never_reads_as_zero() {
        let v = NutrientValue::Absent;
        assert_eq!(v.upper(), None, "Absent must not claim an upper bound of 0");
        assert!(!v.is_covered());
    }

    #[test]
    fn censored_values_carry_a_ceiling_but_no_floor() {
        let v = NutrientValue::BelowLoq { upper: 0.4 };
        assert_eq!(v.lower(), 0.0);
        assert_eq!(v.upper(), Some(0.4));
        assert!(v.is_covered(), "a known detection limit is information");
    }
}
