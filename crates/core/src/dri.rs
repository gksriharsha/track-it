//! Dietary Reference Intakes, by life stage.
//!
//! The other reference system in this app. [`crate::targets`] holds the FDA
//! Daily Values — one adult column, the figures printed on a pack. These are
//! the NASEM/IOM **DRIs**, which vary by age, by sex, and by pregnancy and
//! lactation, and which are what a person actually needs. The two diverge
//! substantially: the DV for iron is 18 mg against an adult male RDA of 8 mg,
//! and a 25-year-old woman's iron RDA is 18 mg against 8 mg at 55.
//!
//! **An RDA and an AI are not the same kind of number and this module keeps
//! them apart.** An RDA is set to meet the needs of 97–98% of a group and an
//! intake below it is meaningfully short. An AI is set where the evidence could
//! not support an RDA — usually the observed median intake of an apparently
//! healthy population — so falling under one says much less. Rendering both as
//! "% of target" without saying which is which would give the second the
//! authority of the first.
//!
//! Sources, all transcribed from the published tables rather than recalled:
//!
//! - Vitamins and elements: NASEM, *Dietary Reference Intakes for Vitamins and
//!   Elements*, summary tables (via NCBI Bookshelf NBK545442, appendix J).
//! - Macronutrients, total water and fibre: the same appendix's macronutrient
//!   table, from *DRI for Energy, Carbohydrate, Fiber, Fat, Fatty Acids,
//!   Cholesterol, Protein, and Amino Acids* (2005).
//!
//! Infants under one year are deliberately absent. Their DRIs are AIs derived
//! from the composition of breast milk, an intake this app has no way to log,
//! and a food diary is not the instrument for that year.

use serde::{Deserialize, Serialize};

/// The sex whose reference table applies.
///
/// This is a lookup key into published tables that have exactly two columns —
/// not a statement about the person. Every screen that asks for it says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sex {
    Female,
    Male,
}

impl Sex {
    pub fn as_str(self) -> &'static str {
        match self {
            Sex::Female => "female",
            Sex::Male => "male",
        }
    }

    pub fn parse(s: &str) -> Option<Sex> {
        match s {
            "female" => Some(Sex::Female),
            "male" => Some(Sex::Male),
            _ => None,
        }
    }
}

/// Pregnancy and lactation move a dozen targets a long way — folate from 400 to
/// 600 µg, iron from 18 to 27 mg, iodine from 150 to 220 µg — so they are their
/// own columns in the tables rather than an adjustment applied to one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifeStage {
    Standard,
    Pregnant,
    Lactating,
}

impl LifeStage {
    pub fn as_str(self) -> &'static str {
        match self {
            LifeStage::Standard => "standard",
            LifeStage::Pregnant => "pregnant",
            LifeStage::Lactating => "lactating",
        }
    }

    pub fn parse(s: &str) -> Option<LifeStage> {
        match s {
            "standard" => Some(LifeStage::Standard),
            "pregnant" => Some(LifeStage::Pregnant),
            "lactating" => Some(LifeStage::Lactating),
            _ => None,
        }
    }
}

/// How much of the day is spent moving, as the multiplier applied to resting
/// energy expenditure. See [`energy_estimate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    Sedentary,
    Light,
    Moderate,
    VeryActive,
    ExtraActive,
}

impl Activity {
    /// The conventional activity factors applied to a resting-metabolic-rate
    /// estimate. They are round numbers by construction and carry no more
    /// precision than that.
    pub fn factor(self) -> f64 {
        match self {
            Activity::Sedentary => 1.2,
            Activity::Light => 1.375,
            Activity::Moderate => 1.55,
            Activity::VeryActive => 1.725,
            Activity::ExtraActive => 1.9,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Activity::Sedentary => "sedentary",
            Activity::Light => "light",
            Activity::Moderate => "moderate",
            Activity::VeryActive => "very_active",
            Activity::ExtraActive => "extra_active",
        }
    }

    pub fn parse(s: &str) -> Option<Activity> {
        match s {
            "sedentary" => Some(Activity::Sedentary),
            "light" => Some(Activity::Light),
            "moderate" => Some(Activity::Moderate),
            "very_active" => Some(Activity::VeryActive),
            "extra_active" => Some(Activity::ExtraActive),
            _ => None,
        }
    }
}

/// A life-stage group — one column of the published tables.
///
/// The ordinal is the index into every table below, so this order is
/// load-bearing and must not be rearranged without moving all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Group {
    Child1To3,
    Child4To8,
    Male9To13,
    Male14To18,
    Male19To30,
    Male31To50,
    Male51To70,
    Male71Plus,
    Female9To13,
    Female14To18,
    Female19To30,
    Female31To50,
    Female51To70,
    Female71Plus,
    Pregnancy14To18,
    Pregnancy19To30,
    Pregnancy31To50,
    Lactation14To18,
    Lactation19To30,
    Lactation31To50,
}

const GROUPS: usize = 20;

impl Group {
    fn index(self) -> usize {
        self as usize
    }

    /// How the published tables name this column, for the UI to show back.
    pub fn label(self) -> &'static str {
        match self {
            Group::Child1To3 => "Children 1–3 years",
            Group::Child4To8 => "Children 4–8 years",
            Group::Male9To13 => "Males 9–13 years",
            Group::Male14To18 => "Males 14–18 years",
            Group::Male19To30 => "Males 19–30 years",
            Group::Male31To50 => "Males 31–50 years",
            Group::Male51To70 => "Males 51–70 years",
            Group::Male71Plus => "Males over 70",
            Group::Female9To13 => "Females 9–13 years",
            Group::Female14To18 => "Females 14–18 years",
            Group::Female19To30 => "Females 19–30 years",
            Group::Female31To50 => "Females 31–50 years",
            Group::Female51To70 => "Females 51–70 years",
            Group::Female71Plus => "Females over 70",
            Group::Pregnancy14To18 => "Pregnancy, 14–18 years",
            Group::Pregnancy19To30 => "Pregnancy, 19–30 years",
            Group::Pregnancy31To50 => "Pregnancy, 31–50 years",
            Group::Lactation14To18 => "Lactation, 14–18 years",
            Group::Lactation19To30 => "Lactation, 19–30 years",
            Group::Lactation31To50 => "Lactation, 31–50 years",
        }
    }
}

/// Which column of the tables a person falls in.
///
/// `None` when the profile cannot place them: no age, no sex, or an age under
/// one year, for which this module holds nothing. The caller then falls back to
/// the Daily Values and must say that it has.
pub fn group_for(sex: Option<Sex>, age_years: Option<u32>, stage: LifeStage) -> Option<Group> {
    let age = age_years?;
    if age < 1 {
        return None;
    }
    // Pregnancy and lactation have their own columns and no male equivalent, so
    // they are resolved before sex is consulted at all.
    if stage != LifeStage::Standard {
        // The tables stop at 50. Beyond it there is no published column, so the
        // honest answer is that these tables cannot place this person.
        let band = match age {
            0..=13 => return None,
            14..=18 => 0,
            19..=30 => 1,
            31..=50 => 2,
            _ => return None,
        };
        return Some(match (stage, band) {
            (LifeStage::Pregnant, 0) => Group::Pregnancy14To18,
            (LifeStage::Pregnant, 1) => Group::Pregnancy19To30,
            (LifeStage::Pregnant, _) => Group::Pregnancy31To50,
            (_, 0) => Group::Lactation14To18,
            (_, 1) => Group::Lactation19To30,
            (_, _) => Group::Lactation31To50,
        });
    }
    // Under nine, the tables do not split by sex.
    if age <= 3 {
        return Some(Group::Child1To3);
    }
    if age <= 8 {
        return Some(Group::Child4To8);
    }
    let sex = sex?;
    Some(match (sex, age) {
        (Sex::Male, 9..=13) => Group::Male9To13,
        (Sex::Male, 14..=18) => Group::Male14To18,
        (Sex::Male, 19..=30) => Group::Male19To30,
        (Sex::Male, 31..=50) => Group::Male31To50,
        (Sex::Male, 51..=70) => Group::Male51To70,
        (Sex::Male, _) => Group::Male71Plus,
        (Sex::Female, 9..=13) => Group::Female9To13,
        (Sex::Female, 14..=18) => Group::Female14To18,
        (Sex::Female, 19..=30) => Group::Female19To30,
        (Sex::Female, 31..=50) => Group::Female31To50,
        (Sex::Female, 51..=70) => Group::Female51To70,
        (Sex::Female, _) => Group::Female71Plus,
    })
}

/// What kind of number a target is. Rendered, never hidden: the four say very
/// different things about what falling short of them means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    /// Recommended Dietary Allowance — meets the needs of 97–98% of the group.
    Rda,
    /// Adequate Intake — used where the evidence could not support an RDA, and
    /// usually the observed median intake of a healthy population. Being under
    /// one is much weaker evidence of a shortfall than being under an RDA.
    Ai,
    /// FDA Daily Value: one adult column, the figure printed on a pack. What
    /// this app falls back to when the profile cannot place someone.
    DailyValue,
    /// A figure the user set themselves.
    UserSet,
}

impl Basis {
    pub fn as_str(self) -> &'static str {
        match self {
            Basis::Rda => "rda",
            Basis::Ai => "ai",
            Basis::DailyValue => "daily_value",
            Basis::UserSet => "user_set",
        }
    }
}

/// One nutrient's reference table, in `Group` order, with the kind of number it
/// holds. `None` in a slot means the tables publish nothing for that column.
struct Row {
    nutrient_id: i64,
    basis: Basis,
    values: [Option<f64>; GROUPS],
}

/// Shorthand for a table row where every column has a value.
const fn all(v: [f64; GROUPS]) -> [Option<f64>; GROUPS] {
    let mut out = [None; GROUPS];
    let mut i = 0;
    while i < GROUPS {
        out[i] = Some(v[i]);
        i += 1;
    }
    out
}

/// The DRI tables.
///
/// Values are in the magnitude **this app stores the nutrient in**, which is
/// not always the magnitude the published table prints. Copper is published in
/// µg and stored here in mg; fluoride is published in mg and stored in µg. Both
/// conversions are done once, here, with the published figure in the comment,
/// so a reader can check the arithmetic against the source.
fn table() -> Vec<Row> {
    vec![
        // ── vitamins ────────────────────────────────────────────────────
        Row { nutrient_id: 1106, basis: Basis::Rda, values: all([ // Vitamin A, µg RAE
            300.0, 400.0, 600.0, 900.0, 900.0, 900.0, 900.0, 900.0,
            600.0, 700.0, 700.0, 700.0, 700.0, 700.0,
            750.0, 770.0, 770.0, 1200.0, 1300.0, 1300.0]) },
        Row { nutrient_id: 1162, basis: Basis::Rda, values: all([ // Vitamin C, mg
            15.0, 25.0, 45.0, 75.0, 90.0, 90.0, 90.0, 90.0,
            45.0, 65.0, 75.0, 75.0, 75.0, 75.0,
            80.0, 85.0, 85.0, 115.0, 120.0, 120.0]) },
        Row { nutrient_id: 1114, basis: Basis::Rda, values: all([ // Vitamin D, µg
            15.0, 15.0, 15.0, 15.0, 15.0, 15.0, 15.0, 20.0,
            15.0, 15.0, 15.0, 15.0, 15.0, 20.0,
            15.0, 15.0, 15.0, 15.0, 15.0, 15.0]) },
        Row { nutrient_id: 1109, basis: Basis::Rda, values: all([ // Vitamin E, mg α-tocopherol
            6.0, 7.0, 11.0, 15.0, 15.0, 15.0, 15.0, 15.0,
            11.0, 15.0, 15.0, 15.0, 15.0, 15.0,
            15.0, 15.0, 15.0, 19.0, 19.0, 19.0]) },
        Row { nutrient_id: 1185, basis: Basis::Ai, values: all([ // Vitamin K, µg
            30.0, 55.0, 60.0, 75.0, 120.0, 120.0, 120.0, 120.0,
            60.0, 75.0, 90.0, 90.0, 90.0, 90.0,
            75.0, 90.0, 90.0, 75.0, 90.0, 90.0]) },
        Row { nutrient_id: 1165, basis: Basis::Rda, values: all([ // Thiamin, mg
            0.5, 0.6, 0.9, 1.2, 1.2, 1.2, 1.2, 1.2,
            0.9, 1.0, 1.1, 1.1, 1.1, 1.1,
            1.4, 1.4, 1.4, 1.4, 1.4, 1.4]) },
        Row { nutrient_id: 1166, basis: Basis::Rda, values: all([ // Riboflavin, mg
            0.5, 0.6, 0.9, 1.3, 1.3, 1.3, 1.3, 1.3,
            0.9, 1.0, 1.1, 1.1, 1.1, 1.1,
            1.4, 1.4, 1.4, 1.6, 1.6, 1.6]) },
        // Published in mg NE; this app stores nutrient 1167 as mg of niacin.
        // The FDA Daily Value in `targets` already carries the same mismatch,
        // and D6 forbids the app from converting between the two bases without
        // knowing the tryptophan contribution. Carried across unchanged so both
        // reference systems say the same thing, and flagged rather than fudged.
        Row { nutrient_id: 1167, basis: Basis::Rda, values: all([ // Niacin, mg NE
            6.0, 8.0, 12.0, 16.0, 16.0, 16.0, 16.0, 16.0,
            12.0, 14.0, 14.0, 14.0, 14.0, 14.0,
            18.0, 18.0, 18.0, 17.0, 17.0, 17.0]) },
        Row { nutrient_id: 1175, basis: Basis::Rda, values: all([ // Vitamin B6, mg
            0.5, 0.6, 1.0, 1.3, 1.3, 1.3, 1.7, 1.7,
            1.0, 1.2, 1.3, 1.3, 1.5, 1.5,
            1.9, 1.9, 1.9, 2.0, 2.0, 2.0]) },
        Row { nutrient_id: 1190, basis: Basis::Rda, values: all([ // Folate, µg DFE
            150.0, 200.0, 300.0, 400.0, 400.0, 400.0, 400.0, 400.0,
            300.0, 400.0, 400.0, 400.0, 400.0, 400.0,
            600.0, 600.0, 600.0, 500.0, 500.0, 500.0]) },
        Row { nutrient_id: 1178, basis: Basis::Rda, values: all([ // Vitamin B12, µg
            0.9, 1.2, 1.8, 2.4, 2.4, 2.4, 2.4, 2.4,
            1.8, 2.4, 2.4, 2.4, 2.4, 2.4,
            2.6, 2.6, 2.6, 2.8, 2.8, 2.8]) },
        Row { nutrient_id: 1170, basis: Basis::Ai, values: all([ // Pantothenic acid, mg
            2.0, 3.0, 4.0, 5.0, 5.0, 5.0, 5.0, 5.0,
            4.0, 5.0, 5.0, 5.0, 5.0, 5.0,
            6.0, 6.0, 6.0, 7.0, 7.0, 7.0]) },
        Row { nutrient_id: 1176, basis: Basis::Ai, values: all([ // Biotin, µg
            8.0, 12.0, 20.0, 25.0, 30.0, 30.0, 30.0, 30.0,
            20.0, 25.0, 30.0, 30.0, 30.0, 30.0,
            30.0, 30.0, 30.0, 35.0, 35.0, 35.0]) },
        Row { nutrient_id: 1180, basis: Basis::Ai, values: all([ // Choline, mg
            200.0, 250.0, 375.0, 550.0, 550.0, 550.0, 550.0, 550.0,
            375.0, 400.0, 425.0, 425.0, 425.0, 425.0,
            450.0, 450.0, 450.0, 550.0, 550.0, 550.0]) },

        // ── elements ────────────────────────────────────────────────────
        Row { nutrient_id: 1087, basis: Basis::Rda, values: all([ // Calcium, mg
            700.0, 1000.0, 1300.0, 1300.0, 1000.0, 1000.0, 1000.0, 1200.0,
            1300.0, 1300.0, 1000.0, 1000.0, 1200.0, 1200.0,
            1300.0, 1000.0, 1000.0, 1300.0, 1000.0, 1000.0]) },
        Row { nutrient_id: 1096, basis: Basis::Ai, values: all([ // Chromium, µg
            11.0, 15.0, 25.0, 35.0, 35.0, 35.0, 30.0, 30.0,
            21.0, 24.0, 25.0, 25.0, 20.0, 20.0,
            29.0, 30.0, 30.0, 44.0, 45.0, 45.0]) },
        // Published in µg (340, 440, 700, 890, 900 …); stored here in mg.
        Row { nutrient_id: 1098, basis: Basis::Rda, values: all([ // Copper, mg
            0.34, 0.44, 0.7, 0.89, 0.9, 0.9, 0.9, 0.9,
            0.7, 0.89, 0.9, 0.9, 0.9, 0.9,
            1.0, 1.0, 1.0, 1.3, 1.3, 1.3]) },
        // Published in mg (0.7, 1, 2, 3, 4 …); stored here in µg.
        Row { nutrient_id: 1099, basis: Basis::Ai, values: all([ // Fluoride, µg
            700.0, 1000.0, 2000.0, 3000.0, 4000.0, 4000.0, 4000.0, 4000.0,
            2000.0, 3000.0, 3000.0, 3000.0, 3000.0, 3000.0,
            3000.0, 3000.0, 3000.0, 3000.0, 3000.0, 3000.0]) },
        Row { nutrient_id: 1100, basis: Basis::Rda, values: all([ // Iodine, µg
            90.0, 90.0, 120.0, 150.0, 150.0, 150.0, 150.0, 150.0,
            120.0, 150.0, 150.0, 150.0, 150.0, 150.0,
            220.0, 220.0, 220.0, 290.0, 290.0, 290.0]) },
        Row { nutrient_id: 1089, basis: Basis::Rda, values: all([ // Iron, mg
            7.0, 10.0, 8.0, 11.0, 8.0, 8.0, 8.0, 8.0,
            8.0, 15.0, 18.0, 18.0, 8.0, 8.0,
            27.0, 27.0, 27.0, 10.0, 9.0, 9.0]) },
        Row { nutrient_id: 1090, basis: Basis::Rda, values: all([ // Magnesium, mg
            80.0, 130.0, 240.0, 410.0, 400.0, 420.0, 420.0, 420.0,
            240.0, 360.0, 310.0, 320.0, 320.0, 320.0,
            400.0, 350.0, 360.0, 360.0, 310.0, 320.0]) },
        Row { nutrient_id: 1101, basis: Basis::Ai, values: all([ // Manganese, mg
            1.2, 1.5, 1.9, 2.2, 2.3, 2.3, 2.3, 2.3,
            1.6, 1.6, 1.8, 1.8, 1.8, 1.8,
            2.0, 2.0, 2.0, 2.6, 2.6, 2.6]) },
        Row { nutrient_id: 1102, basis: Basis::Rda, values: all([ // Molybdenum, µg
            17.0, 22.0, 34.0, 43.0, 45.0, 45.0, 45.0, 45.0,
            34.0, 43.0, 45.0, 45.0, 45.0, 45.0,
            50.0, 50.0, 50.0, 50.0, 50.0, 50.0]) },
        Row { nutrient_id: 1091, basis: Basis::Rda, values: all([ // Phosphorus, mg
            460.0, 500.0, 1250.0, 1250.0, 700.0, 700.0, 700.0, 700.0,
            1250.0, 1250.0, 700.0, 700.0, 700.0, 700.0,
            1250.0, 700.0, 700.0, 1250.0, 700.0, 700.0]) },
        Row { nutrient_id: 1103, basis: Basis::Rda, values: all([ // Selenium, µg
            20.0, 30.0, 40.0, 55.0, 55.0, 55.0, 55.0, 55.0,
            40.0, 55.0, 55.0, 55.0, 55.0, 55.0,
            60.0, 60.0, 60.0, 70.0, 70.0, 70.0]) },
        Row { nutrient_id: 1095, basis: Basis::Rda, values: all([ // Zinc, mg
            3.0, 5.0, 8.0, 11.0, 11.0, 11.0, 11.0, 11.0,
            8.0, 9.0, 8.0, 8.0, 8.0, 8.0,
            12.0, 11.0, 11.0, 13.0, 12.0, 12.0]) },
        Row { nutrient_id: 1092, basis: Basis::Ai, values: all([ // Potassium, mg
            2000.0, 2300.0, 2500.0, 3000.0, 3400.0, 3400.0, 3400.0, 3400.0,
            2300.0, 2300.0, 2600.0, 2600.0, 2600.0, 2600.0,
            2600.0, 2900.0, 2900.0, 2500.0, 2800.0, 2800.0]) },

        // ── macronutrients, water and the essential fatty acids ─────────
        Row { nutrient_id: 1003, basis: Basis::Rda, values: all([ // Protein, g
            13.0, 19.0, 34.0, 52.0, 56.0, 56.0, 56.0, 56.0,
            34.0, 46.0, 46.0, 46.0, 46.0, 46.0,
            71.0, 71.0, 71.0, 71.0, 71.0, 71.0]) },
        Row { nutrient_id: 1005, basis: Basis::Rda, values: all([ // Carbohydrate, g
            130.0, 130.0, 130.0, 130.0, 130.0, 130.0, 130.0, 130.0,
            130.0, 130.0, 130.0, 130.0, 130.0, 130.0,
            175.0, 175.0, 175.0, 210.0, 210.0, 210.0]) },
        Row { nutrient_id: 1079, basis: Basis::Ai, values: all([ // Total fibre, g
            19.0, 25.0, 31.0, 38.0, 38.0, 38.0, 30.0, 30.0,
            26.0, 26.0, 25.0, 25.0, 21.0, 21.0,
            28.0, 28.0, 28.0, 29.0, 29.0, 29.0]) },
        // Published as total water in L/d, which includes water from food AND
        // from drinks. This app's nutrient 1051 sums the water in everything
        // logged, so the comparison only holds for someone who logs what they
        // drink as well as what they eat. The UI says so.
        Row { nutrient_id: 1051, basis: Basis::Ai, values: all([ // Total water, g
            1300.0, 1700.0, 2400.0, 3300.0, 3700.0, 3700.0, 3700.0, 3700.0,
            2100.0, 2300.0, 2700.0, 2700.0, 2700.0, 2700.0,
            3000.0, 3000.0, 3000.0, 3800.0, 3800.0, 3800.0]) },
        Row { nutrient_id: 1316, basis: Basis::Ai, values: all([ // Linoleic acid, g
            7.0, 10.0, 12.0, 16.0, 17.0, 17.0, 14.0, 14.0,
            10.0, 11.0, 12.0, 12.0, 11.0, 11.0,
            13.0, 13.0, 13.0, 13.0, 13.0, 13.0]) },
        Row { nutrient_id: 1404, basis: Basis::Ai, values: all([ // α-linolenic acid, g
            0.7, 0.9, 1.2, 1.6, 1.6, 1.6, 1.6, 1.6,
            1.0, 1.1, 1.1, 1.1, 1.1, 1.1,
            1.4, 1.4, 1.4, 1.3, 1.3, 1.3]) },
    ]
}

/// One nutrient's reference amount for one life-stage group.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Reference {
    pub nutrient_id: i64,
    pub amount: f64,
    pub basis: Basis,
}

/// Every DRI published for this group, in the magnitudes this app stores.
pub fn for_group(group: Group) -> Vec<Reference> {
    table()
        .into_iter()
        .filter_map(|r| {
            r.values[group.index()].map(|amount| Reference {
                nutrient_id: r.nutrient_id,
                amount,
                basis: r.basis,
            })
        })
        .collect()
}

/// This group's reference for one nutrient, or `None` where the tables publish
/// nothing for it — saturated fat, added sugars and cholesterol among them,
/// which have no DRI at all and keep whatever limit the Daily Values give.
pub fn for_nutrient(group: Group, nutrient_id: i64) -> Option<Reference> {
    for_group(group)
        .into_iter()
        .find(|r| r.nutrient_id == nutrient_id)
}

/// An estimate of how much energy a day needs, and how uncertain it is.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct EnergyEstimate {
    /// Resting metabolic rate, kcal/day.
    pub resting: f64,
    /// Resting times the activity factor, kcal/day.
    pub total: f64,
    /// The activity multiplier that was applied.
    pub factor: f64,
}

/// Estimate a day's energy need from the profile.
///
/// **This is an estimate and the app must never print it as a measurement.**
/// It uses Mifflin–St Jeor for resting metabolic rate, which is the equation
/// with the best-validated performance in the general adult population, times a
/// conventional activity factor:
///
/// ```text
/// male:   RMR = 10·kg + 6.25·cm − 5·age + 5
/// female: RMR = 10·kg + 6.25·cm − 5·age − 161
/// ```
///
/// Two honest caveats the UI is obliged to carry. The equation predicts an
/// individual's resting expenditure to roughly ±10% at best, and the activity
/// factors are round numbers standing in for a quantity that genuinely varies
/// day to day. So the figure is a starting point for someone with no better
/// number, not a target derived from this person's own physiology — and anyone
/// who has measured or been given a figure should enter that instead.
///
/// Returns `None` unless sex, age, height, weight and activity are all known.
/// There is no partial answer here: leaving one out and guessing at it would
/// make the result a fiction with a plausible number attached.
pub fn energy_estimate(
    sex: Option<Sex>,
    age_years: Option<u32>,
    height_cm: Option<f64>,
    weight_kg: Option<f64>,
    activity: Option<Activity>,
) -> Option<EnergyEstimate> {
    let (sex, age, height, weight, activity) = (sex?, age_years?, height_cm?, weight_kg?, activity?);
    if !(height.is_finite() && height > 0.0) || !(weight.is_finite() && weight > 0.0) {
        return None;
    }
    let offset = match sex {
        Sex::Male => 5.0,
        Sex::Female => -161.0,
    };
    let resting = 10.0 * weight + 6.25 * height - 5.0 * age as f64 + offset;
    if !(resting.is_finite() && resting > 0.0) {
        return None;
    }
    let factor = activity.factor();
    Some(EnergyEstimate {
        resting,
        total: resting * factor,
        factor,
    })
}

/// An Acceptable Macronutrient Distribution Range: a share of total energy, as
/// a percentage, within which intake is associated with a lower risk of chronic
/// disease while supplying essential nutrients.
///
/// A **range**, which is the whole point. A macronutrient has no single right
/// number, and rendering the midpoint as a target would invent a precision the
/// science does not have.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Amdr {
    pub nutrient_id: i64,
    pub low_pct: f64,
    pub high_pct: f64,
    /// Energy per gram, for turning a share of energy into grams.
    pub kcal_per_gram: f64,
}

/// The AMDRs, which widen for young children.
///
/// From the 2005 macronutrients DRI report. Adults and children over 18 take
/// the adult ranges; 4–18 and 1–3 have their own, because a growing child needs
/// a larger share of energy from fat.
pub fn amdrs(group: Group) -> Vec<Amdr> {
    let (fat, protein) = match group {
        Group::Child1To3 => ((30.0, 40.0), (5.0, 20.0)),
        Group::Child4To8 | Group::Male9To13 | Group::Female9To13 => ((25.0, 35.0), (10.0, 30.0)),
        Group::Male14To18 | Group::Female14To18 => ((25.0, 35.0), (10.0, 30.0)),
        _ => ((20.0, 35.0), (10.0, 35.0)),
    };
    vec![
        Amdr { nutrient_id: 1005, low_pct: 45.0, high_pct: 65.0, kcal_per_gram: 4.0 },
        Amdr { nutrient_id: 1004, low_pct: fat.0, high_pct: fat.1, kcal_per_gram: 9.0 },
        Amdr { nutrient_id: 1003, low_pct: protein.0, high_pct: protein.1, kcal_per_gram: 4.0 },
    ]
}

/// The gram range an AMDR works out to at a given energy intake.
pub fn amdr_grams(a: &Amdr, kcal: f64) -> (f64, f64) {
    (
        kcal * a.low_pct / 100.0 / a.kcal_per_gram,
        kcal * a.high_pct / 100.0 / a.kcal_per_gram,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn amount(group: Group, id: i64) -> f64 {
        for_nutrient(group, id).expect("published for this group").amount
    }

    #[test]
    fn every_row_covers_every_group() {
        // A hole in a table would silently become "no target" for one column
        // rather than the number the source publishes.
        for r in table() {
            for (i, v) in r.values.iter().enumerate() {
                assert!(
                    v.is_some(),
                    "nutrient {} has no value at group index {i}",
                    r.nutrient_id
                );
            }
        }
    }

    #[test]
    fn no_nutrient_is_tabulated_twice() {
        let mut ids: Vec<i64> = table().iter().map(|r| r.nutrient_id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "a nutrient appears in two rows");
    }

    #[test]
    fn iron_differs_by_sex_and_falls_after_menopause() {
        // The single clearest reason a one-column table is not good enough: the
        // Daily Value is 18 mg for everybody, which is more than double an
        // adult man's requirement and wrong for a woman over 50 too.
        assert!(close(amount(Group::Male19To30, 1089), 8.0));
        assert!(close(amount(Group::Female19To30, 1089), 18.0));
        assert!(close(amount(Group::Female51To70, 1089), 8.0));
        assert!(close(amount(Group::Pregnancy19To30, 1089), 27.0));
    }

    #[test]
    fn pregnancy_and_lactation_move_folate_iodine_and_iron() {
        assert!(close(amount(Group::Female19To30, 1190), 400.0));
        assert!(close(amount(Group::Pregnancy19To30, 1190), 600.0));
        assert!(close(amount(Group::Lactation19To30, 1190), 500.0));

        assert!(close(amount(Group::Female19To30, 1100), 150.0));
        assert!(close(amount(Group::Pregnancy19To30, 1100), 220.0));
        assert!(close(amount(Group::Lactation19To30, 1100), 290.0));
    }

    #[test]
    fn an_ai_is_marked_as_one_so_the_ui_cannot_present_it_as_an_rda() {
        // Falling short of an AI says much less than falling short of an RDA,
        // and the app must be able to tell the reader which it is looking at.
        assert_eq!(for_nutrient(Group::Male19To30, 1092).unwrap().basis, Basis::Ai); // potassium
        assert_eq!(for_nutrient(Group::Male19To30, 1185).unwrap().basis, Basis::Ai); // vitamin K
        assert_eq!(for_nutrient(Group::Male19To30, 1079).unwrap().basis, Basis::Ai); // fibre
        assert_eq!(for_nutrient(Group::Male19To30, 1089).unwrap().basis, Basis::Rda); // iron
        assert_eq!(for_nutrient(Group::Male19To30, 1190).unwrap().basis, Basis::Rda); // folate
    }

    #[test]
    fn published_unit_conversions_are_applied_once() {
        // Copper is published in µg and stored in mg; fluoride the other way.
        // Getting either backwards is a thousandfold error that would look
        // entirely plausible on screen.
        assert!(close(amount(Group::Male19To30, 1098), 0.9), "copper is 900 µg = 0.9 mg");
        assert!(close(amount(Group::Male19To30, 1099), 4000.0), "fluoride is 4 mg = 4000 µg");
    }

    #[test]
    fn nutrients_with_no_dri_are_absent_rather_than_invented() {
        // Saturated fat, added sugars, cholesterol and trans fat have no DRI —
        // the reports say "as low as possible", which is not a number. They
        // must return None so the caller falls back to the Daily Value limit
        // rather than getting a figure this module made up.
        for id in [1258, 1235, 1253, 1257] {
            assert!(
                for_nutrient(Group::Male19To30, id).is_none(),
                "nutrient {id} has no DRI and must not be tabulated"
            );
        }
    }

    #[test]
    fn sodium_is_not_a_target_to_reach() {
        // Sodium has an AI of 1,500 mg, but the app treats sodium as a ceiling
        // (the 2019 CDRR of 2,300 mg). Publishing the AI here would put a
        // "reach 1,500 mg of sodium" bar on the dashboard, which is the
        // opposite of the advice.
        assert!(for_nutrient(Group::Male19To30, 1093).is_none());
    }

    // ── placing a person in the tables ──────────────────────────────────

    #[test]
    fn a_profile_without_age_or_sex_cannot_be_placed() {
        assert_eq!(group_for(Some(Sex::Male), None, LifeStage::Standard), None);
        assert_eq!(group_for(None, Some(30), LifeStage::Standard), None);
        // ...but under nine the tables do not split by sex, so age alone is enough.
        assert_eq!(group_for(None, Some(5), LifeStage::Standard), Some(Group::Child4To8));
    }

    #[test]
    fn age_bands_land_on_the_right_side_of_every_boundary() {
        let m = |age| group_for(Some(Sex::Male), Some(age), LifeStage::Standard);
        assert_eq!(m(8), Some(Group::Child4To8));
        assert_eq!(m(9), Some(Group::Male9To13));
        assert_eq!(m(13), Some(Group::Male9To13));
        assert_eq!(m(14), Some(Group::Male14To18));
        assert_eq!(m(18), Some(Group::Male14To18));
        assert_eq!(m(19), Some(Group::Male19To30));
        assert_eq!(m(30), Some(Group::Male19To30));
        assert_eq!(m(31), Some(Group::Male31To50));
        assert_eq!(m(50), Some(Group::Male31To50));
        assert_eq!(m(51), Some(Group::Male51To70));
        assert_eq!(m(70), Some(Group::Male51To70));
        assert_eq!(m(71), Some(Group::Male71Plus));
    }

    #[test]
    fn pregnancy_resolves_before_sex_and_stops_where_the_tables_do() {
        assert_eq!(
            group_for(Some(Sex::Female), Some(28), LifeStage::Pregnant),
            Some(Group::Pregnancy19To30)
        );
        assert_eq!(
            group_for(None, Some(28), LifeStage::Lactating),
            Some(Group::Lactation19To30),
            "the pregnancy columns have no male counterpart, so sex is not needed"
        );
        // The tables publish nothing beyond 50, so neither does this.
        assert_eq!(group_for(Some(Sex::Female), Some(52), LifeStage::Pregnant), None);
        assert_eq!(group_for(Some(Sex::Female), Some(12), LifeStage::Pregnant), None);
    }

    #[test]
    fn an_infant_is_not_placed_at_all() {
        assert_eq!(group_for(Some(Sex::Female), Some(0), LifeStage::Standard), None);
    }

    // ── energy ──────────────────────────────────────────────────────────

    #[test]
    fn energy_needs_every_input_and_refuses_a_partial_profile() {
        // Guessing at a missing height or weight would produce a fiction with a
        // plausible number attached, which is worse than no figure.
        assert!(energy_estimate(Some(Sex::Male), Some(30), Some(175.0), Some(70.0), None).is_none());
        assert!(energy_estimate(Some(Sex::Male), Some(30), Some(175.0), None, Some(Activity::Light)).is_none());
        assert!(energy_estimate(Some(Sex::Male), Some(30), None, Some(70.0), Some(Activity::Light)).is_none());
        assert!(energy_estimate(Some(Sex::Male), None, Some(175.0), Some(70.0), Some(Activity::Light)).is_none());
        assert!(energy_estimate(None, Some(30), Some(175.0), Some(70.0), Some(Activity::Light)).is_none());
    }

    #[test]
    fn mifflin_st_jeor_matches_the_published_equation() {
        // Man, 30 y, 175 cm, 70 kg: 10·70 + 6.25·175 − 5·30 + 5 = 1,648.75
        let e = energy_estimate(
            Some(Sex::Male), Some(30), Some(175.0), Some(70.0), Some(Activity::Sedentary),
        )
        .unwrap();
        assert!(close(e.resting, 1648.75), "got {}", e.resting);
        assert!(close(e.total, 1648.75 * 1.2));

        // Woman, same body: the offset differs by 166 kcal.
        let f = energy_estimate(
            Some(Sex::Female), Some(30), Some(175.0), Some(70.0), Some(Activity::Sedentary),
        )
        .unwrap();
        assert!(close(f.resting, 1482.75), "got {}", f.resting);
    }

    #[test]
    fn a_nonsense_body_produces_no_estimate_rather_than_a_negative_one() {
        assert!(energy_estimate(Some(Sex::Female), Some(30), Some(0.0), Some(70.0), Some(Activity::Light)).is_none());
        assert!(energy_estimate(Some(Sex::Female), Some(30), Some(175.0), Some(-5.0), Some(Activity::Light)).is_none());
        assert!(energy_estimate(Some(Sex::Female), Some(30), Some(f64::NAN), Some(70.0), Some(Activity::Light)).is_none());
    }

    // ── macronutrient ranges ────────────────────────────────────────────

    #[test]
    fn amdrs_are_ranges_and_widen_for_small_children() {
        let adult = amdrs(Group::Male31To50);
        let fat = adult.iter().find(|a| a.nutrient_id == 1004).unwrap();
        assert_eq!((fat.low_pct, fat.high_pct), (20.0, 35.0));

        let toddler = amdrs(Group::Child1To3);
        let tfat = toddler.iter().find(|a| a.nutrient_id == 1004).unwrap();
        assert_eq!((tfat.low_pct, tfat.high_pct), (30.0, 40.0));
    }

    #[test]
    fn an_amdr_becomes_grams_only_against_an_energy_figure() {
        // 2,000 kcal: carbohydrate 45–65% is 225–325 g.
        let carb = amdrs(Group::Male31To50)
            .into_iter()
            .find(|a| a.nutrient_id == 1005)
            .unwrap();
        let (lo, hi) = amdr_grams(&carb, 2000.0);
        assert!(close(lo, 225.0), "got {lo}");
        assert!(close(hi, 325.0), "got {hi}");
    }
}
