//! What a food's forms default to, against the bundled reference database: the
//! first form, which a recipe or a pot takes because it weighs everything raw;
//! the form the Food screen opens on, which only a logged entry moves; and the
//! words a form is offered under. Each test pins a case review found wrong.

use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;

use crate::family_tests::{entry_of, forms, log, refdb, search, user_db, BOILED, RAW, SALTED};
use crate::{db, family, forms_of, search_foods_in, store};

/// Every family once, as `food_forms` gives it for each of its rows.
fn families(rc: &Connection, uc: &Connection) -> Vec<db::FoodFamily> {
    let ids: Vec<i64> = rc
        .prepare("SELECT fdc_id FROM foods ORDER BY fdc_id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for f in ids {
        let fam = forms_of(rc, uc, f).unwrap();
        let key: Vec<i64> = fam.forms.iter().map(|x| x.fdc_id).collect();
        if fam.forms.len() >= 2 && seen.insert(key) {
            out.push(fam);
        }
    }
    out
}

fn uncooked(label: &str) -> bool {
    label
        .split(',')
        .map(str::trim)
        .any(|s| ["raw", "dry", "uncooked", "unroasted"].contains(&s))
}

#[test]
fn a_food_that_comes_uncooked_offers_that_form_first() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let mut wrong = Vec::new();
    for fam in families(&rc, &uc) {
        let first = &fam.forms[0];
        // "plain" is an SR or Foundation row with nothing to add, which is the
        // food as bought ("Nuts, pecans", 691 kcal, ahead of a Foundation row
        // with no energy figure); a bare survey row says "as eaten" instead.
        let ok = uncooked(&first.label) || first.label == "plain";
        if !ok && fam.forms.iter().any(|f| uncooked(&f.label)) {
            wrong.push(format!("{}: {:?}", fam.name, forms_of_labels(&fam)));
        }
    }
    assert!(wrong.is_empty(), "{} families: {wrong:#?}", wrong.len());

    // What a recipe picker searching these takes: the raw row, not the survey's
    // cooked dish (millet 118 kcal cooked against 378 raw; ground chicken 201
    // against 143).
    for (q, raw) in [
        ("millet", 169702),
        ("ground chicken", 171116),
        ("turkey ground", 171505),
        ("buckwheat groats", 170685),
        ("tamarind", 167763),
    ] {
        let hits = search(&rc, &uc, q, 8);
        let h = entry_of(&hits, raw).unwrap_or_else(|| panic!("{q} finds {raw}"));
        assert_eq!(h.forms[0].fdc_id, raw, "{q}: {:?}", forms(h));
    }
    // Survey nuts: the unroasted ones lead, and unsalted comes before salted.
    let almonds = forms_of(&rc, &uc, 2707487).unwrap();
    assert_eq!(
        forms_of_labels(&almonds),
        vec!["unroasted", "unsalted", "salted", "lightly salted"]
    );
}

fn forms_of_labels(fam: &db::FoodFamily) -> Vec<&str> {
    fam.forms.iter().map(|f| f.label.as_str()).collect()
}

#[test]
fn a_bare_survey_row_is_offered_as_eaten_not_as_plain() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let millet = search(&rc, &uc, "millet", 8);
    let h = entry_of(&millet, 2708377).unwrap();
    assert_eq!(
        forms(h),
        vec![(169702, "raw"), (168871, "cooked"), (2708377, "as eaten")]
    );
    for fam in families(&rc, &uc) {
        for f in &fam.forms {
            assert!(
                !["survey", "nfs"].contains(&f.label.as_str()),
                "{}: {:?}",
                fam.name,
                forms_of_labels(&fam)
            );
        }
    }
}

#[test]
fn the_form_an_indian_name_means_leads_its_kind() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    // The alias points rava at the unenriched row; the enriched one carries
    // several times the iron (4.36 mg per 100 g against 1.23).
    for q in ["rava", "sooji", "semolina"] {
        let hits = search(&rc, &uc, q, 8);
        let h = entry_of(&hits, 168933).unwrap_or_else(|| panic!("{q}"));
        assert_eq!(h.forms[0].fdc_id, 168933, "{q}: {:?}", forms(h));
    }
    let imli = search(&rc, &uc, "imli", 8);
    assert_eq!(entry_of(&imli, 167763).unwrap().forms[0].fdc_id, 167763);
}

#[test]
fn a_cooked_after_the_method_still_says_cooked() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let hits = search(&rc, &uc, "buckwheat groats", 8);
    let f = forms(entry_of(&hits, 170686).unwrap());
    assert!(f.contains(&(170685, "roasted, dry")), "{f:?}");
    assert!(f.contains(&(170686, "roasted, cooked")), "{f:?}");
}

/// A pot cooked at `cooked_at` with one reference food as its only line.
fn cook_with(uc: &Connection, id: &str, fdc: i64, cooked_at: &str) {
    uc.execute(
        "INSERT INTO cooks (id, name, cooked_on, cooked_at, expected_yield_g, created_at, updated_at)
         VALUES (?1, 'Dal', substr(?2, 1, 10), ?2, 900, ?2, ?2)",
        rusqlite::params![id, cooked_at],
    )
    .unwrap();
    uc.execute(
        "INSERT INTO cook_ingredients (id, cook_id, position, fdc_id, description, planned_g, raw_g)
         VALUES (?1, ?2, 0, ?3, 'ingredient', 200, 200)",
        rusqlite::params![format!("{id}-0"), id, fdc],
    )
    .unwrap();
}

/// A recipe written at `at` with one reference food as its only line.
fn recipe_with(uc: &Connection, id: &str, fdc: i64, at: &str) {
    uc.execute(
        "INSERT INTO recipes (id, name, yield_g, created_at, updated_at)
         VALUES (?1, 'Dal', 900, ?2, ?2)",
        rusqlite::params![id, at],
    )
    .unwrap();
    uc.execute(
        "INSERT INTO recipe_ingredients (id, recipe_id, position, fdc_id, description, raw_g)
         VALUES (?1, ?2, 0, ?3, 'ingredient', 200)",
        rusqlite::params![format!("{id}-0"), id, fdc],
    )
    .unwrap();
}

#[test]
fn only_a_logged_entry_moves_the_form_a_food_opens_on() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let opens = |uc: &Connection| {
        entry_of(&search(&rc, uc, "mungo beans", 40), RAW)
            .unwrap()
            .fdc_id
    };
    cook_with(&uc, "c1", RAW, "2026-08-25T18:00:00Z");
    log(&uc, BOILED, "2026-09-02T12:00:00Z");
    assert_eq!(opens(&uc), Some(BOILED), "the form logged last");

    // Marking the pot empty chooses no food.
    store::finish_cook(&uc, "c1", true).unwrap();
    assert_eq!(opens(&uc), Some(BOILED), "closing a pot is not a choice");

    // Nor does a recipe written after it: its raw urad says how dal is
    // weighed, not that this person now eats it raw.
    recipe_with(&uc, "r1", RAW, "2026-10-03T18:00:00Z");
    uc.execute(
        "UPDATE recipes SET name = 'Urad dal', updated_at = '2026-10-04T08:00:00Z' WHERE id = 'r1'",
        [],
    )
    .unwrap();
    assert_eq!(opens(&uc), Some(BOILED));

    let chosen = store::fdc_choices(&uc).unwrap();
    assert_eq!(
        chosen.logged.keys().copied().collect::<Vec<_>>(),
        vec![BOILED]
    );
    assert_eq!(
        chosen.used.get(&RAW).map(String::as_str),
        Some("2026-10-03T18:00:00Z"),
        "a recipe line is dated by the recipe's creation, not its last edit"
    );
}

#[test]
fn a_salted_twin_put_in_a_recipe_stays_on_offer() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    recipe_with(&uc, "r1", SALTED, "2026-09-01T08:00:00Z");
    let hits = search(&rc, &uc, "mungo beans", 40);
    let h = entry_of(&hits, SALTED).expect("a twin used before is not folded away");
    assert_eq!(h.fdc_id, Some(RAW), "but a recipe line does not open it");
}

#[test]
fn two_foods_of_one_name_are_listed_form_by_form() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    // Survey tuna is two families, raw-or-canned and the cooked dishes, and
    // both would be "Fish, tuna, survey". A family named after the form it
    // opens on would keep saying "raw" over the canned form chosen under it.
    let hits = search(&rc, &uc, "tuna", 40);
    for (fdc, name) in [
        (2706308, "Fish, tuna, raw"),
        (2706311, "Fish, tuna, canned"),
        (2706310, "Fish, tuna, cooked"),
        (2706309, "Fish, tuna, NFS"),
    ] {
        let h = entry_of(&hits, fdc).unwrap_or_else(|| panic!("{fdc}: {hits:#?}"));
        assert!(h.forms.is_empty(), "{h:#?}");
        assert_eq!((h.fdc_id, h.name.as_deref()), (Some(fdc), Some(name)));
    }
    for h in hits.iter().filter(|h| h.forms.len() >= 2) {
        let named_after_one = h.forms.iter().any(|f| {
            Some(f.description.as_str()) == h.name.as_deref()
                && !f.label.is_empty()
                && f.label != "plain"
                && f.label != "as eaten"
        });
        assert!(!named_after_one, "{h:#?}");
    }
    // Opened on its own, the cooked dish says what "NFS" means.
    let f = forms_of(&rc, &uc, 2706310).unwrap();
    assert_eq!(forms_of_labels(&f), vec!["cooked", "unspecified"]);
}

#[test]
fn a_search_waiting_for_the_index_holds_neither_database() {
    let Some(rc) = refdb() else { return };
    let refdb = db::Db(Mutex::new(rc));
    let user = store::Store(Mutex::new(user_db()));
    std::thread::scope(|s| {
        // Stand in for the launch-time build: nobody can read the index cache.
        // Held inside the scope, so a failed assertion releases it before the
        // scope waits for the search.
        let cache = family::hold_index_cache();
        let search = s.spawn(|| search_foods_in(&refdb, &user, "mungo beans", 10, (false, false), false));
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            user.0.try_lock().is_ok(),
            "the user database is free while it waits"
        );
        assert!(
            refdb.0.try_lock().is_ok(),
            "and so is the reference database"
        );
        drop(cache);
        let hits = search.join().unwrap().unwrap();
        assert!(entry_of(&hits, RAW).is_some());
    });
}
