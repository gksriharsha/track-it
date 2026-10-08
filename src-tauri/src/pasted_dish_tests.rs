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
        place: None,
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
    assert!(line.starts_with("Paneer butter masala — "), "no place given, the name alone: {line}");
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

/// A pasted dish on a given day, under a given name.
fn dish_on(day: &str, name: &str) -> ImportRowInput {
    let mut row = dish(Some("ordered_in"), Some(400.0));
    row.logged_on = day.into();
    row.description = name.into();
    row
}

#[test]
fn a_restaurant_dish_is_offered_again_from_its_first_order() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish(Some("ordered_in"), Some(450.0))).unwrap();
    let recent = store::recent_restaurant_dishes(&uc, "2026-01-01", 4).unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].description, "Paneer butter masala");
    assert_eq!(recent[0].last_pieces, Some(1.0));
    assert_eq!(recent[0].last_amount_label, "1 portion");
    assert_eq!(recent[0].source_kind, "custom");
    // And it is found by its name, marked as what it is.
    let found = store::search_custom_foods(&uc, "paneer", 10, true).unwrap();
    assert_eq!(found.len(), 1);
    // Never a pack in Your foods.
    assert!(store::list_custom_foods(&uc).unwrap().is_empty());
}

#[test]
fn a_spreadsheet_row_is_never_offered_again() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    for day in ["2026-10-01", "2026-10-02", "2026-10-03"] {
        let mut row = pasted(None, None, None);
        row.logged_on = day.into();
        import_one_row(&rc, &mut uc, &row).unwrap();
    }
    assert!(store::recent_restaurant_dishes(&uc, "2026-01-01", 4).unwrap().is_empty());
    assert!(store::frequent_foods_at(&uc, "2026-01-01", 6, Some("dinner")).unwrap().is_empty());
    assert!(store::frequent_foods(&uc, "2026-01-01", 6).unwrap().is_empty());
    assert!(store::search_custom_foods(&uc, "paneer", 10, true).unwrap().is_empty());
}

#[test]
fn the_same_dish_pasted_twice_is_offered_once_as_the_latest() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish_on("2026-10-01", "Chicken biryani")).unwrap();
    import_one_row(&rc, &mut uc, &dish_on("2026-10-02", "Pad thai")).unwrap();
    import_one_row(&rc, &mut uc, &dish_on("2026-10-04", "chicken  BIRYANI")).unwrap();
    let recent = store::recent_restaurant_dishes(&uc, "2026-01-01", 4).unwrap();
    let names: Vec<&str> = recent.iter().map(|r| r.description.as_str()).collect();
    assert_eq!(names, ["chicken  BIRYANI", "Pad thai"], "latest first, one per name");
    let latest = store::day(&uc, "2026-10-04").unwrap()[0].custom_food_id.clone();
    assert_eq!(recent[0].custom_food_id, latest);
    let found = store::search_custom_foods(&uc, "biryani", 10, true).unwrap();
    assert_eq!(found.len(), 1, "one biryani in search, not two");
    assert_eq!(Some(found[0].id.clone()), latest);
    // The limit counts dishes, not foods.
    assert_eq!(store::recent_restaurant_dishes(&uc, "2026-01-01", 1).unwrap().len(), 1);
}

#[test]
fn a_restaurant_dish_had_at_dinner_twice_is_usually_had_at_dinner() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish_on("2026-10-01", "Chicken biryani")).unwrap();
    assert!(store::frequent_foods_at(&uc, "2026-01-01", 6, Some("dinner")).unwrap().is_empty());
    // Logged again from the one-tap row: the same food, counted.
    let id = store::recent_restaurant_dishes(&uc, "2026-01-01", 4).unwrap()[0]
        .custom_food_id
        .clone()
        .unwrap();
    crate::add_frozen(
        &rc, &mut uc, "2026-10-05", Some("dinner"), store::Source::Custom(&id),
        "Chicken biryani", store::Quantity::Pieces(1.0), None, &store::Tags::default(),
    )
    .unwrap();
    let usual = store::frequent_foods_at(&uc, "2026-01-01", 6, Some("dinner")).unwrap();
    assert_eq!(usual.len(), 1);
    assert_eq!(usual[0].last_amount_label, "1 portion");
}

#[test]
fn a_deleted_restaurant_dish_is_not_offered() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish(Some("ordered_in"), None)).unwrap();
    let id = store::recent_restaurant_dishes(&uc, "2026-01-01", 4).unwrap()[0]
        .custom_food_id
        .clone()
        .unwrap();
    store::delete_custom_food(&uc, &id).unwrap();
    assert!(store::recent_restaurant_dishes(&uc, "2026-01-01", 4).unwrap().is_empty());
    assert!(store::search_custom_foods(&uc, "paneer", 10, true).unwrap().is_empty());
}

/// A pasted dish from a named place.
fn dish_from(day: &str, name: &str, place: &str) -> ImportRowInput {
    let mut row = dish_on(day, name);
    row.place = Some(place.into());
    row
}

#[test]
fn the_same_dish_from_two_places_is_two_dishes() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish_from("2026-10-01", "Chicken biryani", "Paradise")).unwrap();
    import_one_row(&rc, &mut uc, &dish_from("2026-10-03", "Chicken biryani", "Bawarchi")).unwrap();
    // The same place again, its spelling folded: replaces Paradise's estimate.
    import_one_row(&rc, &mut uc, &dish_from("2026-10-05", "Chicken biryani", "  paradise ")).unwrap();
    let recent = store::recent_restaurant_dishes(&uc, "2026-01-01", 4).unwrap();
    let rows: Vec<(String, Option<String>)> =
        recent.iter().map(|r| (r.description.clone(), r.place.clone())).collect();
    assert_eq!(
        rows,
        [
            ("Chicken biryani".to_string(), Some("paradise".to_string())),
            ("Chicken biryani".to_string(), Some("Bawarchi".to_string())),
        ],
        "one per place, the latest of each first"
    );
    // Found by the dish, once per place, and by the place alone.
    assert_eq!(store::search_custom_foods(&uc, "biryani", 10, true).unwrap().len(), 2);
    let by_place = store::search_custom_foods(&uc, "bawarchi", 10, true).unwrap();
    assert_eq!(by_place.len(), 1);
    assert_eq!(by_place[0].brand.as_deref(), Some("Bawarchi"));
}

#[test]
fn a_blank_place_is_no_place() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish_from("2026-10-01", "Dosa", "   ")).unwrap();
    let recent = store::recent_restaurant_dishes(&uc, "2026-01-01", 4).unwrap();
    assert_eq!(recent[0].place, None);
}

#[test]
fn ingredient_search_never_offers_a_restaurant_dish() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    for name in ["Chicken biryani", "Chicken 65", "Butter chicken", "Chicken tikka"] {
        import_one_row(&rc, &mut uc, &dish_on("2026-10-01", name)).unwrap();
    }
    assert!(store::search_custom_foods(&uc, "chicken", 6, false).unwrap().is_empty());
    assert_eq!(store::search_custom_foods(&uc, "chicken", 6, true).unwrap().len(), 4);
}

#[test]
fn a_dish_whose_only_entry_was_removed_is_no_longer_offered() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish_from("2026-10-01", "Chicken biryani", "Paradise")).unwrap();
    let entry = store::day(&uc, "2026-10-01").unwrap()[0].id.clone();
    store::remove(&uc, &entry).unwrap();
    assert!(store::search_custom_foods(&uc, "biryani", 10, true).unwrap().is_empty());
    assert!(store::recent_restaurant_dishes(&uc, "2026-01-01", 4).unwrap().is_empty());
}

#[test]
fn two_pastes_of_one_dish_count_together_as_a_habit_and_show_once() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    // Each paste is a food of its own; both were dinners from the same place.
    import_one_row(&rc, &mut uc, &dish_from("2026-10-01", "Chicken biryani", "Paradise")).unwrap();
    import_one_row(&rc, &mut uc, &dish_from("2026-10-04", "Chicken biryani", "Paradise")).unwrap();
    let latest = store::day(&uc, "2026-10-04").unwrap()[0].custom_food_id.clone();
    let usual = store::frequent_foods_at(&uc, "2026-01-01", 6, Some("dinner")).unwrap();
    assert_eq!(usual.len(), 1, "two days of one dish is a habit, shown once");
    assert_eq!(usual[0].custom_food_id, latest, "as the paste last relied on");
    assert_eq!(usual[0].place.as_deref(), Some("Paradise"));
    assert!(usual[0].restaurant);
    // The unfiltered list (the widget's) shows it once too.
    assert_eq!(store::frequent_foods(&uc, "2026-01-01", 6).unwrap().len(), 1);
    // And another place's biryani is another dish.
    import_one_row(&rc, &mut uc, &dish_from("2026-10-05", "Chicken biryani", "Bawarchi")).unwrap();
    assert_eq!(store::frequent_foods(&uc, "2026-01-01", 6).unwrap().len(), 2);
}

#[test]
fn a_restaurant_dish_logged_by_weight_is_still_not_an_import() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish_from("2026-10-01", "Chicken biryani", "Paradise")).unwrap();
    let id = store::day(&uc, "2026-10-01").unwrap()[0].custom_food_id.clone().unwrap();
    crate::add_frozen(
        &rc, &mut uc, "2026-10-02", Some("lunch"), store::Source::Custom(&id),
        "Chicken biryani", store::Quantity::Grams(200.0), None, &store::Tags::default(),
    )
    .unwrap();
    let days = vec!["2026-10-02".to_string()];
    assert!(store::dates_with_existing_imports(&uc, &days).unwrap().is_empty());
}

#[test]
fn the_day_names_a_dish_with_its_place() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish_from("2026-10-01", "Chicken biryani", "Paradise")).unwrap();
    import_one_row(&rc, &mut uc, &dish_on("2026-10-01", "Masala dosa")).unwrap();
    let names: Vec<String> = store::day(&uc, "2026-10-01").unwrap().into_iter().map(|e| e.description).collect();
    assert!(names.contains(&"Chicken biryani · Paradise".to_string()), "{names:?}");
    assert!(names.contains(&"Masala dosa".to_string()), "{names:?}");
    // The food keeps the dish's own name; the place is its brand.
    let recent = store::recent_restaurant_dishes(&uc, "2026-01-01", 4).unwrap();
    assert!(recent.iter().any(|r| r.description == "Chicken biryani" && r.place.as_deref() == Some("Paradise")));
}

#[test]
fn where_a_dishs_values_come_from_names_its_place() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    import_one_row(&rc, &mut uc, &dish_from(DAY, "Chicken biryani", "Paradise")).unwrap();
    let dim = nutrient_dim(&rc).unwrap();
    let user = store::Store(Mutex::new(uc));
    let (_, breakdowns, _) = collect_day(&rc, &user, &dim, DAY).unwrap();
    let line = &breakdowns[0].components[0].description;
    assert!(line.starts_with("Chicken biryani · Paradise — "), "{line}");
}
