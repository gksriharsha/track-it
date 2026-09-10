//! What the two Android home-screen widgets are allowed to know.
//!
//! An `AppWidgetProvider` is a `BroadcastReceiver`. It runs in this app's own
//! process, but the system starts that process for it with no Activity, no
//! Tauri runtime and none of `app.manage(…)` done — and after the encryption
//! work lands, the log database may need a key that is not available while the
//! phone is locked. So a widget cannot read the log, and it must not try. What
//! it reads instead is a snapshot: two small JSON files this module writes,
//! holding nothing but strings that were already formatted here.
//!
//! That is the same rule that keeps nutrient arithmetic out of JavaScript,
//! applied to Kotlin. A median belongs in `trackit_core::spread`; a figure the
//! data does not support arrives as an em dash with a sentence beside it,
//! never as a zero
//! somebody else's `?? 0` invented. See `docs/decisions.md` D19.
//!
//! Two things this module deliberately does NOT do. It never calls into Kotlin:
//! writing a file is `std::fs` and needs no JNI, and the one step that does need
//! the bridge — telling the launcher to redraw — belongs to the Activity, which
//! knows it is alive. And it never holds anything per-nutrient or per-entry: the
//! snapshot is plaintext on disk and becomes the softest target in the app the
//! day the database is encrypted, so what is not in it cannot leak from it.

// Compiled on every platform so its tests run wherever the suite does, which on
// this project is a Mac; called only on Android, because nothing else in the
// world has a home screen to draw on. Without this the desktop build reported
// two dozen dead-code warnings and buried the two the unfinished sync arm
// already has. `vision.rs` reaches for the same attribute for the same reason.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use trackit_core::spread::{summarise, ENOUGH_FOR_SPREAD};

/// How many days the aggregate widget describes. Thirty, which is the span the
/// Statistics screen opens on (`SPANS` in src/screens/Statistics.tsx).
pub const PERIOD_DAYS: i64 = 30;

/// How many food rows fit a home-screen tile without becoming a list. Three.
pub const QUICK_ROWS: usize = 3;

/// Nutrient 1008, energy. Named because three places now have to agree about it.
const ENERGY: i64 = 1008;

/// The shape of the aggregate file. Bumped when a field changes meaning, and the
/// Kotlin reader refuses a number it does not recognise rather than guessing.
pub const AGGREGATE_VERSION: u32 = 1;

/// The shape of the quick-add file, versioned separately. The two files are
/// separate so a reader that cannot understand one still renders the other, and
/// so the provider that draws figures never opens a file with a food name in it.
pub const QUICKADD_VERSION: u32 = 1;

/// The routes a widget tap is permitted to ask for.
///
/// A closed list, and it is closed because `MainActivity` is
/// `android:exported="true"` — it carries LAUNCHER, so any installed app can
/// start it with an extra of its choosing. This list is checked in Kotlin before
/// the Intent is honoured, again here before the parked landing is handed to the
/// web app, and a third time in TypeScript against the router's own `ROUTES`. A
/// whitelist on one side of a bridge is not a whitelist.
pub const WIDGET_ROUTES: [&str; 2] = ["statistics", "foods"];

/// The subdirectory of `no_backup/` all three files live in.
///
/// `no_backup/` because Android documents `getNoBackupFilesDir()` as never
/// automatically backed up, and the encryption work's `dataExtractionRules`
/// already exclude that whole directory. `SharedPreferences` would have been the
/// obvious home and is exactly wrong: it IS swept into Auto Backup by default,
/// which would put a person's figures on a Google server because their phone was
/// set up with backup on.
const DIR: &str = "widget";

/// One line of the aggregate widget: a label, an amount, and — where a system
/// publishes one — the reference figure with its basis named.
///
/// Every field is a finished string and there is not a number among them. The
/// arithmetic and the wording were both settled before this struct exists, which
/// is the point: nothing downstream can round it differently, and nothing
/// downstream can turn a missing figure into a zero.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    pub label: String,
    /// Already carries its unit. "1,980 kcal", "2.1 L", or the literal
    /// an em dash where nothing measured it — never "0", never omitted. Prose
    /// belongs in `note`: this is drawn into a one-line slot sized for a figure.
    pub value: String,
    /// The reference figure with its basis NAMED, or `None` where nothing
    /// publishes one for this measure. "RDA 2,240 kcal", "for reference
    /// 2,240 kcal". Never a percentage, never the bare word "goal", and never
    /// "your target" for energy — see the note where `energy_ref` is built.
    pub r#ref: Option<String>,
    /// The range most days fell in, as a sentence. `None` when there were too
    /// few days to describe a range at all, in which case `value` carries the
    /// refusal instead.
    ///
    /// Shorter than the screen's own "Half your days fell between X and Y."
    /// because a home-screen tile gives this about twenty characters to a line
    /// and there are two of these on it. A sentence clipped at "…between 300
    /// kcal and" would lose the half of the range that makes it a range, which
    /// is worse than saying the same thing in fewer words.
    pub note: Option<String>,
}

/// The aggregate widget's whole content.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Aggregate {
    pub v: u32,
    /// "as at 21:14, 10 Sep 2026". Written down because nothing here polls: the
    /// figures describe the period that was current when they were computed, and
    /// a snapshot that has sat on a home screen for a fortnight must say so
    /// rather than be quietly wrong. The year is in it for that reason.
    pub as_of: String,
    /// "Last 30 days".
    pub period: String,
    /// "You logged food on 24 of the last 30 days, from 12 August." Coverage of
    /// a sample, anchored to a date — which is the distinction between this and
    /// a streak, and also what stops a floating window drifting silently.
    ///
    /// The screen follows it with "Everything here describes those 24."; the
    /// tile does not, because there is nothing else on a tile for that sentence
    /// to be about. What it must keep is the date, and it does.
    pub basis: String,
    /// Empty when there is nothing honest to print, in which case `note` carries
    /// the sentence.
    pub rows: Vec<Row>,
    pub note: Option<String>,
}

/// One tappable food on the quick-add widget.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuickFood {
    /// The food's name, as the person last wrote it. Nothing else: no amount, no
    /// date, no count of how often they ate it.
    pub label: String,
    /// "food" or "custom", split off `FrequentFood::key`.
    pub kind: String,
    pub id: String,
}

/// The quick-add widget's whole content.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuickAdd {
    pub v: u32,
    pub as_of: String,
    pub foods: Vec<QuickFood>,
    /// What to say where the rows would be when there are none. Describes the
    /// record and not the person — "Nothing to show yet", not "nothing logged".
    pub note: Option<String>,
}

/// Where a widget tap asked the app to land.
///
/// Written by `MainActivity` into `no_backup/widget/landing.json` and read back
/// exactly once by [`take_landing`], which deletes the file. Consuming it on the
/// READING side rather than the writing side is what makes it survive an
/// Activity recreation: `android:configChanges` lists neither `density` nor
/// `fontScale`, so a font-size change destroys and rebuilds the Activity,
/// `onCreate` re-reads `getIntent()` — which is now the widget's Intent, because
/// we call `setIntent` — and would offer the same tap again. A file that is gone
/// cannot be re-offered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Landing {
    pub route: String,
    /// "<kind>:<id>", "water", or `None` when the tap asked only for a screen.
    pub pick: Option<String>,
}

/// Whether a string is one of the routes a widget may ask for.
pub fn route_is_allowed(route: &str) -> bool {
    WIDGET_ROUTES.contains(&route)
}

/// Whether a pick token is one this app wrote.
///
/// Three shapes and nothing else: the literal `water`, `food:` followed by
/// decimal digits, and `custom:` followed by the lowercase hex-and-hyphen of a
/// uuid. Anything else is thrown away WHOLE rather than sanitised into something
/// that looks valid — a partially-cleaned token is how a rejected input ends up
/// being honoured in a shape nobody designed.
pub fn pick_is_allowed(pick: &str) -> bool {
    if pick == "water" {
        return true;
    }
    if let Some(id) = pick.strip_prefix("food:") {
        return !id.is_empty() && id.len() <= 12 && id.bytes().all(|b| b.is_ascii_digit());
    }
    if let Some(id) = pick.strip_prefix("custom:") {
        // Lowercase only, because `new_id` (store.rs) builds a uuid through
        // SQLite's `lower(hex(randomblob(…)))` and nothing else in this app ever
        // writes one. Accepting the uppercase spelling as well would widen the
        // whitelist to tokens this app cannot have produced.
        return id.len() == 36
            && id
                .bytes()
                .all(|b| (b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) || b == b'-');
    }
    false
}

// ---------------------------------------------------------------------------
// The only place a string that reaches a home screen is written
// ---------------------------------------------------------------------------

/// A figure with its unit, in the same shape `fmtAmount` (src/lib/nutrient.ts)
/// produces on the web side.
///
/// The digit rule is copied rather than simplified: two decimals below one, one
/// below ten, none above. A widget printing "1980 kcal" beside a screen printing
/// "1,980 kcal" would read as two different numbers, and grouping is done here
/// with an ASCII comma because `toLocaleString(undefined, …)` in the app's
/// WebView resolves to the same separator and because a widget has no locale of
/// its own to consult.
fn fmt_amount(n: f64, unit: &str) -> String {
    let digits = if n == 0.0 {
        0
    } else if n < 1.0 {
        2
    } else if n < 10.0 {
        1
    } else {
        0
    };
    let body = format!("{n:.digits$}", digits = digits);
    let (whole, rest) = match body.split_once('.') {
        Some((w, r)) => (w, Some(r)),
        None => (body.as_str(), None),
    };
    let mut grouped = String::new();
    for (i, ch) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 && ch.is_ascii_digit() {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    match rest {
        Some(r) => format!("{grouped}.{r} {unit}"),
        None => format!("{grouped} {unit}"),
    }
}

/// A date as a person says it: "12 August".
///
/// Deliberately not `Today`/`Yesterday` the way `humanDate` (src/api.ts) does.
/// Those two words are relative to the moment they are READ, and this string is
/// written once and then sits on a home screen — "from Yesterday" on a snapshot
/// a week old is the exact failure the `as_of` line exists to prevent.
fn human_day(iso: &str) -> String {
    const MONTHS: [&str; 12] = [
        "January", "February", "March", "April", "May", "June", "July", "August", "September",
        "October", "November", "December",
    ];
    let mut parts = iso.split('-');
    let (_y, m, d) = (parts.next(), parts.next(), parts.next());
    match (m.and_then(|m| m.parse::<usize>().ok()), d) {
        (Some(m), Some(d)) if (1..=12).contains(&m) => {
            format!("{} {}", d.trim_start_matches('0'), MONTHS[m - 1])
        }
        // An ISO date this app did not write. Printing it raw is ugly and
        // truthful, which beats printing a month we guessed at.
        _ => iso.to_string(),
    }
}

/// When these figures were written, in words: "as at 21:14, 10 Sep 2026".
///
/// Takes `store::local_stamp`'s `YYYY-MM-DD HH:MM` rather than reading a clock,
/// so the moment comes from the same calendar as the days it describes.
///
/// The YEAR is in it deliberately. A widget never polls — `updatePeriodMillis`
/// is zero, and an `AppWidgetProvider` cannot recompute an aggregate because the
/// aggregation lives behind a database it must not open — so a snapshot can sit
/// on a home screen for a fortnight. "as at 18:42, 9 Sep" reads as this evening;
/// with the year on it, a stale figure is visibly stale rather than quietly
/// wrong, which is the failure this whole app is built to avoid.
pub fn stamp(local: &str) -> String {
    const SHORT: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let mut halves = local.split(' ');
    let date = halves.next().unwrap_or_default();
    let time = halves.next().unwrap_or_default();
    let mut ymd = date.split('-');
    let (y, m, d) = (ymd.next(), ymd.next(), ymd.next());
    match (y, m.and_then(|m| m.parse::<usize>().ok()), d) {
        (Some(y), Some(m), Some(d)) if (1..=12).contains(&m) && !time.is_empty() => format!(
            "as at {time}, {} {} {y}",
            d.trim_start_matches('0'),
            SHORT[m - 1]
        ),
        // A stamp this build cannot read is worse than none: a widget with no
        // date on it at least does not claim a moment. Say what is known.
        _ => "as at an unknown moment".to_string(),
    }
}

/// "day"/"days", so a sentence about one day does not read as a bug.
fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        word.to_string()
    } else {
        format!("{word}s")
    }
}

/// One measure of a period, written out the way the Statistics screen writes it.
///
/// The refusal is per MEASURE and comes from that measure's own day count, not
/// from how many days the period had. Energy is measured on every day with food
/// on it and water only on days a bottle was logged, so a month can easily hold
/// twenty-two days of energy and three of water — and printing a water median
/// from three days would claim a pattern the screen it is quoting explicitly
/// refuses to print.
fn measure(label: &str, values: &[f64], write: &dyn Fn(f64) -> String, r#ref: Option<String>) -> Row {
    match summarise(values) {
        Some(s) => Row {
            label: label.to_string(),
            value: write(s.median),
            r#ref,
            note: Some(format!(
                "Half your days: {} – {}",
                write(s.q1),
                write(s.q3)
            )),
        },
        // Both refusals put an em dash in `value` and the sentence in `note`,
        // and that split is structural rather than stylistic. `value` is drawn
        // into a 20sp serif slot with `maxLines="1"` and `ellipsize="end"`,
        // in a column that is (250 − 20 − 10) / 2 = 110dp wide at the tile's
        // minimum size — room for a figure and nothing else. Prose put there
        // renders as "3 days mea…", so the state a freshly placed tile is most
        // likely to be in would have shown a clipped fragment where its
        // largest text should be, which defeats the whole point of saying how
        // many days are missing instead of quietly averaging three of them.
        //
        // The dash is not a placeholder invented here: it is what the day's own
        // energy figure prints when nothing measured it (see `day-hero` in
        // Today.tsx), so a person who has seen one has already been taught to
        // read the other. `note` is 11sp over two lines, which is where a
        // sentence fits — and the sentences are kept short for the same reason
        // the columns are narrow.
        None if values.is_empty() => Row {
            label: label.to_string(),
            value: "—".into(),
            // No figure, so nothing to put a reference beside. A reference
            // printed alone is a target with no record next to it, which is the
            // one thing this widget is not.
            r#ref: None,
            note: Some("Not measured on any day you logged.".into()),
        },
        None => Row {
            label: label.to_string(),
            value: "—".into(),
            r#ref: None,
            note: Some(format!(
                "{} {} measured. A spread needs {ENOUGH_FOR_SPREAD}.",
                values.len(),
                plural(values.len(), "day")
            )),
        },
    }
}

/// Turn a period into the aggregate widget's content.
///
/// A transcription of src/screens/Statistics.tsx and nothing more: the middle
/// day, the range most days fell in, the coverage sentence anchored to its start
/// date, and the reference figure named beside the amount. What is absent is
/// absent on purpose — no bar, no ring, no arc, no percentage of anything, no
/// run of days, and no word that appraises what it finds.
pub fn aggregate_from(view: &crate::RangeView, span_days: i64, as_of: &str) -> Aggregate {
    let logged = view.days_logged;

    // Days that had FOOD, which is the only kind of day whose intake can be
    // averaged. `kcal` is already `None` on a day nothing logged measured
    // energy, and it stays out rather than entering as a zero.
    let kcal_days: Vec<f64> = view
        .days
        .iter()
        .filter(|d| d.food_items > 0)
        .filter_map(|d| d.kcal)
        .collect();

    // Days a bottle was actually logged on. A day with no bottle is filtered out
    // rather than counted as zero: nobody drinks nothing, so a zero there would
    // be a claim about the person instead of about the record.
    let water_days: Vec<f64> = view
        .days
        .iter()
        .filter_map(|d| d.water_ml)
        .filter(|ml| *ml > 0.0)
        .collect();

    let period = format!("Last {span_days} days");

    if logged == 0 {
        return Aggregate {
            v: AGGREGATE_VERSION,
            as_of: as_of.to_string(),
            period,
            basis: String::new(),
            rows: Vec::new(),
            // The screen's own empty state, which describes the record rather
            // than the person and says what will fill it in.
            note: Some(
                "Nothing to average yet. Log a few days and this fills in.".into(),
            ),
        };
    }

    // Exactly the figure Statistics reads, from exactly the same place. Energy
    // is in none of the DRI tables and in none of the Daily Value tables, so
    // this is non-null only where the person set a figure of their own — and
    // where they have not, the reference line VANISHES rather than being
    // invented. There is deliberately one source for it: taking the profile's
    // estimate here as well would give the widget and the screen two numbers to
    // drift between.
    let energy = view.totals.iter().find(|t| t.id == ENERGY);
    // "for reference", flatly, and the difference from naming a basis is the
    // whole point
    // of this surface. Energy is in no DRI and no Daily Value table, so this
    // figure exists only where the person set one — which makes `target_basis`
    // `user_set`, and "your target" is what naming that basis would print. The
    // Statistics
    // screen deliberately refuses that word for exactly this figure, and says
    // why immediately above it: a published estimate labelled "your target"
    // turns a description of how somebody eats into a scatter around a goal. A
    // tile on the home screen is the last place that should read more like a
    // goal than the screen it transcribes, because it is the one nobody opened
    // to check. Neither measure this tile carries has a published basis to
    // name — water has none either — so there is no branch here to keep.
    let energy_ref = energy.and_then(|t| {
        t.target
            .map(|amount| format!("for reference {}", fmt_amount(amount, "kcal")))
    });

    let kcal = |v: f64| fmt_amount(v, "kcal");
    // Water is weighed in grams and drunk in litres, and "1533 g" is not a
    // sentence anybody says about their day.
    let litres = |v: f64| trackit_core::water::describe(v);

    Aggregate {
        v: AGGREGATE_VERSION,
        as_of: as_of.to_string(),
        period,
        basis: format!(
            "You logged food on {logged} of the last {span_days} days, from {}.",
            human_day(&view.from)
        ),
        rows: vec![
            measure("Energy, middle day", &kcal_days, &kcal, energy_ref),
            measure("Water drunk, middle day", &water_days, &litres, None),
        ],
        note: None,
    }
}

/// Turn the frequently-logged foods into the quick-add widget's content.
///
/// A name and a tap, and nothing else. The frequency that did the ordering is
/// never printed and neither is the position: how often somebody logged a food
/// is a figure that scores the person, and this is a shortcut rather than a
/// report on them.
pub fn quickadd_from(rows: &[crate::store::FrequentFood], as_of: &str) -> QuickAdd {
    let foods: Vec<QuickFood> = rows
        .iter()
        .take(QUICK_ROWS)
        .filter_map(|r| {
            // `key` is already "<kind>:<id>" and is documented as the token a
            // widget hands back, so it is split rather than rebuilt from the two
            // id columns — one spelling of the identity, produced once.
            let (kind, id) = r.key.split_once(':')?;
            Some(QuickFood {
                label: r.description.clone(),
                kind: kind.to_string(),
                id: id.to_string(),
            })
        })
        .collect();
    QuickAdd {
        v: QUICKADD_VERSION,
        as_of: as_of.to_string(),
        note: if foods.is_empty() {
            // The record, not the person. "Nothing logged yet" on a home screen,
            // over two buttons, reads as a report card; this says what the file
            // holds, which is nothing yet.
            Some("Nothing to show yet".into())
        } else {
            None
        },
        foods,
    }
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

/// Where the three files live, given the app's data directory.
pub fn dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join("no_backup").join(DIR)
}

/// Replace both snapshots.
///
/// Plain `std::fs` and no bridge of any kind, which is the whole point: this
/// runs on a path that a log entry waits on, release builds set
/// `panic = "abort"`, and a JNI call whose Activity has just been swiped out of
/// recents would take the process down with it rather than merely fail to
/// repaint. There is nothing here that can do that.
///
/// Each file is written to a temporary name in the same directory, flushed, and
/// renamed over the old one. A reader that arrives mid-write must see the old
/// file whole and never half of the new one — a widget repaint really can run
/// while a log entry is being saved.
pub fn write(data_dir: &Path, aggregate: &Aggregate, quick: &QuickAdd) -> Result<(), String> {
    let dir = dir_in(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    replace(&dir, "aggregate.json", aggregate)?;
    replace(&dir, "quickadd.json", quick)
}

fn replace<T: Serialize>(dir: &Path, name: &str, payload: &T) -> Result<(), String> {
    use std::io::Write;

    let json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{name}.writing"));
    let target = dir.join(name);
    {
        let mut f =
            std::fs::File::create(&tmp).map_err(|e| format!("creating {}: {e}", tmp.display()))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("writing {}: {e}", tmp.display()))?;
        // Not tidiness. A rename is atomic against a reader, but on a phone that
        // loses power a moment later the directory entry can point at a file
        // whose contents never reached the disk, and the widget would then read
        // a truncated snapshot for as long as the app stayed closed.
        f.sync_all()
            .map_err(|e| format!("flushing {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        // Leaving the temporary file behind would have the next write reuse a
        // name it thinks is free.
        let _ = std::fs::remove_file(&tmp);
        format!("replacing {}: {e}", target.display())
    })
}

/// Take the landing a widget tap parked, if one is waiting.
///
/// Reading it deletes it, so it is honoured exactly once however many times the
/// Activity is recreated. Both fields are re-validated here even though Kotlin
/// validated them before writing the file: `MainActivity` is exported, the
/// Intent that produced this could have come from any installed app, and a
/// whitelist on one side of a bridge is not a whitelist.
pub fn take_landing(data_dir: &Path) -> Result<Option<Landing>, String> {
    let path = dir_in(data_dir).join("landing.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        // Nothing parked is the ordinary case — the app is opened from its icon
        // far more often than from a widget — so it is not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("reading {}: {e}", path.display())),
    };
    // Deleted before it is parsed, not after. A file this build cannot
    // understand must not be re-read on every launch for the rest of the
    // install's life.
    let _ = std::fs::remove_file(&path);

    let landing: Landing = match serde_json::from_str(&raw) {
        Ok(l) => l,
        // The app opens on its usual front door, which is where it opens anyway.
        Err(_) => return Ok(None),
    };
    if !route_is_allowed(&landing.route) {
        return Ok(None);
    }
    if let Some(pick) = &landing.pick {
        if !pick_is_allowed(pick) {
            // The route survives and the pick does not. Landing on Add food with
            // nothing chosen is the right answer to a token this app did not
            // write; refusing the whole tap would be a worse one.
            return Ok(Some(Landing {
                route: landing.route,
                pick: None,
            }));
        }
    }
    Ok(Some(landing))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DaySummary, NutrientTotal, RangeView};
    use trackit_core::aggregate::sum;

    fn day(date: &str, kcal: Option<f64>, water_ml: Option<f64>, food_items: i64) -> DaySummary {
        DaySummary {
            date: date.into(),
            items: food_items.max(1),
            grams: 500.0,
            kcal,
            food_items,
            supplement_items: 0,
            water_items: if water_ml.is_some() { 1 } else { 0 },
            water_ml,
            origins: Vec::new(),
            cuisines: Vec::new(),
            untagged_origin: 0,
            untagged_cuisine: 0,
        }
    }

    fn energy_total(target: Option<f64>, basis: Option<&str>) -> NutrientTotal {
        NutrientTotal {
            id: ENERGY,
            name: "Energy".into(),
            full_name: "Energy".into(),
            magnitude: "kcal".into(),
            tier: "core".into(),
            group: "macro".into(),
            total: sum(&[]),
            target,
            target_basis: basis.map(String::from),
            is_limit: false,
        }
    }

    fn view(days: Vec<DaySummary>, totals: Vec<NutrientTotal>) -> RangeView {
        let logged = days.iter().filter(|d| d.food_items > 0).count();
        RangeView {
            from: "2026-08-12".into(),
            to: "2026-09-10".into(),
            days_logged: logged,
            days_with_supplements: 0,
            days_with_water: days.iter().filter(|d| d.water_items > 0).count(),
            days,
            totals,
            origins: Vec::new(),
            cuisines: Vec::new(),
        }
    }

    const AS_OF: &str = "as at 21:14, 10 Sep 2026";

    #[test]
    fn a_period_with_no_logged_days_says_there_is_nothing_to_average() {
        let a = aggregate_from(&view(Vec::new(), vec![energy_total(None, None)]), 30, AS_OF);
        assert!(a.rows.is_empty(), "no rows rather than rows of zeroes");
        assert_eq!(
            a.note.as_deref(),
            Some("Nothing to average yet. Log a few days and this fills in.")
        );
        assert!(a.basis.is_empty(), "there is no coverage to state");
    }

    #[test]
    fn a_measure_with_four_days_prints_a_sentence_and_no_median() {
        let days = vec![
            day("2026-09-01", Some(1900.0), None, 2),
            day("2026-09-02", Some(2100.0), None, 2),
            day("2026-09-03", Some(2000.0), None, 2),
            day("2026-09-04", Some(2200.0), None, 2),
        ];
        let a = aggregate_from(&view(days, vec![energy_total(None, None)]), 30, AS_OF);
        let energy = &a.rows[0];
        assert_eq!(energy.value, "—", "a figure slot holds a figure or a dash");
        assert_eq!(
            energy.note.as_deref(),
            Some("4 days measured. A spread needs 5.")
        );
        assert!(!energy.value.contains("kcal"), "there is no figure to print");
    }

    #[test]
    fn a_measure_refuses_on_its_own_day_count_and_not_the_periods() {
        // Twenty-two days of food and three days of water, which is an ordinary
        // month. Energy gets a middle day; water must not.
        let mut days = Vec::new();
        for i in 1..=22 {
            let water = if i <= 3 { Some(1800.0 + i as f64) } else { None };
            days.push(day(&format!("2026-09-{i:02}"), Some(1800.0 + i as f64 * 20.0), water, 2));
        }
        let a = aggregate_from(&view(days, vec![energy_total(None, None)]), 30, AS_OF);
        assert!(a.rows[0].value.contains("kcal"), "energy has 22 days");
        assert_eq!(a.rows[1].value, "—");
        assert_eq!(
            a.rows[1].note.as_deref(),
            Some("3 days measured. A spread needs 5.")
        );
        assert!(
            !a.rows[1].value.contains(" L"),
            "a water median from three days is a pattern claimed from noise"
        );
    }

    #[test]
    fn a_day_that_measured_no_energy_is_absent_rather_than_zero() {
        let days = vec![
            day("2026-09-01", Some(1900.0), None, 2),
            day("2026-09-02", None, None, 2),
            day("2026-09-03", Some(2100.0), None, 2),
            day("2026-09-04", Some(2000.0), None, 2),
            day("2026-09-05", Some(2200.0), None, 2),
            day("2026-09-06", Some(2300.0), None, 2),
        ];
        let a = aggregate_from(&view(days, vec![energy_total(None, None)]), 30, AS_OF);
        // Five measured days, so a spread exists — and the median is the median
        // of those five, not of six with a zero dragging it down.
        assert_eq!(a.rows[0].value, "2,100 kcal");
    }

    #[test]
    fn an_energy_figure_that_was_never_measured_reads_as_not_recorded() {
        let days = vec![day("2026-09-01", None, None, 2)];
        let a = aggregate_from(&view(days, vec![energy_total(None, None)]), 30, AS_OF);
        assert_eq!(a.rows[0].value, "—");
        assert_eq!(
            a.rows[0].note.as_deref(),
            Some("Not measured on any day you logged.")
        );
        assert!(a.rows[0].r#ref.is_none(), "a reference with no record beside it is a target");
    }

    #[test]
    fn the_reference_line_vanishes_when_no_system_publishes_a_figure() {
        // Built twice rather than cloned: `DaySummary` is a serialised view of a
        // day and derives only what crossing the IPC boundary needs, so a test
        // that wanted `Clone` would be asking a shipped type to grow a trait for
        // its own convenience.
        let days = || -> Vec<DaySummary> {
            (1..=6)
                .map(|i| day(&format!("2026-09-0{i}"), Some(2000.0 + i as f64 * 10.0), None, 2))
                .collect()
        };
        let none = aggregate_from(&view(days(), vec![energy_total(None, None)]), 30, AS_OF);
        assert!(
            none.rows[0].r#ref.is_none(),
            "with nothing published the line is absent, not invented"
        );

        let set = aggregate_from(
            &view(days(), vec![energy_total(Some(2240.0), Some("user_set"))]),
            30,
            AS_OF,
        );
        assert_eq!(
            set.rows[0].r#ref.as_deref(),
            Some("for reference 2,240 kcal"),
            "the tile says what the Statistics screen says beside the same \
             figure, and neither of them says “your target”"
        );
    }

    #[test]
    fn the_reference_figure_is_named_and_is_never_a_percentage() {
        let days: Vec<DaySummary> = (1..=6)
            .map(|i| day(&format!("2026-09-0{i}"), Some(2000.0), Some(2100.0), 2))
            .collect();
        let a = aggregate_from(
            &view(days, vec![energy_total(Some(2240.0), Some("user_set"))]),
            30,
            AS_OF,
        );
        let json = serde_json::to_string(&a).unwrap();
        // "for reference" whatever basis the figure carries, because for energy
        // the only basis there can be is the person's own — and the screen this
        // tile transcribes refuses to call that "your target". Named beside the
        // amount either way, which is the property under test.
        assert!(
            json.contains("for reference 2,240 kcal"),
            "named, beside the amount: {json}"
        );
        for forbidden in ["%", "goal", "streak", "on track", "worth a look", "left of"] {
            assert!(
                !json.contains(forbidden),
                "the aggregate snapshot must never carry {forbidden:?}: {json}"
            );
        }
    }

    #[test]
    fn the_coverage_sentence_is_anchored_to_a_date() {
        let days: Vec<DaySummary> = (1..=6)
            .map(|i| day(&format!("2026-09-0{i}"), Some(2000.0), None, 2))
            .collect();
        let a = aggregate_from(&view(days, vec![energy_total(None, None)]), 30, AS_OF);
        assert_eq!(
            a.basis,
            "You logged food on 6 of the last 30 days, from 12 August."
        );
        // And the stamp carries a year, so a fortnight-old snapshot cannot read
        // as this evening's.
        assert!(a.as_of.contains("2026"));
    }

    #[test]
    fn the_aggregate_snapshot_holds_no_food_name() {
        // Built over a period whose only dish was an idli. The aggregate widget
        // draws figures and its provider must never open a file that names what
        // somebody ate.
        let days: Vec<DaySummary> = (1..=6)
            .map(|i| day(&format!("2026-09-0{i}"), Some(2000.0), None, 1))
            .collect();
        let json = serde_json::to_string(&aggregate_from(
            &view(days, vec![energy_total(None, None)]),
            30,
            AS_OF,
        ))
        .unwrap();
        assert!(!json.to_lowercase().contains("idli"));
    }

    /// A ranked row in the shape `frequent_foods` hands back, so the tests below
    /// exercise the same type the app passes in rather than a local stand-in.
    fn ranked(kind: &str, id: &str, description: &str) -> crate::store::FrequentFood {
        crate::store::FrequentFood {
            source_kind: kind.into(),
            key: format!("{kind}:{id}"),
            fdc_id: if kind == "food" { id.parse().ok() } else { None },
            custom_food_id: if kind == "custom" { Some(id.into()) } else { None },
            description: description.into(),
            brand: None,
            last_grams: 150.0,
            last_amount_label: "150 g".into(),
        }
    }

    #[test]
    fn a_quick_add_row_carries_a_label_and_a_kind_id_pair_and_nothing_else() {
        let rows = vec![
            ranked("food", "167763", "Idli"),
            ranked("custom", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "Peanut butter"),
        ];
        let q = quickadd_from(&rows, AS_OF);
        assert_eq!(q.foods.len(), 2);
        assert_eq!(q.foods[0].kind, "food");
        assert_eq!(q.foods[0].id, "167763");
        assert_eq!(q.foods[1].kind, "custom");
        assert!(q.note.is_none());
        let json = serde_json::to_string(&q).unwrap();
        assert!(json.contains("Idli"));
        // Everything the ranking was made of stays behind, and so does the
        // amount. A count of helpings and a last-logged date are figures about
        // the PERSON, and a tile that prints them has become a report on them —
        // the screen may show "150 g last time" beside a row the person is
        // about to confirm, but a home screen is not a place anybody opened.
        for scoring in ["last_grams", "last_amount", "150 g", "entries", "2026-09-0"] {
            assert!(!json.contains(scoring), "{scoring:?} does not belong on a tile: {json}");
        }
    }

    #[test]
    fn quick_add_with_nothing_to_show_describes_the_record_not_the_person() {
        let q = quickadd_from(&[], AS_OF);
        assert!(q.foods.is_empty());
        assert_eq!(q.note.as_deref(), Some("Nothing to show yet"));
        assert!(!serde_json::to_string(&q).unwrap().contains("logged yet"));
    }

    #[test]
    fn quick_add_never_offers_more_rows_than_fit_a_tile() {
        let rows: Vec<crate::store::FrequentFood> = (0..9)
            .map(|i| ranked("food", &format!("{}", 100 + i), &format!("Food {i}")))
            .collect();
        assert_eq!(quickadd_from(&rows, AS_OF).foods.len(), QUICK_ROWS);
    }

    #[test]
    fn the_route_whitelist_admits_exactly_two_destinations() {
        assert!(route_is_allowed("statistics"));
        assert!(route_is_allowed("foods"));
        for forged in [
            "settings", "profile", "household", "import", "", "Foods", "foods/../settings",
            "statistics?menu=1", "javascript:alert(1)",
        ] {
            assert!(!route_is_allowed(forged), "{forged:?} is not a widget destination");
        }
    }

    #[test]
    fn a_pick_token_with_punctuation_in_it_is_thrown_away_whole() {
        assert!(pick_is_allowed("water"));
        assert!(pick_is_allowed("food:167763"));
        assert!(pick_is_allowed("custom:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
        for forged in [
            "food:1; DROP",
            "food:",
            "food:-1",
            "food:1.5",
            "food:9999999999999",
            "custom:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeeZ",
            "custom:AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
            "custom:../../etc/passwd",
            "recipe:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "supplement:1",
            "cook:1",
            "Water",
            "",
        ] {
            assert!(!pick_is_allowed(forged), "{forged:?} is not a token this app wrote");
        }
    }

    #[test]
    fn a_landing_is_honoured_once_and_then_gone() {
        let tmp = std::env::temp_dir().join(format!("trackit-widget-{}", std::process::id()));
        let dir = dir_in(&tmp);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("landing.json"),
            r#"{"route":"foods","pick":"food:167763"}"#,
        )
        .unwrap();

        let first = take_landing(&tmp).unwrap().unwrap();
        assert_eq!(first.route, "foods");
        assert_eq!(first.pick.as_deref(), Some("food:167763"));
        // A font-size change recreates the Activity and re-reads its Intent. The
        // second read must find nothing, or the same tap would be replayed.
        assert!(take_landing(&tmp).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_forged_landing_loses_its_pick_or_the_whole_tap() {
        let tmp = std::env::temp_dir().join(format!("trackit-forged-{}", std::process::id()));
        let dir = dir_in(&tmp);
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(dir.join("landing.json"), r#"{"route":"settings","pick":null}"#).unwrap();
        assert!(take_landing(&tmp).unwrap().is_none(), "a route off the list is refused");

        std::fs::write(
            dir.join("landing.json"),
            r#"{"route":"foods","pick":"food:1; DROP"}"#,
        )
        .unwrap();
        let landed = take_landing(&tmp).unwrap().unwrap();
        assert_eq!(landed.route, "foods");
        assert!(landed.pick.is_none(), "a blank Add food screen, not a mangled hash");

        std::fs::write(dir.join("landing.json"), "not json at all").unwrap();
        assert!(take_landing(&tmp).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_snapshot_is_replaced_whole_rather_than_appended_to() {
        let tmp = std::env::temp_dir().join(format!("trackit-write-{}", std::process::id()));
        let long = aggregate_from(
            &view(
                (1..=6)
                    .map(|i| day(&format!("2026-09-0{i}"), Some(2000.0), None, 2))
                    .collect(),
                vec![energy_total(Some(2240.0), Some("user_set"))],
            ),
            30,
            AS_OF,
        );
        write(&tmp, &long, &quickadd_from(&[], AS_OF)).unwrap();
        let empty = aggregate_from(&view(Vec::new(), vec![energy_total(None, None)]), 30, AS_OF);
        write(&tmp, &empty, &quickadd_from(&[], AS_OF)).unwrap();

        let on_disk = std::fs::read_to_string(dir_in(&tmp).join("aggregate.json")).unwrap();
        assert!(!on_disk.contains("2,240"), "the previous snapshot is gone, not layered under");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&on_disk).unwrap()["v"],
            AGGREGATE_VERSION,
            "and what is there parses as one document"
        );
        assert!(
            !dir_in(&tmp).join("aggregate.json.writing").exists(),
            "no temporary file is left behind for the next write to trip over"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_figure_is_grouped_and_rounded_the_way_the_screen_writes_it() {
        assert_eq!(fmt_amount(1980.0, "kcal"), "1,980 kcal");
        assert_eq!(fmt_amount(412.0, "mg"), "412 mg");
        assert_eq!(fmt_amount(2.1, "g"), "2.1 g");
        assert_eq!(fmt_amount(0.45, "ug"), "0.45 ug");
        assert_eq!(fmt_amount(0.0, "g"), "0 g");
        assert_eq!(fmt_amount(1234567.0, "kcal"), "1,234,567 kcal");
    }

    #[test]
    fn the_stamp_carries_the_year_so_a_stale_snapshot_says_so() {
        assert_eq!(stamp("2026-09-10 21:14"), "as at 21:14, 10 Sep 2026");
        assert_eq!(stamp("2026-01-05 06:03"), "as at 06:03, 5 Jan 2026");
        assert_eq!(stamp(""), "as at an unknown moment");
        assert_eq!(stamp("2026-09-10"), "as at an unknown moment");
    }

    #[test]
    fn a_date_is_written_as_a_person_says_it_and_never_relative_to_now() {
        assert_eq!(human_day("2026-08-12"), "12 August");
        assert_eq!(human_day("2026-01-01"), "1 January");
        assert_eq!(human_day("2026-12-31"), "31 December");
        // A snapshot read a week after it was written must not say "Yesterday".
        assert!(!human_day("2026-09-09").contains("esterday"));
        assert_eq!(human_day("nonsense"), "nonsense");
    }
}
