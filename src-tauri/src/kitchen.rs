//! What is at home: the kitchen screen's pantry, fridge and freezer.
//!
//! Almost all of it is read, not kept. A food is at home when a pot used it or
//! it was logged at home, and the day that happened is what the shelves show.
//! The only rows written here are the few things a person does by hand, all
//! optional: putting a shop away, moving something, and saying it is finished.
//! Nothing ever has to be kept up for the rest of the app to be right; no
//! figure anywhere reads from this.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use crate::containers::FoodRef;
use crate::store::now_iso;
use crate::{db, family, family_index, store};

pub const SCHEMA: &str = r#"
-- What a person said about one food at home. Never a quantity: a thing is
-- there or it is not, so nothing here can drift out of true.
CREATE TABLE IF NOT EXISTS kitchen_items (
  -- 'fdc:<id>' or 'own:<custom food id>': one row per food.
  food           TEXT PRIMARY KEY,
  fdc_id         INTEGER,
  custom_food_id TEXT REFERENCES custom_foods(id),
  description    TEXT NOT NULL,
  -- Where its owner put it. NULL leaves it where the screen guesses.
  place          TEXT CHECK (place IS NULL OR place IN ('pantry','fridge','freezer')),
  put_on         TEXT,   -- ISO date it was last put away
  out_on         TEXT,   -- ISO date it was said to be finished
  updated_at     TEXT NOT NULL,
  CHECK ((fdc_id IS NULL) <> (custom_food_id IS NULL))
);
"#;

/// One food at home, as the shelves show it.
#[derive(Debug, Serialize, PartialEq)]
pub struct KitchenFood {
    pub fdc_id: Option<i64>,
    pub custom_food_id: Option<String>,
    pub description: String,
    /// Search's short name for a reference food; `None` keeps `description`.
    pub name: Option<String>,
    /// The last day a pot used it or it was logged at home.
    pub last_used: Option<String>,
    pub put_on: Option<String>,
    /// The day it was said to be finished. It is at home again once it is
    /// used or put away after that; the screen decides, and offers a finished
    /// thing again when a shop is put away.
    pub out_on: Option<String>,
    pub place: Option<String>,
}

fn key(food: &FoodRef) -> String {
    match (&food.fdc_id, &food.custom_food_id) {
        (Some(id), _) => format!("fdc:{id}"),
        (_, Some(id)) => format!("own:{id}"),
        _ => unreachable!("a FoodRef names one food"),
    }
}

/// Every food used or put away since `since`, newest first, finished or not.
pub fn list(conn: &Connection, since: &str) -> Result<Vec<KitchenFood>, String> {
    let mut by_food: HashMap<FoodRef, KitchenFood> = HashMap::new();
    // A pot's lines that went in, and foods logged at home or bought packed.
    // Restaurant dishes and spreadsheet rows (import_only) never sat on a shelf.
    let mut used = conn
        .prepare(
            "SELECT u.fdc_id, u.custom_food_id, COALESCE(cf.name, u.description), MAX(u.used_on)
               FROM (SELECT ci.fdc_id, ci.custom_food_id, ci.description, c.cooked_on AS used_on
                       FROM cook_ingredients ci JOIN cooks c ON c.id = ci.cook_id
                      WHERE c.deleted_at IS NULL AND ci.raw_g > 0 AND c.cooked_on >= ?1
                     UNION ALL
                     SELECT e.fdc_id, e.custom_food_id, e.description, e.logged_on
                       FROM log_entries e
                      WHERE e.deleted_at IS NULL AND e.source_kind IN ('food','custom')
                        AND (e.origin IS NULL OR e.origin IN ('home','packaged'))
                        AND e.logged_on >= ?1) u
               LEFT JOIN custom_foods cf ON cf.id = u.custom_food_id
              WHERE u.custom_food_id IS NULL OR (cf.deleted_at IS NULL AND cf.import_only = 0)
              GROUP BY u.fdc_id, u.custom_food_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = used
        .query_map([since], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (fdc_id, custom_food_id, description, used_on) = row.map_err(|e| e.to_string())?;
        let Some(food) = FoodRef::of(fdc_id, custom_food_id.as_deref()) else { continue };
        by_food.insert(food, KitchenFood { fdc_id, custom_food_id, description, name: None, last_used: Some(used_on), put_on: None, out_on: None, place: None });
    }

    let mut said = conn
        .prepare(
            "SELECT k.fdc_id, k.custom_food_id, COALESCE(cf.name, k.description), k.place, k.put_on, k.out_on
               FROM kitchen_items k LEFT JOIN custom_foods cf ON cf.id = k.custom_food_id
              WHERE k.custom_food_id IS NULL OR cf.deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = said
        .query_map([], |r| {
            Ok((
                r.get::<_, Option<i64>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (fdc_id, custom_food_id, description, place, put_on, out_on) = row.map_err(|e| e.to_string())?;
        let Some(food) = FoodRef::of(fdc_id, custom_food_id.as_deref()) else { continue };
        let put_on = put_on.filter(|d| d.as_str() >= since);
        let item = by_food.entry(food.clone()).or_insert_with(|| KitchenFood {
            fdc_id, custom_food_id, description, name: None, last_used: None, put_on: None, out_on: None, place: None,
        });
        item.put_on = put_on;
        item.out_on = out_on;
        item.place = place;
        // Only moved or finished, and not used or put away in the window.
        if item.last_used.is_none() && item.put_on.is_none() {
            by_food.remove(&food);
        }
    }

    let mut out: Vec<KitchenFood> = by_food.into_values().collect();
    out.sort_by(|a, b| b.last_used.clone().max(b.put_on.clone()).cmp(&a.last_used.clone().max(a.put_on.clone())).then(a.description.cmp(&b.description)));
    Ok(out)
}

/// Put a food away today, in `place`, or say where it lives now.
pub fn put(conn: &Connection, food: &FoodRef, description: &str, place: &str, on: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO kitchen_items (food, fdc_id, custom_food_id, description, place, put_on, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(food) DO UPDATE SET place = excluded.place, put_on = excluded.put_on,
           description = excluded.description, updated_at = excluded.updated_at",
        params![key(food), food.fdc_id, food.custom_food_id, description, place, on, now_iso(conn)?],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Move a food without saying it was bought again.
pub fn move_to(conn: &Connection, food: &FoodRef, description: &str, place: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO kitchen_items (food, fdc_id, custom_food_id, description, place, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(food) DO UPDATE SET place = excluded.place, updated_at = excluded.updated_at",
        params![key(food), food.fdc_id, food.custom_food_id, description, place, now_iso(conn)?],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Say a food is finished on `on`. It comes back the next time it is used.
pub fn finish(conn: &Connection, food: &FoodRef, description: &str, on: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO kitchen_items (food, fdc_id, custom_food_id, description, out_on, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(food) DO UPDATE SET out_on = excluded.out_on, updated_at = excluded.updated_at",
        params![key(food), food.fdc_id, food.custom_food_id, description, on, now_iso(conn)?],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn food_of(fdc_id: Option<i64>, custom_food_id: Option<String>) -> Result<FoodRef, String> {
    FoodRef::of(fdc_id, custom_food_id.as_deref()).ok_or_else(|| "name exactly one food".to_string())
}

fn place_ok(place: &str) -> Result<(), String> {
    matches!(place, "pantry" | "fridge" | "freezer").then_some(()).ok_or_else(|| format!("no such place: {place}"))
}

/// Async for the same reason as `get_day`: the short names wait on the index.
#[tauri::command(async)]
pub fn get_kitchen(since: String, refdb: State<'_, db::Db>, user: State<'_, store::Store>) -> Result<Vec<KitchenFood>, String> {
    let index: Option<std::sync::Arc<family::Index>> = family_index(&refdb);
    let mut foods = {
        let conn = user.0.lock().map_err(|e| e.to_string())?;
        list(&conn, &since)?
    };
    if let Some(index) = &index {
        for f in foods.iter_mut() {
            f.name = f.fdc_id.and_then(|id| index.entry_name(id, &f.description));
        }
    }
    Ok(foods)
}

#[tauri::command]
pub fn put_away(
    fdc_id: Option<i64>,
    custom_food_id: Option<String>,
    description: String,
    place: String,
    on: String,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    place_ok(&place)?;
    let food = food_of(fdc_id, custom_food_id)?;
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    put(&conn, &food, &description, &place, &on)
}

#[tauri::command]
pub fn move_kitchen_food(
    fdc_id: Option<i64>,
    custom_food_id: Option<String>,
    description: String,
    place: String,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    place_ok(&place)?;
    let food = food_of(fdc_id, custom_food_id)?;
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    move_to(&conn, &food, &description, &place)
}

#[tauri::command]
pub fn finish_kitchen_food(
    fdc_id: Option<i64>,
    custom_food_id: Option<String>,
    description: String,
    on: String,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    let food = food_of(fdc_id, custom_food_id)?;
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    finish(&conn, &food, &description, &on)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{CookIngredient, CookInput, Tags};

    const DAL: i64 = 172420;
    const RICE: i64 = 169756;
    const MILK: i64 = 746782;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(store::SCHEMA).unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }

    fn fdc(id: i64) -> FoodRef {
        FoodRef { fdc_id: Some(id), custom_food_id: None }
    }

    fn cook(c: &mut Connection, on: &str, lines: &[(i64, &str, f64)]) {
        let ingredients = lines
            .iter()
            .enumerate()
            .map(|(i, &(id, d, g))| CookIngredient {
                id: String::new(), position: i as i64, fdc_id: Some(id), custom_food_id: None,
                description: d.into(), planned_g: 100.0, raw_g: g, substituted_for: None, to_taste: false, taste_factor: None,
            })
            .collect();
        store::save_cook(c, None, &CookInput {
            recipe_id: None, name: "Dal".into(), cooked_on: on.into(), scale: 1.0, gross_g: None, vessel_ids: Vec::new(),
            weighed_yield_g: None, expected_yield_g: 1000.0, notes: None, defaults: Tags::default(), ingredients,
        })
        .unwrap();
    }

    fn logged(c: &Connection, on: &str, id: i64, d: &str, origin: Option<&str>) {
        c.execute(
            "INSERT INTO log_entries (id, logged_on, meal, source_kind, fdc_id, description, grams, origin, created_at, updated_at)
             VALUES (?1, ?2, 'breakfast', 'food', ?3, ?4, 100, ?5, 'now', 'now')",
            params![format!("{on}-{id}"), on, id, d, origin],
        )
        .unwrap();
    }

    fn names(c: &Connection, since: &str) -> Vec<(String, Option<String>)> {
        list(c, since).unwrap().into_iter().map(|f| (f.description, f.last_used.or(f.put_on))).collect()
    }

    #[test]
    fn what_a_pot_used_and_what_was_eaten_at_home_fill_the_kitchen() {
        let mut c = db();
        cook(&mut c, "2026-10-05", &[(DAL, "Toor dal", 200.0), (RICE, "Rice", 0.0)]);
        logged(&c, "2026-10-07", MILK, "Milk", Some("home"));
        logged(&c, "2026-10-08", RICE, "Rice", Some("eaten_out"));
        assert_eq!(
            names(&c, "2026-04-01"),
            vec![("Milk".into(), Some("2026-10-07".into())), ("Toor dal".into(), Some("2026-10-05".into()))],
            "a line left out of the pot, and rice eaten out, put nothing on a shelf",
        );
        assert!(names(&c, "2026-10-06").iter().all(|(d, _)| d != "Toor dal"), "older than the window is gone");
    }

    #[test]
    fn finished_is_said_not_deleted_and_a_shop_puts_things_away() {
        let c = db();
        logged(&c, "2026-10-01", MILK, "Milk", None);
        finish(&c, &fdc(MILK), "Milk", "2026-10-02").unwrap();
        assert_eq!(list(&c, "2026-04-01").unwrap()[0].out_on.as_deref(), Some("2026-10-02"));
        logged(&c, "2026-10-03", MILK, "Milk", None);
        assert_eq!(names(&c, "2026-04-01"), vec![("Milk".into(), Some("2026-10-03".into()))]);
        finish(&c, &fdc(RICE), "Rice", "2026-10-03").unwrap();
        assert_eq!(list(&c, "2026-04-01").unwrap().len(), 1, "finished and never used: nothing to show");

        put(&c, &fdc(RICE), "Rice", "pantry", "2026-10-04").unwrap();
        move_to(&c, &fdc(MILK), "Milk", "freezer").unwrap();
        let all = list(&c, "2026-04-01").unwrap();
        assert_eq!(all[0].description, "Rice");
        assert_eq!(all[0].put_on.as_deref(), Some("2026-10-04"));
        assert_eq!(all[1].place.as_deref(), Some("freezer"), "moved, and still at home");
        assert_eq!(all[1].put_on, None, "moving is not buying");
    }
}
