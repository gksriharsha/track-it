//! Kitchen containers: the jars and cans that salt, oil, sugar, ketchup and
//! the rest live in, and what reading them says about cooking by feel.
//!
//! The arithmetic is in `trackit_core::container`; this module stores the
//! history it reads, and `uses` gathers what it is compared against. See that
//! module's header for the reasoning, and `docs/decisions.md` D28.
//!
//! Not shared with the household yet. A container is kitchen-level and would
//! belong in the shared feed, but `row_version` names its tables in a CHECK,
//! and widening that is a table rebuild worth its own change. Until then each
//! device keeps its own containers; cooks a peer shares still count against
//! them, because cooks are shared.

mod uses;
#[cfg(test)]
mod tests;

pub use uses::{
    factor_for, factor_for_line, pantry, record_plate_use, taste_factors, usage_between,
    FoodFactor, FoodUsage, Pantry,
};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use trackit_core::container::{self as calc, EventKind, Known, Measure, Reading, StretchStatus};

use crate::store::{new_id, now_iso, today_iso};

pub const SCHEMA: &str = r#"
-- One physical container in the kitchen: the oil dispenser, the salt jar.
-- Holds one food, which is what the to-taste correction is keyed by, and
-- outlives every pack poured into it.
CREATE TABLE IF NOT EXISTS containers (
  id             TEXT PRIMARY KEY,
  -- What its owner calls it: "oil dispenser", "blue salt jar".
  name           TEXT NOT NULL,
  -- The food it holds: a reference food or one of the user's own, exactly one.
  fdc_id         INTEGER,
  custom_food_id TEXT REFERENCES custom_foods(id),
  -- Denormalised so renaming or deleting the food does not blank the jar.
  description    TEXT NOT NULL,
  -- How its owner reads it day to day: on a scale, in grams with the
  -- container included, or by the marks on its side, in ml of what is
  -- inside. Only the default unit for a reading: any reading may use the
  -- other, and every reading carries its own unit.
  read_by        TEXT NOT NULL DEFAULT 'scale' CHECK (read_by IN ('scale','marks')),
  -- The container weighed empty, when its owner gets round to it. Optional
  -- on purpose: readings of the same container compare without it, and
  -- every reading is stored raw so entering it later completes what waited.
  empty_g        REAL CHECK (empty_g IS NULL OR empty_g > 0),
  -- What it holds when full, by its own marks. Optional; for showing only.
  capacity_ml    REAL CHECK (capacity_ml IS NULL OR capacity_ml > 0),
  -- The owner's measuring cup. Nutrition labels use 240 ml; plenty of
  -- kitchens have 250 ml cups, and a reading in cups is read against this.
  cup_ml         REAL NOT NULL DEFAULT 240 CHECK (cup_ml > 0),
  -- The food's weight per ml, which is what lets an ml reading count in
  -- grams. Resolved when the container is saved, never guessed: from the
  -- pack when it states both, from the reference food's household measures,
  -- or from a cupful the owner weighed. `g_per_ml_note` says which, in words
  -- ("USDA: 1 tbsp is 13.6 g"), because a figure without its source is not
  -- one this app shows.
  g_per_ml        REAL CHECK (g_per_ml IS NULL OR g_per_ml > 0),
  g_per_ml_source TEXT CHECK (g_per_ml_source IS NULL OR g_per_ml_source IN ('label','reference','weighed')),
  g_per_ml_note   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  CHECK ((fdc_id IS NULL) <> (custom_food_id IS NULL)),
  CHECK ((g_per_ml IS NULL) = (g_per_ml_source IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_containers_live ON containers(name) WHERE deleted_at IS NULL;

-- What happened to a container, in order. Never a running level: the level is
-- derived, so deleting a mistaken reading puts the history right by itself.
CREATE TABLE IF NOT EXISTS container_events (
  id           TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES containers(id),
  kind         TEXT NOT NULL CHECK (kind IN ('poured_in','reading','emptied')),
  happened_on  TEXT NOT NULL,          -- ISO date, local
  happened_at  TEXT NOT NULL,          -- instant, so two on one day order
  -- poured_in: what the pack states, net, by weight or by volume.
  -- reading in g: the scale with the container on it, raw.
  -- reading in ml: the marks on its side, which is what is inside.
  -- emptied: a last reading of what was thrown out, either way, or NULL
  -- when it was used to the end.
  amount       REAL CHECK (amount IS NULL OR amount > 0),
  unit         TEXT CHECK (unit IS NULL OR unit IN ('g','ml')),
  -- A reading taken after an accident. The span ending here is discarded.
  spilled      INTEGER NOT NULL DEFAULT 0 CHECK (spilled IN (0,1)),
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  CHECK ((amount IS NULL) = (unit IS NULL)),
  CHECK (kind = 'emptied' OR amount IS NOT NULL),
  CHECK (spilled = 0 OR kind = 'reading')
);
CREATE INDEX IF NOT EXISTS idx_cevents_container ON container_events(container_id, happened_at)
  WHERE deleted_at IS NULL;

-- A container's food added to a plate rather than a pot: ketchup with dosa.
-- The entry itself is an ordinary log entry carrying the grams it was given;
-- this row is what says it came out of a container, and how it was arrived at.
CREATE TABLE IF NOT EXISTS container_uses (
  entry_id   TEXT PRIMARY KEY REFERENCES log_entries(id),
  mode       TEXT NOT NULL CHECK (mode IN ('to_taste','measured')),
  -- For to_taste: the amount the person wrote, and the factor it was
  -- multiplied by when logged. The entry's grams are the product, frozen.
  written_g  REAL CHECK (written_g IS NULL OR written_g > 0),
  factor     REAL CHECK (factor IS NULL OR factor >= 0),
  created_at TEXT NOT NULL,
  CHECK ((mode = 'to_taste') = (written_g IS NOT NULL)),
  CHECK ((mode = 'to_taste') = (factor IS NOT NULL))
);
"#;

/// When something happened, as a fractional local day.
///
/// The instant when it was recorded on the day it happened, so a reading
/// after dinner orders after the dinner. Midday when it was entered for an
/// earlier day, since the time of day it really happened is not known.
pub(crate) fn t_expr(on: &str, at: &str) -> String {
    format!(
        "(CASE WHEN date({at},'localtime') = {on}
               THEN julianday({at},'localtime')
               ELSE julianday({on}) + 0.5 END)"
    )
}

/// A food, as a container and an ingredient line both name it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FoodRef {
    pub fdc_id: Option<i64>,
    pub custom_food_id: Option<String>,
}

impl FoodRef {
    pub fn of(fdc_id: Option<i64>, custom_food_id: Option<&str>) -> Option<FoodRef> {
        match (fdc_id, custom_food_id) {
            (Some(_), None) | (None, Some(_)) => Some(FoodRef {
                fdc_id,
                custom_food_id: custom_food_id.map(str::to_string),
            }),
            _ => None,
        }
    }
    /// The WHERE clause half that selects this food from a table carrying
    /// both columns, aliased `x`.
    pub(crate) fn matches(&self) -> (&'static str, rusqlite::types::Value) {
        match (&self.fdc_id, &self.custom_food_id) {
            (Some(f), _) => ("x.fdc_id = ?1", rusqlite::types::Value::Integer(*f)),
            (None, Some(c)) => ("x.custom_food_id = ?1", rusqlite::types::Value::Text(c.clone())),
            (None, None) => unreachable!("a FoodRef names one food"),
        }
    }
}

/// A food's weight per ml, and where that figure came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Density {
    pub g_per_ml: f64,
    /// `label`, `reference` or `weighed`.
    pub source: String,
    /// The source in words: "USDA: 1 tbsp is 13.6 g".
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerEvent {
    pub id: String,
    /// `poured_in`, `reading` or `emptied`.
    pub kind: String,
    pub happened_on: String,
    pub happened_at: String,
    pub amount: Option<f64>,
    /// `g` or `ml`. A reading in `g` is on the scale, container included; in
    /// `ml` it is off the marks, the food alone.
    pub unit: Option<String>,
    pub spilled: bool,
    pub note: Option<String>,
}

/// A span between two readings, for showing. See `calc::Stretch`.
#[derive(Debug, Clone, Serialize)]
pub struct StretchView {
    pub from_on: String,
    pub to_on: Option<String>,
    pub status: StretchStatus,
    pub used_g: Option<f64>,
    pub used_ml: Option<f64>,
    pub discarded_g: Option<f64>,
    pub days: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Container {
    pub id: String,
    pub name: String,
    pub food: FoodRef,
    pub description: String,
    /// `scale` or `marks`.
    pub read_by: String,
    pub empty_g: Option<f64>,
    pub capacity_ml: Option<f64>,
    pub cup_ml: f64,
    pub density: Option<Density>,
    pub events: Vec<ContainerEvent>,
    pub stretches: Vec<StretchView>,
    /// Its last event was emptying it, and nothing has been poured in since.
    pub finished: bool,
}

/// What a screen sends to add a container or change one.
#[derive(Debug, Clone, Deserialize)]
pub struct ContainerInput {
    pub name: String,
    pub food: FoodRef,
    pub description: String,
    pub read_by: String,
    pub empty_g: Option<f64>,
    pub capacity_ml: Option<f64>,
    pub cup_ml: Option<f64>,
}

fn check_positive(what: &str, g: Option<f64>) -> Result<(), String> {
    match g {
        Some(v) if !(v.is_finite() && v > 0.0) => Err(format!("{what} must be a positive number")),
        _ => Ok(()),
    }
}

/// Add a container, or change one. Changing what food it holds is refused
/// once it has history: those readings were of the old food.
///
/// `density` is resolved by the caller, which can see the reference
/// database; this module never invents one.
pub fn save_container(
    conn: &Connection,
    id: Option<&str>,
    input: &ContainerInput,
    density: Option<&Density>,
) -> Result<String, String> {
    if input.name.trim().is_empty() {
        return Err("a container needs a name".into());
    }
    let food = FoodRef::of(input.food.fdc_id, input.food.custom_food_id.as_deref())
        .ok_or("a container holds exactly one food")?;
    if !matches!(input.read_by.as_str(), "scale" | "marks") {
        return Err("a container is read on a scale or by its marks".into());
    }
    check_positive("the container's empty weight", input.empty_g)?;
    check_positive("what it holds when full", input.capacity_ml)?;
    check_positive("a cup", input.cup_ml)?;
    if let Some(d) = density {
        check_positive("a weight per ml", Some(d.g_per_ml))?;
        if !matches!(d.source.as_str(), "label" | "reference" | "weighed") {
            return Err(format!("“{}” is not a source of a weight per ml", d.source));
        }
    }
    let cup_ml = input.cup_ml.unwrap_or(240.0);
    let now = now_iso(conn)?;
    let (g_per_ml, source, note) = match density {
        Some(d) => (Some(d.g_per_ml), Some(d.source.as_str()), Some(d.note.as_str())),
        None => (None, None, None),
    };
    match id {
        Some(existing) => {
            let held: Option<(Option<i64>, Option<String>)> = conn
                .query_row(
                    "SELECT fdc_id, custom_food_id FROM containers WHERE id=?1 AND deleted_at IS NULL",
                    [existing],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some((fdc, custom)) = held else {
                return Err(format!("container {existing} is not there to update"));
            };
            let has_history: bool = conn
                .query_row(
                    "SELECT EXISTS (SELECT 1 FROM container_events
                                    WHERE container_id=?1 AND deleted_at IS NULL)",
                    [existing],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if has_history && (fdc != food.fdc_id || custom != food.custom_food_id) {
                return Err(
                    "this container already has readings of another food; add a new container \
                     for this one"
                        .into(),
                );
            }
            conn.execute(
                "UPDATE containers SET name=?2, fdc_id=?3, custom_food_id=?4, description=?5,
                    read_by=?6, empty_g=?7, capacity_ml=?8, cup_ml=?9, g_per_ml=?10,
                    g_per_ml_source=?11, g_per_ml_note=?12, updated_at=?13
                 WHERE id=?1",
                rusqlite::params![
                    existing,
                    input.name.trim(),
                    food.fdc_id,
                    food.custom_food_id,
                    input.description,
                    input.read_by,
                    input.empty_g,
                    input.capacity_ml,
                    cup_ml,
                    g_per_ml,
                    source,
                    note,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(existing.to_string())
        }
        None => {
            let id = new_id(conn)?;
            conn.execute(
                "INSERT INTO containers
                   (id,name,fdc_id,custom_food_id,description,read_by,empty_g,capacity_ml,cup_ml,
                    g_per_ml,g_per_ml_source,g_per_ml_note,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)",
                rusqlite::params![
                    id,
                    input.name.trim(),
                    food.fdc_id,
                    food.custom_food_id,
                    input.description,
                    input.read_by,
                    input.empty_g,
                    input.capacity_ml,
                    cup_ml,
                    g_per_ml,
                    source,
                    note,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
    }
}

/// Soft delete. Its history stops counting toward the correction; amounts
/// already given to cooks and plates stay what they were.
pub fn delete_container(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    conn.execute(
        "UPDATE containers SET deleted_at=?2, updated_at=?2 WHERE id=?1 AND deleted_at IS NULL",
        rusqlite::params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// An amount in a unit a person types, as one this table stores: `g` or `ml`.
fn stored(amount: f64, unit: &str, cup_ml: f64) -> Result<(f64, &'static str), String> {
    Ok(match unit {
        "g" => (amount, "g"),
        "kg" => (amount * 1000.0, "g"),
        "ml" => (amount, "ml"),
        "l" | "L" => (amount * 1000.0, "ml"),
        "cup" => (amount * cup_ml, "ml"),
        other => return Err(format!("“{other}” is not a unit a container is read in")),
    })
}

/// Record something that happened to a container.
///
/// `kind` is `poured_in` (the pack's amount), `reading` (on the scale in g or
/// kg, container included; or off the marks in ml, l or cups; `spilled` if
/// it follows an accident) or `emptied` (a last reading if some was thrown
/// out, else no amount).
#[allow(clippy::too_many_arguments)]
pub fn add_event(
    conn: &Connection,
    container_id: &str,
    kind: &str,
    happened_on: &str,
    amount: Option<f64>,
    unit: Option<&str>,
    spilled: bool,
    note: Option<&str>,
) -> Result<String, String> {
    match kind {
        "poured_in" | "reading" if amount.is_none() => {
            return Err(if kind == "poured_in" {
                "pouring in needs the amount on the pack".into()
            } else {
                "a reading needs the figure it reads".into()
            })
        }
        "poured_in" | "reading" | "emptied" => {}
        other => return Err(format!("“{other}” is not something that happens to a container")),
    }
    if spilled && kind != "reading" {
        return Err("a spill is marked on the reading taken after it".into());
    }
    check_positive("the amount", amount)?;
    if !crate::valid_iso_date(happened_on) {
        return Err(format!("“{happened_on}” is not a date"));
    }
    let cup_ml: Option<f64> = conn
        .query_row(
            "SELECT cup_ml FROM containers WHERE id=?1 AND deleted_at IS NULL",
            [container_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(cup_ml) = cup_ml else {
        return Err(format!("container {container_id} is not there"));
    };
    let (amount, unit) = match (amount, unit) {
        (Some(a), Some(u)) => {
            let (a, u) = stored(a, u, cup_ml)?;
            (Some(a), Some(u))
        }
        (Some(_), None) => return Err("an amount needs its unit".into()),
        (None, _) => (None, None),
    };
    let now = now_iso(conn)?;
    // Recorded on the day it happened: now. Entered for another day: midday,
    // the same assumption `t_expr` makes when ordering it.
    let at = if happened_on == today_iso(conn)? {
        now.clone()
    } else {
        format!("{happened_on}T12:00:00Z")
    };
    let id = new_id(conn)?;
    conn.execute(
        "INSERT INTO container_events
           (id,container_id,kind,happened_on,happened_at,amount,unit,spilled,note,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
        rusqlite::params![
            id,
            container_id,
            kind,
            happened_on,
            at,
            amount,
            unit,
            spilled as i64,
            note.map(str::trim).filter(|s| !s.is_empty()),
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn delete_event(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_iso(conn)?;
    conn.execute(
        "UPDATE container_events SET deleted_at=?2, updated_at=?2 WHERE id=?1 AND deleted_at IS NULL",
        rusqlite::params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) struct Row {
    pub id: String,
    pub name: String,
    pub food: FoodRef,
    pub description: String,
    pub read_by: String,
    pub empty_g: Option<f64>,
    pub capacity_ml: Option<f64>,
    pub cup_ml: f64,
    pub density: Option<Density>,
}

pub(crate) fn container_rows(conn: &Connection, food: Option<&FoodRef>) -> Result<Vec<Row>, String> {
    let (filter, bind) = match food {
        Some(f) => {
            let (w, v) = f.matches();
            (format!("AND {w}"), Some(v))
        }
        None => (String::new(), None),
    };
    let mut stmt = conn
        .prepare(&format!(
            "SELECT x.id, x.name, x.fdc_id, x.custom_food_id, x.description, x.read_by, x.empty_g,
                    x.capacity_ml, x.cup_ml, x.g_per_ml, x.g_per_ml_source, x.g_per_ml_note
               FROM containers x WHERE x.deleted_at IS NULL {filter} ORDER BY x.name"
        ))
        .map_err(|e| e.to_string())?;
    let map = |r: &rusqlite::Row<'_>| {
        let g_per_ml: Option<f64> = r.get(9)?;
        let source: Option<String> = r.get(10)?;
        let note: Option<String> = r.get(11)?;
        Ok(Row {
            id: r.get(0)?,
            name: r.get(1)?,
            food: FoodRef {
                fdc_id: r.get(2)?,
                custom_food_id: r.get(3)?,
            },
            description: r.get(4)?,
            read_by: r.get(5)?,
            empty_g: r.get(6)?,
            capacity_ml: r.get(7)?,
            cup_ml: r.get(8)?,
            density: match (g_per_ml, source) {
                (Some(g_per_ml), Some(source)) => Some(Density {
                    g_per_ml,
                    source,
                    note: note.unwrap_or_default(),
                }),
                _ => None,
            },
        })
    };
    let rows = match bind {
        Some(v) => stmt.query_map([v], map),
        None => stmt.query_map([], map),
    }
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// A container's events, in order, with their fractional day.
fn events_of(conn: &Connection, container_id: &str) -> Result<Vec<(ContainerEvent, f64)>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, kind, happened_on, happened_at, amount, unit, spilled, note, {t} AS t
               FROM container_events
              WHERE container_id = ?1 AND deleted_at IS NULL
              ORDER BY t, created_at",
            t = t_expr("happened_on", "happened_at")
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([container_id], |r| {
            Ok((
                ContainerEvent {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    happened_on: r.get(2)?,
                    happened_at: r.get(3)?,
                    amount: r.get(4)?,
                    unit: r.get(5)?,
                    spilled: r.get::<_, i64>(6)? == 1,
                    note: r.get(7)?,
                },
                r.get::<_, f64>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn reading_of(amount: Option<f64>, unit: Option<&str>) -> Option<Reading> {
    match (amount, unit) {
        (Some(a), Some("ml")) => Some(Reading::Marks { ml: a }),
        (Some(a), Some(_)) => Some(Reading::Scale { gross_g: a }),
        _ => None,
    }
}

fn calc_kind(kind: &str, amount: Option<f64>, unit: Option<&str>, spilled: bool) -> EventKind {
    match kind {
        "poured_in" => EventKind::PouredIn {
            amount: match unit {
                Some("ml") => Measure::Ml(amount.unwrap_or(0.0)),
                _ => Measure::Grams(amount.unwrap_or(0.0)),
            },
        },
        "reading" => EventKind::Read {
            reading: reading_of(amount, unit).unwrap_or(Reading::Scale { gross_g: 0.0 }),
            spilled,
        },
        _ => EventKind::Emptied {
            left: reading_of(amount, unit),
        },
    }
}

fn known(row: &Row) -> Known {
    Known {
        tare_g: row.empty_g,
        g_per_ml: row.density.as_ref().map(|d| d.g_per_ml),
    }
}

fn view(s: &calc::Stretch, events: &[(ContainerEvent, f64)]) -> StretchView {
    StretchView {
        from_on: events[s.from_event].0.happened_on.clone(),
        to_on: s.to_event.map(|i| events[i].0.happened_on.clone()),
        status: s.status,
        used_g: s.used_g,
        used_ml: s.used_ml,
        discarded_g: s.discarded_g,
        days: s.to.map(|to| to - s.from),
    }
}

pub(crate) fn build(conn: &Connection, row: Row) -> Result<(Container, Vec<calc::Stretch>), String> {
    let events = events_of(conn, &row.id)?;
    let calc_events: Vec<calc::Event> = events
        .iter()
        .map(|(e, t)| calc::Event {
            t: *t,
            kind: calc_kind(&e.kind, e.amount, e.unit.as_deref(), e.spilled),
        })
        .collect();
    let spans = calc::stretches(&calc_events, known(&row));
    let views = spans.iter().map(|s| view(s, &events)).collect();
    let finished = events.last().is_some_and(|(e, _)| e.kind == "emptied");
    Ok((
        Container {
            id: row.id,
            name: row.name,
            food: row.food,
            description: row.description,
            read_by: row.read_by,
            empty_g: row.empty_g,
            capacity_ml: row.capacity_ml,
            cup_ml: row.cup_ml,
            density: row.density,
            events: events.into_iter().map(|(e, _)| e).collect(),
            stretches: views,
            finished,
        },
        spans,
    ))
}

pub fn list_containers(conn: &Connection) -> Result<Vec<Container>, String> {
    container_rows(conn, None)?
        .into_iter()
        .map(|r| build(conn, r).map(|(c, _)| c))
        .collect()
}

pub fn get_container(conn: &Connection, id: &str) -> Result<Container, String> {
    container_rows(conn, None)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| format!("container {id} is not there"))
        .and_then(|r| build(conn, r).map(|(c, _)| c))
}

/// The span a reading not yet saved would close, as it would read — so the
/// sheet can say "230 ml used since 28 Sep" before anything is stored.
///
/// The reading is taken as happening now, after everything recorded. `None`
/// when it would close nothing (an empty container) or for a pour.
pub fn preview(
    conn: &Connection,
    container_id: &str,
    kind: &str,
    amount: Option<f64>,
    unit: Option<&str>,
    spilled: bool,
) -> Result<Option<StretchView>, String> {
    if kind == "poured_in" {
        return Ok(None);
    }
    let row = container_rows(conn, None)?
        .into_iter()
        .find(|r| r.id == container_id)
        .ok_or_else(|| format!("container {container_id} is not there"))?;
    let (amount, unit) = match (amount, unit) {
        (Some(a), Some(u)) if a.is_finite() && a > 0.0 => {
            let (a, u) = stored(a, u, row.cup_ml)?;
            (Some(a), Some(u))
        }
        _ if kind == "reading" => return Ok(None),
        _ => (None, None),
    };
    let mut events = events_of(conn, &row.id)?;
    let now: f64 = conn
        .query_row("SELECT julianday('now','localtime')", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let t = events.last().map_or(now, |(_, last)| now.max(*last + 1e-6));
    let today = today_iso(conn)?;
    events.push((
        ContainerEvent {
            id: String::new(),
            kind: kind.into(),
            happened_on: today.clone(),
            happened_at: today,
            amount,
            unit: unit.map(str::to_string),
            spilled,
            note: None,
        },
        t,
    ));
    let calc_events: Vec<calc::Event> = events
        .iter()
        .map(|(e, t)| calc::Event {
            t: *t,
            kind: calc_kind(&e.kind, e.amount, e.unit.as_deref(), e.spilled),
        })
        .collect();
    let spans = calc::stretches(&calc_events, known(&row));
    let last = events.len() - 1;
    Ok(spans
        .iter()
        .find(|s| s.to_event == Some(last))
        .map(|s| view(s, &events)))
}
