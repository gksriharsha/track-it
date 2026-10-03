//! What a container's food went into, and what that says: the to-taste
//! correction, the kitchen's use over a period, and the pantry screen that
//! leads with both.

use rusqlite::Connection;
use serde::Serialize;
use trackit_core::container::{self as calc, Factor, StretchStatus, Use, UseMode};

use super::{build, container_rows, t_expr, FoodRef};
use crate::store::now_iso;

/// How long the to-taste correction remembers: habits drift.
const WINDOW_DAYS: f64 = 365.0;

/// Every span of every live container holding this food.
fn spans_for(conn: &Connection, food: &FoodRef) -> Result<Vec<Vec<calc::Stretch>>, String> {
    container_rows(conn, Some(food))?
        .into_iter()
        .map(|r| build(conn, r).map(|(_, s)| s))
        .collect()
}

/// Every time this food went into a recorded pot or plate.
///
/// Pots: every live cook's line for the food that was not left out, from any
/// device, since cooks are the household's. Plates: entries logged through a
/// container. A recipe logged straight, without a cook, is not here: it
/// portions a batch nobody recorded making, so there is no pot to count.
fn uses_for(conn: &Connection, food: &FoodRef) -> Result<Vec<Use>, String> {
    let (w, v) = food.matches();
    let mut out = Vec::new();

    let mut stmt = conn
        .prepare(&format!(
            "SELECT {t}, x.to_taste, x.planned_g, x.raw_g
               FROM cook_ingredients x JOIN cooks c ON c.id = x.cook_id
              WHERE c.deleted_at IS NULL AND x.raw_g > 0 AND {w}",
            t = t_expr("c.cooked_on", "c.cooked_at")
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&v], |r| {
            Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?, r.get::<_, f64>(2)?, r.get::<_, f64>(3)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (t, to_taste, planned, raw) = row.map_err(|e| e.to_string())?;
        let mode = if to_taste == 1 && planned > 0.0 {
            UseMode::ToTaste {
                written_g: planned,
                applied_g: raw,
            }
        } else {
            UseMode::Measured { grams: raw }
        };
        out.push(Use { t, mode });
    }

    let mut stmt = conn
        .prepare(&format!(
            "SELECT {t}, u.mode, u.written_g, x.grams
               FROM container_uses u JOIN log_entries x ON x.id = u.entry_id
              WHERE x.deleted_at IS NULL AND x.grams IS NOT NULL AND {w}",
            t = t_expr("x.logged_on", "x.created_at")
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&v], |r| {
            Ok((
                r.get::<_, f64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<f64>>(2)?,
                r.get::<_, f64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (t, mode, written, grams) = row.map_err(|e| e.to_string())?;
        let mode = match (mode.as_str(), written) {
            ("to_taste", Some(w)) => UseMode::ToTaste {
                written_g: w,
                applied_g: grams,
            },
            _ => UseMode::Measured { grams },
        };
        out.push(Use { t, mode });
    }
    Ok(out)
}

fn julian_now(conn: &Connection) -> Result<f64, String> {
    conn.query_row("SELECT julianday('now','localtime')", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// The to-taste correction for one food right now.
///
/// Exactly 1 — the written amount — for a food no container holds, or whose
/// containers have not yet had a span counted.
pub fn factor_for(conn: &Connection, food: &FoodRef) -> Result<Factor, String> {
    let spans = spans_for(conn, food)?;
    if spans.is_empty() {
        return Ok(Factor::AS_WRITTEN);
    }
    let uses = uses_for(conn, food)?;
    let since = julian_now(conn)? - WINDOW_DAYS;
    Ok(calc::taste_factor(&spans, &uses, Some(since)))
}

/// The same, for an ingredient line that may name no food at all.
pub fn factor_for_line(
    conn: &Connection,
    fdc_id: Option<i64>,
    custom_food_id: Option<&str>,
) -> Result<Factor, String> {
    match FoodRef::of(fdc_id, custom_food_id) {
        Some(f) => factor_for(conn, &f),
        None => Ok(Factor::AS_WRITTEN),
    }
}

/// What the person usually writes for this food by feel, over the window:
/// the median of their to-taste amounts. It turns a factor into a sentence
/// about their own cooking — "your 5 g comes to about 6.2 g" — rather than a
/// ratio. `None` when nothing has been written to taste yet.
fn typical_written_g(uses: &[Use], since: f64) -> Option<f64> {
    let mut w: Vec<f64> = uses
        .iter()
        .filter(|u| u.t >= since)
        .filter_map(|u| match u.mode {
            UseMode::ToTaste { written_g, .. } => Some(written_g),
            UseMode::Measured { .. } => None,
        })
        .collect();
    if w.is_empty() {
        return None;
    }
    w.sort_by(f64::total_cmp);
    let mid = w.len() / 2;
    Some(if w.len() % 2 == 1 { w[mid] } else { (w[mid - 1] + w[mid]) / 2.0 })
}

/// One food that some container holds, and its current correction.
#[derive(Debug, Clone, Serialize)]
pub struct FoodFactor {
    pub food: FoodRef,
    pub description: String,
    pub factor: Factor,
    pub typical_written_g: Option<f64>,
}

fn tracked_foods(conn: &Connection) -> Result<Vec<(FoodRef, String)>, String> {
    let mut seen: Vec<(FoodRef, String)> = Vec::new();
    for r in container_rows(conn, None)? {
        if !seen.iter().any(|(f, _)| *f == r.food) {
            seen.push((r.food, r.description));
        }
    }
    Ok(seen)
}

pub fn taste_factors(conn: &Connection) -> Result<Vec<FoodFactor>, String> {
    let since = julian_now(conn)? - WINDOW_DAYS;
    tracked_foods(conn)?
        .into_iter()
        .map(|(food, description)| {
            let factor = factor_for(conn, &food)?;
            let typical_written_g = typical_written_g(&uses_for(conn, &food)?, since);
            Ok(FoodFactor {
                food,
                description,
                factor,
                typical_written_g,
            })
        })
        .collect()
}

/// A food's kitchen use over a period, next to what the cooks and plates
/// recorded. Both at kitchen level: the pot, not anybody's portion of it.
#[derive(Debug, Clone, Serialize)]
pub struct FoodUsage {
    pub food: FoodRef,
    pub description: String,
    /// Days in the period covered by a counted span. Zero means the period
    /// has nothing to say yet, and every per-day figure is `None`.
    pub days: f64,
    pub used_per_day_g: Option<f64>,
    /// The same in ml, when every counted span could say it.
    pub used_per_day_ml: Option<f64>,
    pub recorded_per_day_g: Option<f64>,
}

/// The period `[from, to]`, inclusive local dates, as fractional days.
fn period(conn: &Connection, from: &str, to: &str) -> Result<(f64, f64), String> {
    if !(crate::valid_iso_date(from) && crate::valid_iso_date(to)) {
        return Err("a period runs between two dates".into());
    }
    conn.query_row(
        "SELECT julianday(?1), julianday(?2) + 1",
        [from, to],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|e| e.to_string())
}

fn food_usage(spans: &[Vec<calc::Stretch>], uses: &[Use], a: f64, b: f64, food: FoodRef, description: String) -> FoodUsage {
    let u = calc::usage(spans, uses, a, b);
    FoodUsage {
        food,
        description,
        days: u.days,
        used_per_day_g: u.used_per_day(),
        used_per_day_ml: u.used_ml_per_day(),
        recorded_per_day_g: u.recorded_per_day(),
    }
}

/// Every tracked food's use over `[from, to]`, inclusive local dates.
pub fn usage_between(conn: &Connection, from: &str, to: &str) -> Result<Vec<FoodUsage>, String> {
    let (a, b) = period(conn, from, to)?;
    tracked_foods(conn)?
        .into_iter()
        .map(|(food, description)| {
            let spans = spans_for(conn, &food)?;
            let uses = uses_for(conn, &food)?;
            Ok(food_usage(&spans, &uses, a, b, food, description))
        })
        .collect()
}

/// A container's last reading, or the pack poured in when there is none.
#[derive(Debug, Clone, Serialize)]
pub struct LastFigure {
    /// `reading` or `poured_in`.
    pub kind: String,
    pub amount: f64,
    pub unit: String,
    pub on: String,
}

/// One container as the pantry lists it.
#[derive(Debug, Clone, Serialize)]
pub struct ContainerSummary {
    pub id: String,
    pub name: String,
    pub read_by: String,
    pub cup_ml: f64,
    pub last: Option<LastFigure>,
    /// Why nothing about it counts yet: `tare` (needs its empty weight) or
    /// `density` (needs its food's weight per ml). `None` once a span has
    /// counted, or when there is simply nothing to compare yet.
    pub waiting: Option<&'static str>,
}

/// One food in the pantry: what its containers have shown, then the
/// containers.
#[derive(Debug, Clone, Serialize)]
pub struct PantryFood {
    pub food: FoodRef,
    pub description: String,
    pub factor: Factor,
    pub typical_written_g: Option<f64>,
    pub usage: FoodUsage,
    /// Why the figures are not there yet, when they are not: `tare`,
    /// `density`, `reading` (no span has closed) or `to_taste` (nothing has
    /// been added by feel to compare against).
    pub waiting: Option<&'static str>,
    pub containers: Vec<ContainerSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Pantry {
    pub foods: Vec<PantryFood>,
    /// Containers used up and not yet refilled, kept so their history can be
    /// opened.
    pub finished: Vec<ContainerSummary>,
}

fn summary(c: &super::Container, spans: &[calc::Stretch]) -> ContainerSummary {
    let last = c
        .events
        .iter()
        .rev()
        .find(|e| e.kind == "reading")
        .or_else(|| c.events.iter().rev().find(|e| e.kind == "poured_in"))
        .and_then(|e| {
            Some(LastFigure {
                kind: e.kind.clone(),
                amount: e.amount?,
                unit: e.unit.clone()?,
                on: e.happened_on.clone(),
            })
        });
    let counted = spans.iter().any(|s| s.counts());
    let waiting = if counted {
        None
    } else if spans.iter().any(|s| s.status == StretchStatus::AwaitingTare) {
        Some("tare")
    } else if spans.iter().any(|s| s.status == StretchStatus::AwaitingDensity) {
        Some("density")
    } else {
        None
    };
    ContainerSummary {
        id: c.id.clone(),
        name: c.name.clone(),
        read_by: c.read_by.clone(),
        cup_ml: c.cup_ml,
        last,
        waiting,
    }
}

/// Everything the pantry screen shows, over the period `[from, to]`.
pub fn pantry(conn: &Connection, from: &str, to: &str) -> Result<Pantry, String> {
    let (a, b) = period(conn, from, to)?;
    let since = julian_now(conn)? - WINDOW_DAYS;
    let mut foods: Vec<PantryFood> = Vec::new();
    let mut finished = Vec::new();

    for (food, description) in tracked_foods(conn)? {
        let built = container_rows(conn, Some(&food))?
            .into_iter()
            .map(|r| build(conn, r))
            .collect::<Result<Vec<_>, _>>()?;
        let spans: Vec<Vec<calc::Stretch>> = built.iter().map(|(_, s)| s.clone()).collect();
        let uses = uses_for(conn, &food)?;
        let factor = calc::taste_factor(&spans, &uses, Some(since));
        let typical = typical_written_g(&uses, since);
        let usage = food_usage(&spans, &uses, a, b, food.clone(), description.clone());

        let mut open = Vec::new();
        for (c, s) in &built {
            if c.finished {
                finished.push(summary(c, s));
            } else {
                open.push(summary(c, s));
            }
        }
        if open.is_empty() {
            continue;
        }
        let closed = spans.iter().flatten().any(|s| s.to.is_some());
        let waiting = if factor.is_counted() {
            None
        } else if let Some(w) = open.iter().find_map(|c| c.waiting) {
            Some(w)
        } else if !closed {
            Some("reading")
        } else if typical.is_none() {
            Some("to_taste")
        } else {
            None
        };
        foods.push(PantryFood {
            food,
            description,
            factor,
            typical_written_g: typical,
            usage,
            waiting,
            containers: open,
        });
    }
    Ok(Pantry { foods, finished })
}

/// Mark an entry just written as having come out of a container. Called in
/// the same transaction as the entry, so the two exist together or not at all.
pub fn record_plate_use(
    conn: &Connection,
    entry_id: &str,
    to_taste: Option<(f64, f64)>,
) -> Result<(), String> {
    let now = now_iso(conn)?;
    let (mode, written, factor) = match to_taste {
        Some((w, f)) => ("to_taste", Some(w), Some(f)),
        None => ("measured", None, None),
    };
    conn.execute(
        "INSERT INTO container_uses (entry_id,mode,written_g,factor,created_at)
         VALUES (?1,?2,?3,?4,?5)",
        rusqlite::params![entry_id, mode, written, factor, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
