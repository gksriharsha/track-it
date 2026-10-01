//! Activity and strength sessions: the commands, and the SQL behind them.
//!
//! A module of its own rather than more of `store.rs` and `lib.rs`, because
//! nothing here touches food. No reference database, no snapshot, no widget:
//! an activity changes no figure the day screen or the home-screen widget
//! prints, so no command here calls `after_write`. The arithmetic over a period
//! lives in `trackit_core::activity`; this file is the part that needs SQLite.
//! See `docs/decisions.md` D26.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use trackit_core::activity::{
    self as core, Effort, ExerciseSummary, Kind, Load, Session, Set, Week, COMMON_EXERCISES,
};

use crate::store::{self, now_iso, today_iso};

/// Upper bounds on text that arrives from the webview, in the spirit of
/// `MAX_NOTE_CHARS`: a guard on the writing side, not a product limit.
const MAX_LABEL_CHARS: usize = 80;
const MAX_NOTE_CHARS: usize = 1000;

// ---------------------------------------------------------------------------
// Shapes on the wire
// ---------------------------------------------------------------------------

/// One set, as the screen shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SetView {
    pub id: String,
    pub position: i64,
    pub exercise_id: String,
    /// As it was when the set was written.
    pub exercise_name: String,
    pub load: String,
    pub reps: Option<u32>,
    pub load_kg: Option<f64>,
    pub seconds: Option<u32>,
}

/// One session, with its sets in the order they were written.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActivityView {
    pub id: String,
    pub logged_on: String,
    pub kind: String,
    pub label: Option<String>,
    pub minutes: Option<f64>,
    pub effort: Option<String>,
    pub note: Option<String>,
    pub corrected_at: Option<String>,
    pub sets: Vec<SetView>,
}

/// A session's own fields, written whole. `id` absent means a new session.
#[derive(Debug, Clone, Deserialize)]
pub struct ActivityInput {
    pub id: Option<String>,
    pub logged_on: String,
    pub kind: String,
    pub label: Option<String>,
    pub minutes: Option<f64>,
    pub effort: Option<String>,
    pub note: Option<String>,
}

/// The figures of one set.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct SetInput {
    pub reps: Option<u32>,
    pub load_kg: Option<f64>,
    pub seconds: Option<u32>,
}

/// Which lift a set is of: an existing row by `id`, or a name to find or make.
#[derive(Debug, Clone, Deserialize)]
pub struct ExerciseRef {
    pub id: Option<String>,
    pub name: String,
    pub load: String,
}

/// What `add_activity_set` hands back: the session may have just been made.
#[derive(Debug, Clone, Serialize)]
pub struct SetAdded {
    pub activity_id: String,
    pub set: SetView,
}

/// A lift the picker can offer.
#[derive(Debug, Clone, Serialize)]
pub struct ExerciseHit {
    /// `None` for a common lift this person has never logged: it gets a row the
    /// first time a set of it is written.
    pub id: Option<String>,
    pub name: String,
    pub load: String,
    /// True for the person's own lifts, which rank first.
    pub own: bool,
    /// The sets of the last session it was in, to pre-fill the next one with.
    pub last_sets: Vec<SetFigures>,
    pub last_on: Option<String>,
}

/// A set's figures without its identity.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SetFigures {
    pub reps: Option<u32>,
    pub load_kg: Option<f64>,
    pub seconds: Option<u32>,
}

/// Something done before, offered as one tap.
#[derive(Debug, Clone, Serialize)]
pub struct RecentActivity {
    pub kind: String,
    pub label: Option<String>,
    pub minutes: Option<f64>,
    pub effort: Option<String>,
    pub last_on: String,
    /// For strength: the lifts of that session, in the order first done.
    pub exercises: Vec<ExerciseRefOut>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExerciseRefOut {
    pub id: String,
    pub name: String,
    pub load: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KindCount {
    pub kind: String,
    pub sessions: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExerciseRange {
    pub exercise_id: String,
    pub name: String,
    pub load: String,
    pub summary: ExerciseSummary,
}

/// A typical whole week of a period: each figure the middle of the whole
/// weeks, taken separately, so the typical minutes and the typical days need
/// not come from the same week.
#[derive(Debug, Clone, Serialize)]
pub struct Typical {
    /// How many whole weeks these are the middle of.
    pub weeks: u32,
    pub minutes: f64,
    pub aerobic_minutes: f64,
    pub active_days: f64,
    pub strength_days: f64,
}

/// A period of activity, decided.
#[derive(Debug, Clone, Serialize)]
pub struct ActivityRange {
    pub from: String,
    pub to: String,
    pub span_days: u32,
    /// The first activity ever logged, if it is on or before `to`.
    pub tracked_since: Option<String>,
    /// Most recent first. Empty when nothing has ever been logged.
    pub weeks: Vec<Week>,
    /// `None` until there is one whole week of tracking in the period.
    pub typical: Option<Typical>,
    /// Sessions in the period.
    pub sessions: u32,
    pub by_kind: Vec<KindCount>,
    pub exercises: Vec<ExerciseRange>,
    /// Echoed from the profile, so the screen can print what About you says
    /// beside what was logged without a second round trip.
    pub profile_activity: Option<String>,
    pub birth_year: Option<i64>,
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/// A real calendar date that has already begun. Asked of SQLite, whose
/// calendar wrote every other date in the log.
fn check_day(conn: &Connection, day: &str) -> Result<(), String> {
    let real: bool = conn
        .query_row("SELECT date(?1) IS ?1", [day], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if !real {
        return Err(format!("“{day}” is not a date"));
    }
    if day > today_iso(conn)?.as_str() {
        return Err("That day has not happened yet.".into());
    }
    Ok(())
}

fn tidy(text: Option<String>, max: usize, what: &str) -> Result<Option<String>, String> {
    let Some(t) = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let n = t.chars().count();
    if n > max {
        return Err(format!("{what} is kept to {max} characters, and this one is {n}"));
    }
    Ok(Some(t))
}

fn check_set(load: Load, set: &SetInput) -> Result<(), String> {
    match load {
        Load::Weight | Load::Body if set.reps.is_none() => {
            return Err("A set of this lift needs its repetitions.".into());
        }
        Load::Time if set.seconds.is_none() => {
            return Err("A hold needs how many seconds it lasted.".into());
        }
        _ => {}
    }
    if let Some(kg) = set.load_kg {
        if !kg.is_finite() || !(0.0..=1000.0).contains(&kg) {
            return Err(format!("{kg} kg is not a weight this can record"));
        }
    }
    if matches!(set.reps, Some(0)) {
        return Err("A set has at least one repetition.".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

fn sets_of(conn: &Connection, activity_id: &str) -> Result<Vec<SetView>, String> {
    let mut st = conn
        .prepare(
            "SELECT s.id, s.position, s.exercise_id, s.exercise_name, e.load,
                    s.reps, s.load_kg, s.seconds
             FROM activity_sets s JOIN exercises e ON e.id = s.exercise_id
             WHERE s.activity_id = ?1 AND s.deleted_at IS NULL
             ORDER BY s.position",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([activity_id], |r| {
            Ok(SetView {
                id: r.get(0)?,
                position: r.get(1)?,
                exercise_id: r.get(2)?,
                exercise_name: r.get(3)?,
                load: r.get(4)?,
                reps: r.get(5)?,
                load_kg: r.get(6)?,
                seconds: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn read_activity(conn: &Connection, id: &str) -> Result<Option<ActivityView>, String> {
    let found = conn
        .query_row(
            "SELECT id, logged_on, kind, label, minutes, effort, note, corrected_at
             FROM activities WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| {
                Ok(ActivityView {
                    id: r.get(0)?,
                    logged_on: r.get(1)?,
                    kind: r.get(2)?,
                    label: r.get(3)?,
                    minutes: r.get(4)?,
                    effort: r.get(5)?,
                    note: r.get(6)?,
                    corrected_at: r.get(7)?,
                    sets: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(mut a) = found else { return Ok(None) };
    a.sets = sets_of(conn, &a.id)?;
    Ok(Some(a))
}

pub fn activities_on(conn: &Connection, day: &str) -> Result<Vec<ActivityView>, String> {
    let ids: Vec<String> = {
        let mut st = conn
            .prepare(
                "SELECT id FROM activities WHERE logged_on = ?1 AND deleted_at IS NULL
                 ORDER BY created_at, rowid",
            )
            .map_err(|e| e.to_string())?;
        let ids = st
            .query_map([day], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        ids
    };
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(a) = read_activity(conn, &id)? {
            out.push(a);
        }
    }
    Ok(out)
}

/// Every session in a period, oldest day first, for the export.
pub fn between(conn: &Connection, from: &str, to: &str) -> Result<Vec<ActivityView>, String> {
    let days: Vec<String> = {
        let mut st = conn
            .prepare(
                "SELECT DISTINCT logged_on FROM activities
                 WHERE deleted_at IS NULL AND logged_on BETWEEN ?1 AND ?2 ORDER BY logged_on",
            )
            .map_err(|e| e.to_string())?;
        let days = st
            .query_map(params![from, to], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        days
    };
    let mut out = Vec::new();
    for d in days {
        out.extend(activities_on(conn, &d)?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Stamp a session as corrected when it belongs to a day already over.
///
/// Editing today's walk is finishing it; editing last Tuesday's is changing the
/// past, and the past says when it was changed.
fn touch(conn: &Connection, activity_id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    let today = today_iso(conn)?;
    conn.execute(
        "UPDATE activities SET updated_at = ?2,
                corrected_at = CASE WHEN logged_on < ?3 THEN ?2 ELSE corrected_at END
         WHERE id = ?1",
        params![activity_id, now, today],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save(conn: &Connection, input: ActivityInput) -> Result<String, String> {
    check_day(conn, &input.logged_on)?;
    let kind = Kind::parse(&input.kind).ok_or_else(|| format!("“{}” is not a kind of activity", input.kind))?;
    let effort = match input.effort.as_deref() {
        None => None,
        Some(e) => Some(Effort::parse(e).ok_or_else(|| format!("“{e}” is not an effort"))?),
    };
    let minutes = input.minutes.filter(|m| m.is_finite());
    if let Some(m) = minutes {
        if !(m > 0.0 && m <= 1440.0) {
            return Err("Minutes are between 1 and a whole day.".into());
        }
    }
    if kind != Kind::Strength && (minutes.is_none() || effort.is_none()) {
        return Err("Say how long it was and how hard.".into());
    }
    let label = tidy(input.label, MAX_LABEL_CHARS, "A name")?;
    let note = tidy(input.note, MAX_NOTE_CHARS, "A note")?;
    let now = now_iso(conn)?;

    match input.id {
        None => {
            let id = store::new_id(conn)?;
            conn.execute(
                "INSERT INTO activities
                   (id, logged_on, kind, label, minutes, effort, note, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)",
                params![
                    id,
                    input.logged_on,
                    kind.as_str(),
                    label,
                    minutes,
                    effort.map(Effort::as_str),
                    note,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
        Some(id) => {
            // The day a session belongs to is part of what it records; moving
            // it is a correction like any other, stamped against the earlier
            // of the two days.
            let changed = conn
                .execute(
                    "UPDATE activities SET logged_on = ?2, kind = ?3, label = ?4, minutes = ?5,
                            effort = ?6, note = ?7
                     WHERE id = ?1 AND deleted_at IS NULL",
                    params![
                        id,
                        input.logged_on,
                        kind.as_str(),
                        label,
                        minutes,
                        effort.map(Effort::as_str),
                        note
                    ],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("That session is no longer in the log.".into());
            }
            touch(conn, &id)?;
            Ok(id)
        }
    }
}

pub fn remove(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let now = now_iso(&tx)?;
    tx.execute(
        "UPDATE activity_sets SET deleted_at = ?2, updated_at = ?2
         WHERE activity_id = ?1 AND deleted_at IS NULL",
        params![id, now],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE activities SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// The live row for a lift, making one when this is its first set.
fn resolve_exercise(conn: &Connection, ex: &ExerciseRef) -> Result<(String, String, Load), String> {
    if let Some(id) = &ex.id {
        let found: Option<(String, String)> = conn
            .query_row(
                "SELECT name, load FROM exercises WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let (name, load) = found.ok_or("That exercise is no longer in the list.")?;
        let load = Load::parse(&load).ok_or("That exercise has an unknown kind of set.")?;
        return Ok((id.clone(), name, load));
    }
    let name = ex.name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("Name the exercise.".into());
    }
    if name.chars().count() > MAX_LABEL_CHARS {
        return Err(format!("An exercise name is kept to {MAX_LABEL_CHARS} characters"));
    }
    let key = core::name_key(&name);
    let existing: Option<(String, String, String)> = conn
        .query_row(
            "SELECT id, name, load FROM exercises WHERE name_key = ?1 AND deleted_at IS NULL",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((id, name, load)) = existing {
        let load = Load::parse(&load).ok_or("That exercise has an unknown kind of set.")?;
        return Ok((id, name, load));
    }
    let load = Load::parse(&ex.load).ok_or_else(|| format!("“{}” is not a kind of set", ex.load))?;
    let id = store::new_id(conn)?;
    let now = now_iso(conn)?;
    conn.execute(
        "INSERT INTO exercises (id, name, name_key, load, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?5)",
        params![id, name, key, load.as_str(), now],
    )
    .map_err(|e| e.to_string())?;
    Ok((id, name, load))
}

/// Write one set, making the session first if this is its first set.
pub fn add_set(
    conn: &Connection,
    activity_id: Option<&str>,
    logged_on: &str,
    exercise: &ExerciseRef,
    set: SetInput,
) -> Result<SetAdded, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (exercise_id, exercise_name, load) = resolve_exercise(&tx, exercise)?;
    check_set(load, &set)?;
    let activity_id = match activity_id {
        Some(id) => {
            let kind: Option<String> = tx
                .query_row(
                    "SELECT kind FROM activities WHERE id = ?1 AND deleted_at IS NULL",
                    [id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match kind.as_deref() {
                Some("strength") => id.to_string(),
                Some(_) => return Err("Sets belong to a strength session.".into()),
                None => return Err("That session is no longer in the log.".into()),
            }
        }
        None => save(
            &tx,
            ActivityInput {
                id: None,
                logged_on: logged_on.to_string(),
                kind: "strength".into(),
                label: None,
                minutes: None,
                effort: None,
                note: None,
            },
        )?,
    };
    let position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM activity_sets WHERE activity_id = ?1",
            [&activity_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let id = store::new_id(&tx)?;
    let now = now_iso(&tx)?;
    // Only the figure the lift is counted in is kept: a weight on a plank, or
    // seconds on a squat, would be a number nothing reads.
    let (reps, load_kg, seconds) = match load {
        Load::Weight | Load::Body => (set.reps, set.load_kg, None),
        Load::Time => (None, set.load_kg, set.seconds),
    };
    tx.execute(
        "INSERT INTO activity_sets
           (id, activity_id, position, exercise_id, exercise_name, reps, load_kg, seconds,
            created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
        params![id, activity_id, position, exercise_id, exercise_name, reps, load_kg, seconds, now],
    )
    .map_err(|e| e.to_string())?;
    touch(&tx, &activity_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SetAdded {
        activity_id,
        set: SetView {
            id,
            position,
            exercise_id,
            exercise_name,
            load: load.as_str().into(),
            reps,
            load_kg,
            seconds,
        },
    })
}

pub fn update_set(conn: &Connection, set_id: &str, set: SetInput) -> Result<(), String> {
    let found: Option<(String, String)> = conn
        .query_row(
            "SELECT s.activity_id, e.load FROM activity_sets s
             JOIN exercises e ON e.id = s.exercise_id
             WHERE s.id = ?1 AND s.deleted_at IS NULL",
            [set_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (activity_id, load) = found.ok_or("That set is no longer in the log.")?;
    let load = Load::parse(&load).ok_or("That exercise has an unknown kind of set.")?;
    check_set(load, &set)?;
    let (reps, load_kg, seconds) = match load {
        Load::Weight | Load::Body => (set.reps, set.load_kg, None),
        Load::Time => (None, set.load_kg, set.seconds),
    };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let now = now_iso(&tx)?;
    tx.execute(
        "UPDATE activity_sets SET reps = ?2, load_kg = ?3, seconds = ?4, updated_at = ?5
         WHERE id = ?1",
        params![set_id, reps, load_kg, seconds, now],
    )
    .map_err(|e| e.to_string())?;
    touch(&tx, &activity_id)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Remove one set. A strength session left with no sets and no length is
/// removed with it: it would be a row on Today saying "Strength" about nothing.
///
/// Returns whether the session went too, so the screen knows to stop pointing
/// at it.
pub fn remove_set(conn: &Connection, set_id: &str) -> Result<bool, String> {
    let activity_id: Option<String> = conn
        .query_row(
            "SELECT activity_id FROM activity_sets WHERE id = ?1 AND deleted_at IS NULL",
            [set_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(activity_id) = activity_id else { return Ok(false) };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let now = now_iso(&tx)?;
    tx.execute(
        "UPDATE activity_sets SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![set_id, now],
    )
    .map_err(|e| e.to_string())?;
    let empty: bool = tx
        .query_row(
            "SELECT minutes IS NULL AND NOT EXISTS (
                SELECT 1 FROM activity_sets WHERE activity_id = a.id AND deleted_at IS NULL)
             FROM activities a WHERE a.id = ?1",
            [&activity_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if empty {
        tx.execute(
            "UPDATE activities SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![activity_id, now],
        )
        .map_err(|e| e.to_string())?;
    } else {
        touch(&tx, &activity_id)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(empty)
}

// ---------------------------------------------------------------------------
// Offering things again
// ---------------------------------------------------------------------------

/// What has been done lately, one tile per distinct thing, most recent first.
///
/// A walk of 30 minutes and a walk of 45 are two tiles, because a tap logs
/// exactly what the tile says. Strength is one tile: the most recent session,
/// whose lifts start the next one.
pub fn recent(conn: &Connection, limit: usize) -> Result<Vec<RecentActivity>, String> {
    let mut out = Vec::new();
    {
        let mut st = conn
            .prepare(
                "SELECT kind, label, minutes, effort, MAX(logged_on) AS last_on
                 FROM activities
                 WHERE deleted_at IS NULL AND kind <> 'strength'
                   AND logged_on >= date('now','localtime','-90 days')
                 GROUP BY kind, label, minutes, effort
                 ORDER BY last_on DESC, MAX(created_at) DESC, MAX(rowid) DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([limit as i64], |r| {
                Ok(RecentActivity {
                    kind: r.get(0)?,
                    label: r.get(1)?,
                    minutes: r.get(2)?,
                    effort: r.get(3)?,
                    last_on: r.get(4)?,
                    exercises: Vec::new(),
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
    }
    let last_strength: Option<(String, String)> = conn
        .query_row(
            "SELECT a.id, a.logged_on FROM activities a
             WHERE a.deleted_at IS NULL AND a.kind = 'strength'
               AND EXISTS (SELECT 1 FROM activity_sets s
                           WHERE s.activity_id = a.id AND s.deleted_at IS NULL)
             ORDER BY a.logged_on DESC, a.created_at DESC, a.rowid DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((id, last_on)) = last_strength {
        let mut lifts: Vec<ExerciseRefOut> = Vec::new();
        for s in sets_of(conn, &id)? {
            if !lifts.iter().any(|l| l.id == s.exercise_id) {
                // The lift's current name, not the one on the old set: this is
                // an offer for the next session, not a record of the last.
                let name: String = conn
                    .query_row("SELECT name FROM exercises WHERE id = ?1", [&s.exercise_id], |r| {
                        r.get(0)
                    })
                    .map_err(|e| e.to_string())?;
                lifts.push(ExerciseRefOut { id: s.exercise_id, name, load: s.load });
            }
        }
        // Placed by date among the others, so a gym session last Friday sits
        // after a walk this morning and before one from a fortnight ago.
        let at = out.iter().position(|r| r.last_on < last_on).unwrap_or(out.len());
        out.insert(
            at,
            RecentActivity {
                kind: "strength".into(),
                label: None,
                minutes: None,
                effort: None,
                last_on,
                exercises: lifts,
            },
        );
        out.truncate(limit.max(1));
    }
    Ok(out)
}

/// The sets of the most recent session containing a lift, excluding one.
fn last_sets(
    conn: &Connection,
    exercise_id: &str,
    excluding: Option<&str>,
) -> Result<(Vec<SetFigures>, Option<String>), String> {
    let last: Option<(String, String)> = conn
        .query_row(
            "SELECT a.id, a.logged_on FROM activities a
             WHERE a.deleted_at IS NULL AND a.id IS NOT ?2
               AND EXISTS (SELECT 1 FROM activity_sets s WHERE s.activity_id = a.id
                           AND s.exercise_id = ?1 AND s.deleted_at IS NULL)
             ORDER BY a.logged_on DESC, a.created_at DESC, a.rowid DESC LIMIT 1",
            params![exercise_id, excluding],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((aid, on)) = last else { return Ok((Vec::new(), None)) };
    let sets = sets_of(conn, &aid)?
        .into_iter()
        .filter(|s| s.exercise_id == exercise_id)
        .map(|s| SetFigures { reps: s.reps, load_kg: s.load_kg, seconds: s.seconds })
        .collect();
    Ok((sets, Some(on)))
}

/// Lifts matching a search: the person's own first, most recently used first,
/// then the common ones they have not used yet.
///
/// The same order Foods keeps — your own before the reference list — for the
/// same reason: the lift you named is the one you do.
pub fn find(
    conn: &Connection,
    query: &str,
    session: Option<&str>,
    limit: usize,
) -> Result<Vec<ExerciseHit>, String> {
    let key = core::name_key(query);
    let mut out: Vec<ExerciseHit> = Vec::new();
    let own: Vec<(String, String, String)> = {
        let mut st = conn
            .prepare(
                "SELECT e.id, e.name, e.load FROM exercises e
                 LEFT JOIN activity_sets s ON s.exercise_id = e.id AND s.deleted_at IS NULL
                 WHERE e.deleted_at IS NULL AND instr(e.name_key, ?1) > 0
                 GROUP BY e.id
                 ORDER BY MAX(s.created_at) IS NULL, MAX(s.created_at) DESC, MAX(s.rowid) DESC, e.name",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([&key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for (id, name, load) in own {
        let (last_sets, last_on) = last_sets(conn, &id, session)?;
        out.push(ExerciseHit { id: Some(id), name, load, own: true, last_sets, last_on });
    }
    for (name, load) in COMMON_EXERCISES {
        let k = core::name_key(name);
        if !k.contains(&key) || out.iter().any(|h| core::name_key(&h.name) == k) {
            continue;
        }
        out.push(ExerciseHit {
            id: None,
            name: (*name).into(),
            load: load.as_str().into(),
            own: false,
            last_sets: Vec::new(),
            last_on: None,
        });
    }
    out.truncate(limit);
    Ok(out)
}

// ---------------------------------------------------------------------------
// A period
// ---------------------------------------------------------------------------

pub fn range(conn: &Connection, from: &str, to: &str) -> Result<ActivityRange, String> {
    let span: i64 = conn
        .query_row(
            "SELECT CAST(julianday(?2) - julianday(?1) AS INTEGER) + 1",
            params![from, to],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !(1..=3660).contains(&span) {
        return Err(format!("{from} to {to} is not a period this can read"));
    }

    // A strength session with no sets left and no length is not a session; the
    // write path removes them, and this read does not count one that slipped by.
    let live = "a.deleted_at IS NULL AND (a.kind <> 'strength' OR a.minutes IS NOT NULL
                OR EXISTS (SELECT 1 FROM activity_sets s
                           WHERE s.activity_id = a.id AND s.deleted_at IS NULL))";

    let since: Option<(String, i64)> = conn
        .query_row(
            &format!(
                "SELECT MIN(a.logged_on), CAST(julianday(?1) - julianday(MIN(a.logged_on)) AS INTEGER)
                 FROM activities a WHERE {live} AND a.logged_on <= ?1"
            ),
            [to],
            |r| {
                let on: Option<String> = r.get(0)?;
                let days: Option<i64> = r.get(1)?;
                Ok(on.zip(days))
            },
        )
        .map_err(|e| e.to_string())?;

    let mut sessions: Vec<(String, String, Session)> = Vec::new();
    {
        let mut st = conn
            .prepare(&format!(
                "SELECT a.id, a.kind, a.minutes, a.effort,
                        CAST(julianday(?2) - julianday(a.logged_on) AS INTEGER)
                 FROM activities a
                 WHERE {live} AND a.logged_on BETWEEN ?1 AND ?2"
            ))
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map(params![from, to], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<f64>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, kind_s, minutes, effort, days) = row.map_err(|e| e.to_string())?;
            let Some(kind) = Kind::parse(&kind_s) else { continue };
            sessions.push((
                id,
                kind_s,
                Session {
                    days_before_end: days.max(0) as u32,
                    kind,
                    minutes,
                    effort: effort.as_deref().and_then(Effort::parse),
                },
            ));
        }
    }

    let plain: Vec<Session> = sessions.iter().map(|(_, _, s)| *s).collect();
    let weeks = core::weeks(span as u32, since.as_ref().map(|(_, d)| (*d).max(0) as u32), &plain);

    let mut by_kind: Vec<KindCount> = Vec::new();
    for k in Kind::ALL {
        let n = sessions.iter().filter(|(_, _, s)| s.kind == k).count() as u32;
        if n > 0 {
            by_kind.push(KindCount { kind: k.as_str().into(), sessions: n });
        }
    }
    by_kind.sort_by(|a, b| b.sessions.cmp(&a.sessions));

    // Each session's top set of each lift, then one summary per lift.
    let mut tops: Vec<(String, Set)> = Vec::new();
    for (id, kind, _) in &sessions {
        if kind != "strength" {
            continue;
        }
        let sets = sets_of(conn, id)?;
        let mut lifts: Vec<&str> = sets.iter().map(|s| s.exercise_id.as_str()).collect();
        lifts.sort();
        lifts.dedup();
        for lift in lifts {
            let these: Vec<Set> = sets
                .iter()
                .filter(|s| s.exercise_id == lift)
                .map(|s| Set { reps: s.reps, load_kg: s.load_kg, seconds: s.seconds })
                .collect();
            if let Some(top) = core::top_set(&these) {
                tops.push((lift.to_string(), top));
            }
        }
    }
    let mut lift_ids: Vec<String> = tops.iter().map(|(id, _)| id.clone()).collect();
    lift_ids.sort();
    lift_ids.dedup();
    let mut exercises = Vec::new();
    for id in lift_ids {
        let (name, load): (String, String) = conn
            .query_row("SELECT name, load FROM exercises WHERE id = ?1", [&id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|e| e.to_string())?;
        let these: Vec<Set> = tops.iter().filter(|(l, _)| *l == id).map(|(_, s)| *s).collect();
        exercises.push(ExerciseRange { exercise_id: id, name, load, summary: core::summarise_exercise(&these) });
    }
    exercises.sort_by(|a, b| b.summary.sessions.cmp(&a.summary.sessions).then(a.name.cmp(&b.name)));

    let whole = weeks.iter().filter(|w| w.tracked_days == 7).count() as u32;
    let typical = (whole > 0).then(|| Typical {
        weeks: whole,
        minutes: core::typical_week(&weeks, |w| w.minutes).unwrap_or(0.0),
        aerobic_minutes: core::typical_week(&weeks, |w| w.aerobic_minutes).unwrap_or(0.0),
        active_days: core::typical_week(&weeks, |w| w.active_days as f64).unwrap_or(0.0),
        strength_days: core::typical_week(&weeks, |w| w.strength_days as f64).unwrap_or(0.0),
    });

    let profile = store::get_profile(conn)?;
    Ok(ActivityRange {
        from: from.into(),
        to: to.into(),
        span_days: span as u32,
        tracked_since: since.map(|(on, _)| on),
        weeks,
        typical,
        sessions: sessions.len() as u32,
        by_kind,
        exercises,
        profile_activity: profile.activity,
        birth_year: profile.birth_year,
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_activities(
    logged_on: String,
    user: State<'_, store::Store>,
) -> Result<Vec<ActivityView>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    activities_on(&conn, &logged_on)
}

#[tauri::command]
pub fn get_activity(id: String, user: State<'_, store::Store>) -> Result<ActivityView, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    read_activity(&conn, &id)?.ok_or_else(|| "That session is no longer in the log.".into())
}

#[tauri::command]
pub fn save_activity(
    activity: ActivityInput,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    save(&conn, activity)
}

#[tauri::command]
pub fn delete_activity(id: String, user: State<'_, store::Store>) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    remove(&conn, &id)
}

#[tauri::command]
pub fn add_activity_set(
    activity_id: Option<String>,
    logged_on: String,
    exercise: ExerciseRef,
    set: SetInput,
    user: State<'_, store::Store>,
) -> Result<SetAdded, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    add_set(&conn, activity_id.as_deref(), &logged_on, &exercise, set)
}

#[tauri::command]
pub fn update_activity_set(
    set_id: String,
    set: SetInput,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    update_set(&conn, &set_id, set)
}

#[tauri::command]
pub fn delete_activity_set(set_id: String, user: State<'_, store::Store>) -> Result<bool, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    remove_set(&conn, &set_id)
}

#[tauri::command]
pub fn recent_activities(
    limit: Option<usize>,
    user: State<'_, store::Store>,
) -> Result<Vec<RecentActivity>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    recent(&conn, limit.unwrap_or(6).clamp(1, 20))
}

#[tauri::command]
pub fn find_exercises(
    query: String,
    session: Option<String>,
    user: State<'_, store::Store>,
) -> Result<Vec<ExerciseHit>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    find(&conn, &query, session.as_deref(), 40)
}

#[tauri::command]
pub fn get_activity_range(
    from: String,
    to: String,
    user: State<'_, store::Store>,
) -> Result<ActivityRange, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    range(&conn, &from, &to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(store::SCHEMA).unwrap();
        store::ensure_device_identity(&c).unwrap();
        store::install_sync_triggers(&c).unwrap();
        c
    }

    fn today(c: &Connection) -> String {
        today_iso(c).unwrap()
    }

    fn walk(day: &str, minutes: f64) -> ActivityInput {
        ActivityInput {
            id: None,
            logged_on: day.into(),
            kind: "walk".into(),
            label: None,
            minutes: Some(minutes),
            effort: Some("moderate".into()),
            note: None,
        }
    }

    fn squat() -> ExerciseRef {
        ExerciseRef { id: None, name: "Squat".into(), load: "weight".into() }
    }

    fn lift(kg: f64, reps: u32) -> SetInput {
        SetInput { reps: Some(reps), load_kg: Some(kg), seconds: None }
    }

    #[test]
    fn a_v18_log_opens_at_v19_with_everything_in_it_where_it_was() {
        // A database as 0.6.0 left it: no activity tables, stamped 18.
        let path = std::env::temp_dir().join(format!(
            "trackit-v18-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(store::SCHEMA).unwrap();
            c.execute_batch(
                "DROP TABLE activity_sets; DROP TABLE exercises; DROP TABLE activities;
                 INSERT INTO day_notes (logged_on, body, created_at, updated_at)
                   VALUES ('2026-09-01', 'Long day', 't', 't');
                 INSERT INTO profile (id, activity, weight_kg) VALUES (1, 'light', 61.5);",
            )
            .unwrap();
            c.pragma_update(None, "user_version", 18).unwrap();
        }
        let c = store::open(&path).unwrap();
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 19);
        assert_eq!(store::day_note(&c, "2026-09-01").unwrap().as_deref(), Some("Long day"));
        let p = store::get_profile(&c).unwrap();
        assert_eq!((p.activity.as_deref(), p.weight_kg), (Some("light"), Some(61.5)));
        let t = today(&c);
        assert!(save(&c, walk(&t, 30.0)).is_ok(), "and the new tables take a row");
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_walk_needs_its_length_and_effort_but_strength_does_not() {
        let c = db();
        let t = today(&c);
        let mut w = walk(&t, 30.0);
        w.effort = None;
        assert!(save(&c, w).is_err());
        let strength = ActivityInput { kind: "strength".into(), minutes: None, effort: None, ..walk(&t, 1.0) };
        assert!(save(&c, strength).is_ok());
    }

    #[test]
    fn a_day_that_has_not_happened_cannot_be_logged() {
        let c = db();
        let tomorrow = store::shift_iso(&c, &today(&c), 1).unwrap();
        assert!(save(&c, walk(&tomorrow, 30.0)).is_err());
        assert!(save(&c, walk("2026-02-30", 30.0)).is_err());
    }

    #[test]
    fn the_first_set_makes_the_session_and_later_sets_join_it() {
        let c = db();
        let t = today(&c);
        let first = add_set(&c, None, &t, &squat(), lift(60.0, 5)).unwrap();
        let second = add_set(&c, Some(&first.activity_id), &t, &squat(), lift(60.0, 5)).unwrap();
        assert_eq!(first.activity_id, second.activity_id);
        assert_eq!(second.set.position, 1);
        let day = activities_on(&c, &t).unwrap();
        assert_eq!(day.len(), 1);
        assert_eq!(day[0].kind, "strength");
        assert_eq!(day[0].sets.len(), 2);
    }

    #[test]
    fn the_same_lift_typed_twice_is_one_exercise() {
        let c = db();
        let t = today(&c);
        let a = add_set(&c, None, &t, &squat(), lift(60.0, 5)).unwrap();
        let shouty = ExerciseRef { id: None, name: "  SQUAT ".into(), load: "weight".into() };
        let b = add_set(&c, Some(&a.activity_id), &t, &shouty, lift(60.0, 5)).unwrap();
        assert_eq!(a.set.exercise_id, b.set.exercise_id);
        assert_eq!(b.set.exercise_name, "Squat");
    }

    #[test]
    fn removing_the_last_set_removes_an_empty_session() {
        let c = db();
        let t = today(&c);
        let a = add_set(&c, None, &t, &squat(), lift(60.0, 5)).unwrap();
        assert!(remove_set(&c, &a.set.id).unwrap());
        assert!(activities_on(&c, &t).unwrap().is_empty());
    }

    #[test]
    fn a_set_keeps_the_name_it_was_logged_under() {
        let c = db();
        let t = today(&c);
        let a = add_set(&c, None, &t, &squat(), lift(60.0, 5)).unwrap();
        c.execute("UPDATE exercises SET name = 'Back squat', name_key = 'back squat'", []).unwrap();
        let day = activities_on(&c, &t).unwrap();
        assert_eq!(day[0].sets[0].exercise_name, "Squat");
        let _ = a;
    }

    #[test]
    fn a_lift_needs_repetitions_and_a_hold_needs_seconds() {
        let c = db();
        let t = today(&c);
        let none = SetInput { reps: None, load_kg: Some(60.0), seconds: None };
        assert!(add_set(&c, None, &t, &squat(), none).is_err());
        let plank = ExerciseRef { id: None, name: "Plank".into(), load: "time".into() };
        let held = SetInput { reps: None, load_kg: None, seconds: Some(60) };
        assert!(add_set(&c, None, &t, &plank, held).is_ok());
    }

    #[test]
    fn editing_a_past_session_marks_it_corrected_and_today_does_not() {
        let c = db();
        let t = today(&c);
        let past = store::shift_iso(&c, &t, -3).unwrap();
        let id = save(&c, walk(&past, 30.0)).unwrap();
        let today_id = save(&c, walk(&t, 30.0)).unwrap();
        save(&c, ActivityInput { id: Some(id.clone()), ..walk(&past, 40.0) }).unwrap();
        save(&c, ActivityInput { id: Some(today_id.clone()), ..walk(&t, 40.0) }).unwrap();
        assert!(read_activity(&c, &id).unwrap().unwrap().corrected_at.is_some());
        assert!(read_activity(&c, &today_id).unwrap().unwrap().corrected_at.is_none());
    }

    #[test]
    fn nothing_here_is_queued_for_a_household_peer() {
        let c = db();
        let t = today(&c);
        save(&c, walk(&t, 30.0)).unwrap();
        add_set(&c, None, &t, &squat(), lift(60.0, 5)).unwrap();
        let pending: i64 = c.query_row("SELECT COUNT(*) FROM sync_pending", [], |r| r.get(0)).unwrap();
        let versions: i64 = c.query_row("SELECT COUNT(*) FROM row_version", [], |r| r.get(0)).unwrap();
        assert_eq!((pending, versions), (0, 0));
    }

    #[test]
    fn the_period_counts_whole_weeks_from_the_first_activity() {
        let c = db();
        let t = today(&c);
        let ten_ago = store::shift_iso(&c, &t, -10).unwrap();
        let from = store::shift_iso(&c, &t, -89).unwrap();
        save(&c, walk(&ten_ago, 30.0)).unwrap();
        save(&c, walk(&t, 45.0)).unwrap();
        let r = range(&c, &from, &t).unwrap();
        assert_eq!(r.span_days, 90);
        assert_eq!(r.tracked_since.as_deref(), Some(ten_ago.as_str()));
        assert_eq!(r.weeks.len(), 2);
        assert_eq!(r.weeks[0].minutes, 45.0);
        assert_eq!(r.weeks[1].tracked_days, 4);
        assert_eq!(r.sessions, 2);
        assert_eq!(r.by_kind[0].kind, "walk");
        // One whole week, so the typical week is that week.
        let t = r.typical.unwrap();
        assert_eq!((t.weeks, t.minutes, t.aerobic_minutes, t.active_days), (1, 45.0, 45.0, 1.0));
    }

    #[test]
    fn the_period_summarises_each_lift_from_each_sessions_top_set() {
        let c = db();
        let t = today(&c);
        for (back, kg) in [(1, 50.0), (3, 55.0), (5, 60.0)] {
            let day = store::shift_iso(&c, &t, -back).unwrap();
            let a = add_set(&c, None, &day, &squat(), lift(kg - 5.0, 8)).unwrap();
            add_set(&c, Some(&a.activity_id), &day, &squat(), lift(kg, 5)).unwrap();
        }
        let from = store::shift_iso(&c, &t, -29).unwrap();
        let r = range(&c, &from, &t).unwrap();
        assert_eq!(r.exercises.len(), 1);
        let s = &r.exercises[0].summary;
        assert_eq!(s.sessions, 3);
        assert_eq!(s.usual.unwrap().load_kg, Some(55.0));
        assert_eq!(s.heaviest.unwrap().load_kg, Some(60.0));
    }

    #[test]
    fn own_lifts_rank_before_common_ones_and_carry_their_last_sets() {
        let c = db();
        let t = today(&c);
        let mine = ExerciseRef { id: None, name: "Squat jump".into(), load: "body".into() };
        add_set(&c, None, &t, &mine, SetInput { reps: Some(10), load_kg: None, seconds: None }).unwrap();
        let hits = find(&c, "squat", None, 40).unwrap();
        assert_eq!(hits[0].name, "Squat jump");
        assert!(hits[0].own);
        assert_eq!(hits[0].last_sets.len(), 1);
        assert!(hits.iter().any(|h| h.name == "Squat" && !h.own));
    }

    #[test]
    fn recent_offers_each_distinct_walk_and_the_last_strength_session() {
        let c = db();
        let t = today(&c);
        save(&c, walk(&t, 30.0)).unwrap();
        save(&c, walk(&t, 30.0)).unwrap();
        save(&c, walk(&t, 45.0)).unwrap();
        let y = store::shift_iso(&c, &t, -1).unwrap();
        add_set(&c, None, &y, &squat(), lift(60.0, 5)).unwrap();
        let r = recent(&c, 6).unwrap();
        assert_eq!(r.iter().filter(|r| r.kind == "walk").count(), 2);
        let strength = r.iter().find(|r| r.kind == "strength").unwrap();
        assert_eq!(strength.exercises[0].name, "Squat");
        assert_eq!(r.last().unwrap().kind, "strength", "yesterday's session sits after today's walks");
    }
}
