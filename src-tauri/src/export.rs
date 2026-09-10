//! Handing the log back to the person who kept it, as a file they own.
//!
//! Two halves, and the split is the whole design. [`export_log`] decides every
//! NUMBER, out of what each entry was frozen with; `src/lib/exportSheet.ts`
//! decides every COLUMN, out of the same `LABEL_NUTRIENTS` list the importer's
//! own header matcher is built from. That is what makes a file this app writes
//! a file this app can read back — not a coincidence to be re-checked by hand
//! each time, but a property of where each decision is made.
//!
//! The reference database is not opened here, and that is deliberate rather
//! than incidental: an export of March must still say what March said after a
//! pack was reformulated in June, so there is no path through this module that
//! could value an entry against today's data. `entry_snapshots` and its
//! children are the only source. An entry that somehow has no snapshot is
//! COUNTED and left out, never resolved on the way past — freezing on sight is
//! `collect_day`'s business, at startup, where valuing an old entry from
//! today's data at least happens once and is recorded as `backfilled`. Doing it
//! from an export would make reading a file a write to history.
//!
//! Putting the bytes on disk is the other job, and the two platforms differ
//! completely. The Mac gets a native save panel through `tauri-plugin-dialog`.
//! Android gets the Storage Access Framework, asked for directly by
//! `ExportPlugin.kt` in the Android source set — which is also why the dialog
//! plugin is scoped out of the Android build in Cargo.toml. See the note there.

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;
use trackit_core::aggregate::{sum, Contribution, DailyTotal};
use trackit_core::NutrientValue;

use crate::store;

/// The fifteen figures a US nutrition panel prints, in the order it prints
/// them.
///
/// This is the importer's vocabulary, not a choice made here: the same fifteen
/// ids in the same order are `LABEL_NUTRIENTS` in src/types.ts, which is where
/// `matchHeader` builds its column lookup from, and the writer names its
/// columns from that list rather than from anything sent across the boundary.
/// So the two lists have to agree, and the way they are held to it is a test on
/// each side rather than a comment: `every_label_nutrient_reaches_the_file`
/// below fails if this list loses one, and `buildExportFile` throws on an id
/// the label list cannot name if this one gains one. A column the importer
/// cannot place is worse than a refused export, and a nutrient that silently
/// stops appearing is worse than either.
const EXPORT_NUTRIENTS: [i64; 15] = [
    1008, 1004, 1258, 1257, 1253, 1093, 1005, 1079, 2000, 1235, 1003, 1114, 1087, 1089, 1092,
];

/// How large a payload this will put on disk in one go.
///
/// A bound on an untrusted command argument rather than a product limit — a
/// year of a person's own eating is a few hundred kilobytes, and nothing a real
/// log can produce comes near this. It is here because `data_base64` arrives
/// from the webview and a size assertion belongs on the writing side.
const MAX_EXPORT_BYTES: usize = 16 * 1024 * 1024;

/// One nutrient of one exported entry, in that nutrient's own unit and already
/// rounded to what the file will carry.
///
/// A nutrient the entry is not exactly known for is not in the list at all. It
/// is never a zero and never the lower bound of an interval — see
/// [`exact_amount`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportNutrient {
    pub nutrient_id: i64,
    pub amount: f64,
}

/// One food entry as one row of the sheet the importer reads back.
///
/// `meal` is a plain `String` and not an `Option`: `log_entries` carries
/// `CHECK ((source_kind = 'water') = (meal IS NULL))` (store.rs), so every
/// entry that is not water names a sitting, and water is not on this sheet.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportLogRow {
    pub logged_on: String,
    pub meal: String,
    pub description: String,
    /// Only the nutrients this entry is exactly known for. A nutrient missing
    /// from here becomes a BLANK cell, which the parser reads as "not tracked".
    pub nutrients: Vec<ExportNutrient>,
}

/// One dose, on a sheet the importer never looks at.
///
/// Kept out of the log sheet on purpose. `parseSpreadsheet` reads
/// `workbook.SheetNames[0]` and nothing else, so a supplement cannot be read
/// back as a 100 g food — which is exactly what `import_one_row` would make of
/// it, and a tablet's nutrients did not arrive in proportion to its weight.
/// See `docs/decisions.md` D12.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportDoseRow {
    pub logged_on: String,
    pub meal: String,
    pub description: String,
    /// Counted in the supplement's own unit noun — tablets, capsules, gummies.
    /// Never a mass.
    pub units: f64,
    pub nutrients: Vec<ExportNutrient>,
}

/// One bottle finished, on a sheet the importer never looks at either.
///
/// Water is drunk across the whole day and belongs to no meal, so it could not
/// go on the log sheet even if the nutrition were worth carrying: the row would
/// have to name a sitting.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportWaterRow {
    pub logged_on: String,
    pub description: String,
    /// What was drunk, in millilitres.
    ///
    /// Note where this comes from. Unlike every other figure in this file it is
    /// not out of the snapshot: the grams are frozen on the entry but the
    /// conversion belongs to the bottle, and `store::day` applies the bottle's
    /// registered weights as they stand today — see `LogEntry::water`. So
    /// re-registering a bottle moves a past figure here exactly as it moves it
    /// on the day screen. That is the app's existing behaviour, said out loud
    /// rather than quietly inherited.
    pub ml: f64,
    /// False when the millilitres came from the density of water rather than
    /// from this bottle's own two weighings. Carried into the file for the same
    /// reason it is carried on screen — see `trackit_core::water::Volume`.
    pub measured: bool,
}

/// Everything one export covers, decided.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportLog {
    pub from: String,
    pub to: String,
    /// Days in the period that have anything logged at all.
    pub days: usize,
    pub rows: Vec<ExportLogRow>,
    pub doses: Vec<ExportDoseRow>,
    pub water: Vec<ExportWaterRow>,
    /// How many (entry, nutrient) pairs were left blank because the entry's
    /// frozen value for that nutrient was not exactly known.
    ///
    /// Shown on the screen so the gaps in the file are stated before it is
    /// written rather than found in a spreadsheet a month later.
    pub blanks: usize,
    /// Food entries carrying no exactly-known nutrient at all.
    ///
    /// Written out anyway: the file is a record for a person first, and a row
    /// naming what was eaten on a day is worth having even with every figure
    /// blank. On the way back in the importer reports each of them and writes
    /// nothing, which is the right answer on both sides — a 100 g entry with no
    /// values would actively lower that day's coverage.
    pub rows_without_values: usize,
    /// Live entries with no frozen nutrition, which this leaves out.
    ///
    /// Normally zero — startup freezes anything unfrozen. It is counted rather
    /// than repaired here because repairing it means valuing an old entry
    /// against today's reference data, and an export must not be the thing that
    /// does that.
    pub unexportable: usize,
}

/// The one number a spreadsheet cell can hold, or `None` when this entry's
/// value for this nutrient is not exactly known.
///
/// A cell is written only when every component contributed a definite value.
/// A recipe where fourteen ingredients know their added sugars and one does not
/// has a partial sum that is SMALLER than the truth, and printing it as the
/// truth is the exact failure `NutrientValue` exists to prevent — one level up,
/// in a file that will be summed by whoever opens it. A spreadsheet cell cannot
/// hold an interval, so the honest cell is an empty one; the parser already
/// reads a blank as "not tracked", never as a zero. See `docs/decisions.md` D17.
///
/// Exact equality between the bounds is correct here rather than careless.
/// `sum` accumulates `lower` and `upper` in one pass over the same slice,
/// adding the same expression in the same order for every kind whose bounds
/// coincide, so either they are bitwise equal or the interval is real. An
/// epsilon would let a genuine `Trace` with a tiny upper bound through as a
/// measurement.
fn exact_amount(total: &DailyTotal) -> Option<f64> {
    // No contributions at all is not a zero, and it is reachable: an entry
    // whose snapshot has no components has nothing to say about any nutrient,
    // and `sum` of an empty slice is `lower: 0.0, upper: Some(0.0)` — which
    // would otherwise print fifteen confident zeroes.
    if total.items_total == 0 {
        return None;
    }
    match total.upper {
        Some(upper) if upper == total.lower && upper.is_finite() => Some(upper),
        _ => None,
    }
}

/// Three decimals, in the nutrient's own unit.
///
/// Vitamin D is printed in micrograms and sodium in milligrams, so three
/// decimals is already an order of magnitude finer than any pack this app has
/// read. It costs sub-milli precision once, on the first generation: re-export
/// an imported file and the figures are already rounded, so from there the
/// cycle is exact. The FILE is the authority, which is the round-trip property
/// worth having.
fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// One entry's frozen contributions to each of the fifteen, keyed by nutrient.
///
/// The rule worth stating: a nutrient with no frozen row is
/// [`NutrientValue::Absent`]. At the moment the entry was logged nothing knew a
/// value for it, and absence is stored as the absence of a row — in the
/// snapshot exactly as in `food_nutrients`. That is a gap the file reports as
/// a blank, never a zero it counts. `collect_day` states the same rule for the
/// day screen; the two must not drift.
fn frozen_contributions(snap: &store::Snapshot) -> HashMap<i64, Vec<Contribution>> {
    let mut by_nutrient: HashMap<i64, Vec<Contribution>> = HashMap::new();
    for component in &snap.components {
        let values: HashMap<i64, NutrientValue> = component.values.iter().cloned().collect();
        for id in EXPORT_NUTRIENTS {
            let value = values.get(&id).cloned().unwrap_or(NutrientValue::Absent);
            by_nutrient
                .entry(id)
                .or_default()
                .push(match component.quantity {
                    store::SnapQuantity::Grams(grams) => Contribution::Food { value, grams },
                    store::SnapQuantity::Servings(units) => Contribution::Dose { value, units },
                });
        }
    }
    by_nutrient
}

/// The cells one entry can fill, in the label's own column order, with every
/// blank counted as it is left.
///
/// The order matters beyond tidiness. The writer lays the columns out in
/// `LABEL_NUTRIENTS` order and the parser reads them back in the order it found
/// them, so a row that comes out of this in the same order is a row that can be
/// compared to its re-imported self field for field.
fn exported_nutrients(snap: &store::Snapshot, blanks: &mut usize) -> Vec<ExportNutrient> {
    let by_nutrient = frozen_contributions(snap);
    let mut out = Vec::new();
    for id in EXPORT_NUTRIENTS {
        let amount = by_nutrient.get(&id).and_then(|cs| exact_amount(&sum(cs)));
        match amount {
            Some(amount) => out.push(ExportNutrient {
                nutrient_id: id,
                amount: round3(amount),
            }),
            None => *blanks += 1,
        }
    }
    out
}

/// A period that runs backwards is a mistake, not an empty file.
///
/// The sentence is the one `get_range` already hands back for the same
/// mistake — two screens must not disagree about a backwards period.
fn check_period(from: &str, to: &str) -> Result<(), String> {
    if from > to {
        return Err("the start of the range must not be after its end".into());
    }
    Ok(())
}

/// Walk the period and build the whole payload out of frozen nutrition.
///
/// Split from the command so the tests exercise THIS rather than a second copy
/// of it: `State` cannot be constructed outside a running app, and a test that
/// re-implements the assembly proves only that two versions of the same bug
/// agree.
fn assemble(conn: &rusqlite::Connection, from: &str, to: &str) -> Result<ExportLog, String> {
    let days = store::logged_days_between(conn, from, to)?;

    let mut out = ExportLog {
        from: from.to_string(),
        to: to.to_string(),
        days: days.len(),
        rows: Vec::new(),
        doses: Vec::new(),
        water: Vec::new(),
        blanks: 0,
        rows_without_values: 0,
        unexportable: 0,
    };

    for day in &days {
        // Two statements a day rather than two an entry, the same shape
        // `collect_day` uses. A year is then a few hundred queries against an
        // indexed column, comparable to opening a twelve-month period in
        // History, which nobody has found slow.
        let entries = store::day(conn, &day.date)?;
        let snapshots = store::day_snapshots(conn, &day.date)?;

        for entry in &entries {
            // Water first, because it is the one row whose figure does not come
            // out of a snapshot and the one entry with no meal to name.
            if entry.source_kind == "water" {
                let Some(volume) = entry.water else {
                    // A water entry whose bottle has gone is a row this cannot
                    // put a volume against, and deriving one from the grams
                    // would assert a calibration that no longer exists.
                    out.unexportable += 1;
                    continue;
                };
                out.water.push(ExportWaterRow {
                    logged_on: entry.logged_on.clone(),
                    description: entry.description.clone(),
                    ml: round3(volume.ml()),
                    measured: volume.is_measured(),
                });
                continue;
            }

            // Both are unreachable in a database this app wrote — startup
            // freezes anything unfrozen, and the `meal` CHECK makes a mealless
            // non-water entry impossible — and both are counted rather than
            // papered over. Resolving the first would value an old entry
            // against today's reference data; defaulting the second to "snack"
            // would put a figure on a sitting the user never named.
            let (Some(snap), Some(meal)) = (snapshots.get(&entry.id), entry.meal.clone()) else {
                out.unexportable += 1;
                continue;
            };
            let nutrients = exported_nutrients(snap, &mut out.blanks);

            if entry.source_kind == "supplement" {
                out.doses.push(ExportDoseRow {
                    logged_on: entry.logged_on.clone(),
                    meal,
                    description: entry.description.clone(),
                    // Every supplement row stores a count; the fallback is the
                    // same unreachable shape as the two above.
                    units: entry.units.unwrap_or(0.0),
                    nutrients,
                });
                continue;
            }

            if nutrients.is_empty() {
                out.rows_without_values += 1;
            }
            out.rows.push(ExportLogRow {
                logged_on: entry.logged_on.clone(),
                meal,
                description: entry.description.clone(),
                nutrients,
            });
        }
    }

    Ok(out)
}

/// Assemble the log for a period out of what each entry was FROZEN with.
///
/// Takes no reference database, which is the point: there is nothing in scope
/// here that could re-value an entry, so "an export of March says what March
/// said" is a property of the signature rather than a promise in a comment.
#[tauri::command]
pub fn export_log(
    from: String,
    to: String,
    user: State<'_, store::Store>,
) -> Result<ExportLog, String> {
    check_period(&from, &to)?;
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    assemble(&conn, &from, &to)
}

/// The extension the file gets and the dialog filters on.
///
/// Two kinds, named rather than sniffed: the frontend chose one of them by
/// pressing a button, so anything else is a bug on this app's own wire and
/// deserves a sentence rather than a guess.
fn export_extension(kind: &str) -> Result<&'static str, String> {
    match kind {
        "xlsx" => Ok("xlsx"),
        "csv" => Ok("csv"),
        other => Err(format!(
            "“{other}” is not a file this app writes — a spreadsheet or a csv"
        )),
    }
}

/// What the Storage Access Framework should be told the document is.
///
/// Sent as a MIME type rather than an extension because that is what the
/// Android picker wants: `MimeTypeMap` does not know `xlsx` on most API levels,
/// and a picker handed one falls back to `*/*` — which saves the file but
/// suggests nothing about it.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn export_mime(ext: &str) -> &'static str {
    match ext {
        "csv" => "text/csv",
        _ => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
}

/// A name a save panel will accept, ending in the right extension.
///
/// The suggestion is composed by the frontend out of two dates, so in practice
/// it is already tame. It is cleaned anyway, for the reason every other input
/// from the webview is: a separator or a control character in `EXTRA_TITLE`
/// would be a document named something other than what the user was shown, and
/// on the desktop side a path fragment in a file NAME is a file written
/// somewhere nobody asked for.
fn safe_file_name(suggested: &str, ext: &str) -> Result<String, String> {
    let swept: String = suggested
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':') {
                ' '
            } else {
                c
            }
        })
        .collect();
    // Runs of whitespace collapse, and then every leading dot and space goes
    // together rather than one kind after the other: "../../etc/passwd" becomes
    // ".. .. etc passwd" at that point, and stripping only dots would leave a
    // name beginning " .. etc". Neither "." nor ".." can survive as a name in
    // its own right, which is the point of doing this at all.
    let stem = swept
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_start_matches(|c: char| c == '.' || c == ' ')
        .trim()
        .to_string();
    if stem.is_empty() {
        return Err("a file needs a name".into());
    }
    if stem.to_lowercase().ends_with(&format!(".{ext}")) {
        Ok(stem)
    } else {
        Ok(format!("{stem}.{ext}"))
    }
}

/// Put an already-encoded export wherever the platform's own save panel is
/// pointed.
///
/// `async` on purpose, and not for tidiness. Tauri runs a synchronous command
/// on the main thread, and both platforms would deadlock there: the desktop
/// panel is shown BY the main thread and waited on by the caller
/// (`tauri-plugin-dialog`'s `blocking_save_file` says so in its own doc), and
/// the Android picker needs the main thread to pump its activity result while
/// this call is still waiting for it.
///
/// `Ok(None)` means nothing was written. On the desktop that is the user
/// closing the panel; on Android the picker may also simply have gone away. The
/// screen therefore says nothing was written rather than claiming the user
/// cancelled, which is a claim this cannot make.
#[tauri::command]
pub async fn save_exported_file(
    app: tauri::AppHandle,
    suggested_name: String,
    kind: String,
    data_base64: String,
) -> Result<Option<String>, String> {
    let ext = export_extension(&kind)?;
    let name = safe_file_name(&suggested_name, ext)?;
    // `b64_decode`'s own refusal names a photo, which is the only other thing
    // this app moves as base64. Rewording it here is cheaper than
    // re-parameterising a function four other tests already call, and the
    // decoder has exactly one failure to report.
    let bytes = crate::b64_decode(&data_base64)
        .map_err(|_| "that file did not arrive as valid base64".to_string())?;
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err(format!(
            "that export came to {} MB, which is more than this writes in one file",
            bytes.len() / (1024 * 1024)
        ));
    }
    save_bytes(&app, &name, ext, &bytes)
}

/// The desktop half: a native save panel, then an ordinary file write.
///
/// The panel always hands back `FilePath::Path` here — `rfd` deals in paths and
/// the plugin converts one straight through — but it is taken through
/// `into_path` regardless, so a future platform that answers with a `file://`
/// URL does not silently lose the write.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn save_bytes<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let chosen = app
        .dialog()
        .file()
        .set_file_name(name)
        // An extension, not a MIME type: `rfd` puts what it is given straight
        // on the end of the file, so a MIME string here produces a document
        // called "… .application/vnd.openxmlformats-officedocument…".
        .add_filter("Spreadsheet", &[ext])
        .blocking_save_file();
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|e| format!("reading the chosen location: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("writing {}: {e}", path.display()))?;
    // The name, not the path. A full path in the app's own serif is unreadable
    // and spends a typographic signal reserved for figures worth dwelling on;
    // the person has just chosen the folder, so they know where it went.
    Ok(Some(
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| name.to_string()),
    ))
}

/// The Android half: `ACTION_CREATE_DOCUMENT`, asked for by `ExportPlugin.kt`.
#[cfg(target_os = "android")]
fn save_bytes<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<Option<String>, String> {
    android::save_document(app, name, export_mime(ext), bytes)
}

/// Nothing on iOS, said out loud. An `Ok(None)` here would read as "you closed
/// the panel" for a panel that never opened.
#[cfg(target_os = "ios")]
fn save_bytes<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _name: &str,
    _ext: &str,
    _bytes: &[u8],
) -> Result<Option<String>, String> {
    Err("saving a file on this device is not supported yet".into())
}

/// The Android bridge, in the same shape as `vision::android`: a Kotlin class in
/// the app's own source set, registered from here by name.
///
/// No Gradle change and no new subproject — which is the reason this is
/// hand-written rather than taken from `tauri-plugin-dialog`. The two files that
/// would have had to carry a plugin AAR, `gen/android/tauri.settings.gradle` and
/// `gen/android/app/tauri.build.gradle.kts`, are generated by the Tauri CLI and
/// are not in the repository at all.
#[cfg(target_os = "android")]
mod android {
    use serde::Deserialize;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    /// The application id, which is also the Kotlin package the class sits in.
    const PLUGIN_IDENTIFIER: &str = "com.kgundu1.trackit";

    pub(super) struct AndroidExport<R: Runtime>(PluginHandle<R>);

    /// What the Kotlin side answers with. `name` is the document's own display
    /// name as the provider reports it — which is not necessarily the name that
    /// was suggested, because the Storage Access Framework silently makes a
    /// second export of the same period into "… (1).xlsx".
    #[derive(Deserialize)]
    struct SavedDocument {
        name: Option<String>,
    }

    pub(super) fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("export")
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "ExportPlugin")?;
                app.manage(AndroidExport(handle));
                Ok(())
            })
            .build()
    }

    pub(super) fn save_document<R: Runtime>(
        app: &AppHandle<R>,
        name: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<Option<String>, String> {
        let saved = app
            .state::<AndroidExport<R>>()
            .0
            .run_mobile_plugin::<SavedDocument>(
                "saveDocument",
                serde_json::json!({
                    "name": name,
                    "mime": mime,
                    "dataBase64": crate::b64_encode(bytes),
                }),
            )
            .map_err(|e| format!("that file could not be saved: {e}"))?;
        Ok(saved.name)
    }
}

/// Registered only for Android, exactly as `vision::init` is: the Kotlin class
/// lives in the Android source set, so a desktop bundle carries none of it.
#[cfg(target_os = "android")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    android::init()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::PathBuf;

    /// A Hershey's-sized bar, the serving the label features were built around.
    const BAR: f64 = 43.0;
    const DAY: &str = "2026-09-04";

    /// The bundled reference database, or `None` when it has not been built yet
    /// (`python3 tools/build_reference_db.py`).
    ///
    /// Only the FIXTURES need it — freezing an entry is what consults reference
    /// data. The export path itself never opens it, which is half of what these
    /// tests are here to hold in place.
    fn refdb() -> Option<Connection> {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("usda_core.db");
        if !p.exists() {
            eprintln!("skipping: {} not built", p.display());
            return None;
        }
        crate::db::open(&p).ok()
    }

    /// An empty user database in the shape this build expects. The last two
    /// calls are not decoration — see the same helper in lib.rs.
    fn user_db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(store::SCHEMA).unwrap();
        store::ensure_device_identity(&c).unwrap();
        store::install_sync_triggers(&c).unwrap();
        c
    }

    fn nutrient(
        id: i64,
        kind: &str,
        amount: Option<f64>,
        upper: Option<f64>,
    ) -> store::CustomNutrient {
        store::CustomNutrient {
            nutrient_id: id,
            kind: kind.into(),
            amount,
            upper,
        }
    }

    /// A transcribed pack whose panel is whatever the test wants it to be.
    fn pack(name: &str, nutrients: Vec<store::CustomNutrient>) -> store::CustomFood {
        store::CustomFood {
            id: String::new(),
            name: name.into(),
            brand: None,
            overrides_fdc_id: None,
            serving_g: BAR,
            serving_label: Some("1 bar (43 g)".into()),
            ingredients: None,
            barcode: None,
            photo_label: None,
            photo_ingredients: None,
            nutrients,
            import_only: false,
        }
    }

    fn saved(conn: &mut Connection, f: &store::CustomFood) -> String {
        store::save_custom_food(conn, None, f).unwrap()
    }

    /// Log `grams` of a transcribed food, frozen at what the pack says now.
    fn eat(refconn: &Connection, conn: &mut Connection, food_id: &str, name: &str, grams: f64) {
        crate::add_frozen(
            refconn,
            conn,
            DAY,
            Some("snack"),
            store::Source::Custom(food_id),
            name,
            store::Quantity::Grams(grams),
            None,
            &store::Tags::default(),
        )
        .unwrap();
    }

    fn amount_of(row: &ExportLogRow, id: i64) -> Option<f64> {
        row.nutrients
            .iter()
            .find(|n| n.nutrient_id == id)
            .map(|n| n.amount)
    }

    /// The immutability claim, which is the whole reason this reads snapshots.
    /// Re-transcribe the pack after the fact and the exported figure must not
    /// move an inch.
    #[test]
    fn an_entry_exports_the_figure_it_was_frozen_with_and_not_todays() {
        let Some(rc) = refdb() else { return };
        let mut uc = user_db();
        let food = saved(
            &mut uc,
            &pack(
                "Milk chocolate bar",
                vec![nutrient(1004, "measured", Some(13.0), None)],
            ),
        );
        eat(&rc, &mut uc, &food, "Milk chocolate bar", 2.0 * BAR);

        let before = assemble(&uc, DAY, DAY).unwrap();
        assert_eq!(before.rows.len(), 1);
        assert_eq!(
            amount_of(&before.rows[0], 1004),
            Some(26.0),
            "two 13 g bars are 26 g of fat"
        );

        // The manufacturer reformulates, and the user re-transcribes the pack.
        let mut changed = store::get_custom_food(&uc, &food).unwrap();
        changed.nutrients = vec![nutrient(1004, "measured", Some(99.0), None)];
        store::save_custom_food(&mut uc, Some(&food), &changed).unwrap();

        let after = assemble(&uc, DAY, DAY).unwrap();
        assert_eq!(
            after.rows, before.rows,
            "the export follows the snapshot, never the pack"
        );
    }

    /// The drift guard, in the direction that actually goes wrong.
    ///
    /// [`EXPORT_NUTRIENTS`] and `LABEL_NUTRIENTS` in src/types.ts are one list
    /// held in two languages, and the failure worth catching is Rust's copy
    /// shrinking or reordering: delete potassium from it and every export from
    /// then on carries a blank potassium column, every re-import silently loses
    /// the nutrient, and nothing anywhere goes red. The first version of this
    /// test built its fixture FROM the constant it then asserted against, so it
    /// held for any subset in any order — a test that could not fail.
    ///
    /// So the assertion reads the OTHER language's list off disk. That makes
    /// the two files structurally unable to disagree without a red test, which
    /// is the only guard worth having across a boundary neither compiler sees.
    /// A parse that finds nothing is itself a failure: this test refusing to
    /// run quietly would put us straight back where we started.
    #[test]
    fn the_two_label_lists_cannot_drift_apart() {
        let ts = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("types.ts");
        let src = std::fs::read_to_string(&ts)
            .unwrap_or_else(|e| panic!("reading {}: {e}", ts.display()));
        let list = src
            .split_once("export const LABEL_NUTRIENTS")
            .and_then(|(_, rest)| rest.split_once("];"))
            .map(|(body, _)| body)
            .expect("LABEL_NUTRIENTS is no longer declared in src/types.ts");
        let ids: Vec<i64> = list
            .match_indices("{ id:")
            .filter_map(|(at, _)| {
                list[at + 5..]
                    .split(',')
                    .next()?
                    .trim()
                    .parse::<i64>()
                    .ok()
            })
            .collect();
        assert_eq!(
            ids.len(),
            EXPORT_NUTRIENTS.len(),
            "src/types.ts declares {} label nutrients and export.rs writes {}",
            ids.len(),
            EXPORT_NUTRIENTS.len()
        );
        assert_eq!(
            ids,
            EXPORT_NUTRIENTS.to_vec(),
            "the columns this file writes are no longer the columns the \
             importer knows how to place"
        );
    }

    /// The other half of the same guard: a food that knows all fifteen fills
    /// fifteen cells, in the label's own order.
    #[test]
    fn every_label_nutrient_reaches_the_file_in_the_labels_own_order() {
        let Some(rc) = refdb() else { return };
        let mut uc = user_db();
        let all = EXPORT_NUTRIENTS
            .iter()
            .enumerate()
            .map(|(i, id)| nutrient(*id, "measured", Some(1.0 + i as f64), None))
            .collect();
        let food = saved(&mut uc, &pack("Fully declared bar", all));
        eat(&rc, &mut uc, &food, "Fully declared bar", BAR);

        let log = assemble(&uc, DAY, DAY).unwrap();
        let ids: Vec<i64> = log.rows[0]
            .nutrients
            .iter()
            .map(|n| n.nutrient_id)
            .collect();
        assert_eq!(ids, EXPORT_NUTRIENTS.to_vec(), "all fifteen, in order");
        assert_eq!(log.blanks, 0, "nothing was left blank");
        assert_eq!(log.rows_without_values, 0);
    }

    /// A value that is only bounded is not a number, and a cell holding its
    /// lower bound is a lie a spreadsheet will happily sum.
    #[test]
    fn a_nutrient_that_is_not_exactly_known_gets_no_cell_at_all() {
        let Some(rc) = refdb() else { return };
        let mut uc = user_db();
        let food = saved(
            &mut uc,
            &pack(
                "Milk chocolate bar",
                vec![
                    nutrient(1004, "measured", Some(13.0), None),
                    // The pack declares 0 mg of sodium, which 21 CFR 101.9
                    // permits anywhere below 5 mg.
                    nutrient(1093, "label_zero", None, Some(5.0)),
                ],
            ),
        );
        eat(&rc, &mut uc, &food, "Milk chocolate bar", BAR);

        let log = assemble(&uc, DAY, DAY).unwrap();
        assert_eq!(amount_of(&log.rows[0], 1004), Some(13.0));
        assert_eq!(
            amount_of(&log.rows[0], 1093),
            None,
            "a label-rounded zero is a range, so the cell stays empty"
        );
        assert_eq!(
            log.blanks, 14,
            "one bounded figure and thirteen the pack never mentioned"
        );
    }

    /// The case the whole `exact_amount` rule exists for: most of a sitting is
    /// accounted for, one dish is not, and the subtotal is smaller than the
    /// truth.
    #[test]
    fn a_dish_that_says_nothing_reports_nothing_rather_than_a_subtotal() {
        let Some(rc) = refdb() else { return };
        let mut uc = user_db();
        let known = saved(
            &mut uc,
            &pack(
                "Milk chocolate bar",
                vec![nutrient(1235, "measured", Some(20.0), None)],
            ),
        );
        let silent = saved(
            &mut uc,
            &pack(
                "Unlabelled biscuit",
                vec![nutrient(1004, "measured", Some(1.0), None)],
            ),
        );
        eat(&rc, &mut uc, &known, "Milk chocolate bar", BAR);
        eat(&rc, &mut uc, &silent, "Unlabelled biscuit", BAR);

        let log = assemble(&uc, DAY, DAY).unwrap();
        assert_eq!(log.rows.len(), 2);
        let sugars: Vec<Option<f64>> = log.rows.iter().map(|r| amount_of(r, 1235)).collect();
        assert_eq!(
            sugars,
            vec![Some(20.0), None],
            "the bar's own 20 g per serving over one serving; the biscuit reports nothing"
        );
    }

    /// A dose is never on the sheet the importer reads. It would come back as a
    /// 100 g food, and a tablet's contents are not a function of its weight.
    #[test]
    fn a_dose_and_a_bottle_stay_off_the_sheet_the_importer_reads() {
        let Some(rc) = refdb() else { return };
        let mut uc = user_db();

        let supplement = store::Supplement {
            id: String::new(),
            name: "Calcium".into(),
            brand: None,
            unit_noun: "tablet".into(),
            serving_units: 1.0,
            serving_label: Some("1 tablet".into()),
            default_units: Some(1.0),
            regime: "us".into(),
            panel_complete: false,
            other_ingredients: None,
            barcode: None,
            photo_panel: None,
            photo_ingredients: None,
            nutrients: vec![store::SupplementNutrient {
                nutrient_id: 1087,
                position: 0,
                label_amount: 500.0,
                label_unit: "mg".into(),
                label_form: "unspecified".into(),
                kind: "measured".into(),
                amount: Some(500.0),
                upper: None,
                convert_note: None,
            }],
        };
        let sup = store::save_supplement(&mut uc, None, &supplement).unwrap();
        crate::add_frozen(
            &rc,
            &mut uc,
            DAY,
            Some("breakfast"),
            store::Source::Supplement(&sup),
            "Calcium",
            store::Quantity::Units(2.0),
            None,
            &store::Tags::default(),
        )
        .unwrap();

        // A litre bottle weighed both empty and full, so its own scale factor
        // is known and the volume is measured rather than assumed.
        let bottle =
            store::save_bottle(&uc, None, "Steel bottle", 1300.0, Some(300.0), Some(1000.0))
                .unwrap();
        crate::add_frozen(
            &rc,
            &mut uc,
            DAY,
            None,
            store::Source::Water(&bottle),
            "Steel bottle",
            store::Quantity::Grams(500.0),
            None,
            &store::Tags::default(),
        )
        .unwrap();

        let log = assemble(&uc, DAY, DAY).unwrap();
        assert!(log.rows.is_empty(), "neither belongs on the log sheet");
        assert_eq!(log.doses.len(), 1);
        assert_eq!(log.doses[0].units, 2.0, "counted, never weighed");
        assert_eq!(
            log.doses[0]
                .nutrients
                .iter()
                .find(|n| n.nutrient_id == 1087),
            Some(&ExportNutrient {
                nutrient_id: 1087,
                amount: 1000.0
            }),
            "two 500 mg tablets"
        );
        assert_eq!(log.water.len(), 1);
        assert_eq!(log.water[0].ml, 500.0, "a calibrated litre bottle");
        assert!(log.water[0].measured, "weighed empty, so not assumed");
    }

    /// An entry the app has not frozen is left out and SAID, rather than valued
    /// against today's reference data on the way past.
    #[test]
    fn an_unfrozen_entry_is_counted_rather_than_valued_on_the_way_out() {
        let Some(rc) = refdb() else { return };
        let mut uc = user_db();
        let food = saved(
            &mut uc,
            &pack(
                "Milk chocolate bar",
                vec![nutrient(1004, "measured", Some(13.0), None)],
            ),
        );
        // `store::add` writes the entry WITHOUT a snapshot, which is the state
        // an entry from before frozen history is in until startup repairs it.
        store::add(
            &uc,
            DAY,
            Some("snack"),
            store::Source::Custom(&food),
            "Milk chocolate bar",
            store::Quantity::Grams(BAR),
            None,
            &store::Tags::default(),
        )
        .unwrap();
        // A frozen entry beside it, so the count is not vacuously right.
        eat(&rc, &mut uc, &food, "Milk chocolate bar", BAR);

        let log = assemble(&uc, DAY, DAY).unwrap();
        assert_eq!(log.rows.len(), 1, "only the frozen one is in the file");
        assert_eq!(log.unexportable, 1, "and the other is reported, not hidden");
    }

    #[test]
    fn an_export_of_a_period_with_nothing_in_it_is_a_file_with_no_rows() {
        let log = assemble(&user_db(), "2026-01-01", "2026-01-31").unwrap();
        assert_eq!(log.days, 0);
        assert!(log.rows.is_empty() && log.doses.is_empty() && log.water.is_empty());
        assert_eq!(log.blanks, 0);
        assert_eq!(log.unexportable, 0);
    }

    #[test]
    fn a_backwards_period_is_refused_in_the_words_the_other_screen_uses() {
        assert_eq!(
            check_period("2026-09-30", "2026-09-01").unwrap_err(),
            "the start of the range must not be after its end"
        );
        assert!(check_period("2026-09-01", "2026-09-30").is_ok());
        assert!(check_period(DAY, DAY).is_ok(), "one day is a period");
    }

    #[test]
    fn nothing_is_a_number_when_no_component_said_anything() {
        // `sum` of an empty slice reads `lower: 0.0, upper: Some(0.0)`, which
        // would otherwise print fifteen confident zeroes for an entry whose
        // snapshot has no components at all.
        let empty = sum(&[]);
        assert_eq!(empty.lower, 0.0);
        assert_eq!(empty.upper, Some(0.0));
        assert_eq!(exact_amount(&empty), None);
    }

    #[test]
    fn a_lab_that_looked_and_found_nothing_exports_a_zero() {
        // The distinction the whole tagged union exists for. `MeasuredZero` is
        // bounded on both ends, so it IS a number; a `0` with no provenance is
        // not, and neither is a trace.
        let looked = sum(&[Contribution::Food {
            value: NutrientValue::MeasuredZero,
            grams: 100.0,
        }]);
        assert_eq!(exact_amount(&looked), Some(0.0));

        for unknowable in [
            NutrientValue::ZeroUnknown,
            NutrientValue::Trace { upper: 0.5 },
        ] {
            let total = sum(&[Contribution::Food {
                value: unknowable.clone(),
                grams: 100.0,
            }]);
            assert_eq!(
                exact_amount(&total),
                None,
                "{unknowable:?} is not a number a cell can hold"
            );
        }
    }

    #[test]
    fn round3_keeps_three_decimals_and_no_more() {
        assert_eq!(round3(123.456_7), 123.457);
        assert_eq!(round3(0.000_4), 0.0);
        assert_eq!(round3(26.0), 26.0);
    }

    #[test]
    fn only_a_spreadsheet_or_a_csv_is_a_file_this_writes() {
        assert_eq!(export_extension("xlsx"), Ok("xlsx"));
        assert_eq!(export_extension("csv"), Ok("csv"));
        for bad in ["", "pdf", "XLSX", "xls"] {
            let refused = export_extension(bad).unwrap_err();
            assert!(
                refused.contains("not a file this app writes"),
                "“{bad}” should be refused with a sentence, got {refused}"
            );
        }
    }

    #[test]
    fn the_picker_is_told_a_mime_type_rather_than_an_extension() {
        assert_eq!(export_mime("csv"), "text/csv");
        assert!(export_mime("xlsx").starts_with("application/vnd.openxmlformats"));
    }

    #[test]
    fn a_suggested_name_is_swept_of_anything_that_would_move_the_file() {
        assert_eq!(
            safe_file_name("TrackIt log 2026-08-11 to 2026-09-09", "xlsx").unwrap(),
            "TrackIt log 2026-08-11 to 2026-09-09.xlsx"
        );
        assert_eq!(
            safe_file_name("../../etc/passwd", "csv").unwrap(),
            "etc passwd.csv",
            "a separator becomes a space and leading dots go"
        );
        assert_eq!(
            safe_file_name("log\n\tof mine.csv", "csv").unwrap(),
            "log of mine.csv",
            "and the extension is not doubled when it is already there"
        );
        assert_eq!(
            safe_file_name("..", "csv").unwrap_err(),
            "a file needs a name"
        );
        assert_eq!(
            safe_file_name("   ", "xlsx").unwrap_err(),
            "a file needs a name"
        );
    }
}
