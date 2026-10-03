use rusqlite::Connection;
use trackit_core::container::StretchStatus;

use super::*;
use crate::store::{self, CookIngredient, CookInput, Tags};

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(store::SCHEMA).unwrap();
    c.execute_batch(SCHEMA).unwrap();
    c
}

const SALT: i64 = 2047;
const OIL: i64 = 171017;

fn food(fdc: i64) -> FoodRef {
    FoodRef { fdc_id: Some(fdc), custom_food_id: None }
}

fn input(name: &str, fdc: i64, read_by: &str) -> ContainerInput {
    ContainerInput {
        name: name.into(),
        food: food(fdc),
        description: name.into(),
        read_by: read_by.into(),
        empty_g: None,
        capacity_ml: None,
        cup_ml: None,
    }
}

fn add(c: &Connection, name: &str, fdc: i64, read_by: &str, density: Option<f64>) -> String {
    let d = density.map(|g_per_ml| Density {
        g_per_ml,
        source: "reference".into(),
        note: "USDA: 1 tbsp is 13.6 g".into(),
    });
    save_container(c, None, &input(name, fdc, read_by), d.as_ref()).unwrap()
}

fn ev(c: &Connection, id: &str, kind: &str, on: &str, amount: Option<f64>, unit: Option<&str>) {
    add_event(c, id, kind, on, amount, unit, false, None).unwrap();
}

fn line(fdc_id: i64, description: &str, planned_g: f64, to_taste: bool) -> CookIngredient {
    CookIngredient {
        id: String::new(),
        position: 0,
        fdc_id: Some(fdc_id),
        custom_food_id: None,
        description: description.into(),
        planned_g,
        raw_g: planned_g,
        substituted_for: None,
        to_taste,
        taste_factor: None,
    }
}

fn cook(c: &mut Connection, on: &str, lines: Vec<CookIngredient>) -> String {
    let lines = lines
        .into_iter()
        .enumerate()
        .map(|(i, mut l)| {
            l.position = i as i64;
            l
        })
        .collect();
    store::save_cook(
        c,
        None,
        &CookInput {
            recipe_id: None,
            name: "Dal".into(),
            cooked_on: on.into(),
            scale: 1.0,
            gross_g: None,
            vessel_ids: Vec::new(),
            weighed_yield_g: None,
            expected_yield_g: 1000.0,
            notes: None,
            defaults: Tags::default(),
            ingredients: lines,
        },
    )
    .unwrap()
}

#[test]
fn a_to_taste_line_is_its_written_amount_until_a_span_is_counted() {
    let mut c = db();
    let jar = add(&c, "Salt jar", SALT, "scale", None);
    ev(&c, &jar, "poured_in", "2026-01-01", Some(1000.0), Some("g"));
    let id = cook(&mut c, "2026-01-05", vec![line(SALT, "Salt", 10.0, true)]);
    let pot = store::get_cook(&c, &id).unwrap();
    assert_eq!(pot.ingredients[0].raw_g, 10.0);
    assert_eq!(pot.ingredients[0].taste_factor, Some(1.0));
}

#[test]
fn the_container_corrects_what_was_written_and_the_pot_keeps_its_figure() {
    let mut c = db();
    let jar = add(&c, "Salt jar", SALT, "scale", None);
    ev(&c, &jar, "poured_in", "2026-01-01", Some(500.0), Some("g"));
    ev(&c, &jar, "reading", "2026-01-01", Some(700.0), Some("g"));
    // Two pots by feel, written as 20 g between them; a 30 g measured pickle.
    let first = cook(&mut c, "2026-01-03", vec![line(SALT, "Salt", 10.0, true)]);
    cook(&mut c, "2026-01-04", vec![line(SALT, "Salt", 10.0, true)]);
    cook(&mut c, "2026-01-05", vec![line(SALT, "Salt", 30.0, false)]);
    // 700 − 640 = 60 g gone; 30 measured, so 30 by feel for 20 written.
    ev(&c, &jar, "reading", "2026-01-10", Some(640.0), Some("g"));

    let f = factor_for(&c, &food(SALT)).unwrap();
    assert_eq!(f.stretches, 1);
    assert!((f.factor - 1.5).abs() < 1e-9, "{f:?}");

    let next = cook(&mut c, "2026-01-12", vec![line(SALT, "Salt", 8.0, true)]);
    let pot = store::get_cook(&c, &next).unwrap();
    assert!((pot.ingredients[0].raw_g - 12.0).abs() < 1e-9);

    // A pot made before the correction keeps the amount it was saved with,
    // and keeps it through a re-save.
    let old = store::get_cook(&c, &first).unwrap();
    assert_eq!(old.ingredients[0].raw_g, 10.0);
    let mut again = old.ingredients.clone();
    again.push(line(11282, "Onion", 100.0, false));
    again[1].position = 1;
    store::save_cook(
        &mut c,
        Some(&first),
        &CookInput {
            recipe_id: None,
            name: old.name.clone(),
            cooked_on: old.cooked_on.clone(),
            scale: 1.0,
            gross_g: None,
            vessel_ids: Vec::new(),
            weighed_yield_g: None,
            expected_yield_g: 1000.0,
            notes: None,
            defaults: Tags::default(),
            ingredients: again,
        },
    )
    .unwrap();
    assert_eq!(store::get_cook(&c, &first).unwrap().ingredients[0].raw_g, 10.0);
}

#[test]
fn a_to_taste_line_left_out_at_the_stove_stays_out() {
    let mut c = db();
    let mut salt = line(SALT, "Salt", 5.0, true);
    salt.raw_g = 0.0;
    let id = cook(&mut c, "2026-01-05", vec![salt, line(11282, "Onion", 100.0, false)]);
    let pot = store::get_cook(&c, &id).unwrap();
    assert_eq!(pot.ingredients[0].raw_g, 0.0, "left out, not valued back in");
    assert_eq!(pot.ingredients[0].taste_factor, None);
}

#[test]
fn a_spill_drops_only_its_own_span() {
    let mut c = db();
    let can = add(&c, "Oil can", OIL, "scale", None);
    ev(&c, &can, "poured_in", "2026-02-01", Some(1000.0), Some("g"));
    ev(&c, &can, "reading", "2026-02-01", Some(1300.0), Some("g"));
    cook(&mut c, "2026-02-03", vec![line(OIL, "Oil", 50.0, true)]);
    ev(&c, &can, "reading", "2026-02-10", Some(1200.0), Some("g"));
    cook(&mut c, "2026-02-12", vec![line(OIL, "Oil", 50.0, true)]);
    add_event(&c, &can, "reading", "2026-02-15", Some(900.0), Some("g"), true, Some("knocked over")).unwrap();

    let got = get_container(&c, &can).unwrap();
    let statuses: Vec<_> = got.stretches.iter().map(|s| s.status).collect();
    assert_eq!(
        statuses,
        vec![StretchStatus::AwaitingTare, StretchStatus::Counted, StretchStatus::Spilled, StretchStatus::Open]
    );
    let f = factor_for(&c, &food(OIL)).unwrap();
    assert!((f.factor - 2.0).abs() < 1e-9, "100 g used for 50 g written: {f:?}");
}

#[test]
fn entering_the_empty_weight_later_counts_what_was_waiting() {
    let mut c = db();
    let jar = add(&c, "Salt jar", SALT, "scale", None);
    ev(&c, &jar, "poured_in", "2026-03-01", Some(500.0), Some("g"));
    cook(&mut c, "2026-03-05", vec![line(SALT, "Salt", 25.0, true)]);
    ev(&c, &jar, "reading", "2026-03-10", Some(750.0), Some("g"));
    assert!(!factor_for(&c, &food(SALT)).unwrap().is_counted());

    let mut i = input("Salt jar", SALT, "scale");
    i.empty_g = Some(300.0);
    save_container(&c, Some(&jar), &i, None).unwrap();
    // 500 in, 450 left: 50 g used for 25 written.
    let f = factor_for(&c, &food(SALT)).unwrap();
    assert!((f.factor - 2.0).abs() < 1e-9, "{f:?}");
}

#[test]
fn oil_read_off_the_marks_counts_once_it_has_a_weight_per_ml() {
    let mut c = db();
    let can = add(&c, "Oil dispenser", OIL, "marks", None);
    ev(&c, &can, "poured_in", "2026-09-12", Some(1.0), Some("l"));
    cook(&mut c, "2026-09-15", vec![line(OIL, "Oil", 200.0, true)]);
    ev(&c, &can, "reading", "2026-09-21", Some(640.0), Some("ml"));
    let got = get_container(&c, &can).unwrap();
    assert_eq!(got.stretches[0].status, StretchStatus::AwaitingDensity);
    assert_eq!(got.stretches[0].used_ml, Some(360.0));

    let d = Density { g_per_ml: 0.92, source: "reference".into(), note: "USDA: 1 tbsp is 13.6 g".into() };
    save_container(&c, Some(&can), &input("Oil dispenser", OIL, "marks"), Some(&d)).unwrap();
    let got = get_container(&c, &can).unwrap();
    assert_eq!(got.stretches[0].status, StretchStatus::Counted);
    assert!((got.stretches[0].used_g.unwrap() - 331.2).abs() < 1e-9);
    // 331.2 g by feel against 200 g written.
    let f = factor_for(&c, &food(OIL)).unwrap();
    assert!((f.factor - 331.2 / 200.0).abs() < 1e-9, "{f:?}");
}

#[test]
fn a_reading_in_cups_is_read_against_the_containers_own_cup() {
    let c = db();
    let mut i = input("Ghee jar", 2710168, "marks");
    i.cup_ml = Some(250.0);
    let jar = save_container(&c, None, &i, None).unwrap();
    ev(&c, &jar, "poured_in", "2026-09-01", Some(1000.0), Some("ml"));
    ev(&c, &jar, "reading", "2026-09-10", Some(2.0), Some("cup"));
    let got = get_container(&c, &jar).unwrap();
    assert_eq!(got.events[1].amount, Some(500.0));
    assert_eq!(got.events[1].unit.as_deref(), Some("ml"));
    assert_eq!(got.stretches[0].used_ml, Some(500.0));
}

#[test]
fn a_preview_says_what_a_reading_would_close_without_storing_it() {
    let c = db();
    let can = add(&c, "Oil dispenser", OIL, "marks", Some(0.92));
    ev(&c, &can, "poured_in", "2026-09-12", Some(1000.0), Some("ml"));
    ev(&c, &can, "reading", "2026-09-28", Some(640.0), Some("ml"));
    let p = preview(&c, &can, "reading", Some(410.0), Some("ml"), false).unwrap().unwrap();
    assert_eq!(p.from_on, "2026-09-28");
    assert_eq!(p.used_ml, Some(230.0));
    assert_eq!(get_container(&c, &can).unwrap().events.len(), 2, "nothing stored");
    assert!(preview(&c, &can, "poured_in", Some(1.0), Some("l"), false).unwrap().is_none());
}

#[test]
fn a_container_with_history_cannot_change_its_food() {
    let c = db();
    let jar = add(&c, "Jar", SALT, "scale", None);
    ev(&c, &jar, "poured_in", "2026-03-01", Some(500.0), Some("g"));
    assert!(save_container(&c, Some(&jar), &input("Jar", 19335, "scale"), None).is_err());
}

#[test]
fn the_pantry_leads_with_what_each_food_has_shown() {
    let mut c = db();
    let jar = add(&c, "Salt jar", SALT, "scale", None);
    ev(&c, &jar, "poured_in", "2026-04-01", Some(300.0), Some("g"));
    cook(&mut c, "2026-04-03", vec![line(SALT, "Salt", 5.0, true)]);
    cook(&mut c, "2026-04-05", vec![line(SALT, "Salt", 100.0, false)]);
    ev(&c, &jar, "emptied", "2026-04-11", None, None);
    let tin = add(&c, "Ghee tin", 2710168, "scale", None);
    ev(&c, &tin, "poured_in", "2026-04-01", Some(905.0), Some("g"));
    ev(&c, &tin, "reading", "2026-04-08", Some(1100.0), Some("g"));

    let p = pantry(&c, "2026-04-01", "2026-04-30").unwrap();
    // The salt jar is finished, so salt has no open container to list.
    assert!(p.foods.iter().all(|f| f.food != food(SALT)));
    assert_eq!(p.finished.len(), 1);
    let ghee = p.foods.iter().find(|f| f.food == food(2710168)).unwrap();
    assert_eq!(ghee.waiting, Some("tare"));
    assert_eq!(ghee.containers[0].waiting, Some("tare"));
    assert_eq!(ghee.containers[0].last.as_ref().unwrap().amount, 1100.0);
}

#[test]
fn usage_compares_the_kitchen_with_the_recorded_pots() {
    let mut c = db();
    let jar = add(&c, "Salt jar", SALT, "scale", None);
    ev(&c, &jar, "poured_in", "2026-04-01", Some(300.0), Some("g"));
    cook(&mut c, "2026-04-05", vec![line(SALT, "Salt", 100.0, false)]);
    ev(&c, &jar, "emptied", "2026-04-11", None, None);
    let u = usage_between(&c, "2026-04-01", "2026-04-30").unwrap();
    assert_eq!(u.len(), 1);
    assert!((u[0].days - 10.0).abs() < 1e-9);
    assert!((u[0].used_per_day_g.unwrap() - 30.0).abs() < 1e-9);
    assert!((u[0].recorded_per_day_g.unwrap() - 10.0).abs() < 1e-9);
}

#[test]
fn events_are_checked_before_they_are_stored() {
    let c = db();
    let jar = add(&c, "Jar", SALT, "scale", None);
    assert!(add_event(&c, &jar, "poured_in", "2026-03-01", None, None, false, None).is_err());
    assert!(add_event(&c, &jar, "reading", "2026-03-01", Some(-4.0), Some("g"), false, None).is_err());
    assert!(add_event(&c, &jar, "poured_in", "2026-03-01", Some(5.0), Some("g"), true, None).is_err());
    assert!(add_event(&c, &jar, "reading", "2026-03-01", Some(5.0), Some("pinch"), false, None).is_err());
    assert!(add_event(&c, &jar, "refilled", "2026-03-01", Some(5.0), Some("g"), false, None).is_err());
    assert!(add_event(&c, &jar, "emptied", "2026-03-01", None, None, false, None).is_ok());
}

mod upgrade {
    use super::*;

    fn has(c: &Connection, table: &str, column: &str) -> bool {
        c.prepare(&format!("SELECT {column} FROM {table} LIMIT 0")).is_ok()
    }

    /// A database in the last released shape — v21, before any line could be
    /// added by feel — opens, gains the columns, and keeps its rows.
    #[test]
    fn a_v21_database_opens_and_keeps_its_lines() {
        let dir = std::env::temp_dir().join(format!("trackit-v21-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("user.db");
        let _ = std::fs::remove_file(&path);
        {
            let c = store::open(&path).unwrap();
            c.execute_batch(
                "INSERT INTO recipes (id,name,yield_g,created_at,updated_at)
                   VALUES ('r','Dal',900,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
                 INSERT INTO recipe_ingredients (id,recipe_id,position,fdc_id,description,raw_g)
                   VALUES ('ri','r',0,2047,'Salt',6);
                 DROP TABLE container_uses; DROP TABLE container_events; DROP TABLE containers;
                 ALTER TABLE recipe_ingredients DROP COLUMN to_taste;
                 ALTER TABLE cook_ingredients DROP COLUMN taste_factor;
                 ALTER TABLE cook_ingredients DROP COLUMN to_taste;
                 PRAGMA user_version = 21;",
            )
            .unwrap();
            assert!(!has(&c, "recipe_ingredients", "to_taste"));
        }
        let c = store::open(&path).unwrap();
        assert!(has(&c, "recipe_ingredients", "to_taste"));
        assert!(has(&c, "cook_ingredients", "taste_factor"));
        assert!(has(&c, "containers", "g_per_ml"));
        assert!(has(&c, "container_events", "unit"));
        let r = store::get_recipe(&c, "r").unwrap();
        assert_eq!(r.ingredients[0].raw_g, 6.0);
        assert!(!r.ingredients[0].to_taste);
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, store::SCHEMA_VERSION);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real thing: a copy of a database a person has actually used. Run
    /// with `TRACKIT_UPGRADE_DB=/path/to/copy/user.db cargo test -- --ignored`.
    /// Point it at a COPY; opening migrates in place.
    #[test]
    #[ignore]
    fn a_real_database_copy_opens() {
        let Ok(path) = std::env::var("TRACKIT_UPGRADE_DB") else {
            return;
        };
        let c = store::open(&std::path::PathBuf::from(path)).unwrap();
        let recipes = store::list_recipes(&c).unwrap();
        for r in &recipes {
            store::get_recipe(&c, &r.id).unwrap();
        }
        let jar = add(&c, "Test jar", SALT, "scale", None);
        ev(&c, &jar, "poured_in", "2026-01-01", Some(500.0), Some("g"));
        assert!(!factor_for(&c, &food(SALT)).unwrap().is_counted());
        eprintln!("opened: {} recipes", recipes.len());
    }
}
