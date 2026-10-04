//! What the words of a USDA description say: which of them name the food, and
//! which only say how it was prepared, salted or which survey coded it.
//!
//! USDA writes one food as many rows — "Mungo beans, mature seeds, raw",
//! "…, cooked, boiled, without salt", "…, cooked, boiled, with salt" — and a
//! search that lists them all makes the user tell near-identical lines apart
//! before they can log anything. `family.rs` folds those rows into one food with
//! several forms; this module is only the reading of a single description that
//! the folding is built on. Nothing here touches a database.
//!
//! Every vocabulary list below was measured against the bundled reference data
//! before it was written down, and the rules are a port of the prototypes the
//! grouping was decided from (families.py, breaker.py, refined.py). Changing a
//! word changes which rows count as one food, so a change belongs in a test in
//! `family_tests.rs` first.

/// The data type of a survey (FNDDS) row. Survey rows describe dishes as eaten,
/// and a cooked one assumes fat and salt, which is why several rules treat them
/// apart.
pub const SURVEY: &str = "survey_fndds_food";

/// Separates the parts of a key held as one string. Never in a description.
pub const SEP: char = '\u{1f}';

/// Salt statements. A twin with and without one is usually sodium apart only.
#[rustfmt::skip]
const SALT_SEGS: &[&str] = &[
    "with salt", "without salt", "with salt added", "without salt added", "no salt added",
    "salted", "unsalted", "lightly salted", "with added salt", "without added salt",
    "low sodium", "reduced sodium", "regular pack", "salt added in processing", "sodium added",
];

/// Preparation and state. A segment made only of one of these says how the food
/// was had, not which food it is.
#[rustfmt::skip]
const STATE_SEGS: &[&str] = &[
    "raw", "cooked", "boiled", "drained", "steamed", "baked", "roasted", "dry roasted",
    "dry-roasted", "oil roasted", "oil-roasted", "stir-fried", "microwaved", "microwave",
    "canned", "frozen", "unprepared", "prepared", "uncooked", "dry", "fresh",
    "solids and liquids", "solids and liquid", "drained solids", "rinsed in tap water",
    "drained solids rinsed in tap water", "drained and rinsed", "heated", "heated in oven",
    "from dried", "from canned", "from frozen", "from fresh", "nfs", "ns as to form",
    "fat added", "no added fat", "ns as to fat", "ns as to fat type", "cooked with oil",
    "cooked with butter or margarine", "made with oil", "made with butter",
    "made with margarine", "cooked, as ingredient", "as ingredient", "unroasted", "mature",
    "boiled with salt",
];

#[rustfmt::skip]
const FORTIFY_SEGS: &[&str] = &[
    "enriched", "unenriched", "fortified", "not fortified", "unfortified",
];

/// Implied by the food's name: dropped so survey "Mung beans, cooked" and SR
/// "Mung beans, mature seeds, cooked, boiled" are read as the same food.
const IMPLIED_SEGS: &[&str] = &["mature seeds"];

/// How a food was cut. Frozen "chopped or leaf" spinach is still spinach.
#[rustfmt::skip]
const CUT_SEGS: &[&str] = &[
    "chopped or leaf", "chopped", "sliced", "diced", "spears", "cut", "florets", "slices",
    "halves", "cubed", "shredded", "pieces", "leaf",
];

/// A first segment that names a class rather than a food. Its second segment is
/// part of the name even when it reads like a preparation: "Beans, baked" is
/// baked beans and "Rice, fried" is fried rice, not forms of beans and rice.
#[rustfmt::skip]
const CLASS_HEADS: &[&str] = &[
    "beans", "bean", "rice", "nuts", "nut", "oil", "oils", "spices", "seeds", "cheese",
    "cereals", "cereal", "snacks", "babyfood", "restaurant", "candies", "beverages", "soup",
    "sauce", "peppers", "squash", "cabbage", "lettuce", "fish", "beef", "pork", "chicken",
    "lamb", "veal", "turkey", "crackers", "cookies", "cake", "bread", "pasta", "noodles",
    "flour", "cereals ready-to-eat", "fast foods", "game meat", "infant formula",
    "salad dressing", "frozen novelties", "puddings", "pie", "pies", "syrups",
    "tomato products", "margarine-like",
];

/// A survey row naming one of these is a cooked recipe that assumes fat and salt
/// unless it says otherwise ("Mung beans, cooked" carries 6.9 g fat per 100 g
/// against 0.4 g for SR boiled mung beans), so it never passes as a form of the
/// SR food.
#[rustfmt::skip]
const FN_COOKED: &[&str] = &[
    "cooked", "baked", "boiled", "roasted", "dry roasted", "from dried", "from canned",
    "from frozen", "from fresh", "nfs", "ns as to form", "fat added", "no added fat",
    "ns as to fat", "ns as to fat type", "cooked with oil", "cooked with butter or margarine",
    "made with oil", "made with butter", "made with margarine", "as ingredient",
    "cooked, as ingredient",
];

const FDP_LOWER: &str = " (includes foods for usda's food distribution program)";
const FDP_CASED: &str = "(Includes foods for USDA's Food Distribution Program)";

fn contains(set: &[&str], s: &str) -> bool {
    set.contains(&s)
}

/// A segment that says nothing about which food this is.
fn strip_set(s: &str) -> bool {
    [SALT_SEGS, STATE_SEGS, FORTIFY_SEGS, IMPLIED_SEGS, CUT_SEGS]
        .iter()
        .any(|set| contains(set, s))
}

pub fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Lower-cased, the food-programme note removed, one space between words.
pub fn norm(d: &str) -> String {
    let s = d
        .to_lowercase()
        .replace(FDP_LOWER, "")
        .replace("boiled. drained", "boiled, drained");
    collapse_ws(&s)
}

/// Split on commas and semicolons that are not inside parentheses.
fn split_top(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    for ch in s.chars() {
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth = (depth - 1).max(0);
        }
        if (ch == ',' || ch == ';') && depth == 0 {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(ch);
        }
    }
    out.push(cur);
    out
}

/// "boiled with salt" written as one segment, split into the method and the salt.
fn glued_salt(part: &str, suffixes: &[&str], ignore_case: bool) -> Option<(String, String)> {
    for suf in suffixes {
        let cut = part.len().wrapping_sub(suf.len());
        if part.len() <= suf.len() || !part.is_char_boundary(cut) {
            continue;
        }
        let tail = &part[cut..];
        if (ignore_case && tail.eq_ignore_ascii_case(suf)) || tail == *suf {
            return Some((part[..cut].to_string(), tail[1..].to_string()));
        }
    }
    None
}

/// The lower-cased segments the salt-twin rule compares.
pub fn segs(d: &str) -> Vec<String> {
    let mut out = Vec::new();
    for x in split_top(&norm(d)) {
        let x = x.trim();
        if x.is_empty() {
            continue;
        }
        match glued_salt(x, &[" with salt", " without salt"], false) {
            Some((a, b)) => out.extend([a, b]),
            None => out.push(x.to_string()),
        }
    }
    out
}

/// Split on ". " — USDA's "boiled. drained" typo, among others.
fn split_dot_space(s: &str) -> Vec<String> {
    let cs: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '.' && cs.get(i + 1).is_some_and(|c| c.is_whitespace()) {
            out.push(std::mem::take(&mut cur));
            i += 1;
            while cs.get(i).is_some_and(|c| c.is_whitespace()) {
                i += 1;
            }
            continue;
        }
        cur.push(cs[i]);
        i += 1;
    }
    out.push(cur);
    out
}

/// The description's segments in its own casing, which the family name and the
/// form labels are cut from. Capitalised parentheticals are kept whole because
/// survey rows put brands there ("Nutrition bar (PowerBar)").
pub fn segments_cased(desc: &str) -> Vec<String> {
    let mut d = desc.to_string();
    while let Some(i) = d.find(FDP_CASED) {
        d = format!("{}{}", d[..i].trim_end(), &d[i + FDP_CASED.len()..]);
    }
    let salts = [
        " with salt added",
        " without salt added",
        " with salt",
        " without salt",
    ];
    let mut out = Vec::new();
    for s in split_top(&d) {
        let s = collapse_ws(&s);
        let s = s.trim_matches('.');
        if s.is_empty() {
            continue;
        }
        for part in split_dot_space(s) {
            match glued_salt(&part, &salts, true) {
                Some((a, b)) => out.extend([a, b]),
                None => out.push(part),
            }
        }
    }
    out
}

/// Crude singular, so "Mangos" and "Mango" share a key.
fn sing(w: &str) -> String {
    let n = w.chars().count();
    if n > 3 && w.ends_with("oes") {
        w[..w.len() - 2].to_string()
    } else if n > 3 && w.ends_with('s') && !w.ends_with("ss") {
        w[..w.len() - 1].to_string()
    } else {
        w.to_string()
    }
}

fn norm_seg(s: &str) -> String {
    let words = s.split(|c: char| c.is_whitespace() || c == '-');
    words
        .filter(|w| !w.is_empty())
        .map(sing)
        .collect::<Vec<_>>()
        .join(" ")
}

fn opens_lower(cs: &[char], k: usize) -> bool {
    cs[k] == '('
        && cs
            .get(k + 1)
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// Every lower-case parenthetical — "(garbanzo beans, bengal gram)", "(pe-tsai)"
/// — with the space before it.
fn strip_lower_parens(s: &str) -> String {
    let cs: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < cs.len() {
        let mut k = i;
        while cs.get(k).is_some_and(|c| c.is_whitespace()) {
            k += 1;
        }
        if k < cs.len() && opens_lower(&cs, k) {
            if let Some(off) = cs[k + 1..].iter().position(|&c| c == ')') {
                i = k + off + 2;
                continue;
            }
        }
        out.push(cs[i]);
        i += 1;
    }
    out
}

/// The lower-case parentheticals of a description, sorted and distinct. Two of
/// them telling one family apart ("(pe-tsai)", "(pak-choi)") split it in two.
pub fn lower_parens(desc: &str) -> Vec<String> {
    let mut d = desc.to_string();
    while let Some(i) = d.find("(Includes foods") {
        let end = d[i..].find(')').map_or(d.len(), |j| i + j + 1);
        d = format!("{}{}", d[..i].trim_end(), &d[end..]);
    }
    let cs: Vec<char> = d.chars().collect();
    let mut found = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        if opens_lower(&cs, i) {
            if let Some(off) = cs[i + 1..].iter().position(|&c| c == ')') {
                found.push(cs[i..=i + 1 + off].iter().collect::<String>());
                i += off + 2;
                continue;
            }
        }
        i += 1;
    }
    found.sort();
    found.dedup();
    found
}

/// A segment that is nothing but a lower-case parenthetical.
fn is_lower_paren_seg(c: &str) -> bool {
    let cs: Vec<char> = c.chars().collect();
    cs.len() >= 2
        && opens_lower(&cs, 0)
        && cs[cs.len() - 1] == ')'
        && !cs[1..cs.len() - 1].contains(&')')
}

fn key_seg(s: &str) -> String {
    let t = strip_lower_parens(s);
    let t = t.trim();
    norm_seg(&if t.is_empty() { s } else { t }.to_lowercase())
}

/// How many leading segments are the food's name whatever they say.
fn head_len(cased: &[String]) -> usize {
    if cased.len() > 1 && contains(CLASS_HEADS, &cased[0].to_lowercase()) {
        2
    } else {
        1
    }
}

/// Which segments name the food, aligned with `segments_cased`.
pub fn identity_mask(desc: &str) -> (Vec<String>, Vec<bool>) {
    let cased = segments_cased(desc);
    let head = head_len(&cased);
    let mask = cased
        .iter()
        .enumerate()
        .map(|(j, c)| j < head || !(strip_set(&c.to_lowercase()) || is_lower_paren_seg(c)))
        .collect();
    (cased, mask)
}

/// The family key: what food this is, with how it was made removed, folded for
/// case, plurals and lower-case parentheticals, and with the order of the later
/// segments ignored. `survey_only` says no row outside FNDDS carries this
/// description; a cooked survey dish then keys apart from the SR food.
pub fn identity(desc: &str, survey_only: bool) -> Vec<String> {
    let (cased, mask) = identity_mask(desc);
    let head = head_len(&cased);
    let mut key: Vec<String> = Vec::new();
    let mut tail: Vec<String> = Vec::new();
    for (j, c) in cased.iter().enumerate().filter(|(j, _)| mask[*j]) {
        if j < head {
            key.push(key_seg(c));
        } else {
            tail.push(key_seg(c));
        }
    }
    tail.sort();
    tail.dedup();
    key.extend(tail);
    if survey_only && names_fn_cooked(desc) {
        key.push("~fndds".into());
    }
    key
}

/// Whether a description names a cooked survey dish.
pub fn names_fn_cooked(desc: &str) -> bool {
    segments_cased(desc)
        .iter()
        .any(|c| contains(FN_COOKED, &c.to_lowercase()))
}

/// The family's name in USDA's own casing: the segments that name the food.
pub fn family_name(desc: &str) -> String {
    let (cased, mask) = identity_mask(desc);
    let named = cased
        .into_iter()
        .zip(mask)
        .filter(|(_, m)| *m)
        .map(|(c, _)| c);
    named.collect::<Vec<_>>().join(", ")
}

pub fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// A regex `\b(w1|w2|…)\b` search: one of `words` standing as a whole word.
pub fn has_word(hay: &str, words: &[&str]) -> bool {
    words.iter().any(|w| {
        hay.match_indices(w).any(|(i, _)| {
            let before = hay[..i].chars().next_back();
            let after = hay[i + w.len()..].chars().next();
            before.is_none_or(|c| !is_word_char(c)) && after.is_none_or(|c| !is_word_char(c))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_split_outside_parentheses_and_unglue_salt() {
        assert_eq!(
            segments_cased("Chickpeas (garbanzo beans, bengal gram), mature seeds, raw"),
            vec![
                "Chickpeas (garbanzo beans, bengal gram)",
                "mature seeds",
                "raw"
            ]
        );
        assert_eq!(
            segs("Peas, boiled. drained with salt"),
            vec!["peas", "boiled", "drained", "with salt"]
        );
        let fdp = "Oats (Includes foods for USDA's Food Distribution Program)";
        assert_eq!(segments_cased(fdp), vec!["Oats"]);
        assert_eq!(
            segments_cased("Nuts, almonds, dry roasted, With Salt Added")[3],
            "With Salt Added"
        );
    }

    #[test]
    fn a_mungo_bean_reads_as_one_food_with_several_forms() {
        let raw = "Mungo beans, mature seeds, raw";
        let boiled = "Mungo beans, mature seeds, cooked, boiled, without salt";
        let salted = "Mungo beans, mature seeds, cooked, boiled, with salt";
        assert_eq!(identity(raw, false), identity(boiled, false));
        assert_eq!(identity(salted, false), identity(boiled, false));
        assert_eq!(family_name(boiled), "Mungo beans");
    }

    #[test]
    fn a_class_head_keeps_its_second_word_and_brands_stay_apart() {
        assert_ne!(
            identity("Beans, kidney, red, raw", false),
            identity("Beans, snap, green, raw", false)
        );
        let kind = identity("Cereal or granola bar (KIND Fruit and Nut Bar)", false);
        assert_ne!(
            kind,
            identity("Cereal or granola bar (Nature Valley)", false)
        );
        assert_eq!(
            identity("Mung beans, cooked", true)
                .last()
                .map(String::as_str),
            Some("~fndds")
        );
        assert_eq!(
            lower_parens("Cabbage, chinese (pe-tsai), raw"),
            vec!["(pe-tsai)"]
        );
    }

    #[test]
    fn whole_words_only() {
        assert!(has_word("cooked, boiled", &["boiled"]));
        assert!(has_word("stir-fried", &["fried"]));
        assert!(!has_word("microwaved", &["microwave"]));
        assert!(!has_word("unboiled", &["boiled"]));
    }
}
