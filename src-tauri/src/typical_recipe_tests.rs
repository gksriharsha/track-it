//! Typical home recipes (`tools/typical_dishes.py`): found by the names a
//! Telugu kitchen uses, in place of USDA's own version of the dish, and valued
//! from their lines the way a portion of a recipe is.

use std::sync::Mutex;

use rusqlite::Connection;
use trackit_core::aggregate::sum;

use crate::family_tests::{refdb, user_db};
use crate::{add_frozen, collect_day, db, merge_hits_shaped, nutrient_dim, per_100g_of, store};

const IDLI: i64 = 100_000_001;
const USDA_IDLI: i64 = 2_708_346;
const GARELU: i64 = 100_000_006;
const USDA_VADA: i64 = 2_709_130;
const DAY: &str = "2026-10-23";

/// The Food screen's search (`dishes`), or an ingredient picker's.
fn hits(rc: &Connection, uc: &Connection, q: &str, dishes: bool) -> Vec<i64> {
    let replaced = db::replaced_ids(rc).unwrap();
    merge_hits_shaped(rc, uc, q, vec![], &replaced, false, 40, false, dishes)
        .unwrap()
        .iter()
        .filter_map(|h| h.fdc_id)
        .collect()
}

#[test]
fn a_dish_is_found_by_its_telugu_name_and_usdas_version_is_not() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let garelu = hits(&rc, &uc, "minapa garelu", true);
    assert_eq!(garelu.first(), Some(&GARELU), "{garelu:?}");
    let vada = hits(&rc, &uc, "vada", true);
    assert!(vada.contains(&GARELU) && !vada.contains(&USDA_VADA), "{vada:?}");
    let idli = hits(&rc, &uc, "idli", true);
    assert!(idli.contains(&IDLI) && !idli.contains(&USDA_IDLI), "{idli:?}");
}

#[test]
fn an_ingredient_picker_never_offers_a_typical_recipe() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    for q in ["pappu", "sambar", "rice", "idli"] {
        let found = hits(&rc, &uc, q, false);
        assert!(found.iter().all(|f| *f < 100_000_000), "{q}: {found:?}");
    }
}

#[test]
fn a_typical_recipe_stays_a_dish_of_its_own_beside_usdas_entry_of_the_same_name() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    // With the replaced entry let back in, the two are two rows, not two forms.
    let both = merge_hits_shaped(&rc, &uc, "idli", vec![], &[], true, 40, false, true).unwrap();
    let typical = both.iter().find(|h| h.fdc_id == Some(IDLI)).expect("typical idli");
    assert!(typical.forms.is_empty());
    assert!(both.iter().any(|h| h.fdc_id == Some(USDA_IDLI)));
}

#[test]
fn a_portion_is_its_lines_share_of_the_batch_with_no_water_and_no_figure_of_its_own() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let recipe = db::typical_recipe(&rc, IDLI).unwrap().unwrap();
    assert_eq!(recipe.piece_noun.as_deref(), Some("idli"));
    assert!(db::typical_recipe(&rc, USDA_IDLI).unwrap().is_none());
    let (snap, parts) =
        crate::resolve_contribution(&rc, &uc, store::Source::Food(IDLI), "Idli", store::Quantity::Grams(80.0))
            .unwrap();
    assert_eq!(snap.unwrap().yield_g, recipe.cooked_g);
    let fed: Vec<_> = recipe.lines.iter().filter(|l| l.role != "water").collect();
    assert_eq!(parts.len(), fed.len());
    for (c, l) in parts.iter().zip(fed) {
        let store::SnapQuantity::Grams(g) = c.quantity else { panic!("{c:?}") };
        assert!((g - l.raw_g * 80.0 / recipe.cooked_g).abs() < 1e-9);
    }
    // 2 idlis: about 120 kcal, and every line of this dish has an energy value.
    let per100 = per_100g_of(&rc, &uc, store::Source::Food(IDLI)).unwrap();
    assert!((140.0..160.0).contains(&per100.energy.lower), "{:?}", per100.energy);
    assert_eq!(per100.energy.coverage, Some(1.0));
}

#[test]
fn a_logged_dish_keeps_its_values_when_the_recipe_changes_afterwards() {
    let Some(rc) = refdb() else { return };
    // A writable copy, so the recipe can be changed under the entry.
    let mut copy = Connection::open_in_memory().unwrap();
    rusqlite::backup::Backup::new(&rc, &mut copy)
        .unwrap()
        .run_to_completion(256, std::time::Duration::ZERO, None)
        .unwrap();
    let mut uc = user_db();
    let tags = store::Tags { origin: None, cuisine: None };
    add_frozen(&copy, &mut uc, DAY, Some("breakfast"), store::Source::Food(IDLI), "Idli",
        store::Quantity::Grams(80.0), None, &tags)
        .unwrap();
    let dim = nutrient_dim(&copy).unwrap();
    let user = store::Store(Mutex::new(uc));
    let energy = |rc: &Connection| {
        let (_, _, by_nutrient) = collect_day(rc, &user, &dim, DAY).unwrap();
        sum(&by_nutrient[&1008]).lower
    };
    let before = energy(&copy);
    copy.execute("UPDATE food_recipes SET cooked_g = cooked_g * 2 WHERE fdc_id = ?1", [IDLI])
        .unwrap();
    assert_eq!(energy(&copy), before);
    assert!((110.0..130.0).contains(&before), "{before}");
}
