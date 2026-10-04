//! Building the family index: every reference row read once and sorted into
//! salt twins, repeat groups and families.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

use super::forms::{build_family, Facts};
use super::Index;
use crate::tidy::{self, SEP, SURVEY};

/// A kitchen word: salt was added at the stove, so the twin without it is the
/// same food. A product word means the salt came with the product instead.
#[rustfmt::skip]
const KITCHEN: &[&str] = &[
    "cooked", "boiled", "steamed", "baked", "stir-fried", "microwaved", "mashed", "braised",
    "simmered",
];
#[rustfmt::skip]
const PRODUCT: &[&str] = &[
    "canned", "oil-roasted", "oil roasted", "dry-roasted", "dry roasted", "margarine", "butter",
    "spread",
];
/// Methods that, named, make a generic "cooked" redundant when matching twins.
#[rustfmt::skip]
const TWIN_METHODS: &[&str] = &[
    "boiled", "steamed", "baked", "stir-fried", "microwaved", "braised", "simmered", "roasted",
];

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

fn sep() -> String {
    SEP.to_string()
}

/// The repeat rule's singular, which does not know "-oes".
fn sing_word(w: &str) -> String {
    if w.chars().count() > 3 && w.ends_with('s') && !w.ends_with("ss") {
        w[..w.len() - 1].to_string()
    } else {
        w.to_string()
    }
}

/// The repeat key: the same food under several fdc_ids ("Strawberries, raw" six
/// times over) keys the same once case, punctuation, plurals and the order of
/// the later segments are set aside.
pub(super) fn repeat_key(d: &str) -> String {
    let s = tidy::norm(d).replace(['-', '/'], " ");
    let s: String = s
        .chars()
        .filter(|&c| tidy::is_word_char(c) || c.is_whitespace() || c == ',')
        .collect();
    let s = tidy::collapse_ws(&s);
    let parts: Vec<String> = s
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| {
            p.split_whitespace()
                .map(sing_word)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    let Some((first, rest)) = parts.split_first() else {
        return String::new();
    };
    let mut rest = rest.to_vec();
    rest.sort();
    std::iter::once(first.clone())
        .chain(rest)
        .collect::<Vec<_>>()
        .join(&sep())
}

/// What a salted row and its unsalted twin share once the salt statement, a
/// "drained" and a generic "cooked" beside a named method are set aside.
fn twin_bag(segs: &[String], normed: &str, drop: &str) -> String {
    let method = tidy::has_word(normed, TWIN_METHODS);
    let mut out: Vec<&str> = segs
        .iter()
        .map(String::as_str)
        .filter(|x| *x != drop && *x != "drained" && !(method && *x == "cooked"))
        .collect();
    out.sort();
    out.join(&sep())
}

/// Whether two rows that read alike disagree on what they are made of: energy
/// beyond max(12%, 10 kcal), fat or protein beyond max(25%, 1 g), sodium beyond
/// max(50%, 50 mg). A survey dish that differs like this is a recipe, not a copy
/// of the SR row, and keeps its own row ("Broccoli, chinese, cooked": 0.7 g fat
/// in SR, 3.4 g in the survey).
fn material(conn: &Connection, a: i64, b: i64) -> Result<bool, String> {
    let mut stmt = conn
        .prepare_cached("SELECT amount FROM food_nutrients WHERE fdc_id = ?1 AND nutrient_id = ?2")
        .map_err(err)?;
    for (n, rel, abs) in [
        (1008, 0.12, 10.0),
        (1004, 0.25, 1.0),
        (1003, 0.25, 1.0),
        (1093, 0.5, 50.0),
    ] {
        let mut get = |f: i64| match stmt.query_row(rusqlite::params![f, n], |r| r.get(0)) {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        };
        let (Some(va), Some(vb)): (Option<f64>, Option<f64>) = (get(a)?, get(b)?) else {
            continue;
        };
        let (d, m) = ((va - vb).abs(), va.max(vb));
        if m > 0.0 && d / m > rel && d > abs {
            return Ok(true);
        }
    }
    Ok(false)
}

/// How much a row knows: energy measured, then how many displayed nutrients
/// are measured, then how many portions it offers.
fn fullness(conn: &Connection, f: i64) -> Result<(bool, i64, i64), String> {
    let (n, energy): (i64, i64) = conn
        .prepare_cached(
            "SELECT COUNT(*), COALESCE(MAX(fn.nutrient_id = 1008), 0)
             FROM food_nutrients fn JOIN nutrients n ON n.id = fn.nutrient_id
             WHERE fn.fdc_id = ?1 AND n.role = 'primary'
               AND fn.value_kind NOT IN ('assumed_zero','zero_unknown')",
        )
        .map_err(err)?
        .query_row([f], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(err)?;
    let portions: i64 = conn
        .prepare_cached("SELECT COUNT(*) FROM food_portions WHERE fdc_id = ?1")
        .map_err(err)?
        .query_row([f], |r| r.get(0))
        .map_err(err)?;
    Ok((energy != 0, n, portions))
}

type Row = (i64, String, String);

impl Index {
    pub fn build(conn: &Connection) -> Result<Index, String> {
        let rows: Vec<Row> = conn
            .prepare("SELECT fdc_id, description, data_type FROM foods ORDER BY fdc_id")
            .map_err(err)?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        let mut aliases: HashMap<String, Vec<i64>> = HashMap::new();
        let mut noted: HashSet<i64> = HashSet::new();
        let alias_rows: Vec<(String, i64, Option<String>)> = conn
            .prepare("SELECT alias, fdc_id, note FROM food_aliases")
            .map_err(err)?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        for (alias, f, note) in alias_rows {
            aliases.entry(alias).or_default().push(f);
            if note.is_some() {
                noted.insert(f);
            }
        }
        let alias_ids: HashSet<i64> = aliases.values().flatten().copied().collect();
        let foods: HashMap<i64, (String, String)> = rows
            .iter()
            .map(|(f, d, t)| (*f, (d.clone(), t.clone())))
            .collect();

        // A description no row outside the survey carries.
        let fold = |d: &str| tidy::collapse_ws(d).to_lowercase();
        let mut fold_types: HashMap<String, HashSet<&str>> = HashMap::new();
        for (_, d, t) in &rows {
            fold_types.entry(fold(d)).or_default().insert(t);
        }
        let survey_only = |d: &str| {
            fold_types
                .get(&fold(d))
                .is_some_and(|s| s.len() == 1 && s.contains(SURVEY))
        };

        let salt_twin = salt_twins(&rows);
        let salt_base: HashSet<i64> = salt_twin.values().copied().collect();
        let (canon, members, apart) = repeat_groups(conn, &rows, &alias_ids, &noted)?;

        // Family keys, from each group's canonical member so a group is never
        // split between two families.
        let mut canons: Vec<i64> = members.keys().copied().collect();
        canons.sort_unstable();
        let mut by_key: Vec<(String, Vec<i64>)> = Vec::new();
        let mut slot: HashMap<String, usize> = HashMap::new();
        for &c in &canons {
            let d = &foods[&c].0;
            let mut k = tidy::identity(d, survey_only(d));
            if apart.contains(&c) && tidy::names_fn_cooked(d) && !k.iter().any(|x| x == "~fndds") {
                k.push("~fndds".into());
            }
            let k = k.join(&sep());
            let i = *slot.entry(k.clone()).or_insert_with(|| {
                by_key.push((k, Vec::new()));
                by_key.len() - 1
            });
            by_key[i].1.push(c);
        }
        // Two different lower-case parentheticals in one family name two foods:
        // pe-tsai and pak-choi are both "Cabbage, chinese" until they are read.
        let mut key_of: HashMap<i64, String> = HashMap::new();
        for (k, cs) in &by_key {
            let ps: Vec<Vec<String>> = cs.iter().map(|c| tidy::lower_parens(&foods[c].0)).collect();
            let mut distinct: Vec<&Vec<String>> = ps.iter().filter(|p| !p.is_empty()).collect();
            distinct.sort();
            distinct.dedup();
            for (c, p) in cs.iter().zip(&ps) {
                let key = if distinct.len() >= 2 && !p.is_empty() {
                    format!("{k}{SEP}{SEP}{}", p.join(&sep()))
                } else {
                    k.clone()
                };
                key_of.insert(*c, key);
            }
        }
        // A salted row belongs with its unsalted twin, so it can sit beside it.
        for (h, t) in &salt_twin {
            if let Some(k) = key_of.get(&canon[t]).cloned() {
                key_of.insert(canon[h], k);
            }
        }
        let mut fam_order: Vec<&String> = Vec::new();
        let mut fam_canons: HashMap<&String, Vec<i64>> = HashMap::new();
        for c in &canons {
            let k = &key_of[c];
            if !fam_canons.contains_key(k) {
                fam_order.push(k);
            }
            fam_canons.entry(k).or_default().push(*c);
        }
        // Energy as `fullness` counts it: a figure, measured or a measured zero.
        let energy: HashSet<i64> = conn
            .prepare(
                "SELECT fdc_id FROM food_nutrients WHERE nutrient_id = 1008
                   AND value_kind NOT IN ('assumed_zero','zero_unknown')",
            )
            .map_err(err)?
            .query_map([], |r| r.get(0))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        let facts = Facts {
            foods: &foods,
            salt_twin: &salt_twin,
            salt_base: &salt_base,
            canon: &canon,
            energy: &energy,
            alias_ids: &alias_ids,
        };
        let mut families = Vec::with_capacity(fam_order.len());
        let mut family_of = HashMap::new();
        for k in fam_order {
            let fam = build_family(&fam_canons[k], &facts);
            for fm in &fam.forms {
                family_of.insert(fm.canon, families.len());
            }
            families.push(fam);
        }
        Ok(Index {
            foods,
            salt_twin,
            canon,
            members,
            family_of,
            families,
            aliases,
        })
    }
}

/// Each kitchen-salted row ("…, cooked, boiled, with salt") and the row cooked
/// the same way without it. Only kitchen salt: a canned or roasted product
/// sold salted is a different product, not the same food with a pinch added.
fn salt_twins(rows: &[Row]) -> HashMap<i64, i64> {
    let parsed: HashMap<i64, (Vec<String>, String)> = rows
        .iter()
        .map(|(f, d, _)| (*f, (tidy::segs(d), tidy::norm(d))))
        .collect();
    let salted = |f: &i64| parsed[f].0.iter().any(|x| x == "with salt");
    let mut bag: HashMap<String, Vec<i64>> = HashMap::new();
    for (f, _, _) in rows.iter().filter(|(f, _, _)| !salted(f)) {
        let (s, n) = &parsed[f];
        bag.entry(twin_bag(s, n, "without salt"))
            .or_default()
            .push(*f);
    }
    let types: HashMap<i64, &str> = rows.iter().map(|(f, _, t)| (*f, t.as_str())).collect();
    let mut out = HashMap::new();
    for (f, _, t) in rows {
        let (s, n) = &parsed[f];
        if !salted(f) || !tidy::has_word(n, KITCHEN) || tidy::has_word(n, PRODUCT) {
            continue;
        }
        let Some(ts) = bag.get(&twin_bag(s, n, "with salt")) else {
            continue;
        };
        // The one that says "without salt", then the same data type, then the
        // lowest id.
        let best = ts.iter().copied().filter(|g| g != f).min_by_key(|g| {
            let says = parsed[g].0.iter().any(|x| x == "without salt");
            (!says, types[g] != t.as_str(), *g)
        });
        if let Some(g) = best {
            out.insert(*f, g);
        }
    }
    out
}

type Groups = (HashMap<i64, i64>, HashMap<i64, Vec<i64>>, HashSet<i64>);

/// Rows that are the same food under several fdc_ids, each mapped to the one
/// that represents it, with each group's members. Also returns the survey rows
/// kept apart because their numbers disagree with the SR row they read like.
fn repeat_groups(
    conn: &Connection,
    rows: &[Row],
    alias_ids: &HashSet<i64>,
    noted: &HashSet<i64>,
) -> Result<Groups, String> {
    let mut keys: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, Vec<(i64, bool)>> = HashMap::new();
    for (f, d, t) in rows {
        let k = repeat_key(d);
        if !by_key.contains_key(&k) {
            keys.push(k.clone());
        }
        by_key.entry(k).or_default().push((*f, t == SURVEY));
    }
    // The alias target with a note, then any alias target, then the fullest
    // row, then the lowest id.
    let canon_of = |v: &[i64]| -> Result<i64, String> {
        let mut al: Vec<i64> = v
            .iter()
            .copied()
            .filter(|f| alias_ids.contains(f))
            .collect();
        if !al.is_empty() {
            al.sort_by_key(|f| (!noted.contains(f), *f));
            return Ok(al[0]);
        }
        if v.len() == 1 {
            return Ok(v[0]);
        }
        let mut best = (v[0], fullness(conn, v[0])?);
        for &f in &v[1..] {
            let full = fullness(conn, f)?;
            if full > best.1 || (full == best.1 && f < best.0) {
                best = (f, full);
            }
        }
        Ok(best.0)
    };
    let (mut canon, mut members, mut apart) = (HashMap::new(), HashMap::new(), HashSet::new());
    for k in keys {
        let v = &by_key[&k];
        let nf: Vec<i64> = v.iter().filter(|x| !x.1).map(|x| x.0).collect();
        let fnr: Vec<i64> = v.iter().filter(|x| x.1).map(|x| x.0).collect();
        let mut groups: Vec<Vec<i64>> = Vec::new();
        if !nf.is_empty() && !fnr.is_empty() {
            // A survey row joins the SR/Foundation rows only if its numbers agree.
            let c = canon_of(&nf)?;
            let mut joined = nf.clone();
            for &f in &fnr {
                if material(conn, c, f)? {
                    apart.insert(f);
                    groups.push(vec![f]);
                } else {
                    joined.push(f);
                }
            }
            groups.push(joined);
        } else {
            groups.push(v.iter().map(|x| x.0).collect());
        }
        for mut g in groups {
            let c = canon_of(&g)?;
            g.sort_unstable();
            for &f in &g {
                canon.insert(f, c);
            }
            members.insert(c, g);
        }
    }
    Ok((canon, members, apart))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_key_alike_across_case_plural_and_order() {
        assert_eq!(
            repeat_key("Strawberries, raw"),
            repeat_key("strawberries, Raw")
        );
        assert_eq!(repeat_key("Bananas, raw"), repeat_key("Banana, raw"));
        assert_eq!(
            repeat_key("Yogurt, plain, whole milk"),
            repeat_key("Yogurt, whole milk, plain")
        );
        assert_ne!(repeat_key("Spinach, raw"), repeat_key("Spinach, boiled"));
    }

    #[test]
    fn twins_match_on_everything_but_the_salt() {
        let salted = "Mungo beans, mature seeds, cooked, boiled, with salt";
        let plain = "Mungo beans, mature seeds, cooked, boiled, without salt";
        let bag = |d: &str, drop| twin_bag(&tidy::segs(d), &tidy::norm(d), drop);
        assert_eq!(bag(salted, "with salt"), bag(plain, "without salt"));
        assert!(tidy::has_word(&tidy::norm(salted), KITCHEN));
        assert!(tidy::has_word(
            "peanuts, all types, oil-roasted, with salt",
            PRODUCT
        ));
    }
}
