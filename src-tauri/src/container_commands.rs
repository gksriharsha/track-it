//! The commands the screens call for kitchen containers. Storage and the
//! queries behind them are in `containers`; the arithmetic is in
//! `trackit_core::container`.

use tauri::{AppHandle, State};

use crate::containers::{
    self, Container, ContainerInput, Density, FoodFactor, FoodRef, FoodUsage, Pantry, StretchView,
};
use crate::{after_write, db, resolve_contribution, store};

/// Millilitres in one of each household measure, US customary — the measures
/// USDA's portion weights are stated in.
const MEASURES: &[(&str, &str, f64)] = &[
    // (SR unit, FNDDS description, ml)
    ("tbsp", "1 tablespoon", 14.7868),
    ("tsp", "1 teaspoon", 4.92892),
    ("cup", "1 cup", 236.588),
    ("fl oz", "1 fl oz", 29.5735),
];

/// A food's weight per ml from the reference database's household measures,
/// in the order they are most trustworthy for a liquid or a condiment: a
/// tablespoon first, a cup last of the spoons (a cup of anything chopped is
/// mostly air, and only plain "1 cup" rows are read at all).
fn reference_density(refconn: &rusqlite::Connection, fdc_id: i64) -> Result<Option<Density>, String> {
    let mut stmt = refconn
        .prepare("SELECT amount, unit, description, gram_weight FROM food_portions WHERE fdc_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([fdc_id], |r| {
            Ok((
                r.get::<_, f64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, f64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (unit, phrase, ml) in MEASURES {
        let found = rows.iter().find(|(amount, u, d, _)| {
            let by_unit = u.as_deref() == Some(*unit);
            let by_words = *amount == 1.0 && d.as_deref().map(str::trim) == Some(*phrase);
            by_unit || by_words
        });
        if let Some((amount, _, _, grams)) = found {
            let volume = amount * ml;
            if volume > 0.0 && *grams > 0.0 {
                let shown = if *amount == 1.0 { format!("1 {unit}") } else { format!("{amount} {unit}") };
                return Ok(Some(Density {
                    g_per_ml: grams / volume,
                    source: "reference".into(),
                    note: format!("USDA: {shown} is {} g", trim(*grams)),
                }));
            }
        }
    }
    Ok(None)
}

/// What a pack says about its own weight per ml.
///
/// A food saved per ml is counted at a gram a millilitre everywhere in this
/// app (`GRAMS_PER_ML`): its recipe lines and logged amounts are millilitres
/// carried as grams. So its containers must convert at exactly that figure,
/// or a reading off the marks would be weighed against amounts written in a
/// different currency. Said as a convention, because it is not a measurement.
///
/// Otherwise "1 tbsp (15 mL)" printed beside a serving weighed in grams is the
/// pack's own statement of both.
fn label_density(food: &store::CustomFood) -> Option<Density> {
    if food.serving_ml.is_some() {
        return Some(Density {
            g_per_ml: store::GRAMS_PER_ML,
            source: "label".into(),
            note: "Logged by volume: 1 ml counts as 1 g".into(),
        });
    }
    let label = food.serving_label.as_deref()?.to_lowercase();
    let at = label.find("ml")?;
    let digits: String = label[..at]
        .trim_end()
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let ml: f64 = digits.parse().ok().filter(|v: &f64| *v > 0.0)?;
    Some(Density {
        g_per_ml: food.serving_g / ml,
        source: "label".into(),
        note: format!("The pack: {} ml is {} g", trim(ml), trim(food.serving_g)),
    })
}

fn trim(v: f64) -> String {
    let r = (v * 10.0).round() / 10.0;
    if r.fract() == 0.0 {
        format!("{r:.0}")
    } else {
        format!("{r:.1}")
    }
}

/// Where a food's weight per ml comes from when nobody has weighed a cupful:
/// its own pack, then the reference food it stands in for, then nothing.
fn resolve_density(
    refconn: &rusqlite::Connection,
    uconn: &rusqlite::Connection,
    food: &FoodRef,
) -> Result<Option<Density>, String> {
    match (food.fdc_id, food.custom_food_id.as_deref()) {
        (Some(fdc), _) => reference_density(refconn, fdc),
        (None, Some(id)) => {
            let own = store::get_custom_food_for_history(uconn, id)?;
            if let Some(d) = label_density(&own) {
                return Ok(Some(d));
            }
            match own.overrides_fdc_id {
                Some(fdc) => reference_density(refconn, fdc),
                None => Ok(None),
            }
        }
        (None, None) => Ok(None),
    }
}

/// A cupful the owner weighed, as a weight per ml.
fn weighed_density(cup_g: f64, cup_ml: f64) -> Result<Density, String> {
    if !(cup_g.is_finite() && cup_g > 0.0) {
        return Err("a weighed cup must be a positive weight".into());
    }
    Ok(Density {
        g_per_ml: cup_g / cup_ml,
        source: "weighed".into(),
        note: format!("You weighed a cup: {} g", trim(cup_g)),
    })
}

#[tauri::command]
pub fn list_containers(user: State<'_, store::Store>) -> Result<Vec<Container>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    containers::list_containers(&conn)
}

#[tauri::command]
pub fn get_container(id: String, user: State<'_, store::Store>) -> Result<Container, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    containers::get_container(&conn, &id)
}

/// Everything the pantry screen shows: each food with what its containers
/// have shown over `[from, to]`, then the containers.
#[tauri::command]
pub fn pantry(from: String, to: String, user: State<'_, store::Store>) -> Result<Pantry, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    containers::pantry(&conn, &from, &to)
}

/// The weight per ml a container of this food would start with, and where it
/// comes from, for the add screen to show before anything is saved.
#[tauri::command]
pub fn suggest_density(
    fdc_id: Option<i64>,
    custom_food_id: Option<String>,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<Option<Density>, String> {
    let food = FoodRef::of(fdc_id, custom_food_id.as_deref()).ok_or("a container holds exactly one food")?;
    let refconn = refdb.0.lock().map_err(|e| e.to_string())?;
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    resolve_density(&refconn, &conn, &food)
}

/// Add a container, or change one.
///
/// The weight per ml is resolved here, where both databases are to hand:
/// `weighed_cup_g` (a cupful the owner put on a scale) wins, otherwise the
/// pack or the reference food decides. `poured_in` is the first pack, tipped
/// in today, saved in the same transaction as the container.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_container(
    id: Option<String>,
    container: ContainerInput,
    weighed_cup_g: Option<f64>,
    poured_in: Option<f64>,
    poured_unit: Option<String>,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    let refconn = refdb.0.lock().map_err(|e| e.to_string())?;
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;
    let cup_ml = container.cup_ml.unwrap_or(240.0);
    let density = match weighed_cup_g {
        Some(g) => Some(weighed_density(g, cup_ml)?),
        None => resolve_density(&refconn, &conn, &container.food)?,
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let saved = containers::save_container(&tx, id.as_deref(), &container, density.as_ref())?;
    if let Some(amount) = poured_in {
        let today = store::today_iso(&tx)?;
        containers::add_event(
            &tx,
            &saved,
            "poured_in",
            &today,
            Some(amount),
            Some(poured_unit.as_deref().unwrap_or("g")),
            false,
            None,
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(saved)
}

#[tauri::command]
pub fn delete_container(id: String, user: State<'_, store::Store>) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    containers::delete_container(&conn, &id)
}

/// Record a pack poured in, a reading, or the container finished. Returns the
/// container as it now reads, so the screen redraws from one answer.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_container_event(
    container_id: String,
    kind: String,
    happened_on: String,
    amount: Option<f64>,
    unit: Option<String>,
    spilled: Option<bool>,
    note: Option<String>,
    user: State<'_, store::Store>,
) -> Result<Container, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    containers::add_event(
        &conn,
        &container_id,
        &kind,
        &happened_on,
        amount,
        unit.as_deref(),
        spilled.unwrap_or(false),
        note.as_deref(),
    )?;
    containers::get_container(&conn, &container_id)
}

/// What a reading not yet saved would close: "230 ml used since 28 Sep".
#[tauri::command]
pub fn preview_container_event(
    container_id: String,
    kind: String,
    amount: Option<f64>,
    unit: Option<String>,
    spilled: Option<bool>,
    user: State<'_, store::Store>,
) -> Result<Option<StretchView>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    containers::preview(&conn, &container_id, &kind, amount, unit.as_deref(), spilled.unwrap_or(false))
}

#[tauri::command]
pub fn delete_container_event(id: String, user: State<'_, store::Store>) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    containers::delete_event(&conn, &id)
}

/// Each tracked food's to-taste correction as it stands.
#[tauri::command]
pub fn taste_factors(user: State<'_, store::Store>) -> Result<Vec<FoodFactor>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    containers::taste_factors(&conn)
}

/// Kitchen use of each tracked food over a period, beside what the cooks and
/// plates recorded. For aggregate views; never for a single day.
#[tauri::command]
pub fn container_usage(
    from: String,
    to: String,
    user: State<'_, store::Store>,
) -> Result<Vec<FoodUsage>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    containers::usage_between(&conn, &from, &to)
}

/// Add a container's food to a plate: ketchup with the dosa.
///
/// `to_taste` makes `grams` the amount the person would write, valued at the
/// container correction as it stands now; otherwise `grams` is what was
/// measured. Either way the entry is an ordinary one carrying the grams it was
/// given, frozen like every other, and it exists together with the record of
/// where it came from or not at all.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn log_container_use(
    logged_on: String,
    meal: String,
    fdc_id: Option<i64>,
    custom_food_id: Option<String>,
    description: String,
    grams: f64,
    to_taste: bool,
    origin: Option<String>,
    cuisine: Option<String>,
    app: AppHandle,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    if !(grams.is_finite() && grams > 0.0) {
        return Err("an amount added to a plate must be a positive weight".into());
    }
    // Reference before user, the order every command holding both keeps.
    let refconn = refdb.0.lock().map_err(|e| e.to_string())?;
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;

    let source = match (fdc_id, custom_food_id.as_deref()) {
        (Some(id), None) => store::Source::Food(id),
        (None, Some(id)) => store::Source::Custom(id),
        _ => return Err("a container's food is a reference food or one of your own".into()),
    };
    let food = FoodRef::of(fdc_id, custom_food_id.as_deref())
        .ok_or("a container's food is a reference food or one of your own")?;

    let (applied, taste) = if to_taste {
        let factor = containers::factor_for(&conn, &food)?.factor;
        (grams * factor, Some((grams, factor)))
    } else {
        (grams, None)
    };
    if !(applied.is_finite() && applied > 0.0) {
        // A factor of zero: measured uses accounted for everything the
        // containers gave out. Logging nothing is the honest reading of that,
        // but an entry of zero grams is not one the log can hold.
        return Err(
            "your containers say measured amounts already account for all of this food, so \
             there is nothing left to add by feel"
                .into(),
        );
    }
    let quantity = store::Quantity::Grams(applied);
    let tags = store::Tags { origin, cuisine };

    let (recipe, components) = resolve_contribution(&refconn, &conn, source, &description, quantity)?;
    let snap = store::Snapshot {
        basis: store::SnapBasis::Logged,
        frozen_at: store::now_iso(&conn)?,
        corrected_at: None,
        recipe,
        components,
    };
    let out = (|| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let id = store::add(&tx, &logged_on, Some(&meal), source, &description, quantity, None, &tags)?;
        store::write_snapshot(&tx, &id, &snap)?;
        containers::record_plate_use(&tx, &id, taste)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    })();
    after_write(&app, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refdb() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE food_portions (id INTEGER PRIMARY KEY, fdc_id INTEGER, amount REAL,
               unit TEXT, description TEXT, gram_weight REAL, source TEXT);
             INSERT INTO food_portions (fdc_id,amount,unit,description,gram_weight,source) VALUES
               (171017, 1, 'cup', NULL, 218, 'SR'),
               (171017, 1, 'tbsp', NULL, 13.6, 'SR'),
               (2709733, 1, '10205', '1 cup', 272, 'FN'),
               (2709733, 1, '21000', '1 tablespoon', 17, 'FN'),
               (2709733, 1, '64546', 'Guideline amount on regular sandwich', 17, 'FN'),
               (999, 1, '10205', '1 cup, diced', 150, 'FN');",
        )
        .unwrap();
        c
    }

    #[test]
    fn a_tablespoon_is_read_before_a_cup() {
        let d = reference_density(&refdb(), 171017).unwrap().unwrap();
        assert!((d.g_per_ml - 13.6 / 14.7868).abs() < 1e-9);
        assert_eq!(d.note, "USDA: 1 tbsp is 13.6 g");
        let d = reference_density(&refdb(), 2709733).unwrap().unwrap();
        assert!((d.g_per_ml - 17.0 / 14.7868).abs() < 1e-9);
    }

    #[test]
    fn a_cup_of_something_chopped_is_not_a_density() {
        assert!(reference_density(&refdb(), 999).unwrap().is_none());
    }

    #[test]
    fn a_pack_that_states_ml_gives_its_own_weight_per_ml() {
        let mut f = store::CustomFood {
            id: "x".into(),
            name: "Sunflower oil".into(),
            brand: None,
            overrides_fdc_id: None,
            serving_g: 14.0,
            serving_ml: None,
            serving_pieces: None,
            piece_noun: None,
            serving_label: Some("1 Tbsp (15 mL)".into()),
            ingredients: None,
            barcode: None,
            photo_label: None,
            photo_ingredients: None,
            nutrients: Vec::new(),
            import_only: false,
        };
        let d = label_density(&f).unwrap();
        assert!((d.g_per_ml - 14.0 / 15.0).abs() < 1e-9);
        assert_eq!(d.note, "The pack: 15 ml is 14 g");
        f.serving_label = Some("2 bars".into());
        assert!(label_density(&f).is_none());
        // A pack saved per ml counts a ml as a gram, and its containers must too.
        f.serving_ml = Some(330.0);
        let d = label_density(&f).unwrap();
        assert_eq!(d.g_per_ml, 1.0);
    }

    #[test]
    fn a_weighed_cup_reads_against_the_containers_own_cup() {
        let d = weighed_density(218.0, 240.0).unwrap();
        assert!((d.g_per_ml - 218.0 / 240.0).abs() < 1e-9);
        assert_eq!(d.note, "You weighed a cup: 218 g");
        assert!(weighed_density(0.0, 240.0).is_err());
    }
}
