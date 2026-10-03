//! What a kitchen container says about the amounts nobody measures.
//!
//! Salt, oil, sugar, ketchup and the like go into food by feel. Weighing every
//! pinch is not going to happen, and a recipe line saying "5 g salt" is a guess
//! written down once. The container they live in is a different matter: what
//! went into it is printed on the pack, and the container itself can be read
//! whenever its owner thinks of it. Over a few weeks that is a far better
//! figure than any single pinch.
//!
//! Two calculations live here, both pure:
//!
//! - [`stretches`] reads one container's history — poured in, read, spilled,
//!   emptied — into the spans between readings, and how much was used in each.
//! - [`taste_factor`] compares what was used in those spans with what the
//!   person *wrote down* for the same food over the same time, and returns how
//!   far their written amounts run from the truth. A to-taste line is then the
//!   written amount times that factor.
//!
//! A factor rather than a rate per kilogram of food, deliberately. The written
//! amount already knows that dal takes more salt than kheer and that a double
//! batch takes twice as much; what the container adds is the one thing the
//! writer cannot know about themselves — that they always reach for a little
//! more than they say. Before any span has been counted the factor is exactly
//! 1, which is the written amount, so nothing here ever invents a default.
//!
//! **Two ways to read a container.** On a scale, in grams, with the container
//! itself in every reading. Or by the marks on its side, in millilitres, which
//! is what is inside. A pack poured in states its own amount, by weight or by
//! volume. Any of these can follow any other.
//!
//! **Two numbers that may not be known yet.** The container's own weight
//! (`tare_g`), which its owner may not have weighed, and the food's weight per
//! millilitre (`g_per_ml`), which may have no source yet. Neither is needed
//! wherever it cancels: two scale readings of one jar compare without the jar,
//! and two readings of the marks compare in millilitres without a density. So
//! every level is held as the sum
//!
//! ```text
//! grams of food  =  a  +  b × g_per_ml  +  c × tare_g
//! ```
//!
//! and a span's use is the difference of two such sums. Only the unknowns that
//! survive the subtraction are asked for, and a span that needs one that is
//! missing waits, and says which, rather than guess. Every reading is stored as
//! it was taken, so entering the number later completes what was waiting.
//!
//! Times are days since any fixed origin, fractional, so the caller can order
//! and prorate without this crate knowing about calendars. The store passes
//! SQLite's `julianday`.

use serde::{Deserialize, Serialize};

/// An amount as it was measured: a weight or a volume.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "unit", content = "amount", rename_all = "snake_case")]
pub enum Measure {
    Grams(f64),
    Ml(f64),
}

/// A reading of a container.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "by", rename_all = "snake_case")]
pub enum Reading {
    /// On a scale: the food and the container together, in grams.
    Scale { gross_g: f64 },
    /// Off the marks on its side: the food alone, in millilitres.
    Marks { ml: f64 },
}

/// One thing that happened to a container.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventKind {
    /// A pack tipped in, by the amount its label states. Topping up a
    /// container that still holds some is the same event.
    PouredIn { amount: Measure },
    /// A reading. `spilled` marks one taken after an accident: the span ending
    /// here is thrown away, because nobody knows how much of it was cooked and
    /// how much went on the floor. Spans before and after are unaffected.
    Read { reading: Reading, spilled: bool },
    /// Finished. `left` is a last reading when something was left and thrown
    /// out; `None` means it was used to the end.
    Emptied { left: Option<Reading> },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// Days, fractional. Events must arrive in this order.
    pub t: f64,
    pub kind: EventKind,
}

/// The two numbers a span may need, when they are known.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Known {
    /// The container weighed empty.
    pub tare_g: Option<f64>,
    /// The food's weight per millilitre.
    pub g_per_ml: Option<f64>,
}

/// Why a span does or does not count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StretchStatus {
    /// Grams used are known and go into the factor.
    Counted,
    /// Ended in a spill. Kept so the history reads right; never counted.
    Spilled,
    /// Needs the container's empty weight to say how much was used.
    AwaitingTare,
    /// Needs the food's weight per millilitre to say it in grams. What was
    /// used may still be known in millilitres.
    AwaitingDensity,
    /// The reading came out more than everything known to be in it — a pour
    /// that was not recorded, or a scale that drifted. Not counted, because a
    /// negative use is not a measurement of anything.
    Inconsistent,
    /// Still in use. No end, so no amount yet.
    Open,
}

/// The span between two readings of one container.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Stretch {
    /// Index into the event slice of the event that began it.
    pub from_event: usize,
    /// Index of the event that ended it, `None` while open.
    pub to_event: Option<usize>,
    pub from: f64,
    pub to: Option<f64>,
    pub status: StretchStatus,
    /// Grams that left the container in this span, when they can be worked
    /// out — including for a spill, so the history can say how much went,
    /// while the status keeps it out of the factor.
    pub used_g: Option<f64>,
    /// The same in millilitres, when it can be worked out: exactly, between
    /// two readings of the marks, or through the weight per millilitre.
    pub used_ml: Option<f64>,
    /// Grams thrown out with the container when it was emptied, if known.
    pub discarded_g: Option<f64>,
}

impl Stretch {
    pub fn counts(&self) -> bool {
        self.status == StretchStatus::Counted
    }
    /// Whether `t` falls inside this span: after its start, up to and
    /// including its end. An open span runs on indefinitely.
    pub fn contains(&self, t: f64) -> bool {
        t > self.from && self.to.map_or(true, |to| t <= to)
    }
}

/// Grams of food, as `a + b × g_per_ml + c × tare_g`. See the module header.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct Level {
    a: f64,
    b: f64,
    c: f64,
}

/// A coefficient this small is a rounding error, not a quantity.
const EPS: f64 = 1e-9;

impl Level {
    fn of(r: Reading) -> Level {
        match r {
            // gross = food + jar, so food = gross − jar.
            Reading::Scale { gross_g } => Level { a: gross_g, b: 0.0, c: -1.0 },
            Reading::Marks { ml } => Level { a: 0.0, b: ml, c: 0.0 },
        }
    }
    fn plus(self, m: Measure) -> Level {
        match m {
            Measure::Grams(g) => Level { a: self.a + g, ..self },
            Measure::Ml(ml) => Level { b: self.b + ml, ..self },
        }
    }
    fn minus(self, o: Level) -> Level {
        Level { a: self.a - o.a, b: self.b - o.b, c: self.c - o.c }
    }
    fn needs_tare(self) -> bool {
        self.c.abs() > EPS
    }
    fn needs_density(self) -> bool {
        self.b.abs() > EPS
    }
    /// In grams, if every unknown it still carries is known.
    fn grams(self, k: Known) -> Option<f64> {
        let tare = if self.needs_tare() { k.tare_g? * self.c } else { 0.0 };
        let dens = if self.needs_density() { k.g_per_ml? * self.b } else { 0.0 };
        Some(self.a + dens + tare)
    }
    /// In millilitres: exactly when it is volume alone, otherwise through the
    /// weight per millilitre.
    fn ml(self, k: Known) -> Option<f64> {
        if self.a.abs() <= EPS && !self.needs_tare() {
            return Some(self.b);
        }
        let rho = k.g_per_ml.filter(|r| *r > 0.0)?;
        self.grams(k).map(|g| g / rho)
    }
}

/// Read a container's history into spans.
///
/// The container is taken to start empty: it is the person's own jar, and the
/// first thing that happens to it is a pack going in.
pub fn stretches(events: &[Event], known: Known) -> Vec<Stretch> {
    let mut out = Vec::new();
    let mut level = Level::default();
    // Where the current span began; `None` while the container is empty.
    let mut start: Option<(usize, f64)> = None;

    for (i, e) in events.iter().enumerate() {
        match e.kind {
            EventKind::PouredIn { amount } => {
                if start.is_none() {
                    start = Some((i, e.t));
                }
                level = level.plus(amount);
            }
            EventKind::Read { reading, spilled } => {
                let now = Level::of(reading);
                if let Some((from_event, from)) = start {
                    out.push(close(from_event, from, i, e.t, level.minus(now), None, spilled, known));
                }
                // A reading of a container nothing was poured into still
                // anchors what comes next.
                level = now;
                start = Some((i, e.t));
            }
            EventKind::Emptied { left } => {
                let rest = left.map(Level::of).unwrap_or_default();
                if let Some((from_event, from)) = start {
                    let discarded = left.and_then(|_| rest.grams(known)).map(|g| g.max(0.0));
                    out.push(close(from_event, from, i, e.t, level.minus(rest), discarded, false, known));
                }
                level = Level::default();
                start = None;
            }
        }
    }

    if let Some((from_event, from)) = start {
        out.push(Stretch {
            from_event,
            to_event: None,
            from,
            to: None,
            status: StretchStatus::Open,
            used_g: None,
            used_ml: None,
            discarded_g: None,
        });
    }
    out
}

/// Half a gram or half a millilitre either way is a kitchen, not an event.
fn settle(v: f64) -> f64 {
    if v.abs() < 0.5 {
        0.0
    } else {
        v
    }
}

#[allow(clippy::too_many_arguments)]
fn close(
    from_event: usize,
    from: f64,
    to_event: usize,
    to: f64,
    used: Level,
    discarded_g: Option<f64>,
    spilled: bool,
    known: Known,
) -> Stretch {
    let used_g = used.grams(known).map(settle);
    let used_ml = used.ml(known).map(settle);
    let negative = used_g.or(used_ml).is_some_and(|v| v < 0.0);
    let status = if spilled {
        StretchStatus::Spilled
    } else if negative {
        StretchStatus::Inconsistent
    } else if used_g.is_some() {
        StretchStatus::Counted
    } else if used.needs_tare() && known.tare_g.is_none() {
        StretchStatus::AwaitingTare
    } else {
        StretchStatus::AwaitingDensity
    };
    Stretch {
        from_event,
        to_event: Some(to_event),
        from,
        to: Some(to),
        status,
        used_g,
        used_ml,
        discarded_g,
    }
}

/// One time a container's food went into something.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Use {
    pub t: f64,
    pub mode: UseMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UseMode {
    /// Weighed or spooned out to a stated amount. Already counted, so it comes
    /// off a span's total before the rest is shared out.
    Measured { grams: f64 },
    /// By feel. `written_g` is the person's own figure for it — what the
    /// recipe line says, scaled to the pot — and `applied_g` is what the entry
    /// was actually given, the written figure times the factor at the time.
    ToTaste { written_g: f64, applied_g: f64 },
}

impl UseMode {
    /// What this use put into food, as recorded.
    pub fn recorded_g(self) -> f64 {
        match self {
            UseMode::Measured { grams } => grams,
            UseMode::ToTaste { applied_g, .. } => applied_g,
        }
    }
}

/// How far written amounts run from what the containers say, and on what.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Factor {
    /// Multiply a to-taste line's written amount by this. Exactly 1 when
    /// nothing has been counted.
    pub factor: f64,
    /// How many counted spans it rests on. Zero means the factor is the
    /// written amount and nothing more.
    pub stretches: usize,
    /// Grams used by feel over those spans, after measured uses came off.
    pub by_feel_g: f64,
    /// What the to-taste lines in those spans were written as.
    pub written_g: f64,
}

impl Factor {
    pub const AS_WRITTEN: Factor = Factor {
        factor: 1.0,
        stretches: 0,
        by_feel_g: 0.0,
        written_g: 0.0,
    };
    pub fn is_counted(&self) -> bool {
        self.stretches > 0
    }
}

/// The share of a use that belongs to each container it could have come from.
///
/// With two jars of the same oil open at once, nothing says which one a pour
/// came out of. Splitting it evenly between every span that contains it is
/// the assumption that does not favour either; counting it whole in both would
/// count it twice.
fn split(containers: &[Vec<Stretch>], t: f64) -> Vec<((usize, usize), f64)> {
    let holders: Vec<(usize, usize)> = containers
        .iter()
        .enumerate()
        .filter_map(|(c, spans)| spans.iter().position(|s| s.contains(t)).map(|i| (c, i)))
        .collect();
    let share = if holders.is_empty() {
        0.0
    } else {
        1.0 / holders.len() as f64
    };
    holders.into_iter().map(|k| (k, share)).collect()
}

/// The to-taste correction for one food, from every container that held it.
///
/// For each counted span: what was used, less what measured uses account for,
/// is what went in by feel; the to-taste uses in that span say what the person
/// *wrote* for the same amount. The factor is the ratio of those two sums over
/// every span counted.
///
/// A span with no to-taste use in it says nothing about feel and is skipped
/// whole. Measured uses that exceed a span's total — a heavy hand with the
/// measuring spoon on a scale that reads light — leave nothing by feel rather
/// than a negative amount.
///
/// `since` keeps the factor to recent habit: spans ending before it are left
/// out. `None` counts everything.
pub fn taste_factor(containers: &[Vec<Stretch>], uses: &[Use], since: Option<f64>) -> Factor {
    // Per counted span: (which span, used, measured, written).
    let mut per: Vec<((usize, usize), f64, f64, f64)> = Vec::new();
    for u in uses {
        for (key, share) in split(containers, u.t) {
            let s = &containers[key.0][key.1];
            if !s.counts() || since.is_some_and(|c| s.to.unwrap_or(f64::MAX) < c) {
                continue;
            }
            let idx = match per.iter().position(|p| p.0 == key) {
                Some(i) => i,
                None => {
                    per.push((key, s.used_g.unwrap_or(0.0), 0.0, 0.0));
                    per.len() - 1
                }
            };
            match u.mode {
                UseMode::Measured { grams } => per[idx].2 += grams * share,
                UseMode::ToTaste { written_g, .. } => per[idx].3 += written_g * share,
            }
        }
    }

    let mut f = Factor::AS_WRITTEN;
    for (_, used, measured, written) in per {
        if written <= 0.0 {
            continue;
        }
        f.stretches += 1;
        f.by_feel_g += (used - measured).max(0.0);
        f.written_g += written;
    }
    if f.written_g > 0.0 {
        f.factor = f.by_feel_g / f.written_g;
    } else {
        f = Factor::AS_WRITTEN;
    }
    f
}

/// The kitchen's use of one food over a period, next to what was recorded.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    /// Days in the period that some counted span covers. The figures below
    /// are all over these days and no others, so they compare like with like;
    /// a period with no counted span has nothing to say.
    pub days: f64,
    /// Grams that left the containers over those days, each span prorated by
    /// how much of it falls in the period.
    pub used_g: f64,
    /// The same in millilitres, when every counted span could say it.
    pub used_ml: Option<f64>,
    /// Grams the cooks and plates recorded over the same spans.
    pub recorded_g: f64,
}

/// A rate needs at least this many days under it. Two readings minutes apart
/// close a real span, but dividing what it used by a sliver of a day yields
/// a figure in the hundreds of thousands that describes nothing.
pub const MIN_RATE_DAYS: f64 = 1.0;

impl Usage {
    fn rated(&self) -> bool {
        self.days >= MIN_RATE_DAYS
    }
    pub fn used_per_day(&self) -> Option<f64> {
        self.rated().then(|| self.used_g / self.days)
    }
    pub fn used_ml_per_day(&self) -> Option<f64> {
        self.rated().then_some(self.used_ml?).map(|ml| ml / self.days)
    }
    pub fn recorded_per_day(&self) -> Option<f64> {
        self.rated().then(|| self.recorded_g / self.days)
    }
}

/// How much of one food the containers gave out over `[from, to)`, and how
/// much of that the log accounts for.
///
/// The gap between the two is the honest part: salt added at the table, a
/// dish nobody recorded as a cook, oil left in the kadai. Nothing here says
/// which, and nothing here judges it.
pub fn usage(containers: &[Vec<Stretch>], uses: &[Use], from: f64, to: f64) -> Usage {
    let mut out = Usage {
        days: 0.0,
        used_g: 0.0,
        used_ml: Some(0.0),
        recorded_g: 0.0,
    };
    let mut covered: Vec<(f64, f64)> = Vec::new();
    for s in containers.iter().flatten().filter(|s| s.counts()) {
        let (a, b) = (s.from, s.to.unwrap_or(s.from));
        let (lo, hi) = (a.max(from), b.min(to));
        if hi <= lo || b <= a {
            continue;
        }
        let share = (hi - lo) / (b - a);
        out.used_g += s.used_g.unwrap_or(0.0) * share;
        out.used_ml = match (out.used_ml, s.used_ml) {
            (Some(sum), Some(ml)) => Some(sum + ml * share),
            _ => None,
        };
        covered.push((lo, hi));
    }
    out.days = union_length(&mut covered);
    if out.days <= 0.0 {
        out.used_ml = None;
    }

    for u in uses.iter().filter(|u| u.t >= from && u.t < to) {
        for ((c, i), share) in split(containers, u.t) {
            if containers[c][i].counts() {
                out.recorded_g += u.mode.recorded_g() * share;
            }
        }
    }
    out
}

fn union_length(spans: &mut [(f64, f64)]) -> f64 {
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut total = 0.0;
    let mut cur: Option<(f64, f64)> = None;
    for &(a, b) in spans.iter() {
        cur = match cur {
            Some((ca, cb)) if a <= cb => Some((ca, cb.max(b))),
            Some((ca, cb)) => {
                total += cb - ca;
                Some((a, b))
            }
            None => Some((a, b)),
        };
    }
    if let Some((ca, cb)) = cur {
        total += cb - ca;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Known = Known { tare_g: None, g_per_ml: None };

    fn pour(t: f64, grams: f64) -> Event {
        Event { t, kind: EventKind::PouredIn { amount: Measure::Grams(grams) } }
    }
    fn pour_ml(t: f64, ml: f64) -> Event {
        Event { t, kind: EventKind::PouredIn { amount: Measure::Ml(ml) } }
    }
    fn weigh(t: f64, gross_g: f64) -> Event {
        Event { t, kind: EventKind::Read { reading: Reading::Scale { gross_g }, spilled: false } }
    }
    fn marks(t: f64, ml: f64) -> Event {
        Event { t, kind: EventKind::Read { reading: Reading::Marks { ml }, spilled: false } }
    }
    fn spill(t: f64, gross_g: f64) -> Event {
        Event { t, kind: EventKind::Read { reading: Reading::Scale { gross_g }, spilled: true } }
    }
    fn empty(t: f64, gross_g: Option<f64>) -> Event {
        Event { t, kind: EventKind::Emptied { left: gross_g.map(|gross_g| Reading::Scale { gross_g }) } }
    }
    fn tare(g: f64) -> Known {
        Known { tare_g: Some(g), g_per_ml: None }
    }
    fn dens(r: f64) -> Known {
        Known { tare_g: None, g_per_ml: Some(r) }
    }
    fn taste(t: f64, written_g: f64) -> Use {
        Use { t, mode: UseMode::ToTaste { written_g, applied_g: written_g } }
    }
    fn measured(t: f64, grams: f64) -> Use {
        Use { t, mode: UseMode::Measured { grams } }
    }
    fn close_to(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn readings_of_the_same_jar_need_no_empty_weight() {
        // 1 kg poured into a jar of unknown weight, then weighed twice. The
        // first span runs from a label to a reading and has to wait for the
        // jar; the second runs reading to reading and does not.
        let s = stretches(&[pour(0.0, 1000.0), weigh(10.0, 1100.0), weigh(20.0, 700.0)], NONE);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].status, StretchStatus::AwaitingTare);
        assert_eq!(s[1].status, StretchStatus::Counted);
        assert!(close_to(s[1].used_g.unwrap(), 400.0));
        assert_eq!(s[2].status, StretchStatus::Open);
    }

    #[test]
    fn entering_the_empty_weight_later_completes_the_waiting_spans() {
        // Same history; the jar turns out to weigh 250 g.
        let s = stretches(&[pour(0.0, 1000.0), weigh(10.0, 1100.0), empty(30.0, None)], tare(250.0));
        assert_eq!(s[0].status, StretchStatus::Counted);
        assert!(close_to(s[0].used_g.unwrap(), 150.0)); // 1000 in, 850 left
        assert!(close_to(s[1].used_g.unwrap(), 850.0)); // used to the end
    }

    #[test]
    fn a_top_up_between_readings_is_added_not_lost() {
        let s = stretches(&[pour(0.0, 500.0), weigh(1.0, 700.0), pour(5.0, 500.0), weigh(9.0, 900.0)], NONE);
        // 700 + 500 poured − 900 read = 300 used.
        assert!(close_to(s[1].used_g.unwrap(), 300.0));
        assert!(s[1].counts());
    }

    #[test]
    fn a_spill_loses_its_own_span_and_nothing_else() {
        let s = stretches(
            &[pour(0.0, 1000.0), weigh(0.1, 1200.0), weigh(10.0, 820.0), spill(18.0, 510.0), weigh(25.0, 400.0)],
            NONE,
        );
        assert!(s[1].counts() && close_to(s[1].used_g.unwrap(), 380.0));
        assert_eq!(s[2].status, StretchStatus::Spilled);
        assert!(s[3].counts() && close_to(s[3].used_g.unwrap(), 110.0));
    }

    #[test]
    fn emptying_with_a_last_reading_needs_no_empty_weight_for_the_use() {
        // 600 g on the scale, then thrown out at 330 g: 270 g used. How much of
        // that 330 was food rather than jar needs the jar, and is left unknown.
        let s = stretches(&[pour(0.0, 500.0), weigh(1.0, 600.0), empty(20.0, Some(330.0))], NONE);
        assert!(close_to(s[1].used_g.unwrap(), 270.0));
        assert_eq!(s[1].discarded_g, None);
        let s = stretches(&[pour(0.0, 500.0), weigh(1.0, 600.0), empty(20.0, Some(330.0))], tare(300.0));
        assert!(close_to(s[1].discarded_g.unwrap(), 30.0));
    }

    #[test]
    fn a_reading_heavier_than_its_contents_is_not_a_negative_use() {
        let s = stretches(&[pour(0.0, 500.0), weigh(1.0, 600.0), weigh(5.0, 640.0)], NONE);
        assert_eq!(s[1].status, StretchStatus::Inconsistent);
        assert!(!s[1].counts());
    }

    #[test]
    fn a_refill_after_emptying_starts_a_fresh_span() {
        let s = stretches(&[pour(0.0, 500.0), empty(10.0, None), pour(12.0, 1000.0)], NONE);
        assert_eq!(s.len(), 2);
        assert!(close_to(s[0].used_g.unwrap(), 500.0));
        assert_eq!(s[1].status, StretchStatus::Open);
        assert!(close_to(s[1].from, 12.0));
    }

    #[test]
    fn readings_off_the_marks_compare_in_ml_without_a_density() {
        // 1 L poured in, read at 640 ml, then 410 ml.
        let s = stretches(&[pour_ml(0.0, 1000.0), marks(9.0, 640.0), marks(16.0, 410.0)], NONE);
        assert!(close_to(s[0].used_ml.unwrap(), 360.0));
        assert!(close_to(s[1].used_ml.unwrap(), 230.0));
        // Grams need the oil's weight per ml, so neither span counts yet.
        assert_eq!(s[1].status, StretchStatus::AwaitingDensity);
        assert_eq!(s[1].used_g, None);
        // Sunflower oil, 0.92 g per ml: now both count, in grams.
        let s = stretches(&[pour_ml(0.0, 1000.0), marks(9.0, 640.0), marks(16.0, 410.0)], dens(0.92));
        assert!(s[1].counts());
        assert!(close_to(s[1].used_g.unwrap(), 230.0 * 0.92));
    }

    #[test]
    fn a_scale_reading_after_marks_needs_both_numbers() {
        // Read 500 ml by the marks, then weighed at 700 g, bottle included.
        let ev = [pour_ml(0.0, 1000.0), marks(5.0, 500.0), weigh(10.0, 700.0)];
        assert_eq!(stretches(&ev, dens(0.92))[1].status, StretchStatus::AwaitingTare);
        assert_eq!(stretches(&ev, tare(300.0))[1].status, StretchStatus::AwaitingDensity);
        let both = Known { tare_g: Some(300.0), g_per_ml: Some(0.92) };
        let s = stretches(&ev, both);
        // 460 g of oil in, 400 g left: 60 g used, about 65 ml.
        assert!(close_to(s[1].used_g.unwrap(), 60.0));
        assert!(close_to(s[1].used_ml.unwrap(), 60.0 / 0.92));
    }

    #[test]
    fn a_pack_in_grams_into_a_container_read_by_marks_needs_a_density() {
        let s = stretches(&[pour(0.0, 905.0), marks(10.0, 600.0)], NONE);
        assert_eq!(s[0].status, StretchStatus::AwaitingDensity);
        let s = stretches(&[pour(0.0, 905.0), marks(10.0, 600.0)], dens(0.905));
        assert!(close_to(s[0].used_g.unwrap(), 905.0 - 600.0 * 0.905));
    }

    #[test]
    fn nothing_counted_means_exactly_the_written_amount() {
        let jar = stretches(&[pour(0.0, 1000.0), weigh(10.0, 900.0)], NONE); // awaiting
        let f = taste_factor(&[jar], &[taste(5.0, 10.0)], None);
        assert_eq!(f, Factor::AS_WRITTEN);
        assert!(!f.is_counted());
    }

    #[test]
    fn the_factor_is_what_was_used_by_feel_over_what_was_written() {
        // 500 g used by the end; 100 g of it measured into a pickle; the
        // to-taste lines over the same days were written as 320 g in all.
        let jar = stretches(&[pour(0.0, 500.0), empty(30.0, None)], NONE);
        let uses = [measured(3.0, 100.0), taste(5.0, 120.0), taste(15.0, 200.0)];
        let f = taste_factor(&[jar], &uses, None);
        assert_eq!(f.stretches, 1);
        assert!(close_to(f.by_feel_g, 400.0));
        assert!(close_to(f.factor, 400.0 / 320.0));
    }

    #[test]
    fn a_span_with_only_measured_uses_says_nothing_about_feel() {
        let jar = stretches(&[pour(0.0, 500.0), weigh(1.0, 600.0), weigh(10.0, 400.0), empty(20.0, Some(300.0))], NONE);
        let uses = [measured(5.0, 200.0), taste(15.0, 50.0)];
        let f = taste_factor(&[jar], &uses, None);
        assert_eq!(f.stretches, 1);
        assert!(close_to(f.factor, 100.0 / 50.0));
    }

    #[test]
    fn two_jars_open_at_once_share_a_use_rather_than_count_it_twice() {
        let a = stretches(&[pour(0.0, 300.0), empty(10.0, None)], NONE);
        let b = stretches(&[pour(0.0, 300.0), empty(10.0, None)], NONE);
        let f = taste_factor(&[a, b], &[taste(5.0, 400.0)], None);
        assert!(close_to(f.factor, 1.5));
    }

    #[test]
    fn spans_before_the_window_are_left_out() {
        let jar = stretches(&[pour(0.0, 100.0), weigh(0.1, 200.0), weigh(10.0, 100.0), weigh(400.0, 50.0)], NONE);
        let uses = [taste(5.0, 100.0), taste(200.0, 100.0)];
        let all = taste_factor(&[jar.clone()], &uses, None);
        let recent = taste_factor(&[jar], &uses, Some(300.0));
        assert_eq!(all.stretches, 2);
        assert_eq!(recent.stretches, 1);
        assert!(close_to(recent.factor, 0.5));
    }

    #[test]
    fn usage_prorates_a_span_across_the_period_edge() {
        // 300 g over 30 days; a period covering the last 10 of them.
        let jar = stretches(&[pour(0.0, 300.0), empty(30.0, None)], NONE);
        let uses = [measured(5.0, 50.0), measured(25.0, 40.0)];
        let u = usage(&[jar], &uses, 20.0, 40.0);
        assert!(close_to(u.days, 10.0));
        assert!(close_to(u.used_g, 100.0));
        assert!(close_to(u.recorded_g, 40.0));
        assert!(close_to(u.used_per_day().unwrap(), 10.0));
    }

    #[test]
    fn usage_says_ml_when_the_counted_spans_can() {
        let can = stretches(&[pour_ml(0.0, 1000.0), marks(10.0, 700.0)], dens(0.92));
        let u = usage(&[can], &[], 0.0, 10.0);
        assert!(close_to(u.used_ml_per_day().unwrap(), 30.0));
        assert!(close_to(u.used_per_day().unwrap(), 27.6));
        // A jar on the scale with no density cannot say ml.
        let jar = stretches(&[pour(0.0, 300.0), empty(30.0, None)], NONE);
        assert_eq!(usage(&[jar], &[], 0.0, 30.0).used_ml_per_day(), None);
    }

    #[test]
    fn a_span_shorter_than_a_day_gives_no_rate() {
        // Poured in and read a few minutes later: 360 ml really did go, but
        // "per day" over 0.0007 of a day is not a figure.
        let can = stretches(&[pour_ml(0.0, 1000.0), marks(0.0007, 640.0)], dens(0.92));
        assert!(can[0].counts());
        let u = usage(&[can], &[], 0.0, 1.0);
        assert_eq!(u.used_per_day(), None);
        assert_eq!(u.used_ml_per_day(), None);
        assert_eq!(u.recorded_per_day(), None);
    }

    #[test]
    fn a_period_with_nothing_counted_has_no_rate() {
        let jar = stretches(&[pour(0.0, 300.0)], NONE);
        let u = usage(&[jar], &[], 0.0, 30.0);
        assert_eq!(u.used_per_day(), None);
        assert_eq!(u.used_ml_per_day(), None);
    }

    #[test]
    fn overlapping_jars_do_not_double_the_days() {
        let a = stretches(&[pour(0.0, 300.0), empty(10.0, None)], NONE);
        let b = stretches(&[pour(5.0, 300.0), empty(15.0, None)], NONE);
        let u = usage(&[a, b], &[], 0.0, 100.0);
        assert!(close_to(u.days, 15.0));
        assert!(close_to(u.used_g, 600.0));
    }
}
