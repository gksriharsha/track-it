//! What a logged entry, a dish's line and a quick-add row are called on screen:
//! the short name search gives the food, worked out where they are drawn and
//! never stored. These pin the one condition that keeps a past day honest —
//! the stored description must still be the dataset's — and that nothing but
//! a plain reference food is renamed.

use std::sync::Mutex;

use rusqlite::Connection;

use crate::family_tests::{refdb, user_db};
use crate::{
    add_frozen, base_description, collect_day, db, family, family_index, name_day, nutrient_dim,
    resolve_frequent, store, widgets, EntryBreakdown,
};

const DAY: &str = "2026-09-04";
/// "Mungo beans, mature seeds, cooked, boiled, without salt": urad, boiled.
const BOILED: i64 = 172427;
/// "Mungo beans, mature seeds, raw".
const RAW: i64 = 174259;

fn food(rc: &Connection, uc: &mut Connection, fdc: i64, description: &str) -> String {
    let source = store::Source::Food(fdc);
    let grams = store::Quantity::Grams(150.0);
    add_frozen(
        rc,
        uc,
        DAY,
        Some("lunch"),
        source,
        description,
        grams,
        None,
        &store::Tags::default(),
    )
    .unwrap()
}

/// The day as `get_day` hands it to the screen: collected, then named.
fn named_day(
    rc: &Connection,
    uc: Connection,
) -> (Vec<store::LogEntry>, Vec<EntryBreakdown>, Connection) {
    let dim = nutrient_dim(rc).unwrap();
    let user = store::Store(Mutex::new(uc));
    let (mut entries, mut breakdowns, _) = collect_day(rc, &user, &dim, DAY).unwrap();
    name_day(&family::index(rc).unwrap(), &mut entries, &mut breakdowns);
    (entries, breakdowns, user.0.into_inner().unwrap())
}

fn by_id<'a>(entries: &'a [store::LogEntry], id: &str) -> &'a store::LogEntry {
    entries
        .iter()
        .find(|e| e.id == id)
        .expect("the entry is on the day")
}

#[test]
fn a_reference_entry_is_called_what_search_calls_its_food() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    let boiled_desc = base_description(&rc, BOILED).unwrap();
    let raw_desc = base_description(&rc, RAW).unwrap();
    let boiled = food(&rc, &mut uc, BOILED, &boiled_desc);
    let raw = food(&rc, &mut uc, RAW, &raw_desc);

    let (entries, _, uc) = named_day(&rc, uc);
    let (b, r) = (by_id(&entries, &boiled), by_id(&entries, &raw));
    assert_eq!(
        b.name.as_deref(),
        Some("Mungo beans, boiled"),
        "the chip the panel showed"
    );
    assert_eq!(r.name.as_deref(), Some("Mungo beans, raw"));
    assert_eq!(
        b.description, boiled_desc,
        "the full USDA wording rides beside it"
    );
    assert_eq!(b.fdc_id, Some(BOILED));

    // Shown, never written: the log still says what it was told.
    let stored = store::day(&uc, DAY).unwrap();
    let s = by_id(&stored, &boiled);
    assert_eq!(
        (s.description.as_str(), s.name.as_deref()),
        (boiled_desc.as_str(), None)
    );
}

#[test]
fn an_entry_whose_wording_the_dataset_no_longer_has_keeps_its_own() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    // Logged under wording a later dataset changed. A name worked out from
    // today's data would be today's claim about that day.
    let reworded = food(
        &rc,
        &mut uc,
        BOILED,
        "Mungo beans, mature seeds, boiled (old wording)",
    );
    let (entries, _, _) = named_day(&rc, uc);
    assert_eq!(by_id(&entries, &reworded).name, None);

    // And under an id a later dataset dropped, or gave to another food.
    let index = family::index(&rc).unwrap();
    assert_eq!(
        index.entry_name(999_999_999, "A food the dataset has since dropped"),
        None
    );
    assert_eq!(
        index.entry_name(RAW, &base_description(&rc, BOILED).unwrap()),
        None
    );
}

fn own_food() -> store::CustomFood {
    store::CustomFood {
        id: String::new(),
        name: "Mungo beans, mature seeds, raw".into(),
        brand: Some("Pack".into()),
        overrides_fdc_id: None,
        serving_g: 30.0,
        serving_ml: None,
        serving_pieces: None,
        piece_noun: None,
        serving_label: None,
        ingredients: None,
        barcode: None,
        photo_label: None,
        photo_ingredients: None,
        nutrients: vec![store::CustomNutrient {
            nutrient_id: 1004,
            kind: "measured".into(),
            amount: Some(1.0),
            upper: None,
            printed_pct: None,
            label_form: None,
        }],
        import_only: false,
        dv_basis: "current".into(),
    }
}

fn tablet() -> store::Supplement {
    store::Supplement {
        id: String::new(),
        name: "B12".into(),
        brand: None,
        unit_noun: "tablet".into(),
        serving_units: 1.0,
        serving_label: None,
        default_units: Some(1.0),
        regime: "us".into(),
        panel_complete: false,
        other_ingredients: None,
        barcode: None,
        photo_panel: None,
        photo_ingredients: None,
        nutrients: vec![store::SupplementNutrient {
            nutrient_id: 1178,
            position: 0,
            label_amount: 500.0,
            label_unit: "ug".into(),
            label_form: "unspecified".into(),
            kind: "measured".into(),
            amount: Some(500.0),
            upper: None,
            convert_note: None,
        }],
    }
}

fn line(position: i64, fdc_id: i64, description: &str) -> store::RecipeIngredient {
    store::RecipeIngredient {
        id: String::new(),
        position,
        fdc_id: Some(fdc_id),
        custom_food_id: None,
        description: description.into(),
        raw_g: 200.0,
        optional: false,
        to_taste: false,
    }
}

#[test]
fn a_pack_a_dish_a_dose_and_water_keep_their_names_and_a_dish_names_its_lines() {
    let Some(rc) = refdb() else { return };
    let mut uc = user_db();
    let tags = store::Tags::default();
    let raw_desc = base_description(&rc, RAW).unwrap();

    // Named exactly as a reference row, and still the user's own name for it.
    let cid = store::save_custom_food(&mut uc, None, &own_food()).unwrap();
    let pack = add_frozen(
        &rc,
        &mut uc,
        DAY,
        Some("snack"),
        store::Source::Custom(&cid),
        &raw_desc,
        store::Quantity::Grams(30.0),
        None,
        &tags,
    )
    .unwrap();

    // One line as the recipe builder writes it, the full USDA wording; one
    // in words of the user's own, which no dataset row carries.
    let lines = [line(0, RAW, &raw_desc), line(1, BOILED, "urad dal")];
    let rid = store::save_recipe(&mut uc, "Dal", 800.0, None, None, &lines, &[], &tags).unwrap();
    let dish = add_frozen(
        &rc,
        &mut uc,
        DAY,
        Some("lunch"),
        store::Source::Recipe(&rid),
        "Dal",
        store::Quantity::Grams(200.0),
        None,
        &tags,
    )
    .unwrap();

    let sid = store::save_supplement(&mut uc, None, &tablet()).unwrap();
    let dose = add_frozen(
        &rc,
        &mut uc,
        DAY,
        Some("breakfast"),
        store::Source::Supplement(&sid),
        "B12",
        store::Quantity::Units(1.0),
        None,
        &tags,
    )
    .unwrap();

    let bid = store::save_bottle(&uc, None, "Steel bottle", 1050.0, None, None).unwrap();
    let bottle = store::add(
        &uc,
        DAY,
        None,
        store::Source::Water(&bid),
        "Steel bottle",
        store::Quantity::Grams(500.0),
        None,
        &tags,
    )
    .unwrap();

    let (entries, breakdowns, _) = named_day(&rc, uc);
    for id in [&pack, &dish, &dose, &bottle] {
        let e = by_id(&entries, id);
        assert_eq!(
            e.name, None,
            "a {} keeps the name it was logged under",
            e.source_kind
        );
    }
    let parts = |id: &str| {
        let b = breakdowns
            .iter()
            .find(|b| b.entry_id == id)
            .expect("a breakdown per entry");
        b.components
            .iter()
            .map(|c| c.name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        parts(&dish),
        vec![Some("Mungo beans, raw".to_string()), None]
    );
    assert!(
        parts(&pack).iter().all(Option::is_none),
        "a pack's provenance line"
    );
    assert!(
        parts(&dose).iter().all(Option::is_none),
        "a dose's panel line"
    );
}

#[test]
fn a_quick_add_row_and_its_widget_tile_are_named_as_search_names_the_food() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let tags = store::Tags::default();
    let boiled_desc = base_description(&rc, BOILED).unwrap();
    for on in ["2026-09-01", "2026-09-02"] {
        store::add(
            &uc,
            on,
            Some("lunch"),
            store::Source::Food(BOILED),
            &boiled_desc,
            store::Quantity::Grams(150.0),
            None,
            &tags,
        )
        .unwrap();
    }
    let mut own = own_food();
    own.name = "Haldiram's moong dal".into();
    let mut uc = uc;
    let cid = store::save_custom_food(&mut uc, None, &own).unwrap();
    for on in ["2026-09-01", "2026-09-02"] {
        store::add(
            &uc,
            on,
            Some("snack"),
            store::Source::Custom(&cid),
            "Haldiram's moong dal",
            store::Quantity::Grams(30.0),
            None,
            &tags,
        )
        .unwrap();
    }

    let candidates = store::frequent_foods(&uc, "2026-08-01", 6).unwrap();
    let rows = resolve_frequent(&rc, Some(&family::index(&rc).unwrap()), candidates, &[], 6);
    let urad = rows
        .iter()
        .find(|r| r.fdc_id == Some(BOILED))
        .expect("the boiled urad row");
    assert_eq!(urad.name.as_deref(), Some("Mungo beans, boiled"));
    assert_eq!(urad.description, boiled_desc, "what a tap logs");
    let pack = rows
        .iter()
        .find(|r| r.custom_food_id.is_some())
        .expect("the pack's row");
    assert_eq!(pack.name, None);

    // The tile says what the chip says, and its file keeps its shape: a label
    // and the identity a tap hands back, nothing more.
    let tile = widgets::quickadd_from(&rows, "4 Oct 2026, 09:00");
    let labels: Vec<&str> = tile.foods.iter().map(|f| f.label.as_str()).collect();
    assert!(labels.contains(&"Mungo beans, boiled"), "{labels:?}");
    assert!(labels.contains(&"Haldiram's moong dal"), "{labels:?}");
    let json = serde_json::to_string(&tile).unwrap();
    assert!(
        !json.contains("mature seeds") && !json.contains("\"name\""),
        "{json}"
    );
}

#[test]
fn without_an_index_a_quick_add_list_is_still_read_in_full_words() {
    // A short name is a nicety beside what was logged. A reference database
    // the index cannot be built from leaves the day, the list and the
    // correction sheet to their stored descriptions instead of refusing them.
    let unreadable = db::Db(Mutex::new(Connection::open_in_memory().unwrap()));
    assert!(family_index(&unreadable).is_none());

    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let boiled_desc = base_description(&rc, BOILED).unwrap();
    store::add(
        &uc,
        DAY,
        Some("lunch"),
        store::Source::Food(BOILED),
        &boiled_desc,
        store::Quantity::Grams(150.0),
        None,
        &store::Tags::default(),
    )
    .unwrap();
    let candidates = store::frequent_foods(&uc, "2026-08-01", 6).unwrap();
    let rows = resolve_frequent(&rc, None, candidates, &[], 6);
    assert_eq!(rows.len(), 1, "the row is still offered");
    assert_eq!(
        (rows[0].name.as_deref(), rows[0].description.as_str()),
        (None, boiled_desc.as_str())
    );
}
