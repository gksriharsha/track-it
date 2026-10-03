//! A pack's "% Daily Value" lines, saved and read back. The conversion itself
//! is tested in `trackit_core::daily_value`; these test that the store applies
//! it, keeps what was printed, and upgrades an older database cleanly.

use rusqlite::Connection;

use crate::store::{self, CustomFood, CustomNutrient};

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(store::SCHEMA).unwrap();
    c
}

fn pct(id: i64, kind: &str, printed: f64, form: Option<&str>) -> CustomNutrient {
    CustomNutrient {
        nutrient_id: id,
        kind: kind.into(),
        // Deliberately wrong: the store must derive these, not trust them.
        amount: if kind == "measured" { Some(999.0) } else { None },
        upper: if kind == "measured" { None } else { Some(999.0) },
        printed_pct: Some(printed),
        label_form: form.map(str::to_string),
    }
}

fn milk(basis: &str, nutrients: Vec<CustomNutrient>) -> CustomFood {
    CustomFood {
        id: String::new(),
        name: "Whole milk".into(),
        brand: None,
        overrides_fdc_id: None,
        serving_g: 244.0,
        serving_ml: None,
        serving_pieces: None,
        piece_noun: None,
        serving_label: Some("1 cup (240 mL)".into()),
        ingredients: None,
        barcode: None,
        photo_label: None,
        photo_ingredients: None,
        nutrients,
        import_only: false,
        dv_basis: basis.into(),
    }
}

fn line(f: &CustomFood, id: i64) -> &CustomNutrient {
    f.nutrients.iter().find(|n| n.nutrient_id == id).unwrap()
}

fn close(a: Option<f64>, b: f64) -> bool {
    a.is_some_and(|a| (a - b).abs() < 1e-9)
}

#[test]
fn an_older_milk_panel_saves_as_the_amounts_it_stands_for() {
    let mut c = db();
    let id = store::save_custom_food(
        &mut c,
        None,
        &milk(
            "older",
            vec![
                pct(1106, "measured", 10.0, Some("retinol")),
                pct(1162, "measured", 4.0, None),
                pct(1114, "measured", 25.0, None),
                pct(1087, "measured", 30.0, None),
            ],
        ),
    )
    .unwrap();
    let f = store::get_custom_food(&c, &id).unwrap();
    assert_eq!(f.dv_basis, "older");
    assert!(close(line(&f, 1106).amount, 150.0), "{:?}", line(&f, 1106));
    assert!(close(line(&f, 1162).amount, 2.4));
    assert!(close(line(&f, 1114).amount, 2.5));
    assert!(close(line(&f, 1087).amount, 300.0));
    // What the pack printed comes back, so the editor shows "10%" again.
    assert_eq!(line(&f, 1106).printed_pct, Some(10.0));
    assert_eq!(line(&f, 1106).label_form.as_deref(), Some("retinol"));
}

#[test]
fn older_vitamin_a_without_its_form_is_refused_with_a_sentence() {
    let mut c = db();
    let err = store::save_custom_food(
        &mut c,
        None,
        &milk("older", vec![pct(1106, "measured", 10.0, None)]),
    )
    .unwrap_err();
    assert!(err.contains("retinol"), "{err}");
}

#[test]
fn re_saving_under_the_other_basis_reconverts_every_percentage() {
    let mut c = db();
    let id = store::save_custom_food(
        &mut c,
        None,
        &milk("older", vec![pct(1087, "measured", 30.0, None), pct(1106, "measured", 10.0, Some("retinol"))]),
    )
    .unwrap();
    let mut f = store::get_custom_food(&c, &id).unwrap();
    f.dv_basis = "current".into();
    store::save_custom_food(&mut c, Some(&id), &f).unwrap();
    let f = store::get_custom_food(&c, &id).unwrap();
    assert!(close(line(&f, 1087).amount, 390.0));
    assert!(close(line(&f, 1106).amount, 90.0));
    // A current panel needs no compound, so a stale one is not kept.
    assert_eq!(line(&f, 1106).label_form, None);
}

#[test]
fn printed_zero_and_less_than_percentages_become_bounds() {
    let mut c = db();
    let id = store::save_custom_food(
        &mut c,
        None,
        &milk(
            "older",
            vec![pct(1089, "label_zero", 0.0, None), pct(1162, "below_loq", 2.0, None)],
        ),
    )
    .unwrap();
    let f = store::get_custom_food(&c, &id).unwrap();
    // 0% of 18 mg iron is under 2% of it; "less than 2%" of 60 mg vitamin C.
    assert!(close(line(&f, 1089).upper, 0.36));
    assert_eq!(line(&f, 1089).amount, None);
    assert!(close(line(&f, 1162).upper, 1.2));
}

#[test]
fn a_percentage_of_a_line_with_no_daily_value_is_refused() {
    let mut c = db();
    assert!(store::save_custom_food(&mut c, None, &milk("current", vec![pct(1008, "measured", 8.0, None)])).is_err());
    assert!(store::save_custom_food(&mut c, None, &milk("older", vec![pct(1235, "measured", 8.0, None)])).is_err());
    assert!(store::save_custom_food(&mut c, None, &milk("someday", vec![])).is_err());
}

#[test]
fn amounts_typed_as_amounts_are_untouched() {
    let mut c = db();
    let mut n = pct(1087, "measured", 0.0, None);
    n.printed_pct = None;
    n.amount = Some(276.0);
    n.label_form = Some("retinol".into());
    let id = store::save_custom_food(&mut c, None, &milk("older", vec![n])).unwrap();
    let f = store::get_custom_food(&c, &id).unwrap();
    assert!(close(line(&f, 1087).amount, 276.0));
    assert_eq!(line(&f, 1087).label_form, None, "a form without a percentage describes nothing");
}

#[test]
fn a_v22_database_gains_the_columns_and_keeps_its_foods() {
    let dir = std::env::temp_dir().join(format!("trackit-pct-v22-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("user.db");
    let _ = std::fs::remove_file(&path);
    {
        let c = store::open(&path).unwrap();
        c.execute_batch(
            "INSERT INTO custom_foods (id,name,serving_g,created_at,updated_at)
               VALUES ('f','Milk',244,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
             INSERT INTO custom_food_nutrients (id,food_id,nutrient_id,kind,amount)
               VALUES ('n','f',1087,'measured',300);
             ALTER TABLE custom_food_nutrients DROP COLUMN label_form;
             ALTER TABLE custom_food_nutrients DROP COLUMN printed_pct;
             ALTER TABLE custom_foods DROP COLUMN dv_basis;
             PRAGMA user_version = 22;",
        )
        .unwrap();
    }
    let c = store::open(&path).unwrap();
    let f = store::get_custom_food(&c, "f").unwrap();
    assert_eq!(f.dv_basis, "current");
    assert!(close(line(&f, 1087).amount, 300.0));
    assert_eq!(line(&f, 1087).printed_pct, None);
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, store::SCHEMA_VERSION);
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
}
