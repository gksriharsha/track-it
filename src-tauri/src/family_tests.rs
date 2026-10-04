//! Search against the bundled reference database: one row per food, its forms
//! chosen on the amount panel. These pin the decisions the grouping was chosen
//! for, food by food, so a vocabulary change that breaks one shows up here.

use std::path::PathBuf;

use rusqlite::Connection;

use crate::{db, forms_of, merge_hits_shaped, store};

/// The bundled reference database, or `None` when it has not been built yet
/// (`python3 tools/build_reference_db.py`).
pub(crate) fn refdb() -> Option<Connection> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("usda_core.db");
    if !p.exists() {
        eprintln!("skipping: {} not built", p.display());
        return None;
    }
    db::open(&p).ok()
}

/// An empty user database in the shape the app runs with.
pub(crate) fn user_db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", "ON").unwrap();
    c.execute_batch(store::SCHEMA).unwrap();
    store::ensure_device_identity(&c).unwrap();
    store::install_sync_triggers(&c).unwrap();
    c
}

/// A plain food logged at a given instant.
pub(crate) fn log(uc: &Connection, fdc_id: i64, at: &str) {
    uc.execute(
        "INSERT INTO log_entries (id, logged_on, meal, source_kind, fdc_id, description, grams,
                                  created_at, updated_at)
         VALUES (?1, substr(?3, 1, 10), 'lunch', 'food', ?2, 'logged', 100, ?3, ?3)",
        rusqlite::params![format!("e{fdc_id}{at}"), fdc_id, at],
    )
    .unwrap();
}

pub(crate) fn search(rc: &Connection, uc: &Connection, q: &str, limit: u32) -> Vec<db::FoodHit> {
    let overridden = store::overridden_fdc_ids(uc).unwrap();
    merge_hits_shaped(rc, uc, q, vec![], &overridden, false, limit, false).unwrap()
}

fn flat(rc: &Connection, uc: &Connection, q: &str, limit: u32) -> Vec<db::FoodHit> {
    let overridden = store::overridden_fdc_ids(uc).unwrap();
    merge_hits_shaped(rc, uc, q, vec![], &overridden, false, limit, true).unwrap()
}

/// The entry an fdc_id is offered under, as the row itself or as one of its forms.
pub(crate) fn entry_of(hits: &[db::FoodHit], fdc: i64) -> Option<&db::FoodHit> {
    hits.iter()
        .find(|h| h.fdc_id == Some(fdc) || h.forms.iter().any(|f| f.fdc_id == fdc))
}

pub(crate) fn forms(h: &db::FoodHit) -> Vec<(i64, &str)> {
    h.forms
        .iter()
        .map(|f| (f.fdc_id, f.label.as_str()))
        .collect()
}

/// Every reference row on offer: an entry's forms, or the entry itself when it
/// has none. An entry opens on one of its own forms, so that is not counted twice.
pub(crate) fn offered(hits: &[db::FoodHit]) -> Vec<i64> {
    hits.iter()
        .flat_map(|h| {
            if h.forms.is_empty() {
                h.fdc_id.into_iter().collect::<Vec<_>>()
            } else {
                assert!(
                    h.forms.iter().any(|f| Some(f.fdc_id) == h.fdc_id),
                    "opens on one of its forms"
                );
                h.forms.iter().map(|f| f.fdc_id).collect()
            }
        })
        .collect()
}

pub(crate) const RAW: i64 = 174259;
pub(crate) const BOILED: i64 = 172427;
pub(crate) const SALTED: i64 = 175256;

#[test]
fn mungo_beans_is_one_row_with_its_forms_and_the_salted_twin_folded_away() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let hits = search(&rc, &uc, "mungo beans", 40);
    let mungo: Vec<&db::FoodHit> = hits
        .iter()
        .filter(|h| {
            entry_of(std::slice::from_ref(h), RAW).is_some()
                || entry_of(std::slice::from_ref(h), BOILED).is_some()
        })
        .collect();
    assert_eq!(mungo.len(), 1, "one row for the food, got {hits:#?}");
    let h = mungo[0];
    assert_eq!(h.name.as_deref(), Some("Mungo beans"));
    assert_eq!(forms(h), vec![(RAW, "raw"), (BOILED, "boiled")]);
    assert_eq!(
        h.fdc_id,
        Some(RAW),
        "opens on the first form when nothing says otherwise"
    );
    assert_eq!(
        h.description, "Mungo beans, mature seeds, raw",
        "the full USDA wording is kept"
    );
    assert!(
        !offered(&hits).contains(&SALTED),
        "the kitchen-salted twin is folded away"
    );
    // Folded away, never removed.
    assert_eq!(db::detail(&rc, SALTED).unwrap().fdc_id, SALTED);
}

#[test]
fn urad_dal_opens_on_the_form_the_indian_name_means_and_keeps_the_note() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let hits = search(&rc, &uc, "urad dal", 40);
    let h = entry_of(&hits, BOILED).expect("urad dal finds the mungo beans");
    assert_eq!(forms(h), vec![(RAW, "raw"), (BOILED, "boiled")]);
    assert_eq!(h.fdc_id, Some(BOILED), "the alias names the cooked dal");
    assert_eq!(
        h.note.as_deref(),
        Some("USDA files urad dal under its botanical name, Mungo beans")
    );
    assert!(h.matched_alias);
    assert_eq!(
        hits.iter().filter(|x| x.note.is_some()).count(),
        1,
        "the note is said once"
    );

    let raw = search(&rc, &uc, "urad dal raw", 40);
    assert_eq!(entry_of(&raw, RAW).unwrap().fdc_id, Some(RAW));
}

#[test]
fn asking_for_salt_offers_both_twins_side_by_side() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    for q in ["mungo beans salt", "mungo beans sal"] {
        let hits = search(&rc, &uc, q, 40);
        let h = entry_of(&hits, BOILED).unwrap();
        let f = forms(h);
        let i = f
            .iter()
            .position(|x| *x == (BOILED, "boiled, no salt"))
            .unwrap_or_else(|| panic!("{q}: {f:?}"));
        assert_eq!(
            f.get(i + 1),
            Some(&(SALTED, "boiled, salted")),
            "{q}: salted sits right after its twin"
        );
    }
}

#[test]
fn a_salted_twin_once_logged_stays_on_offer_and_is_what_opens() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    log(&uc, RAW, "2026-09-01T08:00:00Z");
    log(&uc, SALTED, "2026-09-02T08:00:00Z");
    let hits = search(&rc, &uc, "mungo beans", 40);
    let h = entry_of(&hits, SALTED).expect("a choice once made is not taken away");
    assert_eq!(h.fdc_id, Some(SALTED), "it opens on the form last had");
    assert_eq!(
        forms(h),
        vec![(RAW, "raw"), (BOILED, "boiled"), (SALTED, "boiled, salted")]
    );

    // A later raw entry moves it back.
    log(&uc, RAW, "2026-09-03T08:00:00Z");
    assert_eq!(
        entry_of(&search(&rc, &uc, "urad dal", 40), RAW)
            .unwrap()
            .fdc_id,
        Some(RAW)
    );
}

#[test]
fn the_same_food_under_six_ids_is_one_form() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let repeats = [167762, 327699, 747448, 2263887, 2346409, 2709283];
    let hits = search(&rc, &uc, "strawberries", 40);
    let h = entry_of(&hits, 167762).expect("strawberries");
    // The raw berries are one form; canned and frozen are the food's other forms.
    assert_eq!(h.name.as_deref(), Some("Strawberries"));
    assert_eq!(
        forms(h).first(),
        Some(&(167762, "raw")),
        "the SR row is the fullest of the six"
    );
    assert_eq!(h.fdc_id, Some(167762));
    let shown = offered(&hits);
    assert_eq!(
        repeats.iter().filter(|f| shown.contains(f)).count(),
        1,
        "{shown:?}"
    );
    // The other five still resolve.
    for f in repeats {
        db::detail(&rc, f).unwrap();
    }
}

#[test]
fn a_survey_dish_is_its_own_food_never_a_form_of_the_sr_beans() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let hits = search(&rc, &uc, "mung beans", 40);
    let dish = entry_of(&hits, 2707389).expect("survey mung beans, cooked");
    assert!(dish.forms.is_empty(), "{dish:#?}");
    let sr = entry_of(&hits, 174256).expect("SR mung beans");
    assert!(sr.forms.iter().any(|f| f.fdc_id == 174257));
    assert!(!sr.forms.iter().any(|f| f.fdc_id == 2707389));
    assert_ne!(dish.name, sr.name);
}

#[test]
fn spinach_keeps_the_survey_family_apart_from_the_sr_one() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let hits = search(&rc, &uc, "spinach", 40);
    let sr = entry_of(&hits, 168462).expect("Spinach, raw");
    let survey = entry_of(&hits, 2709615).expect("Spinach, fresh, cooked, no added fat");
    assert!(!std::ptr::eq(sr, survey), "two entries");
    assert!(sr
        .forms
        .iter()
        .all(|f| f.description.starts_with("Spinach")));
    assert!(survey.forms.len() >= 2 && sr.forms.len() >= 2);
    assert_eq!(sr.name.as_deref(), Some("Spinach"));
    assert_eq!(
        survey.name.as_deref(),
        Some("Spinach, survey"),
        "the survey row gives way on the name"
    );
    // The baby leaves are a food of their own, named without repeating USDA.
    assert_eq!(
        entry_of(&hits, 1999632).unwrap().name.as_deref(),
        Some("Spinach, baby")
    );
}

#[test]
fn foods_that_only_share_a_word_stay_apart() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let beans = search(&rc, &uc, "beans", 200);
    let kidney = entry_of(&beans, 173744).expect("Beans, kidney, red, raw");
    let snap = entry_of(&beans, 169961).expect("Beans, snap, green, raw");
    assert!(!std::ptr::eq(kidney, snap));

    let cabbage = search(&rc, &uc, "cabbage", 60);
    let pe_tsai = entry_of(&cabbage, 169979).expect("pe-tsai");
    let pak_choi = entry_of(&cabbage, 170390).expect("pak-choi");
    assert!(
        !std::ptr::eq(pe_tsai, pak_choi),
        "pe-tsai and pak-choi are two vegetables"
    );
    assert!(pe_tsai.forms.iter().any(|f| f.fdc_id == 169980));

    let tofu = search(&rc, &uc, "tofu", 60);
    for brand in [172461, 174292, 173787, 173788, 175236, 173786] {
        let h = entry_of(&tofu, brand).unwrap_or_else(|| panic!("brand row {brand} is offered"));
        assert!(
            h.forms.is_empty(),
            "a brand's tofu is not a form of another: {h:#?}"
        );
    }
}

#[test]
fn every_indian_name_reaches_the_food_it_names() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let aliases: Vec<(String, i64)> = rc
        .prepare("SELECT alias, fdc_id FROM food_aliases")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(aliases.len() > 100);
    for (alias, fdc) in aliases {
        let hits = search(&rc, &uc, &alias, 40);
        let h = entry_of(&hits, fdc).unwrap_or_else(|| panic!("{alias:?} does not reach {fdc}"));
        assert!(h.matched_alias, "{alias:?}");
    }
}

#[test]
fn a_replaced_entry_is_never_offered_as_a_form() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    uc.execute(
        "INSERT INTO custom_foods (id, name, overrides_fdc_id, serving_g, created_at, updated_at)
         VALUES ('cf1', 'Our urad', ?1, 100, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')",
        [RAW],
    )
    .unwrap();
    let hits = search(&rc, &uc, "mungo beans", 40);
    assert!(!offered(&hits).contains(&RAW), "{hits:#?}");
    assert_eq!(
        hits[0].custom_food_id.as_deref(),
        Some("cf1"),
        "its stand-in leads"
    );
    let h = entry_of(&hits, BOILED).unwrap();
    assert!(h.forms.is_empty(), "one form left is a single food");
    assert_eq!(h.name.as_deref(), Some("Mungo beans, boiled"));
    assert!(forms_of(&rc, &uc, BOILED).unwrap().forms.is_empty());

    // The base picker still sees it.
    let overridden = store::overridden_fdc_ids(&uc).unwrap();
    let all =
        merge_hits_shaped(&rc, &uc, "mungo beans", vec![], &overridden, true, 40, true).unwrap();
    assert!(all.iter().any(|h| h.fdc_id == Some(RAW)));
}

#[test]
fn the_limit_counts_foods_not_usda_rows() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    for (q, limit) in [("spinach", 6), ("beans", 12), ("rice", 40)] {
        let hits = search(&rc, &uc, q, limit);
        assert_eq!(hits.len(), limit as usize, "{q}: {limit} foods");
        assert!(
            offered(&hits).len() > hits.len(),
            "{q}: and more forms than rows"
        );
        let mut ids = offered(&hits);
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "{q}: no row is offered twice");
    }
}

#[test]
fn flat_lists_every_form_as_its_own_row() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let hits = flat(&rc, &uc, "mungo beans", 40);
    let names: Vec<(Option<i64>, &str)> = hits
        .iter()
        .map(|h| (h.fdc_id, h.name.as_deref().unwrap()))
        .collect();
    assert_eq!(
        names[..2],
        [
            (Some(RAW), "Mungo beans, raw"),
            (Some(BOILED), "Mungo beans, boiled")
        ]
    );
    assert!(hits.iter().all(|h| h.forms.is_empty()));
}

#[test]
fn an_amount_panel_can_list_the_forms_of_whatever_it_opened_on() {
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let f = forms_of(&rc, &uc, BOILED).unwrap();
    assert_eq!(f.name, "Mungo beans");
    assert_eq!(
        f.forms
            .iter()
            .map(|x| (x.fdc_id, x.label.as_str()))
            .collect::<Vec<_>>(),
        vec![(RAW, "raw"), (BOILED, "boiled")]
    );

    let f = forms_of(&rc, &uc, SALTED).unwrap();
    assert_eq!(
        f.forms
            .iter()
            .map(|x| (x.fdc_id, x.label.as_str()))
            .collect::<Vec<_>>(),
        vec![(RAW, "raw"), (BOILED, "boiled"), (SALTED, "boiled, salted")],
        "a salted row opened directly is one of its own forms"
    );

    let f = forms_of(&rc, &uc, 2707389).unwrap();
    assert!(
        f.forms.is_empty(),
        "a food in one form has nothing to switch to"
    );
    assert_eq!(f.name, "Mung beans, cooked");

    // A repeat opened directly stands for its group.
    let f = forms_of(&rc, &uc, 2709283).unwrap();
    assert!(f
        .forms
        .iter()
        .any(|x| x.fdc_id == 2709283 && x.label == "raw"));
    assert!(!f.forms.iter().any(|x| x.fdc_id == 167762));
    assert!(forms_of(&rc, &uc, -1).is_err());
}

/// Writes every query in `TIDY_QUERIES` (one per line) as JSON to `TIDY_OUT`,
/// in the shape the Python prototype dumps, so the port can be diffed against
/// it. `cargo test dump_for_prototype -- --ignored`.
#[test]
#[ignore]
fn dump_for_prototype() {
    let (Ok(qs), Ok(out)) = (std::env::var("TIDY_QUERIES"), std::env::var("TIDY_OUT")) else {
        return;
    };
    let Some(rc) = refdb() else { return };
    let uc = user_db();
    let mut res = serde_json::Map::new();
    for q in std::fs::read_to_string(qs).unwrap().lines() {
        for f in [false, true] {
            let overridden = store::overridden_fdc_ids(&uc).unwrap();
            let hits = merge_hits_shaped(&rc, &uc, q, vec![], &overridden, false, 40, f).unwrap();
            let rows: Vec<serde_json::Value> = hits
                .iter()
                .map(|h| {
                    serde_json::json!([
                        h.fdc_id,
                        h.name,
                        h.forms
                            .iter()
                            .map(|x| serde_json::json!([x.fdc_id, x.label]))
                            .collect::<Vec<_>>()
                    ])
                })
                .collect();
            res.insert(
                format!("{q}|{}", u8::from(f)),
                serde_json::Value::Array(rows),
            );
        }
    }
    let ids: Vec<i64> = rc
        .prepare("SELECT fdc_id FROM foods ORDER BY fdc_id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for f in ids {
        let fam = forms_of(&rc, &uc, f).unwrap();
        let forms: Vec<serde_json::Value> = fam
            .forms
            .iter()
            .map(|x| serde_json::json!([x.fdc_id, x.label]))
            .collect();
        res.insert(format!("@{f}"), serde_json::json!([fam.name, forms]));
    }
    std::fs::write(out, serde_json::to_string(&res).unwrap()).unwrap();
}
