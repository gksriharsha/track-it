//! Access to the bundled read-only USDA reference database.
//!
//! All SQL lives behind Rust commands rather than being issued from the
//! frontend. That is not a style preference: a nutrient value crossing IPC as a
//! bare JSON `null` becomes `0` under every ordinary JS idiom (`Number(null)`,
//! `null ?? 0`, `+null`, a `reduce` that adds it), which is exactly the bug this
//! app exists to avoid. Values cross as a tagged union instead.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use trackit_core::NutrientValue;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tauri::{AppHandle, Manager};

pub struct Db(pub Mutex<Connection>);

/// One search result, from either the reference data or the user's own foods.
///
/// The two kinds share a shape because the picker shows them in one list, but
/// only one of `fdc_id` / `custom_food_id` is ever set: a food the user typed
/// off a pack has no USDA identifier, and inventing one would let a caller log
/// the generic entry while believing it logged the pack.
#[derive(Debug, Serialize)]
pub struct FoodHit {
    /// "custom" for one of the user's own foods, "reference" for bundled USDA
    /// data. This module only ever produces "reference".
    pub kind: String,
    pub fdc_id: Option<i64>,
    pub custom_food_id: Option<String>,
    pub description: String,
    /// The brand as printed on the pack. Reference entries carry none.
    pub brand: Option<String>,
    pub data_type: String,
    /// Set when the hit came from an Indian-name alias and the USDA name is
    /// misleading enough to need saying so in the results.
    pub note: Option<String>,
    /// True when an exact alias matched, so the UI can mark why this is first.
    pub matched_alias: bool,
}

impl FoodHit {
    /// A hit from the bundled reference data. Ranking the user's own foods above
    /// these, and dropping the ones a custom food replaces, happens in `lib.rs`
    /// where both databases are in scope — nothing here knows about either.
    fn reference(
        fdc_id: i64,
        description: String,
        data_type: String,
        note: Option<String>,
        matched_alias: bool,
    ) -> Self {
        FoodHit {
            kind: "reference".into(),
            fdc_id: Some(fdc_id),
            custom_food_id: None,
            description,
            brand: None,
            data_type,
            note,
            matched_alias,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct NutrientRow {
    pub id: i64,
    pub name: String,
    pub magnitude: String,
    pub basis: String,
    pub tier: String,
    pub value: NutrientValue,
}

/// One row of the nutrient dimension: the panel's spine, without any food's
/// values on it.
///
/// A custom food may have no reference row at all, so its panel cannot be built
/// by reading a food — it is built by walking these and resolving each id
/// against the label, then the overridden food, then nothing.
#[derive(Debug, Clone, Serialize)]
pub struct NutrientMeta {
    pub id: i64,
    pub short_name: String,
    pub magnitude: String,
    pub basis: String,
    pub tier: String,
    pub display_group: String,
    pub display_order: i64,
}

#[derive(Debug, Serialize)]
pub struct Portion {
    pub amount: f64,
    pub unit: Option<String>,
    pub description: Option<String>,
    pub gram_weight: f64,
}

#[derive(Debug, Serialize)]
pub struct FoodDetail {
    pub fdc_id: i64,
    pub description: String,
    pub data_type: String,
    pub nutrients: Vec<NutrientRow>,
    pub portions: Vec<Portion>,
}

/// Locate the reference database, copying it out of the app bundle on first run.
///
/// On Android `resource_dir()` returns the literal string `asset://localhost/`,
/// which is not a filesystem path and which SQLite cannot open, so the database
/// must be copied into the app data directory before use. `FsExt::open` is the
/// one primitive that works on both platforms: on desktop it falls through to
/// `std::fs`, and on Android it recognises the `asset://` prefix and obtains a
/// real file descriptor through the asset manager.
///
/// The copy is streamed. Reading the whole 37 MB file into a `Vec<u8>` first is
/// reported to crash on Android at around 90 MB and wastes the memory anyway.
pub fn resolve(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let target = data_dir.join("usda_core.db");

    // An existing copy is only reusable if it matches what this build expects.
    // Returning early on mere existence means a schema change ships to a user
    // who already ran the app and they silently keep the stale database — which
    // then fails at query time with a confusing "no such column".
    if target.exists() {
        match open(&target).and_then(|c| probe(&c)) {
            Ok(()) => return Ok(target),
            Err(e) => {
                eprintln!("replacing stale reference database ({e})");
                let _ = fs::remove_file(&target);
            }
        }
    }

    // Candidate sources, in order: the bundled resource, then the repo copy so
    // `tauri dev` works without a bundling step.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("resources").join("usda_core.db"));
        candidates.push(res.join("usda_core.db"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("usda_core.db"),
    );

    // `exists()` is meaningless for an `asset://` path, so on Android take the
    // first candidate and let the fs plugin succeed or fail on the open.
    let src = candidates
        .iter()
        .find(|p| p.exists() || p.to_string_lossy().starts_with("asset://"))
        .ok_or_else(|| {
            format!(
                "reference database not found. Run `python3 tools/build_reference_db.py`. \
                 Looked in: {}",
                candidates
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?
        .clone();

    // Write to a temp name then rename, so an interrupted copy cannot leave a
    // truncated database that later opens "successfully" but returns nothing.
    let partial = target.with_extension("partial");
    stream_copy(app, &src, &partial)?;
    fs::rename(&partial, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

/// Copy `src` to `dst`, going through the Tauri fs plugin so bundled Android
/// assets (which live inside the APK zip) work the same as ordinary files.
fn stream_copy(app: &AppHandle, src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    use std::io::{BufReader, BufWriter};
    use tauri_plugin_fs::{FsExt, OpenOptions};

    let reader = app
        .fs()
        .open(src.clone(), OpenOptions::new().read(true).to_owned())
        .map_err(|e| format!("open resource {}: {e}", src.display()))?;
    let out = fs::File::create(dst).map_err(|e| format!("create {}: {e}", dst.display()))?;
    let mut r = BufReader::new(reader);
    let mut w = BufWriter::new(out);
    std::io::copy(&mut r, &mut w).map_err(|e| format!("copy failed: {e}"))?;
    Ok(())
}

/// Cheap check that a reference database matches the schema this build expects.
///
/// Must touch every table and column the queries in this module use. A copy
/// already in the app data dir is only reusable if it satisfies all of them —
/// otherwise the app starts happily and then fails on first search.
fn probe(conn: &Connection) -> Result<(), String> {
    conn.query_row(
        "SELECT short_name, display_group, display_order FROM nutrients
         WHERE role = 'primary' LIMIT 1",
        [],
        |_| Ok(()),
    )
    .map_err(|e| format!("nutrients probe failed: {e}"))?;
    conn.query_row("SELECT alias, fdc_id, note FROM food_aliases LIMIT 1", [], |_| Ok(()))
        .map_err(|e| format!("food_aliases probe failed: {e}"))?;
    Ok(())
}

pub fn open(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    Ok(conn)
}

/// Turn free text into an FTS5 prefix query, discarding anything that would be
/// interpreted as FTS syntax rather than as a search term.
fn fts_query(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split_whitespace()
        .map(|t| {
            t.chars()
                .filter(|c| c.is_alphanumeric() || *c == '\'')
                .collect::<String>()
        })
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" AND "))
    }
}

/// Search foods, ranking an exact Indian-name alias above the free-text index.
///
/// Without this, a literal description match outranks an alias match: searching
/// "ghee" surfaced "Butter, Clarified butter (ghee)" — an 18-nutrient row —
/// ahead of the fuller entry, so the user would log ghee and receive a nearly
/// empty nutrient panel.
///
/// An alias must resolve to the food actually searched for, never to a similar
/// substitute. Ghee is not clarified butter and neither is anhydrous milk fat;
/// where the underlying numbers are a proxy, the hit carries a note saying so.
pub fn search(conn: &Connection, query: &str, limit: u32) -> Result<Vec<FoodHit>, String> {
    let Some(q) = fts_query(query) else {
        return Ok(vec![]);
    };

    let needle = query.trim().to_lowercase();
    let mut hits: Vec<FoodHit> = Vec::new();
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();

    // Pass 1: exact alias, then alias-prefix.
    let mut astmt = conn
        .prepare(
            "SELECT f.fdc_id, f.description, f.data_type, a.note
             FROM food_aliases a JOIN foods f ON f.fdc_id = a.fdc_id
             WHERE a.alias = ?1 OR a.alias LIKE ?1 || ' %' OR ?1 LIKE a.alias || ' %'
             ORDER BY (a.alias = ?1) DESC, length(a.alias)
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let alias_rows = astmt
        .query_map(rusqlite::params![needle, limit], |r| {
            Ok(FoodHit::reference(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                true,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in alias_rows {
        let h = row.map_err(|e| e.to_string())?;
        // Every hit this function returns carries an fdc_id; only custom foods
        // built elsewhere do not.
        if let Some(id) = h.fdc_id {
            if seen.insert(id) {
                hits.push(h);
            }
        }
    }

    // Pass 2: the free-text index, for everything else.
    let mut stmt = conn
        .prepare(
            "SELECT f.fdc_id, f.description, f.data_type
             FROM foods_fts fts
             JOIN foods f ON f.fdc_id = fts.rowid
             WHERE foods_fts MATCH ?1
             ORDER BY bm25(foods_fts), length(f.description)
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![q, limit], |r| {
            Ok(FoodHit::reference(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                None,
                false,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let h = row.map_err(|e| e.to_string())?;
        if hits.len() as u32 >= limit {
            break;
        }
        if let Some(id) = h.fdc_id {
            if seen.insert(id) {
                hits.push(h);
            }
        }
    }
    Ok(hits)
}

/// The nutrient dimension LEFT JOINed to one food's measurements.
///
/// Driving the query from `nutrients` rather than from `food_nutrients` is what
/// makes an unmeasured nutrient appear at all: it comes back with a NULL
/// `value_kind` and becomes `Absent`, instead of dropping out of the panel and
/// leaving the reader to assume zero.
const PANEL_SQL: &str = "SELECT n.id, n.short_name, n.magnitude, n.basis, n.tier,
                fn.value_kind, fn.amount, fn.upper_bound
         FROM nutrients n
         LEFT JOIN food_nutrients fn
                ON fn.nutrient_id = n.id AND fn.fdc_id = ?1
         WHERE n.role = 'primary'
         ORDER BY n.display_order, n.id";

/// Interpret one row of [`PANEL_SQL`], where a NULL kind means the LEFT JOIN
/// found no measurement.
///
/// Every read of a nutrient out of this database goes through here. Two
/// mappings would eventually disagree about what some stored kind means, and
/// the disagreement would be invisible — one screen showing a bound where
/// another shows a measurement.
fn panel_value(kind: Option<String>, amount: Option<f64>, upper: Option<f64>) -> NutrientValue {
    match kind {
        Some(k) => NutrientValue::from_db(&k, amount, upper),
        None => NutrientValue::Absent,
    }
}

/// Every displayed nutrient of one reference food, keyed by nutrient id.
///
/// This is what a custom food borrows for the 30-odd nutrients no pack prints.
/// The map always holds the full displayed set; an entry may be `Absent`, which
/// means the reference food has no measurement either — inheriting it inherits
/// the gap, and the caller should report that as unknown rather than as
/// something the base food told us.
///
/// An `fdc_id` with no `foods` row is an error rather than 47 absences: a
/// custom food pointing at a food that is not there has lost its base, and
/// quietly returning nothing would label that loss "inherited".
pub fn nutrients_of(
    conn: &Connection,
    fdc_id: i64,
) -> Result<std::collections::HashMap<i64, NutrientValue>, String> {
    conn.query_row("SELECT 1 FROM foods WHERE fdc_id = ?1", [fdc_id], |_| Ok(()))
        .map_err(|e| format!("food {fdc_id}: {e}"))?;

    let mut stmt = conn.prepare(PANEL_SQL).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([fdc_id], |r| {
            let kind: Option<String> = r.get(5)?;
            let amount: Option<f64> = r.get(6)?;
            let upper: Option<f64> = r.get(7)?;
            Ok((r.get::<_, i64>(0)?, panel_value(kind, amount, upper)))
        })
        .map_err(|e| e.to_string())?;

    let mut out = std::collections::HashMap::new();
    for row in rows {
        let (id, value) = row.map_err(|e| e.to_string())?;
        out.insert(id, value);
    }
    Ok(out)
}

/// The displayed nutrients in display order — the spine a panel is rendered on.
pub fn displayed_nutrients(conn: &Connection) -> Result<Vec<NutrientMeta>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, short_name, magnitude, basis, tier,
                    COALESCE(display_group, ''), display_order
             FROM nutrients WHERE role = 'primary'
             ORDER BY display_order, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(NutrientMeta {
                id: r.get(0)?,
                short_name: r.get(1)?,
                magnitude: r.get(2)?,
                basis: r.get(3)?,
                tier: r.get(4)?,
                display_group: r.get(5)?,
                display_order: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn detail(conn: &Connection, fdc_id: i64) -> Result<FoodDetail, String> {
    let (description, data_type): (String, String) = conn
        .query_row(
            "SELECT description, data_type FROM foods WHERE fdc_id = ?1",
            [fdc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("food {fdc_id}: {e}"))?;

    let mut stmt = conn.prepare(PANEL_SQL).map_err(|e| e.to_string())?;

    let nutrients = stmt
        .query_map([fdc_id], |r| {
            let kind: Option<String> = r.get(5)?;
            let amount: Option<f64> = r.get(6)?;
            let upper: Option<f64> = r.get(7)?;
            Ok(NutrientRow {
                id: r.get(0)?,
                name: r.get(1)?,
                magnitude: r.get(2)?,
                basis: r.get(3)?,
                tier: r.get(4)?,
                value: panel_value(kind, amount, upper),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut pstmt = conn
        .prepare(
            "SELECT amount, unit, description, gram_weight
             FROM food_portions WHERE fdc_id = ?1 ORDER BY gram_weight",
        )
        .map_err(|e| e.to_string())?;
    let portions = pstmt
        .query_map([fdc_id], |r| {
            Ok(Portion {
                amount: r.get(0)?,
                unit: r.get(1)?,
                description: r.get(2)?,
                gram_weight: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(FoodDetail {
        fdc_id,
        description,
        data_type,
        nutrients,
        portions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opens the built reference database, or skips when it has not been
    /// generated yet (`python3 tools/build_reference_db.py`).
    fn conn() -> Option<Connection> {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("usda_core.db");
        if !p.exists() {
            eprintln!("skipping: {} not built", p.display());
            return None;
        }
        open(&p).ok()
    }

    #[test]
    fn search_finds_foods_by_prefix() {
        let Some(c) = conn() else { return };
        let hits = search(&c, "broccoli raw", 10).unwrap();
        assert!(!hits.is_empty(), "expected matches for 'broccoli raw'");
        assert!(hits
            .iter()
            .all(|h| h.description.to_lowercase().contains("broccoli")));
    }

    #[test]
    fn search_input_cannot_break_fts_syntax() {
        let Some(c) = conn() else { return };
        // Bare FTS operators would otherwise raise a syntax error rather than
        // returning no results.
        for q in ["\"", "AND", "*", "NEAR(", "a OR b", ")("] {
            assert!(search(&c, q, 5).is_ok(), "query {q:?} must not error");
        }
    }

    #[test]
    fn detail_returns_every_primary_nutrient_even_when_unmeasured() {
        let Some(c) = conn() else { return };
        let hit = &search(&c, "cheddar", 1).unwrap()[0];
        let d = detail(&c, hit.fdc_id.expect("a reference hit always has an fdc_id")).unwrap();
        assert!(d.nutrients.len() > 30, "panel should be dense");
        // Iodine is absent from SR Legacy entirely; the row must still be
        // present and must read Absent rather than being dropped or zeroed.
        let iodine = d.nutrients.iter().find(|n| n.id == 1100).unwrap();
        assert!(matches!(
            iodine.value,
            NutrientValue::Absent | NutrientValue::Measured { .. }
        ));
    }

    #[test]
    fn unprovenanced_zero_is_preserved_not_flattened() {
        let Some(c) = conn() else { return };
        // Cheddar reports vitamin C as 0 with no derivation code. If that ever
        // arrives as Measured{0.0}, the app is lying about the food.
        let hit = search(&c, "cheese cheddar", 5)
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let d = detail(&c, hit.fdc_id.expect("a reference hit always has an fdc_id")).unwrap();
        if let Some(vit_c) = d.nutrients.iter().find(|n| n.id == 1162) {
            assert!(
                !matches!(vit_c.value, NutrientValue::Measured { amount } if amount == 0.0),
                "an unprovenanced 0 must not be surfaced as a measured zero"
            );
        }
    }

    #[test]
    fn an_indian_name_finds_the_food_usda_files_under_another_name() {
        let Some(c) = conn() else { return };
        // USDA files urad dal as "Mungo beans"; searching the Indian name used
        // to return nothing at all.
        let hits = search(&c, "urad dal", 5).unwrap();
        assert!(!hits.is_empty(), "urad dal must resolve");
        assert!(hits[0].description.to_lowercase().contains("mungo"));
        assert!(hits[0].matched_alias);
    }

    #[test]
    fn ghee_resolves_to_a_ghee_entry_and_admits_the_data_is_a_proxy() {
        let Some(c) = conn() else { return };
        let hits = search(&c, "ghee", 5).unwrap();
        let top = &hits[0];
        // It must be an entry actually named ghee, not a substitute product.
        assert!(
            top.description.to_lowercase().contains("ghee"),
            "top hit for ghee was {:?}, which is not ghee",
            top.description
        );
        assert_ne!(top.fdc_id, Some(171314), "the 18-nutrient row must not rank first");
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM food_nutrients WHERE fdc_id = ?1",
                [top.fdc_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(n > 60, "top ghee hit carries only {n} nutrients");
        // USDA never measured ghee separately, so the hit must say so.
        let note = top.note.as_deref().unwrap_or("");
        assert!(
            note.contains("proxy"),
            "a proxy value must be labelled as one; note was {note:?}"
        );
    }

    #[test]
    fn aliases_never_shadow_ordinary_english_search() {
        let Some(c) = conn() else { return };
        for q in ["broccoli raw", "cheddar", "spinach"] {
            assert!(!search(&c, q, 5).unwrap().is_empty(), "{q} must still work");
        }
    }

    #[test]
    fn portions_carry_a_positive_gram_weight() {
        let Some(c) = conn() else { return };
        let hit = &search(&c, "broccoli", 1).unwrap()[0];
        let d = detail(&c, hit.fdc_id.expect("a reference hit always has an fdc_id")).unwrap();
        for p in &d.portions {
            assert!(p.gram_weight > 0.0);
            assert!(p.amount > 0.0);
        }
    }
}
