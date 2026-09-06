//! Turning positioned OCR text into a nutrition panel.
//!
//! This module is pure: it never touches a camera, an OCR engine or Tauri. It
//! takes text blocks with geometry and returns what the pack appears to say, so
//! the part of the feature where the accuracy actually lives can be tested
//! without a device.
//!
//! Three things drive the design, all of them ways a naive reading gets a
//! number wrong:
//!
//! 1. **A panel is a table, and a table is geometry.** "Calories" and "200" sit
//!    at opposite ends of one row in large type, so an OCR engine returns them
//!    as two unrelated strings. Rows are therefore reassembled from vertical
//!    overlap before a single character is matched.
//! 2. **The %DV column is not the amount.** "Total Fat 5g 6%" is five grams.
//!    Any token ending in `%` is discarded before a number is chosen, and only
//!    energy — which prints no unit at all — may claim a bare number.
//! 3. **A shorter nutrient name must never win over a longer one containing
//!    it.** "Saturated Fat" is not fat, "Added Sugars" is not total sugars.
//!    Matches are resolved longest-span-first, and an overlapping shorter match
//!    loses.
//!
//! Nothing here decides anything: every [`Reading`] is a suggestion the user
//! confirms. A misread "15" for "1.5" would poison every day it was logged in,
//! so the parser's job is to be honest about what it could and could not
//! attribute — hence [`Panel::missing`] and [`Panel::unmatched_rows`] — rather
//! than to maximise the count of values it produces.

use crate::label::LabelEntry;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

/// One block of text as an OCR engine returned it. Coordinates are fractions
/// of the image with the ORIGIN AT TOP-LEFT and y increasing downwards; the
/// binding is responsible for converting into this, so the parser never has
/// to know whose convention it was given.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextBlock {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One nutrient the panel appears to declare, in the unit this app stores that
/// nutrient in.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Reading {
    pub nutrient_id: i64,
    pub entry: LabelEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Panel {
    pub serving_g: Option<f64>,
    pub serving_label: Option<String>,
    pub readings: Vec<Reading>,
    /// Every label nutrient this panel did NOT yield, so the UI can say what
    /// it missed instead of implying the pack is silent on them.
    pub missing: Vec<i64>,
    /// Text blocks the parser could not attribute. Useful for saying "this
    /// does not look like a nutrition panel" rather than "0 values found".
    ///
    /// Counted per assembled row, and a panel's own furniture — "Nutrition
    /// Facts", "% Daily Value*" — counts too. It is a ratio to judge against
    /// the readings, not a defect list.
    pub unmatched_rows: usize,
}

/// The nutrients a US panel prints, in the order it prints them. Mirrors
/// `LABEL_NUTRIENTS` in src/types.ts: the ids have to agree or the same pack
/// yields two different foods.
pub const LABEL_NUTRIENT_IDS: [i64; 15] = [
    1008, 1004, 1258, 1257, 1253, 1093, 1005, 1079, 2000, 1235, 1003, 1114, 1087, 1089, 1092,
];

/// Name synonyms per nutrient, normalised the same way a row is (lowercase, no
/// full stops). Order within a nutrient does not matter — the longest match on
/// the row wins regardless — but every entry must be a whole-token phrase.
const SYNONYMS: &[(i64, &[&str])] = &[
    (1008, &["calories", "calorie", "energy"]),
    (1004, &["total fat", "fat"]),
    (
        1258,
        &["saturated fat", "sat fat", "saturates", "saturated"],
    ),
    (1257, &["trans fat", "trans"]),
    (1253, &["cholesterol", "cholest"]),
    // Salt is deliberately NOT a synonym for sodium. A pack outside the US
    // prints salt, which is sodium chloride — 2.5 times the sodium by mass.
    // Mapping it would silently inflate every sodium figure by that factor.
    (1093, &["sodium"]),
    (
        1005,
        &[
            "total carbohydrate",
            "total carbohydrates",
            "total carb",
            "total carbs",
            "carbohydrate",
            "carbohydrates",
            "carb",
            "carbs",
        ],
    ),
    (1079, &["dietary fiber", "dietary fibre", "fiber", "fibre"]),
    (2000, &["total sugars", "total sugar", "sugars", "sugar"]),
    (
        1235,
        &["added sugars", "added sugar", "includes added sugars"],
    ),
    (1003, &["protein"]),
    (1114, &["vitamin d", "vit d"]),
    (1087, &["calcium"]),
    (1089, &["iron"]),
    (1092, &["potassium", "potas", "potass"]),
];

/// A phrase whose presence on a row disqualifies a nutrient from that row.
/// "Sugar Alcohol 2g" is a real panel line and it is not sugar; without this
/// the `sugar` synonym would read a polyol figure into total sugars.
///
/// The same applies to a sub-row indented under its parent: "Polyunsaturated
/// Fat 1.5g" is nutrient 1316, not total fat, and "Soluble Fiber 1g" is 1082,
/// not dietary fiber. The parent's row normally wins by being printed first,
/// but only when it yielded a figure — a %DV-only parent row, or one lost to
/// glare or a crop, leaves the sub-row free to supply the parent's value.
///
/// Matched with `row_norm.contains`, so "insoluble fiber" is caught by the
/// "soluble fiber" entry as a substring rather than needing its own.
const DISQUALIFIERS: &[(i64, &str)] = &[
    (2000, "sugar alcohol"),
    (1235, "sugar alcohol"),
    (1004, "polyunsaturated"),
    (1004, "monounsaturated"),
    (1079, "soluble fiber"),
    (1079, "soluble fibre"),
];

/// The unit this app stores a nutrient in. A printed figure is converted into
/// this or it is dropped — accepting a number whose unit we could not reconcile
/// is how 20 mg of calcium becomes 20 g.
fn stored_unit(nutrient_id: i64) -> Option<Unit> {
    match nutrient_id {
        1008 => Some(Unit::Kcal),
        1004 | 1258 | 1257 | 1005 | 1079 | 2000 | 1235 | 1003 => Some(Unit::Gram),
        1253 | 1093 | 1087 | 1089 | 1092 => Some(Unit::Milligram),
        1114 => Some(Unit::Microgram),
        _ => None,
    }
}

pub fn parse(blocks: &[TextBlock]) -> Panel {
    let rows = rows_from(blocks);

    let mut readings: Vec<Reading> = Vec::new();
    let mut serving_g: Option<f64> = None;
    let mut serving_label: Option<String> = None;
    let mut serving_seen = false;
    let mut unmatched_rows = 0usize;

    for row in &rows {
        let toks = tokenize(row);
        if toks.is_empty() {
            continue;
        }

        let mut attributed = false;

        // Only the first serving row counts. A pack that repeats it in another
        // language would otherwise overwrite the one we already read.
        if !serving_seen {
            if let Some((grams, label)) = serving_from(&toks) {
                serving_seen = true;
                serving_g = grams;
                serving_label = label;
                attributed = true;
            }
        }

        for (nutrient_id, entry) in readings_from(&toks) {
            // First row wins. A panel prints a nutrient once; a second hit is
            // more likely a footnote or a second column than a correction.
            if !readings.iter().any(|r| r.nutrient_id == nutrient_id) {
                readings.push(Reading { nutrient_id, entry });
            }
            attributed = true;
        }

        if !attributed {
            unmatched_rows += 1;
        }
    }

    // Emit in the panel's printed order so these line up row-for-row with the
    // form the user is about to confirm them in.
    readings.sort_by_key(|r| {
        LABEL_NUTRIENT_IDS
            .iter()
            .position(|id| *id == r.nutrient_id)
            .unwrap_or(usize::MAX)
    });

    let missing = LABEL_NUTRIENT_IDS
        .iter()
        .copied()
        .filter(|id| !readings.iter().any(|r| r.nutrient_id == *id))
        .collect();

    Panel {
        serving_g,
        serving_label,
        readings,
        missing,
        unmatched_rows,
    }
}

// ---------------------------------------------------------------------------
// Rows from geometry
// ---------------------------------------------------------------------------

/// Two blocks share a row when their y-ranges overlap by more than half the
/// shorter one's height. Half of the *shorter* block, so a large-type
/// "Calories" still claims the small-type figure beside it.
fn shares_row(a: &TextBlock, b: &TextBlock) -> bool {
    let top = a.y.max(b.y);
    let bottom = (a.y + a.h).min(b.y + b.h);
    let shorter = a.h.min(b.h);
    shorter > 0.0 && (bottom - top) > shorter * 0.5
}

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// Group blocks into rows, top to bottom, each row's blocks joined left to
/// right by a single space.
///
/// Public because it is the geometry every scanner in this crate starts from —
/// the ingredient list and the Supplement Facts panel are read off the same
/// reassembled rows. One implementation, so a change to how a row is decided
/// cannot make two parsers disagree about where a row ends.
pub fn rows_from(blocks: &[TextBlock]) -> Vec<String> {
    // A block with impossible geometry cannot be placed in a row, and guessing
    // where it belongs would scramble every row around it.
    let usable: Vec<&TextBlock> = blocks
        .iter()
        .filter(|b| {
            b.x.is_finite()
                && b.y.is_finite()
                && b.w.is_finite()
                && b.h.is_finite()
                && b.h > 0.0
                && !b.text.trim().is_empty()
        })
        .collect();

    let n = usable.len();
    let mut parent: Vec<usize> = (0..n).collect();
    for i in 0..n {
        for j in (i + 1)..n {
            if shares_row(usable[i], usable[j]) {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                if ri != rj {
                    parent[ri] = rj;
                }
            }
        }
    }

    // Built by first appearance rather than through a hash map, so the same
    // input always yields the same rows.
    let mut roots: Vec<usize> = Vec::new();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        match roots.iter().position(|x| *x == r) {
            Some(k) => groups[k].push(i),
            None => {
                roots.push(r);
                groups.push(vec![i]);
            }
        }
    }

    for g in groups.iter_mut() {
        g.sort_by(|a, b| cmp_f64(usable[*a].x, usable[*b].x));
    }
    groups.sort_by(|a, b| {
        let ta = a.iter().map(|i| usable[*i].y).fold(f64::MAX, f64::min);
        let tb = b.iter().map(|i| usable[*i].y).fold(f64::MAX, f64::min);
        cmp_f64(ta, tb)
    });

    groups
        .iter()
        .map(|g| {
            g.iter()
                .map(|i| usable[*i].text.trim())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect()
}

fn cmp_f64(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// Punctuation stripped from a token's edges. `.` is here so "Vit." and
/// "Potas." normalise to their spelled-out synonyms; it is stripped only at the
/// edges, so the point in "0.6" survives.
const EDGE: &[char] = &[
    '(', ')', '[', ']', '{', '}', ',', ';', ':', '*', '|', '"', '\'', '\u{2018}', '\u{2019}',
    '\u{201c}', '\u{201d}', '.',
];

struct Tok {
    /// As it appeared, so a parenthesised "(57g)" is still recognisable.
    raw: String,
    /// Edge punctuation removed and commas resolved. Numbers parse here.
    clean: String,
    /// `clean`, lowercased with full stops removed. Names match here.
    norm: String,
}

/// Commas resolved rather than deleted.
///
/// A comma between digits is a thousands separator only when exactly three
/// digits follow it — "Sodium 1,200mg". Everywhere else it is a decimal comma,
/// which is what a pack outside the US prints and also what an OCR engine
/// returns when it reads a full stop as one. Deleting it there multiplies the
/// figure by ten: "Total Fat 12,5 g" would be read as 125 g, and "Saturated Fat
/// 1,5 g" as the 15 g this module's header names as the error it exists to
/// prevent.
fn de_comma(s: &str) -> String {
    let ch: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, c) in ch.iter().enumerate() {
        if *c != ',' {
            out.push(*c);
            continue;
        }
        // A comma with no digit on one side of it is punctuation, not part of a
        // figure, and carries nothing into the number.
        if i == 0 || !ch[i - 1].is_ascii_digit() {
            continue;
        }
        let run = ch[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if run >= 1 && run != 3 {
            out.push('.');
        }
    }
    out
}

fn tokenize(row: &str) -> Vec<Tok> {
    row.split(|c: char| {
        // A bullet between two nutrients on a shared row is a column divider,
        // not a word.
        c.is_whitespace() || c == '\u{2022}' || c == '\u{00b7}' || c == '\u{2027}'
    })
    .filter_map(|raw| {
        let trimmed = raw.trim_matches(|c| EDGE.contains(&c));
        if trimmed.is_empty() {
            return None;
        }
        let clean = de_comma(trimmed);
        let norm: String = clean
            .chars()
            .filter(|c| *c != '.')
            .flat_map(|c| c.to_lowercase())
            .collect();
        Some(Tok {
            raw: raw.to_string(),
            clean,
            norm,
        })
    })
    .collect()
}

// ---------------------------------------------------------------------------
// Units and numbers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    Gram,
    Milligram,
    Microgram,
    Kcal,
    /// A %DV figure. Kept as a unit rather than dropped at parse time so the
    /// selector can say *why* it refused a number.
    Percent,
    /// A suffix we do not recognise ("oz", "IU"). Not the same as no unit at
    /// all: a number we cannot place is dropped, never taken as bare.
    Unrecognised,
}

/// Power of ten relative to a gram. Exact for the three mass units, which
/// keeps a conversion like 1.2 g -> 1200 mg free of drift.
fn mass_exp(u: Unit) -> Option<i32> {
    match u {
        Unit::Gram => Some(0),
        Unit::Milligram => Some(-3),
        Unit::Microgram => Some(-6),
        _ => None,
    }
}

fn unit_word(s: &str) -> Option<Unit> {
    // "6%" and "6%DV" are both the Daily Value column.
    if s.starts_with('%') {
        return Some(Unit::Percent);
    }
    match s {
        "g" | "gram" | "grams" => Some(Unit::Gram),
        "mg" | "milligram" | "milligrams" => Some(Unit::Milligram),
        // "mcg" is how a panel writes µg; both mu characters occur in the wild.
        "mcg" | "mcgs" | "\u{00b5}g" | "\u{03bc}g" | "ug" | "microgram" | "micrograms" => {
            Some(Unit::Microgram)
        }
        "kcal" | "kcals" | "cal" | "cals" | "calories" => Some(Unit::Kcal),
        // A kilojoule is energy, but not the energy this app stores, and a
        // dual-unit row — "Energy 1004 kJ 240 kcal" — prints the kJ figure
        // first. Recognising it as a unit we cannot use is what makes the 1004
        // droppable; leaving it unknown would let the bare-number rule meant for
        // "Calories 200" claim it, and log energy 4.2 times too high.
        "kj" | "kjs" | "kilojoule" | "kilojoules" => Some(Unit::Unrecognised),
        _ => None,
    }
}

/// A token short enough that, printed right after a figure, it can only be a
/// unit. Kept to two letters so an ordinary word cannot qualify: "per" in
/// "Calories 200 per serving" and "package" in "Serving Size 1 package" stay
/// words, while "kJ", "IU", "oz", "ml" and "lb" do not.
fn looks_like_unit(s: &str) -> bool {
    let n = s.chars().count();
    (1..=2).contains(&n) && s.chars().all(|c| c.is_alphabetic())
}

struct NumCand {
    /// Token index the number starts at.
    start: usize,
    /// One past the last token it consumed, so a detached unit ("5" "g") is
    /// counted as part of the number.
    end: usize,
    value: f64,
    unit: Option<Unit>,
    less_than: bool,
    parenthesised: bool,
}

/// (value, unit, "less than") from a single token, if it begins with a number.
fn parse_number(s: &str) -> Option<(f64, Option<Unit>, bool)> {
    let mut rest = s;
    let mut less_than = false;
    if let Some(r) = rest
        .strip_prefix('<')
        .or_else(|| rest.strip_prefix('\u{2264}'))
    {
        rest = r;
        less_than = true;
    }
    let split = rest
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(rest.len());
    let (digits, suffix) = rest.split_at(split);
    if !digits.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let value: f64 = digits.parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    let unit = if suffix.is_empty() {
        None
    } else {
        Some(unit_word(&suffix.to_lowercase()).unwrap_or(Unit::Unrecognised))
    };
    Some((value, unit, less_than))
}

fn numbers_in(toks: &[Tok]) -> Vec<NumCand> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        if let Some((value, unit, mut less_than)) = parse_number(&toks[i].clean) {
            let mut end = i + 1;
            let mut unit = unit;
            if unit.is_none() {
                if let Some(u) = toks.get(end).and_then(|t| unit_word(&t.norm)) {
                    unit = Some(u);
                    end += 1;
                } else if toks.get(end).is_some_and(|t| looks_like_unit(&t.norm)) {
                    // A one- or two-letter word sitting immediately after a
                    // figure is a unit, and one we failed to place: "200 IU",
                    // "8 oz". Attached, `parse_number` already calls that
                    // Unrecognised; detached it has to be consumed the same way,
                    // or the number is left bare and energy's bare-number rule
                    // takes it. Whether OCR emitted the space is not something
                    // the reading may turn on.
                    unit = Some(Unit::Unrecognised);
                    end += 1;
                }
            }
            // "Contains less than 1g of ..." is a censored value, not a
            // measurement, and the phrase sits before the number.
            if i >= 2 && toks[i - 2].norm == "less" && toks[i - 1].norm == "than" {
                less_than = true;
            }
            let parenthesised = toks[i..end].iter().any(|t| t.raw.contains('('));
            out.push(NumCand {
                start: i,
                end,
                value,
                unit,
                less_than,
                parenthesised,
            });
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

/// Convert a printed figure into the unit this app stores the nutrient in, or
/// `None` when the two cannot be reconciled. Dropping the reading is correct
/// there; guessing is not.
fn to_stored(value: f64, printed: Option<Unit>, nutrient_id: i64) -> Option<f64> {
    let stored = stored_unit(nutrient_id)?;
    match printed {
        // Energy is the one row that prints no unit — "Calories 200".
        None | Some(Unit::Kcal) => {
            if stored == Unit::Kcal {
                Some(value)
            } else {
                None
            }
        }
        Some(p) => {
            let pe = mass_exp(p)?;
            let se = mass_exp(stored)?;
            Some(value * 10f64.powi(pe - se))
        }
    }
}

// ---------------------------------------------------------------------------
// Serving size
// ---------------------------------------------------------------------------

/// `Some` when this row is the serving-size line, carrying its grams and its
/// text. "6 servings per container" is a different row and does not match:
/// the token is "servings", not "serving".
fn serving_from(toks: &[Tok]) -> Option<(Option<f64>, Option<String>)> {
    let at = (0..toks.len().saturating_sub(1))
        .find(|i| toks[*i].norm == "serving" && toks[i + 1].norm == "size")?;
    let rest = at + 2;

    let label = toks[rest..]
        .iter()
        .map(|t| t.raw.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let label = label
        .trim()
        .trim_start_matches([':', '-'])
        .trim()
        .to_string();

    let nums = numbers_in(toks);
    // "(57g)" is the metric weight; a bare leading "1" is the count of whatever
    // household measure follows it, so only a mass-bearing number qualifies.
    let masses: Vec<&NumCand> = nums
        .iter()
        .filter(|n| !n.less_than && n.unit.and_then(mass_exp).is_some() && n.start >= rest)
        .collect();
    let chosen = masses
        .iter()
        .find(|n| n.parenthesised)
        .or_else(|| masses.last());

    let grams = chosen.and_then(|n| {
        let exp = mass_exp(n.unit?)?;
        let g = n.value * 10f64.powi(exp);
        if g.is_finite() && g > 0.0 {
            Some(g)
        } else {
            None
        }
    });

    Some((grams, if label.is_empty() { None } else { Some(label) }))
}

// ---------------------------------------------------------------------------
// Nutrients
// ---------------------------------------------------------------------------

struct NameMatch {
    nutrient_id: i64,
    start: usize,
    end: usize,
}

/// Every nutrient this row declares. A row can yield more than one — a panel's
/// footer prints two per line, divided by a bullet.
fn readings_from(toks: &[Tok]) -> Vec<(i64, LabelEntry)> {
    let row_norm = toks
        .iter()
        .map(|t| t.norm.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    let mut candidates: Vec<NameMatch> = Vec::new();
    for (nutrient_id, syns) in SYNONYMS {
        if DISQUALIFIERS
            .iter()
            .any(|(id, phrase)| id == nutrient_id && row_norm.contains(phrase))
        {
            continue;
        }
        for syn in *syns {
            let words: Vec<&str> = syn.split(' ').collect();
            if words.len() > toks.len() {
                continue;
            }
            for start in 0..=(toks.len() - words.len()) {
                if words
                    .iter()
                    .enumerate()
                    .all(|(k, w)| toks[start + k].norm == *w)
                {
                    candidates.push(NameMatch {
                        nutrient_id: *nutrient_id,
                        start,
                        end: start + words.len(),
                    });
                }
            }
        }
    }

    // Longest span first: this is the whole defence against "Saturated Fat"
    // being read as fat and "Added Sugars" as total sugars. Ties break on
    // position, then on the panel's own order, so the result is deterministic.
    candidates.sort_by(|a, b| {
        (b.end - b.start)
            .cmp(&(a.end - a.start))
            .then(a.start.cmp(&b.start))
            .then_with(|| {
                let ia = LABEL_NUTRIENT_IDS.iter().position(|i| *i == a.nutrient_id);
                let ib = LABEL_NUTRIENT_IDS.iter().position(|i| *i == b.nutrient_id);
                ia.cmp(&ib)
            })
    });

    let mut accepted: Vec<NameMatch> = Vec::new();
    for c in candidates {
        // A nutrient is claimed once per row, and two names may not share a
        // token: the losing candidate is the shorter name inside the longer.
        let taken = accepted
            .iter()
            .any(|a| (c.start < a.end && a.start < c.end) || a.nutrient_id == c.nutrient_id);
        if !taken {
            accepted.push(c);
        }
    }
    accepted.sort_by_key(|m| m.start);

    let nums = numbers_in(toks);
    let mut claimed = vec![false; nums.len()];
    let mut chosen: Vec<Option<usize>> = vec![None; accepted.len()];

    // A number may not be read across another nutrient's name, and no figure
    // may be read twice: on "Calcium 20mg 2% • Iron" the 20 belongs to calcium
    // and iron simply printed no amount. Saying nothing there is right; lifting
    // the neighbour's figure is the kind of quiet error this app cannot make.
    let usable = |n: &NumCand, nutrient_id: i64| -> bool {
        // A bare percentage is never an amount.
        if n.unit == Some(Unit::Percent) || n.unit == Some(Unit::Unrecognised) {
            return false;
        }
        to_stored(n.value, n.unit, nutrient_id).is_some()
    };

    // Pass one: the figure to the right, which is the column a panel prints
    // amounts in. Everyone claims theirs before anyone looks leftwards.
    for (k, m) in accepted.iter().enumerate() {
        let right_bound = accepted
            .get(k + 1)
            .map(|next| next.start)
            .unwrap_or(toks.len());
        chosen[k] = (0..nums.len())
            .filter(|i| !claimed[*i])
            .filter(|i| nums[*i].start >= m.end && nums[*i].end <= right_bound)
            .filter(|i| usable(&nums[*i], m.nutrient_id))
            .min_by_key(|i| nums[*i].start - m.end);
        if let Some(i) = chosen[k] {
            claimed[i] = true;
        }
    }

    // Pass two: "Includes 14g Added Sugars" prints its number before the name.
    for (k, m) in accepted.iter().enumerate() {
        if chosen[k].is_some() {
            continue;
        }
        let left_bound = if k == 0 { 0 } else { accepted[k - 1].end };
        chosen[k] = (0..nums.len())
            .filter(|i| !claimed[*i])
            // Energy may not take a bare number from its left. A panel prints
            // "Calories 200", never "200 Calories" — but the footnote "based on
            // a 2,000 calorie diet" does put a figure there, and the bare-number
            // rule that exists for the real row would otherwise read the
            // footnote as 2000 kcal on any frame where the real row was cropped
            // or lost.
            .filter(|i| !(m.nutrient_id == 1008 && nums[*i].unit.is_none()))
            .filter(|i| nums[*i].start >= left_bound && nums[*i].end <= m.start)
            .filter(|i| usable(&nums[*i], m.nutrient_id))
            .min_by_key(|i| m.start - nums[*i].end);
        if let Some(i) = chosen[k] {
            claimed[i] = true;
        }
    }

    let mut out = Vec::new();
    for (k, m) in accepted.iter().enumerate() {
        let Some(n) = chosen[k].map(|i| &nums[i]) else {
            continue;
        };
        let Some(amount) = to_stored(n.value, n.unit, m.nutrient_id) else {
            continue;
        };

        let entry = if n.less_than {
            // A "less than 0" would be a claim of absence dressed as a bound.
            if amount > 0.0 {
                LabelEntry::LessThan { upper: amount }
            } else {
                continue;
            }
        } else if amount == 0.0 {
            // The rule this app exists to enforce: a printed 0 is a rounding
            // ceiling, not a measurement. Never Printed { amount: 0.0 }.
            LabelEntry::DeclaredZero
        } else {
            LabelEntry::Printed { amount }
        };

        out.push((m.nutrient_id, entry));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(text: &str, x: f64, y: f64, w: f64, h: f64) -> TextBlock {
        TextBlock {
            text: text.to_string(),
            x,
            y,
            w,
            h,
        }
    }

    /// The Nature's Bakery fig bar panel, transcribed from the user's photo,
    /// laid out the way an OCR engine really returns it: "Calories" and "200"
    /// are separate blocks at opposite ends of one row, the %DV column is its
    /// own block, and the footer prints two nutrients per line.
    fn fig_bar() -> Vec<TextBlock> {
        vec![
            b("Nutrition Facts", 0.05, 0.020, 0.60, 0.045),
            b("6 servings per container", 0.05, 0.080, 0.50, 0.025),
            b("Serving Size", 0.05, 0.115, 0.25, 0.028),
            b("1 package (57g)", 0.55, 0.115, 0.40, 0.028),
            b("Amount per Serving", 0.05, 0.160, 0.40, 0.025),
            b("Calories", 0.05, 0.200, 0.30, 0.050),
            b("200", 0.72, 0.200, 0.23, 0.050),
            b("% Daily Value*", 0.60, 0.270, 0.35, 0.022),
            b("Total Fat 5g", 0.05, 0.310, 0.50, 0.026),
            b("6%", 0.85, 0.310, 0.10, 0.026),
            b("Saturated Fat 0g", 0.08, 0.350, 0.50, 0.026),
            b("0%", 0.85, 0.350, 0.10, 0.026),
            b("Trans Fat 0g", 0.08, 0.390, 0.50, 0.026),
            b("Cholesterol 0mg", 0.05, 0.430, 0.50, 0.026),
            b("0%", 0.85, 0.430, 0.10, 0.026),
            b("Sodium 75mg", 0.05, 0.470, 0.50, 0.026),
            b("3%", 0.85, 0.470, 0.10, 0.026),
            b("Total Carbohydrate 37g", 0.05, 0.510, 0.55, 0.026),
            b("13%", 0.83, 0.510, 0.12, 0.026),
            b("Dietary Fiber 3g", 0.08, 0.550, 0.50, 0.026),
            b("11%", 0.83, 0.550, 0.12, 0.026),
            b("Total Sugars 19g", 0.08, 0.590, 0.50, 0.026),
            b("Includes 14g Added Sugars", 0.11, 0.630, 0.60, 0.026),
            b("28%", 0.83, 0.630, 0.12, 0.026),
            b("Protein 3g", 0.05, 0.670, 0.50, 0.026),
            b("Vit. D 0.6mcg 4%", 0.05, 0.730, 0.42, 0.026),
            b("\u{2022}", 0.48, 0.730, 0.03, 0.026),
            b("Iron 0.9mg 6%", 0.53, 0.730, 0.42, 0.026),
            b("Calcium 20mg 2%", 0.05, 0.770, 0.42, 0.026),
            b("\u{2022}", 0.48, 0.770, 0.03, 0.026),
            b("Potas. 150mg 4%", 0.53, 0.770, 0.42, 0.026),
        ]
    }

    fn entry(p: &Panel, nutrient_id: i64) -> Option<LabelEntry> {
        p.readings
            .iter()
            .find(|r| r.nutrient_id == nutrient_id)
            .map(|r| r.entry.clone())
    }

    /// Build a single row of blocks from strings, evenly spaced left to right
    /// on one line. For the cases where only the text matters.
    fn one_row(parts: &[&str]) -> Vec<TextBlock> {
        parts
            .iter()
            .enumerate()
            .map(|(i, t)| b(t, 0.05 + i as f64 * 0.2, 0.30, 0.18, 0.026))
            .collect()
    }

    #[test]
    fn the_fig_bar_panel_parses_exactly() {
        let p = parse(&fig_bar());

        assert_eq!(p.serving_g, Some(57.0));
        assert_eq!(p.serving_label.as_deref(), Some("1 package (57g)"));

        // The assertion this whole file exists for: the %DV column beside
        // "Total Fat 5g" reads 6%, and 6 is not the amount.
        assert_eq!(
            entry(&p, 1004),
            Some(LabelEntry::Printed { amount: 5.0 }),
            "total fat is 5 g; 6 is the %DV"
        );

        assert_eq!(entry(&p, 1008), Some(LabelEntry::Printed { amount: 200.0 }));
        assert_eq!(entry(&p, 1258), Some(LabelEntry::DeclaredZero));
        assert_eq!(entry(&p, 1257), Some(LabelEntry::DeclaredZero));
        assert_eq!(entry(&p, 1253), Some(LabelEntry::DeclaredZero));
        assert_eq!(entry(&p, 1093), Some(LabelEntry::Printed { amount: 75.0 }));
        assert_eq!(entry(&p, 1005), Some(LabelEntry::Printed { amount: 37.0 }));
        assert_eq!(entry(&p, 1079), Some(LabelEntry::Printed { amount: 3.0 }));
        assert_eq!(entry(&p, 2000), Some(LabelEntry::Printed { amount: 19.0 }));
        assert_eq!(entry(&p, 1235), Some(LabelEntry::Printed { amount: 14.0 }));
        assert_eq!(entry(&p, 1003), Some(LabelEntry::Printed { amount: 3.0 }));
        assert_eq!(entry(&p, 1114), Some(LabelEntry::Printed { amount: 0.6 }));
        assert_eq!(entry(&p, 1089), Some(LabelEntry::Printed { amount: 0.9 }));
        assert_eq!(entry(&p, 1087), Some(LabelEntry::Printed { amount: 20.0 }));
        assert_eq!(entry(&p, 1092), Some(LabelEntry::Printed { amount: 150.0 }));

        assert!(p.missing.is_empty(), "nothing missing: {:?}", p.missing);
        assert_eq!(p.readings.len(), 15);
        // Emitted in the panel's own order.
        let ids: Vec<i64> = p.readings.iter().map(|r| r.nutrient_id).collect();
        assert_eq!(ids, LABEL_NUTRIENT_IDS.to_vec());
        // "Nutrition Facts", "6 servings per container", "Amount per Serving"
        // and "% Daily Value*" — the panel's furniture, and nothing else.
        assert_eq!(p.unmatched_rows, 4);
    }

    #[test]
    fn calories_and_its_figure_are_joined_by_geometry_not_by_string() {
        // Shuffled input, and the two blocks are a third of the image apart.
        let blocks = vec![
            b("200", 0.72, 0.200, 0.23, 0.050),
            b("Trans Fat 0g", 0.08, 0.390, 0.50, 0.026),
            b("Calories", 0.05, 0.200, 0.30, 0.050),
        ];
        let p = parse(&blocks);
        assert_eq!(entry(&p, 1008), Some(LabelEntry::Printed { amount: 200.0 }));
        assert_eq!(entry(&p, 1257), Some(LabelEntry::DeclaredZero));
    }

    #[test]
    fn a_photo_of_something_else_reads_as_nothing_rather_than_zeroes() {
        let blocks = vec![
            b("Nature's Bakery", 0.05, 0.10, 0.60, 0.05),
            b("Whole Wheat", 0.05, 0.20, 0.50, 0.04),
            b("Stone Ground", 0.05, 0.28, 0.50, 0.04),
            b("Baked with real fruit", 0.05, 0.36, 0.60, 0.03),
            b("Net Wt 12 oz", 0.05, 0.44, 0.40, 0.03),
        ];
        let p = parse(&blocks);
        assert!(p.readings.is_empty(), "got {:?}", p.readings);
        assert_eq!(p.unmatched_rows, 5);
        assert_eq!(p.missing.len(), LABEL_NUTRIENT_IDS.len());
        assert_eq!(p.serving_g, None);
    }

    #[test]
    fn nothing_at_all_is_not_a_panel_full_of_zeroes() {
        let p = parse(&[]);
        assert!(p.readings.is_empty());
        assert_eq!(p.unmatched_rows, 0);
        assert_eq!(p.missing, LABEL_NUTRIENT_IDS.to_vec());
    }

    #[test]
    fn includes_added_sugars_puts_its_number_first() {
        let p = parse(&one_row(&["Includes 14g Added Sugars", "28%"]));
        assert_eq!(entry(&p, 1235), Some(LabelEntry::Printed { amount: 14.0 }));
        assert_eq!(entry(&p, 2000), None, "the added sugars row is not sugars");
    }

    #[test]
    fn total_sugars_is_not_added_sugars() {
        let p = parse(&one_row(&["Total Sugars 19g"]));
        assert_eq!(entry(&p, 2000), Some(LabelEntry::Printed { amount: 19.0 }));
        assert_eq!(entry(&p, 1235), None);
    }

    #[test]
    fn a_longer_name_always_beats_a_shorter_one_inside_it() {
        let p = parse(&one_row(&["Saturated Fat 0g", "0%"]));
        assert_eq!(entry(&p, 1258), Some(LabelEntry::DeclaredZero));
        assert_eq!(entry(&p, 1004), None, "saturated fat is not total fat");

        let p = parse(&one_row(&["Total Carbohydrate 37g", "13%"]));
        assert_eq!(entry(&p, 1005), Some(LabelEntry::Printed { amount: 37.0 }));

        let p = parse(&one_row(&["Dietary Fiber 3g", "11%"]));
        assert_eq!(entry(&p, 1079), Some(LabelEntry::Printed { amount: 3.0 }));
    }

    #[test]
    fn a_printed_zero_is_a_ceiling_and_never_a_measurement() {
        let p = parse(&one_row(&["Saturated Fat 0g", "0%"]));
        let e = entry(&p, 1258).unwrap();
        assert_eq!(e, LabelEntry::DeclaredZero);
        assert_ne!(
            e,
            LabelEntry::Printed { amount: 0.0 },
            "a declared zero must never be transcribed as a measured 0"
        );
        // And it still carries a bound once converted, rather than becoming a
        // claim of absence.
        let v = crate::label::to_value(&e, 1258, 57.0).unwrap();
        assert!(v.upper().is_some());
        assert_ne!(v, crate::NutrientValue::MeasuredZero);
    }

    #[test]
    fn mcg_is_micrograms_and_the_percent_is_not_the_amount() {
        let p = parse(&one_row(&["Vit. D 0.6mcg 4%"]));
        assert_eq!(
            entry(&p, 1114),
            Some(LabelEntry::Printed { amount: 0.6 }),
            "0.6 mcg is 0.6 µg, and 4 is the %DV"
        );
    }

    #[test]
    fn two_nutrients_can_share_one_row() {
        let blocks = vec![
            b("Calcium 20mg 2%", 0.05, 0.77, 0.42, 0.026),
            b("\u{2022}", 0.48, 0.77, 0.03, 0.026),
            b("Potas. 150mg 4%", 0.53, 0.77, 0.42, 0.026),
        ];
        let p = parse(&blocks);
        assert_eq!(entry(&p, 1087), Some(LabelEntry::Printed { amount: 20.0 }));
        assert_eq!(entry(&p, 1092), Some(LabelEntry::Printed { amount: 150.0 }));
    }

    #[test]
    fn a_number_is_never_read_across_another_nutrients_name() {
        // Iron prints no figure here. Taking calcium's would be worse than
        // reporting nothing.
        let p = parse(&one_row(&["Calcium 20mg 2%", "Iron"]));
        assert_eq!(entry(&p, 1087), Some(LabelEntry::Printed { amount: 20.0 }));
        assert_eq!(entry(&p, 1089), None);
    }

    #[test]
    fn a_printed_unit_is_converted_into_the_one_we_store() {
        // Sodium is stored in mg; some packs print grams.
        let p = parse(&one_row(&["Sodium 1.2g 52%"]));
        match entry(&p, 1093).unwrap() {
            LabelEntry::Printed { amount } => assert!((amount - 1200.0).abs() < 1e-9, "{amount}"),
            other => panic!("expected a printed amount, got {other:?}"),
        }
        // Vitamin D is stored in µg; a pack printing mg is 1000 times larger.
        let p = parse(&one_row(&["Vitamin D 0.002mg"]));
        match entry(&p, 1114).unwrap() {
            LabelEntry::Printed { amount } => assert!((amount - 2.0).abs() < 1e-9, "{amount}"),
            other => panic!("expected a printed amount, got {other:?}"),
        }
    }

    #[test]
    fn a_unit_we_cannot_reconcile_yields_no_reading() {
        // Ounces are not in the mass table, and 3 oz of protein read as 3 g
        // would be wrong in the direction that hides a deficit.
        let p = parse(&one_row(&["Protein 3 oz"]));
        assert_eq!(entry(&p, 1003), None);
        // Neither is an energy unit on a mass row.
        let p = parse(&one_row(&["Total Fat 5kcal"]));
        assert_eq!(entry(&p, 1004), None);
        // A bare number is accepted for energy only.
        let p = parse(&one_row(&["Protein 3"]));
        assert_eq!(entry(&p, 1003), None);
    }

    #[test]
    fn a_percentage_is_never_taken_as_an_amount() {
        // No amount printed at all, only the Daily Value column.
        let p = parse(&one_row(&["Vitamin D", "10%"]));
        assert_eq!(entry(&p, 1114), None);
        let p = parse(&one_row(&["Calories", "15%"]));
        assert_eq!(
            entry(&p, 1008),
            None,
            "energy takes a bare number, but not a percentage"
        );
    }

    #[test]
    fn a_censored_amount_stays_censored() {
        let p = parse(&one_row(&["Dietary Fiber less than 1g"]));
        assert_eq!(entry(&p, 1079), Some(LabelEntry::LessThan { upper: 1.0 }));

        let p = parse(&one_row(&["Total Sugars <1g"]));
        assert_eq!(entry(&p, 2000), Some(LabelEntry::LessThan { upper: 1.0 }));

        // Stored in mg, so the bound converts with the amount.
        let p = parse(&one_row(&["Cholesterol less than 2mg"]));
        assert_eq!(entry(&p, 1253), Some(LabelEntry::LessThan { upper: 2.0 }));
    }

    #[test]
    fn salt_is_not_sodium() {
        // Salt is 2.5 times the sodium by mass. Reading one as the other would
        // understate every sodium figure on a non-US pack.
        let p = parse(&one_row(&["Salt 1.2g"]));
        assert_eq!(entry(&p, 1093), None);
    }

    #[test]
    fn sugar_alcohol_is_not_sugar() {
        let p = parse(&one_row(&["Sugar Alcohol 2g"]));
        assert_eq!(entry(&p, 2000), None);
        assert_eq!(entry(&p, 1235), None);
    }

    #[test]
    fn serving_size_is_read_but_servings_per_container_is_not() {
        let blocks = vec![
            b("6 servings per container", 0.05, 0.08, 0.50, 0.025),
            b("Serving size 2 tbsp 32 g", 0.05, 0.12, 0.60, 0.028),
        ];
        let p = parse(&blocks);
        assert_eq!(p.serving_g, Some(32.0));
        assert_eq!(p.serving_label.as_deref(), Some("2 tbsp 32 g"));

        // The count of servings must never be mistaken for the serving weight.
        let p = parse(&[b("6 servings per container", 0.05, 0.08, 0.50, 0.025)]);
        assert_eq!(p.serving_g, None);
        assert_eq!(p.serving_label, None);
    }

    #[test]
    fn a_serving_row_without_a_weight_still_yields_its_label() {
        let p = parse(&one_row(&["Serving size 1 bar"]));
        assert_eq!(p.serving_g, None, "no grams printed, so none invented");
        assert_eq!(p.serving_label.as_deref(), Some("1 bar"));
    }

    #[test]
    fn blocks_with_impossible_geometry_are_dropped_not_guessed_at() {
        let mut blocks = fig_bar();
        blocks.push(b("Sodium 999mg", f64::NAN, 0.47, 0.5, 0.026));
        blocks.push(b("Protein 99g", 0.05, 0.67, 0.5, 0.0));
        let p = parse(&blocks);
        assert_eq!(entry(&p, 1093), Some(LabelEntry::Printed { amount: 75.0 }));
        assert_eq!(entry(&p, 1003), Some(LabelEntry::Printed { amount: 3.0 }));
    }

    #[test]
    fn a_kilojoule_figure_is_never_read_as_calories() {
        // The EU/FSSAI energy row prints kJ first. Taking the nearer figure
        // would log 1004 kcal for a 240 kcal serving.
        let p = parse(&one_row(&["Energy 1004 kJ 240 kcal"]));
        assert_eq!(entry(&p, 1008), Some(LabelEntry::Printed { amount: 240.0 }));

        let p = parse(&one_row(&["Energy", "1004 kJ", "240 kcal"]));
        assert_eq!(entry(&p, 1008), Some(LabelEntry::Printed { amount: 240.0 }));

        // kJ alone is energy this app cannot store. No reading beats a wrong one.
        let p = parse(&one_row(&["Energy 840 kJ"]));
        assert_eq!(entry(&p, 1008), None);

        // Whether OCR emitted the space may not change the answer.
        let p = parse(&one_row(&["Energy 840kJ"]));
        assert_eq!(entry(&p, 1008), None);
    }

    #[test]
    fn a_detached_unit_we_cannot_place_is_not_a_bare_number() {
        // Only energy may claim a number with no unit, so an unplaceable unit
        // left behind is the one case that turns into a reading.
        let p = parse(&one_row(&["Calories 200 IU"]));
        assert_eq!(entry(&p, 1008), None);
        let p = parse(&one_row(&["Calories 200 oz"]));
        assert_eq!(entry(&p, 1008), None);
        // A word is still a word: "per" is not a unit.
        let p = parse(&one_row(&["Calories 200 per serving"]));
        assert_eq!(entry(&p, 1008), Some(LabelEntry::Printed { amount: 200.0 }));
    }

    #[test]
    fn the_calorie_diet_footnote_is_not_an_energy_row() {
        // The footnote sits at the foot of the panel, so a frame cropped to the
        // lower half can carry it without the Calories row that outranks it.
        let p = parse(&one_row(&[
            "* Percent Daily Values are based on a 2,000 calorie diet.",
        ]));
        assert_eq!(entry(&p, 1008), None);
        assert_eq!(p.unmatched_rows, 1, "and the row counts as unattributed");

        // The real row still reads, from the right where a panel prints it.
        let p = parse(&one_row(&["Calories", "200"]));
        assert_eq!(entry(&p, 1008), Some(LabelEntry::Printed { amount: 200.0 }));
    }

    #[test]
    fn a_decimal_comma_is_not_a_thousands_separator() {
        // Deleting the comma reads 12.5 g of fat as 125 g, and 1.5 g of
        // saturated fat as the 15 g this module exists to prevent.
        let p = parse(&one_row(&["Total Fat 12,5 g"]));
        assert_eq!(entry(&p, 1004), Some(LabelEntry::Printed { amount: 12.5 }));

        let p = parse(&one_row(&["Saturated Fat 1,5 g"]));
        assert_eq!(entry(&p, 1258), Some(LabelEntry::Printed { amount: 1.5 }));

        // And a rounding-floor figure stays one instead of becoming a
        // confident 5 g.
        let p = parse(&one_row(&["Dietary Fiber 0,5g"]));
        assert_eq!(entry(&p, 1079), Some(LabelEntry::Printed { amount: 0.5 }));

        // The separator the strip was written for still works.
        let p = parse(&one_row(&["Sodium 1,200mg"]));
        assert_eq!(entry(&p, 1093), Some(LabelEntry::Printed { amount: 1200.0 }));
    }

    #[test]
    fn a_fat_or_fibre_sub_row_does_not_supply_its_parent() {
        // Polyunsaturated fat is 1316 and soluble fibre is 1082. Neither is the
        // parent's figure, and on a frame missing the parent row nothing else
        // stops the bare "fat" and "fiber" synonyms from taking it.
        let p = parse(&one_row(&["Polyunsaturated Fat 1.5g"]));
        assert_eq!(entry(&p, 1004), None);
        let p = parse(&one_row(&["Monounsaturated Fat 2g"]));
        assert_eq!(entry(&p, 1004), None);
        let p = parse(&one_row(&["Soluble Fiber 1g"]));
        assert_eq!(entry(&p, 1079), None);
        let p = parse(&one_row(&["Insoluble Fiber 2g"]));
        assert_eq!(entry(&p, 1079), None);

        // The trigger is the parent's FIGURE being lost, not the whole row: a
        // parent row carrying only its %DV yields nothing to outrank the
        // sub-row beneath it.
        let p = parse(&vec![
            b("Total Fat", 0.05, 0.30, 0.30, 0.026),
            b("6%", 0.85, 0.30, 0.10, 0.026),
            b("Polyunsaturated Fat 1.5g", 0.08, 0.34, 0.50, 0.026),
        ]);
        assert_eq!(entry(&p, 1004), None);

        // A whole panel still reads its parent rows normally.
        let p = parse(&fig_bar());
        assert_eq!(entry(&p, 1004), Some(LabelEntry::Printed { amount: 5.0 }));
        assert_eq!(entry(&p, 1079), Some(LabelEntry::Printed { amount: 3.0 }));
    }

    #[test]
    fn every_label_nutrient_has_a_stored_unit_and_a_synonym() {
        for id in LABEL_NUTRIENT_IDS {
            assert!(stored_unit(id).is_some(), "no stored unit for {id}");
            assert!(
                SYNONYMS.iter().any(|(sid, _)| *sid == id),
                "no synonym for {id}"
            );
        }
        for (id, _) in SYNONYMS {
            assert!(
                LABEL_NUTRIENT_IDS.contains(id),
                "synonym for {id}, which is not on the panel"
            );
        }
    }
}
