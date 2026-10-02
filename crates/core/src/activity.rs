//! What a person did, as distinct from what they ate.
//!
//! Two kinds of record: a session of movement measured in minutes and effort
//! (a walk, a swim, a yoga class), and a strength session measured in sets.
//! This module holds the arithmetic both come down to over a period, and
//! deliberately holds nothing that would turn either into a score.
//!
//! There is no energy figure here. "Calories burned" is the number most fitness
//! apps lead with, and it is the one that turns a day into a budget — eat back
//! what you earned. It is also an estimate that misses for any one person by a
//! fifth or more, and the profile's activity factor already counts habitual
//! exercise once; adding a session's estimate on top would count it twice. See
//! `docs/decisions.md` D26.
//!
//! Dates do not appear either. The caller asks SQLite how many days before the
//! end of the period each session fell, for the reason `store::today_iso`
//! gives: every date in the log came from that calendar, and a second one
//! computed here would disagree with it across a daylight-saving boundary.

use serde::Serialize;

/// What was done. A short fixed list of plain words, so the period can say what
/// a week was made of; a session's own name ("Badminton", "Evening walk") is a
/// free-text label beside it, not a new kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Walk,
    Run,
    Cycle,
    Swim,
    Yoga,
    Strength,
    Sport,
    Dance,
    Other,
}

impl Kind {
    pub const ALL: [Kind; 9] = [
        Kind::Walk,
        Kind::Run,
        Kind::Cycle,
        Kind::Swim,
        Kind::Yoga,
        Kind::Strength,
        Kind::Sport,
        Kind::Dance,
        Kind::Other,
    ];

    pub fn parse(s: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.as_str() == s)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Walk => "walk",
            Kind::Run => "run",
            Kind::Cycle => "cycle",
            Kind::Swim => "swim",
            Kind::Yoga => "yoga",
            Kind::Strength => "strength",
            Kind::Sport => "sport",
            Kind::Dance => "dance",
            Kind::Other => "other",
        }
    }
}

/// How hard, by the talk test rather than by heart rate: nobody typing a walk
/// in afterwards knows their heart rate, and everybody knows whether they could
/// still talk. Stored under the WHO's own words so the reference line below can
/// cite them without translation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Effort {
    /// Could sing. Counts toward time spent moving, not toward the WHO line.
    Light,
    /// Could talk but not sing.
    Moderate,
    /// Only a few words at a time.
    Vigorous,
}

impl Effort {
    pub fn parse(s: &str) -> Option<Effort> {
        match s {
            "light" => Some(Effort::Light),
            "moderate" => Some(Effort::Moderate),
            "vigorous" => Some(Effort::Vigorous),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Light => "light",
            Effort::Moderate => "moderate",
            Effort::Vigorous => "vigorous",
        }
    }
}

/// What a set of an exercise is counted in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Load {
    /// Kilograms lifted, times repetitions.
    Weight,
    /// Repetitions of the body's own weight. Added weight is allowed — a
    /// weighted pull-up is still a pull-up — but not expected.
    Body,
    /// Held for seconds: a plank.
    Time,
}

impl Load {
    pub fn parse(s: &str) -> Option<Load> {
        match s {
            "weight" => Some(Load::Weight),
            "body" => Some(Load::Body),
            "time" => Some(Load::Time),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Load::Weight => "weight",
            Load::Body => "body",
            Load::Time => "time",
        }
    }
}

/// The lifts most people will reach for, offered after the user's own.
///
/// Plain names, the ones written on a gym whiteboard. Not a database of
/// variations: a person who does a deficit Romanian deadlift with a pause can
/// name it themselves, and their name then ranks first from that day on.
pub const COMMON_EXERCISES: &[(&str, Load)] = &[
    ("Squat", Load::Weight),
    ("Front squat", Load::Weight),
    ("Goblet squat", Load::Weight),
    ("Deadlift", Load::Weight),
    ("Romanian deadlift", Load::Weight),
    ("Bench press", Load::Weight),
    ("Incline bench press", Load::Weight),
    ("Overhead press", Load::Weight),
    ("Barbell row", Load::Weight),
    ("Dumbbell row", Load::Weight),
    ("Lat pulldown", Load::Weight),
    ("Seated cable row", Load::Weight),
    ("Leg press", Load::Weight),
    ("Leg curl", Load::Weight),
    ("Leg extension", Load::Weight),
    ("Hip thrust", Load::Weight),
    ("Calf raise", Load::Weight),
    ("Lunge", Load::Weight),
    ("Bulgarian split squat", Load::Weight),
    ("Biceps curl", Load::Weight),
    ("Triceps pushdown", Load::Weight),
    ("Lateral raise", Load::Weight),
    ("Face pull", Load::Weight),
    ("Kettlebell swing", Load::Weight),
    ("Pull-up", Load::Body),
    ("Chin-up", Load::Body),
    ("Push-up", Load::Body),
    ("Dip", Load::Body),
    ("Hanging leg raise", Load::Body),
    ("Crunch", Load::Body),
    ("Plank", Load::Time),
    ("Side plank", Load::Time),
];

/// One session as the period arithmetic needs it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Session {
    /// Days before the last day of the period: 0 is that day itself.
    pub days_before_end: u32,
    pub kind: Kind,
    /// Required for everything but strength, where how long it took is often
    /// not known and is never needed to say what was lifted.
    pub minutes: Option<f64>,
    pub effort: Option<Effort>,
}

/// Minutes in the currency the WHO 2020 adult guideline is written in: a
/// vigorous minute counts as two moderate ones, and light activity does not
/// count toward the line at all.
///
/// Strength is left out even when it was hard. The guideline treats
/// muscle-strengthening as its own recommendation, counted in days, and folding
/// a heavy squat session into aerobic minutes would answer a question the
/// guideline does not ask.
pub fn aerobic_minutes(s: &Session) -> f64 {
    if s.kind == Kind::Strength {
        return 0.0;
    }
    let m = s.minutes.filter(|m| m.is_finite() && *m > 0.0).unwrap_or(0.0);
    match s.effort {
        Some(Effort::Moderate) => m,
        Some(Effort::Vigorous) => 2.0 * m,
        Some(Effort::Light) | None => 0.0,
    }
}

/// One rolling week of a period.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Week {
    /// 0 is the week ending on the period's last day, 1 the one before it.
    pub index: u32,
    /// How many of its seven days fell on or after the first activity ever
    /// logged. Seven is a whole week of tracking; fewer means the week began
    /// before the person started, and its zeros are "not yet recorded", not
    /// "did nothing".
    pub tracked_days: u32,
    /// Every minute, light ones included.
    pub minutes: f64,
    /// See [`aerobic_minutes`].
    pub aerobic_minutes: f64,
    /// Days with any session at all.
    pub active_days: u32,
    /// Days with a strength session.
    pub strength_days: u32,
}

/// The period as rolling weeks ending on its last day.
///
/// Rolling rather than calendar weeks so the most recent week is always whole:
/// a Monday-to-Sunday week read on a Tuesday is two days long and would look
/// like a collapse. `span_days / 7` weeks are returned, so a 30-day period is
/// four weeks and its two oldest days are not counted — a week with two days
/// in it is not a week.
///
/// `tracked_since` is how many days before the end the first activity EVER was
/// logged, not the first one in this period. A person who has logged for a year
/// and then had a quiet month had a quiet month; a person who started on
/// Thursday did not have an empty three weeks before it. Weeks entirely before
/// it are dropped; the one it falls in reports how many days it covers.
pub fn weeks(span_days: u32, tracked_since: Option<u32>, sessions: &[Session]) -> Vec<Week> {
    let Some(since) = tracked_since else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for index in 0..span_days / 7 {
        let first = index * 7; // nearest the end
        let last = first + 6;
        if first > since {
            break;
        }
        let tracked_days = (since.min(last) - first) + 1;
        let mut minutes = 0.0;
        let mut aerobic = 0.0;
        let mut active = [false; 7];
        let mut strength = [false; 7];
        for s in sessions.iter().filter(|s| (first..=last).contains(&s.days_before_end)) {
            let d = (s.days_before_end - first) as usize;
            minutes += s.minutes.filter(|m| m.is_finite() && *m > 0.0).unwrap_or(0.0);
            aerobic += aerobic_minutes(s);
            active[d] = true;
            if s.kind == Kind::Strength {
                strength[d] = true;
            }
        }
        out.push(Week {
            index,
            tracked_days,
            minutes,
            aerobic_minutes: aerobic,
            active_days: active.iter().filter(|b| **b).count() as u32,
            strength_days: strength.iter().filter(|b| **b).count() as u32,
        });
    }
    out
}

/// The middle of some whole-week figures, by the same median-of-halves rule
/// `spread` uses, or `None` when there is no whole week to take one from.
///
/// Partial weeks are left out: a week of which three days were tracked has
/// three days' worth of minutes in it, and averaging it with full weeks would
/// pull every figure down by the person's own start date.
pub fn typical_week(weeks: &[Week], figure: impl Fn(&Week) -> f64) -> Option<f64> {
    let mut v: Vec<f64> = weeks.iter().filter(|w| w.tracked_days == 7).map(figure).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let h = v.len() / 2;
    Some(if v.len() % 2 == 1 { v[h] } else { (v[h - 1] + v[h]) / 2.0 })
}

/// One set as written.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Set {
    pub reps: Option<u32>,
    pub load_kg: Option<f64>,
    pub seconds: Option<u32>,
}

impl Set {
    /// Heavier first, then more repetitions, then longer held.
    fn key(&self) -> (f64, u32, u32) {
        (
            self.load_kg.filter(|x| x.is_finite()).unwrap_or(0.0),
            self.reps.unwrap_or(0),
            self.seconds.unwrap_or(0),
        )
    }

    fn rank(&self, other: &Set) -> std::cmp::Ordering {
        let (a, b) = (self.key(), other.key());
        a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2))
    }
}

/// A session's heaviest set of one exercise, the one that says what the
/// session was: for 60 × 5, 60 × 5, 62.5 × 3, it is 62.5 × 3. Repetitions break
/// a tie, so 60 × 6 outranks 60 × 5.
pub fn top_set(sets: &[Set]) -> Option<Set> {
    sets.iter().copied().max_by(|a, b| a.rank(b))
}

/// Below this many sessions of an exercise there is no "usually" — two
/// sessions are two sessions, and are listed as such.
pub const ENOUGH_FOR_USUAL: usize = 3;

/// One exercise over a period.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExerciseSummary {
    pub sessions: u32,
    /// The middle session's top set: a set that was actually lifted, never an
    /// average of two that produces a weight nobody put on the bar. With an
    /// even number of sessions, the lower of the two middle ones. `None` below
    /// [`ENOUGH_FOR_USUAL`].
    pub usual: Option<Set>,
    /// The heaviest top set in the period. A description, not a record: there
    /// is no "personal best" in this app, and this field is not compared with
    /// any other period.
    pub heaviest: Option<Set>,
}

/// Summarise one exercise from each session's top set, in any order.
///
/// There is deliberately no volume or tonnage figure. Sets × reps × kg is a
/// single number that only ever wants to go up, which makes it a score.
pub fn summarise_exercise(top_sets: &[Set]) -> ExerciseSummary {
    let mut v = top_sets.to_vec();
    v.sort_by(|a, b| a.rank(b));
    ExerciseSummary {
        sessions: v.len() as u32,
        usual: (v.len() >= ENOUGH_FOR_USUAL).then(|| v[(v.len() - 1) / 2]),
        heaviest: v.last().copied(),
    }
}

/// The key two names of one exercise must share to be the same exercise:
/// "Bench Press", "bench press " and "BENCH  PRESS" are one lift.
pub fn name_key(name: &str) -> String {
    name.split_whitespace()
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(days: u32, kind: Kind, minutes: Option<f64>, effort: Option<Effort>) -> Session {
        Session { days_before_end: days, kind, minutes, effort }
    }

    fn set(load: Option<f64>, reps: Option<u32>) -> Set {
        Set { reps, load_kg: load, seconds: None }
    }

    #[test]
    fn a_hard_minute_counts_twice_and_an_easy_one_not_at_all() {
        assert_eq!(aerobic_minutes(&s(0, Kind::Walk, Some(30.0), Some(Effort::Moderate))), 30.0);
        assert_eq!(aerobic_minutes(&s(0, Kind::Run, Some(20.0), Some(Effort::Vigorous))), 40.0);
        assert_eq!(aerobic_minutes(&s(0, Kind::Yoga, Some(45.0), Some(Effort::Light))), 0.0);
    }

    #[test]
    fn strength_is_never_aerobic_however_hard_it_was() {
        let heavy = s(0, Kind::Strength, Some(60.0), Some(Effort::Vigorous));
        assert_eq!(aerobic_minutes(&heavy), 0.0);
    }

    #[test]
    fn every_kind_round_trips_through_its_stored_word() {
        for k in Kind::ALL {
            assert_eq!(Kind::parse(k.as_str()), Some(k));
        }
        assert_eq!(Kind::parse("crossfit"), None);
    }

    #[test]
    fn nothing_tracked_is_no_weeks_rather_than_empty_ones() {
        assert!(weeks(90, None, &[]).is_empty());
    }

    #[test]
    fn weeks_before_the_first_activity_are_not_counted_as_zeros() {
        // Started ten days before the end of a 90-day period: week 0 is whole,
        // week 1 has four tracked days, and weeks 2..12 do not exist.
        let w = weeks(90, Some(10), &[s(10, Kind::Walk, Some(30.0), Some(Effort::Moderate))]);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].tracked_days, 7);
        assert_eq!(w[1].tracked_days, 4);
        assert_eq!(w[1].minutes, 30.0);
    }

    #[test]
    fn a_quiet_week_after_tracking_began_is_a_real_zero() {
        let w = weeks(28, Some(27), &[s(27, Kind::Walk, Some(30.0), Some(Effort::Moderate))]);
        assert_eq!(w.len(), 4);
        assert!(w.iter().all(|w| w.tracked_days == 7));
        assert_eq!(w[0].minutes, 0.0);
        assert_eq!(w[3].minutes, 30.0);
    }

    #[test]
    fn a_thirty_day_period_is_four_whole_weeks() {
        assert_eq!(weeks(30, Some(200), &[]).len(), 4);
        assert_eq!(weeks(6, Some(200), &[]).len(), 0);
    }

    #[test]
    fn two_sessions_on_one_day_are_one_active_day() {
        let w = weeks(
            7,
            Some(100),
            &[
                s(2, Kind::Walk, Some(20.0), Some(Effort::Light)),
                s(2, Kind::Strength, None, None),
                s(5, Kind::Strength, Some(40.0), None),
            ],
        );
        assert_eq!(w[0].active_days, 2);
        assert_eq!(w[0].strength_days, 2);
        assert_eq!(w[0].minutes, 60.0);
        assert_eq!(w[0].aerobic_minutes, 0.0);
    }

    #[test]
    fn the_typical_week_ignores_a_partial_one() {
        let w = vec![
            Week { index: 0, tracked_days: 7, minutes: 100.0, aerobic_minutes: 0.0, active_days: 0, strength_days: 0 },
            Week { index: 1, tracked_days: 7, minutes: 200.0, aerobic_minutes: 0.0, active_days: 0, strength_days: 0 },
            Week { index: 2, tracked_days: 2, minutes: 0.0, aerobic_minutes: 0.0, active_days: 0, strength_days: 0 },
        ];
        assert_eq!(typical_week(&w, |w| w.minutes), Some(150.0));
        assert_eq!(typical_week(&w[2..], |w| w.minutes), None);
    }

    #[test]
    fn the_top_set_is_the_heaviest_and_reps_break_a_tie() {
        let sets = [set(Some(60.0), Some(5)), set(Some(62.5), Some(3)), set(Some(60.0), Some(6))];
        assert_eq!(top_set(&sets), Some(set(Some(62.5), Some(3))));
        let tie = [set(Some(60.0), Some(5)), set(Some(60.0), Some(6))];
        assert_eq!(top_set(&tie), Some(set(Some(60.0), Some(6))));
        assert_eq!(top_set(&[]), None);
    }

    #[test]
    fn bodyweight_sets_rank_by_repetitions() {
        let sets = [set(None, Some(8)), set(None, Some(10)), set(None, Some(9))];
        assert_eq!(top_set(&sets), Some(set(None, Some(10))));
    }

    #[test]
    fn usual_is_a_set_that_was_lifted_not_an_average() {
        // Four sessions: the lower middle one, 55 × 6, not a 57.5 nobody lifted.
        let tops = [
            set(Some(60.0), Some(5)),
            set(Some(50.0), Some(8)),
            set(Some(55.0), Some(6)),
            set(Some(62.5), Some(4)),
        ];
        let sum = summarise_exercise(&tops);
        assert_eq!(sum.sessions, 4);
        assert_eq!(sum.usual, Some(set(Some(55.0), Some(6))));
        assert_eq!(sum.heaviest, Some(set(Some(62.5), Some(4))));
    }

    #[test]
    fn two_sessions_have_no_usual() {
        let sum = summarise_exercise(&[set(Some(40.0), Some(8)), set(Some(42.5), Some(8))]);
        assert_eq!(sum.usual, None);
        assert_eq!(sum.heaviest, Some(set(Some(42.5), Some(8))));
    }

    #[test]
    fn names_differing_only_in_case_and_spacing_are_one_exercise() {
        assert_eq!(name_key("  Bench   Press "), name_key("bench press"));
        assert_ne!(name_key("Bench press"), name_key("Incline bench press"));
    }

    #[test]
    fn the_common_list_has_no_duplicates() {
        let mut keys: Vec<String> = COMMON_EXERCISES.iter().map(|(n, _)| name_key(n)).collect();
        let before = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), before);
    }
}
