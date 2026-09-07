//! Turning a weighed bottle into a volume of water.
//!
//! Water is drunk by volume and weighed by mass, and this app only ever
//! measures the mass: a bottle goes on the scale full, and again later, and the
//! difference is what was drunk. Reporting that difference in grams is exact
//! and useless — nobody thinks about their day in grams of water.
//!
//! The conversion is not a constant. Water is close to 1 g per ml, but a
//! bottle sold as one litre rarely holds exactly one litre of water to the brim
//! that a person actually fills it to, and the number on the label is what its
//! owner thinks in. So the bottle calibrates itself: weighed empty once,
//! weighed full once, and told what its maker calls it. What a full bottle
//! holds in water is `full - empty` grams, that is `volume` millilitres by the
//! label, and every later reading scales between the two.
//!
//! Where a bottle has not been calibrated the conversion falls back to the
//! density of water — and says that it did. The two are not the same claim, and
//! this app does not have a habit of pretending otherwise.

use serde::{Deserialize, Serialize};

/// A volume of water, and where the conversion from mass came from.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Volume {
    /// Converted using this bottle's own empty weight, full weight and stated
    /// volume. The scale factor came from the user's own two weighings.
    Measured { ml: f64 },
    /// Converted at the density of water, because the bottle has not been
    /// weighed empty or has no stated volume.
    ///
    /// Not a lie and not a measurement: pure water is 0.998 g/ml at room
    /// temperature, so the figure is right to about two parts in a thousand —
    /// far inside the error of everything around it. It is marked because the
    /// app says where its numbers come from, not because the number is poor.
    Assumed { ml: f64 },
}

impl Volume {
    pub fn ml(self) -> f64 {
        match self {
            Volume::Measured { ml } | Volume::Assumed { ml } => ml,
        }
    }
    pub fn litres(self) -> f64 {
        self.ml() / 1000.0
    }
    pub fn is_measured(self) -> bool {
        matches!(self, Volume::Measured { .. })
    }
}

/// Water at 20 °C, in grams per millilitre.
const DENSITY: f64 = 0.9982;

/// What a weighed amount of water from one bottle comes to in millilitres.
///
/// `empty_g` and `volume_ml` are `None` for a bottle recorded before this
/// existed, or one its owner has not finished describing. Both are needed
/// together: a bottle's own scale factor is `volume_ml / (full_g - empty_g)`
/// and neither half means anything alone.
///
/// A capacity of zero or less is refused rather than divided by — it would mean
/// a bottle that weighs the same full as empty, which is not a bottle.
pub fn volume_of(grams: f64, empty_g: Option<f64>, full_g: f64, volume_ml: Option<f64>) -> Volume {
    if let (Some(empty), Some(stated)) = (empty_g, volume_ml) {
        let capacity_g = full_g - empty;
        if capacity_g > 0.0 && stated > 0.0 {
            return Volume::Measured { ml: grams * stated / capacity_g };
        }
    }
    Volume::Assumed { ml: grams / DENSITY }
}

/// Render a volume the way a person says it.
///
/// Litres past a litre, millilitres below — nobody says "0.35 litres" out loud,
/// and nobody says "2,400 millilitres" either.
pub fn describe(ml: f64) -> String {
    if ml >= 1000.0 {
        let l = ml / 1000.0;
        // One decimal is the most a kitchen scale and a bottle can support
        // between them; two would be inventing precision.
        format!("{:.1} L", l)
    } else {
        format!("{} ml", ml.round() as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_calibrated_bottle_scales_between_its_own_two_weighings() {
        // Weighed 140 g empty and 1,130 g full, sold as a litre: 990 g of water
        // is what its owner calls one litre, so 495 g is half of one.
        let v = volume_of(495.0, Some(140.0), 1130.0, Some(1000.0));
        assert!(v.is_measured());
        assert!((v.ml() - 500.0).abs() < 0.001);
        assert!((v.litres() - 0.5).abs() < 0.000_001);
    }

    #[test]
    fn the_label_is_honoured_even_when_the_bottle_does_not_hold_it() {
        // A "1 litre" bottle that actually takes 940 g of water to the line its
        // owner fills to. Drinking all of it is one litre TO THEM, and that is
        // the number they think in — which is the whole reason the stated
        // volume is asked for rather than derived from the mass.
        let v = volume_of(940.0, Some(120.0), 1060.0, Some(1000.0));
        assert!((v.ml() - 1000.0).abs() < 0.001);
    }

    #[test]
    fn an_uncalibrated_bottle_falls_back_to_density_and_says_so() {
        let v = volume_of(500.0, None, 1050.0, None);
        assert!(!v.is_measured());
        // 500 g of water is a little over 500 ml, not a little under.
        assert!(v.ml() > 500.0 && v.ml() < 501.0);
    }

    #[test]
    fn half_a_calibration_is_not_a_calibration() {
        // A bottle weighed empty but never told what it is called, and one told
        // its volume but never weighed empty, are both uncalibrated. The scale
        // factor needs both halves.
        assert!(!volume_of(500.0, Some(140.0), 1130.0, None).is_measured());
        assert!(!volume_of(500.0, None, 1130.0, Some(1000.0)).is_measured());
    }

    #[test]
    fn a_bottle_that_weighs_the_same_full_as_empty_is_not_divided_by() {
        // Would be a division by zero, and before that a nonsense bottle.
        let v = volume_of(500.0, Some(1130.0), 1130.0, Some(1000.0));
        assert!(!v.is_measured(), "no capacity means no scale factor");
        assert!(v.ml().is_finite());
    }

    #[test]
    fn volumes_read_the_way_people_say_them() {
        assert_eq!(describe(2400.0), "2.4 L");
        assert_eq!(describe(1000.0), "1.0 L");
        assert_eq!(describe(350.0), "350 ml");
        assert_eq!(describe(0.0), "0 ml");
    }
}
