//! A dish pasted in from an assistant's estimate rides the spreadsheet row's
//! path (`import_one_row`), with the three things a pasted dish can carry that
//! a spreadsheet row cannot: its weight, where it came from and its cuisine.

use std::sync::Mutex;

use crate::family_tests::{refdb, user_db};
use crate::{collect_day, import_one_row, nutrient_dim, store, ImportNutrientInput, ImportRowInput};

const DAY: &str = "2026-10-06";

fn dish(origin: Option<&str>, grams: Option<f64>) -> ImportRowInput {
    pasted(origin, grams, Some("portion"))
}

fn pasted(origin: Option<&str>, grams: Option<f64>, piece_noun: Option<&str>) -> ImportRowInput {
    ImportRowInput {
        logged_on: DAY.into(),
        meal: "dinner".into(),
        description: "Paneer butter masala".into(),
        nutrients: vec![
            ImportNutrientInput { nutrient_id: 1008, amount: 620.0 },
            ImportNutrientInput { nutrient_id: 1003, amount: 22.0 },
        ],
        source_row: 1,
        origin: origin.map(String::from),
        cuisine: Some("  North Indian ".into()),
        grams,
        piece_noun: piece_noun.map(String::from),
    }
}

#[test]
fn a_pasted_dish_is_one_portion_as_heavy_as_its_estimate_with_its_tags() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish(Some("ordered_in"), Some(350.0))).unwrap();
    let day = store::day(&uc, DAY).unwrap();
    assert_eq!(day.len(), 1);
    let e = &day[0];
    assert_eq!(e.pieces, Some(1.0));
    assert_eq!(e.piece_noun.as_deref(), Some("portion"));
    assert_eq!(e.grams, Some(350.0));
    assert_eq!(e.origin.as_deref(), Some("ordered_in"));
    assert_eq!(e.cuisine.as_deref(), Some("North Indian"));
    // A one-off: it never joins the user's own foods.
    assert!(store::list_custom_foods(&uc).unwrap().is_empty());
}

#[test]
fn a_pasted_dish_says_its_values_came_from_an_estimate_not_a_pack() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish(Some("ordered_in"), Some(450.0))).unwrap();
    let dim = nutrient_dim(&rc).unwrap();
    let user = store::Store(Mutex::new(uc));
    let (_, breakdowns, _) = collect_day(&rc, &user, &dim, DAY).unwrap();
    let line = &breakdowns[0].components[0].description;
    assert!(line.contains("from an estimate") && !line.contains("off the pack"), "{line}");
}

#[test]
fn without_a_weight_it_is_still_one_portion_and_never_a_weight() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish(None, None)).unwrap();
    let e = &store::day(&uc, DAY).unwrap()[0];
    assert_eq!(e.pieces, Some(1.0));
    // The nominal mass the sums run on, behind a count the day shows.
    assert_eq!(e.grams, Some(100.0));
    assert_eq!(e.origin, None);
}

#[test]
fn a_spreadsheet_row_stays_a_weighed_100_g() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &pasted(None, None, None)).unwrap();
    let e = &store::day(&uc, DAY).unwrap()[0];
    assert_eq!(e.grams, Some(100.0));
    assert_eq!(e.pieces, None);
}

#[test]
fn a_pasted_dish_is_not_an_import_the_spreadsheet_importer_warns_of() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    let days = vec![DAY.to_string()];
    import_one_row(&rc, &mut uc, &dish(Some("eaten_out"), Some(300.0))).unwrap();
    assert!(store::dates_with_existing_imports(&uc, &days).unwrap().is_empty());
    import_one_row(&rc, &mut uc, &pasted(None, None, None)).unwrap();
    assert_eq!(store::dates_with_existing_imports(&uc, &days).unwrap(), days);
}

#[test]
fn a_bad_origin_or_weight_is_refused_and_leaves_nothing_behind() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    assert!(import_one_row(&rc, &mut uc, &dish(Some("takeaway"), None)).is_err());
    assert!(import_one_row(&rc, &mut uc, &dish(None, Some(-5.0))).is_err());
    assert!(import_one_row(&rc, &mut uc, &pasted(None, None, Some("  "))).is_err());
    assert!(store::day(&uc, DAY).unwrap().is_empty());
    let left: i64 = uc
        .query_row("SELECT COUNT(*) FROM custom_foods", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}
