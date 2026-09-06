//! Reading a Supplement Facts panel.
//!
//! Same geometry as [`crate::panel`] — rows reassembled from vertical overlap,
//! because "Vitamin D3 (as cholecalciferol)" and "25 mcg" are two unrelated
//! strings until they are put back on one line — but not the same content. A
//! Supplement Facts panel differs from a Nutrition Facts panel in three ways
//! that each have their own way of producing a wrong number:
//!
//! 1. **It names a chemical form.** "(as d-alpha tocopheryl acetate)" is not a
//!    second nutrient and not part of the amount; it is what decides whether an
//!    IU figure converts at 0.67 or 0.45. It is read from the parenthetical and
//!    from nowhere else — [`crate::supplement`] already models an unstated form
//!    as a refusal, and a form guessed from the nutrient's name would turn that
//!    refusal into a fabricated number.
//! 2. **It prints the same figure twice.** "25 mcg (1,000 IU)" is one dose in
//!    two units. The mcg is taken: it is the modern FDA format and it converts
//!    without knowing the compound, whereas the IU figure cannot be converted
//!    at all unless the form is named.
//! 3. **Its units are compound.** "400 mcg DFE", "15 mg NE", "18 mg
//!    alpha-tocopherol" — the trailing word names the *basis* the figure is on.
//!    The leading token is what [`supplement::LabelUnit::parse`] reads, and the
//!    whole printed string is kept verbatim so a stored figure can still be
//!    checked against the pack years later.
//!
//! And one rule shared with the nutrition panel, for the same reason: **the
//! %DV column is never an amount.** Here it is enforced from the other
//! direction — every nutrient line on a supplement panel prints a unit, so a
//! figure whose unit this app cannot name is not a candidate at all. "100%" and
//! a bare "60" both fail that test and neither can ever reach a reading.
//!
//! Nothing here is decided. Every [`SupReading`] is a suggestion the user
//! confirms against the bottle, and `regime` and `panel_complete` are not
//! suggested at all — no photograph can assert which market printed a pack or
//! that its panel lists everything in it.

use crate::panel::{self, TextBlock};
use crate::supplement::{self, Form, LabelUnit};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SupReading {
    pub nutrient_id: i64,
    /// Exactly as printed — these three are what make the conversion auditable.
    pub label_amount: f64,
    /// The whole printed unit, "mcg DFE" and not "mcg". The leading token is
    /// what parses; the rest is what the pack said.
    pub label_unit: String,
    /// A [`Form`] identifier, or empty when the pack named no form this app's
    /// arithmetic distinguishes. Empty is a real state, not a missing one.
    pub label_form: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SupPanel {
    /// How many of `unit_noun` one label serving is: "Serving Size 2 tablets".
    pub serving_units: Option<f64>,
    /// The serving row's own wording, so the user can check it word for word.
    pub serving_label: Option<String>,
    /// The thing being counted, singularised: "tablet", "capsule", "scoop".
    pub unit_noun: Option<String>,
    /// In the order the panel prints them, which is the order the user will
    /// read them back in.
    pub readings: Vec<SupReading>,
    /// Rows nothing could be attributed to. A ratio to judge the readings
    /// against, not a defect list — a panel's own furniture counts.
    pub unmatched_rows: usize,
    pub trouble: Option<String>,
}

/// Every nutrient this parser can name, with the spellings packs really print.
///
/// The hyphenated forms are here because names match on exact tokens and a
/// hyphen survives normalisation: "Vitamin B-12" is ordinary pack typography,
/// and without its own entry the whole row is dropped rather than misread.
///
/// The ids are this app's reference-database ids and must not drift: the same
/// bottle scanned twice has to land on the same nutrient. Matching is
/// longest-phrase-first across nutrients, so a two-word name always beats a
/// one-word name inside it.
const SYNONYMS: &[(i64, &[&str])] = &[
    // ── Vitamins ────────────────────────────────────────────────────────
    (1106, &["vitamin a", "vit a"]),
    (1162, &["vitamin c", "vit c", "ascorbic acid", "l-ascorbic acid"]),
    (
        1114,
        &[
            "vitamin d",
            "vitamin d3",
            "vitamin d-3",
            "vitamin d2",
            "vitamin d-2",
            "vit d",
            "vit d3",
            "vit d-3",
            "cholecalciferol",
        ],
    ),
    (
        1109,
        &[
            "vitamin e",
            "vit e",
            "alpha-tocopherol",
            "alpha tocopherol",
        ],
    ),
    (
        1185,
        &[
            "vitamin k",
            "vitamin k1",
            "vitamin k-1",
            "vitamin k2",
            "vitamin k-2",
            "vit k",
            "phylloquinone",
            "menaquinone",
        ],
    ),
    (
        1165,
        &["thiamin", "thiamine", "vitamin b1", "vitamin b-1", "vit b1"],
    ),
    (1166, &["riboflavin", "vitamin b2", "vitamin b-2", "vit b2"]),
    (
        1167,
        &[
            "niacin",
            "niacinamide",
            "nicotinamide",
            "vitamin b3",
            "vitamin b-3",
            "vit b3",
        ],
    ),
    (
        1170,
        &[
            "pantothenic acid",
            "vitamin b5",
            "vitamin b-5",
            "vit b5",
            "calcium pantothenate",
            "pantothenate",
        ],
    ),
    (
        1175,
        &[
            "vitamin b6",
            "vitamin b-6",
            "vit b6",
            "pyridoxine",
            "pyridoxine hydrochloride",
        ],
    ),
    (1176, &["biotin", "vitamin b7", "vitamin b-7", "vit b7"]),
    (
        1190,
        &["folate", "folic acid", "vitamin b9", "vitamin b-9", "vit b9"],
    ),
    (
        1178,
        &[
            "vitamin b12",
            "vitamin b-12",
            "vit b12",
            "vit b-12",
            "cobalamin",
            "methylcobalamin",
            "cyanocobalamin",
        ],
    ),
    // ── Minerals ────────────────────────────────────────────────────────
    (1087, &["calcium"]),
    (1089, &["iron"]),
    (1090, &["magnesium"]),
    (1091, &["phosphorus", "phosphorous"]),
    (1092, &["potassium"]),
    // Salt is deliberately absent, for the reason panel.rs gives: it is sodium
    // chloride, 2.5 times the sodium by mass.
    (1093, &["sodium"]),
    (1095, &["zinc"]),
    (1098, &["copper"]),
    (1101, &["manganese"]),
    (1103, &["selenium"]),
    (1100, &["iodine", "iodide"]),
    (1096, &["chromium"]),
    (1102, &["molybdenum"]),
];

/// Words that qualify a unit rather than following it: "mcg **DFE**", "mg
/// **NE**", "mg **alpha-tocopherol**". Absorbed into the printed unit text so
/// the stored figure keeps the basis the pack put it on.
///
/// No nutrient name appears here. A word that could open the next nutrient on a
/// two-column row must not be eaten as part of this one's unit.
const QUALIFIERS: &[&str] = &[
    "dfe",
    "ne",
    "rae",
    "re",
    "te",
    "ate",
    "\u{3b1}-te",
    "alpha-tocopherol",
    "alpha",
    "tocopherol",
    "tocopherols",
    "equivalent",
    "equivalents",
];

/// Adjectives a serving row puts between the count and the thing counted:
/// "1 **level** scoop".
const MEASURE_WORDS: &[&str] = &[
    "level",
    "heaping",
    "heaped",
    "rounded",
    "slightly",
    "approximately",
    "approx",
    "about",
];

/// Row openings that mean this is not a panel line. "Other Ingredients:
/// Magnesium Stearate" names a mineral and is not a declaration of one.
const NOT_PANEL: &[&str] = &["ingredients", "other ingredients"];

/// Words that introduce the compound a nutrient was supplied AS. Whatever
/// follows one of these names a form, never a second nutrient: "Selenium, as
/// sodium selenite, 55 mcg" declares 55 mcg of selenium and no sodium at all.
///
/// The bracket test alone cannot carry this. `in_paren` counts literal
/// parentheses, so it is blind to the same wording set off by commas or square
/// brackets — and to a pack whose opening "(" the recogniser lost to one faint
/// glyph. In every one of those the compound's own name would be accepted,
/// would take the row's only figure through the `bound` rule below, and would
/// be offered as a nutrient the pack never declared while the real one vanished.
const FORM_LEADS: &[&str] = &[
    "as",
    "from",
    "form",
    "forms",
    "providing",
    "provides",
    "yielding",
    "yields",
];

pub fn parse(blocks: &[TextBlock]) -> SupPanel {
    let rows = panel::rows_from(blocks);

    let mut readings: Vec<SupReading> = Vec::new();
    let mut serving_units: Option<f64> = None;
    let mut serving_label: Option<String> = None;
    let mut unit_noun: Option<String> = None;
    let mut serving_seen = false;
    let mut unmatched_rows = 0usize;
    // Rows that named a nutrient, whether or not a figure could be read off
    // them. This is what separates "this is not a panel" from "this is a panel
    // I could not read", which are two different things for the user to do.
    let mut named_rows = 0usize;

    for row in &rows {
        let toks = tokenize(row);
        if toks.is_empty() {
            continue;
        }
        let mut attributed = false;

        // Only the first serving row counts, the same as panel.rs: a pack that
        // repeats it in another language would otherwise overwrite it.
        if !serving_seen {
            if let Some(s) = serving_from(&toks) {
                serving_seen = true;
                serving_units = s.units;
                serving_label = s.label;
                unit_noun = s.noun;
                attributed = true;
            }
        }

        let (named, found) = readings_from(row, &toks);
        if named > 0 {
            named_rows += 1;
        }
        for r in found {
            // First row wins: a panel declares a nutrient once, and a second
            // hit is a footnote or a second column rather than a correction.
            if !readings.iter().any(|x| x.nutrient_id == r.nutrient_id) {
                readings.push(r);
            }
            attributed = true;
        }

        if !attributed {
            unmatched_rows += 1;
        }
    }

    let trouble = trouble_for(readings.len(), rows.len(), named_rows, serving_seen);

    SupPanel {
        serving_units,
        serving_label,
        unit_noun,
        readings,
        unmatched_rows,
        trouble,
    }
}

/// The sentence for a scan that produced nothing.
///
/// Three failures with three different remedies. "0 nutrients" describes the
/// result rather than the cause and leaves nothing to try next.
fn trouble_for(
    readings: usize,
    rows: usize,
    named_rows: usize,
    serving_seen: bool,
) -> Option<String> {
    if readings > 0 {
        return None;
    }
    if rows == 0 {
        return Some(
            "No text was found in this photo at all. It is likely too far away, too dark or \
             too blurry — fill the frame with the Supplement Facts panel and hold the camera \
             steady."
                .into(),
        );
    }
    if named_rows == 0 && !serving_seen {
        return Some(
            "No Supplement Facts panel was found in this photo. There is text on it, but none \
             of it reads as a panel line — the panel is usually on the back or the side of the \
             bottle."
                .into(),
        );
    }
    Some(
        "The panel was legible, but no line could be read as an amount. Retake it square-on \
         with the whole panel in the frame and no glare across the figures, or type the \
         amounts in below."
            .into(),
    )
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// Punctuation stripped from a token's edges. The full stop is here so "Vit."
/// normalises to "vit"; it is stripped only at the edges, so the point in "1.2"
/// survives. The dagger and double dagger are a panel's own footnote markers.
const EDGE: &[char] = &[
    '(', ')', '[', ']', '{', '}', ',', ';', ':', '*', '|', '"', '\'', '\u{2018}', '\u{2019}',
    '\u{201c}', '\u{201d}', '.', '\u{2020}', '\u{2021}',
];

struct Tok {
    /// Byte offset of this token in the row it came from, so a nutrient's own
    /// stretch of the row can be sliced back out — a form parenthetical belongs
    /// to the name it follows and to no other on the same row.
    at: usize,
    /// As printed, punctuation and all, so a serving row reads back word for
    /// word — "1 Level Scoop (10 g)" and not "1 Level Scoop 10 g".
    raw: String,
    /// Edge punctuation removed and commas resolved. Numbers parse here.
    clean: String,
    /// `clean`, lowercased with full stops removed. Names match here.
    norm: String,
    /// Whether this token sits inside a parenthesis. A parenthetical on a
    /// supplement panel is the chemical form, and the words in it are NOT a
    /// nutrient declaration: "Selenium (as sodium selenite)" declares selenium,
    /// not sodium.
    in_paren: bool,
}

/// Commas resolved rather than deleted, on the same rule panel.rs uses: a comma
/// with exactly three digits after it is a thousands separator, and anywhere
/// else it is a decimal comma. Deleting it there multiplies a figure by ten.
fn de_comma(s: &str) -> String {
    let ch: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, c) in ch.iter().enumerate() {
        if *c != ',' {
            out.push(*c);
            continue;
        }
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
    let mut out = Vec::new();
    let mut depth: i32 = 0;
    for word in row.split_whitespace() {
        // `split_whitespace` yields subslices of `row`, so pointer arithmetic
        // against the base gives the offset without a second scan.
        let at = word.as_ptr() as usize - row.as_ptr() as usize;
        // A token that opens a parenthesis is itself inside it, so the opening
        // depth is taken before the word's own brackets are counted.
        let opens = word.matches('(').count() as i32;
        let closes = word.matches(')').count() as i32;
        let in_paren = depth > 0 || opens > 0;
        depth = (depth + opens - closes).max(0);

        let trimmed = word.trim_matches(|c: char| EDGE.contains(&c));
        if trimmed.is_empty() {
            continue;
        }
        let clean = de_comma(trimmed);
        let norm: String = clean
            .chars()
            .filter(|c| *c != '.')
            .flat_map(|c| c.to_lowercase())
            .collect();
        out.push(Tok {
            at,
            raw: word.to_string(),
            clean,
            norm,
            in_paren,
        });
    }
    out
}

/// A token's text with its edge punctuation removed, for a unit read out of
/// "(1,000 IU)" where the closing bracket is not part of the unit.
fn bare(word: &str) -> String {
    word.trim_matches(|c: char| EDGE.contains(&c)).to_string()
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

struct NumCand {
    start: usize,
    /// One past the last token consumed, unit and qualifiers included.
    end: usize,
    value: f64,
    unit: LabelUnit,
    /// The unit exactly as printed, qualifiers and all.
    unit_text: String,
    in_paren: bool,
}

/// `(value, trailing suffix)` when a token begins with a number.
fn split_number(s: &str) -> Option<(f64, &str)> {
    let rest = s.strip_prefix('<').unwrap_or(s);
    let split = rest
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(rest.len());
    let (digits, suffix) = rest.split_at(split);
    if !digits.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let value: f64 = digits.parse().ok()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    Some((value, suffix))
}

/// Every figure on the row that carries a unit this app can name.
///
/// **This is where the %DV column dies.** A candidate is built only when a
/// [`LabelUnit`] parses out of the token after the digits, so "100%" — whose
/// suffix is "%" — and a bare "60" never become candidates at all. On a
/// supplement panel that costs nothing: every nutrient line prints its unit.
fn numbers_in(toks: &[Tok]) -> Vec<NumCand> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let Some((value, suffix)) = split_number(&toks[i].clean) else {
            i += 1;
            continue;
        };

        let mut end = i + 1;
        let mut parts: Vec<String> = Vec::new();
        let unit = if !suffix.is_empty() {
            // "25mcg", printed with no space.
            LabelUnit::parse(suffix).inspect(|_| parts.push(suffix.to_string()))
        } else if let Some(t) = toks.get(end) {
            match LabelUnit::parse(&t.norm) {
                Some(u) => {
                    parts.push(bare(&t.raw));
                    end += 1;
                    Some(u)
                }
                None => None,
            }
        } else {
            None
        };

        let Some(unit) = unit else {
            i += 1;
            continue;
        };

        // At most two: "mcg DFE" is one, "mg alpha tocopherol" is two, and
        // three would be a sentence rather than a unit.
        for _ in 0..2 {
            match toks.get(end) {
                Some(t) if QUALIFIERS.contains(&t.norm.as_str()) => {
                    parts.push(bare(&t.raw));
                    end += 1;
                }
                _ => break,
            }
        }

        out.push(NumCand {
            start: i,
            end,
            value,
            unit,
            unit_text: parts.join(" "),
            in_paren: toks[i].in_paren,
        });
        i = end;
    }
    out
}

// ---------------------------------------------------------------------------
// Chemical form
// ---------------------------------------------------------------------------

/// A parenthetical reduced to space-separated words, padded at both ends, so a
/// phrase can be matched whole. Hyphens become spaces, which is what keeps
/// "d-alpha" and "dl-alpha" — a 1.49x difference — from matching each other.
fn flatten(s: &str) -> String {
    let mut out = String::from(" ");
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    if !out.ends_with(' ') {
        out.push(' ');
    }
    out
}

/// The form a parenthetical names, as a [`Form`] identifier, or `""`.
///
/// Only the compounds [`crate::supplement`] gives a different factor to are
/// named here. "(as magnesium oxide)" returns nothing, and that is right rather
/// than a gap: 21 CFR 101.36(b)(3)(ii) makes the salt declare elemental
/// magnesium, so the oxide never enters the arithmetic and claiming a form
/// would only imply it did.
///
/// Plain "beta-carotene" is deliberately absent too. Supplemental and dietary
/// beta-carotene differ sixfold, the pack that says only "beta-carotene" has
/// not said which, and `supplement::convert` already refuses an unstated form
/// with a sentence explaining the choice. Guessing here would replace that
/// refusal with a number six times out.
fn form_in(row: &str) -> String {
    for group in parentheticals(row) {
        let f = flatten(&group);
        let id = if f.contains(" dl alpha ") || f.contains(" all rac ") {
            "alpha_tocopherol_synthetic"
        } else if f.contains(" d alpha ") || f.contains(" rrr alpha ") {
            "alpha_tocopherol_natural"
        } else if f.contains(" methylfolate ")
            || f.contains(" l methylfolate ")
            || f.contains(" methyltetrahydrofolate ")
            || f.contains(" mthf ")
            || f.contains(" metafolin ")
            || f.contains(" quatrefolic ")
        {
            "methylfolate"
        } else if f.contains(" folic acid ") || f.contains(" pteroylmonoglutamic ") {
            "folic_acid"
        } else if f.contains(" food folate ") || f.contains(" natural folate ") {
            "food_folate"
        } else if f.contains(" cholecalciferol ")
            || f.contains(" ergocalciferol ")
            || f.contains(" d3 ")
            || f.contains(" d2 ")
        {
            "vitamin_d"
        } else if f.contains(" retinyl ")
            || f.contains(" retinol ")
            || f.contains(" vitamin a acetate ")
            || f.contains(" vitamin a palmitate ")
        {
            "retinol"
        } else {
            continue;
        };
        // Round-tripped through the domain rather than returned as a bare
        // string: what is stored has to be a Form this app can read back.
        if let Some(form) = Form::parse(id) {
            return form.as_str().to_string();
        }
    }
    String::new()
}

/// The text inside each parenthesis on the row, outermost first.
fn parentheticals(row: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut buf = String::new();
    for c in row.chars() {
        match c {
            '(' => {
                if depth == 0 {
                    buf.clear();
                } else {
                    buf.push(c);
                }
                depth += 1;
            }
            ')' => {
                depth = (depth - 1).max(0);
                if depth == 0 {
                    if !buf.trim().is_empty() {
                        out.push(buf.clone());
                    }
                    buf.clear();
                } else {
                    buf.push(c);
                }
            }
            _ if depth > 0 => buf.push(c),
            _ => {}
        }
    }
    // An unclosed parenthesis is ordinary on a cropped photo; take what there is.
    if depth > 0 && !buf.trim().is_empty() {
        out.push(buf);
    }
    out
}

// ---------------------------------------------------------------------------
// Serving size
// ---------------------------------------------------------------------------

struct Serving {
    units: Option<f64>,
    label: Option<String>,
    noun: Option<String>,
}

/// `Some` when this row is the serving-size line.
///
/// "Servings Per Container 60" is a different row and does not match: the token
/// is "servings", not "serving". Mistaking it would make one bottle a serving
/// and multiply every figure on the panel by sixty.
fn serving_from(toks: &[Tok]) -> Option<Serving> {
    let at = (0..toks.len().saturating_sub(1))
        .find(|i| toks[*i].norm == "serving" && toks[i + 1].norm == "size")?;
    let rest = at + 2;

    let label = toks[rest..]
        .iter()
        .map(|t| t.raw.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let label = label.trim().trim_start_matches([':', '-']).trim().to_string();

    // The count is the first plain figure after the header, and never one
    // inside a parenthesis: "1 Scoop (10 g)" is one scoop, not ten.
    let count_at = (rest..toks.len()).find(|i| !toks[*i].in_paren && split_number(&toks[*i].clean).is_some());
    let units = count_at
        .and_then(|i| split_number(&toks[i].clean))
        .map(|(v, _)| v)
        .filter(|v| *v > 0.0);

    let noun = count_at.and_then(|i| {
        toks[i + 1..]
            .iter()
            .take_while(|t| !t.in_paren)
            .find(|t| {
                t.norm.chars().all(|c| c.is_alphabetic())
                    && t.norm.chars().count() >= 2
                    && !MEASURE_WORDS.contains(&t.norm.as_str())
            })
            .map(|t| singular(&t.norm))
    });

    Some(Serving {
        units,
        label: if label.is_empty() { None } else { Some(label) },
        noun,
    })
}

/// "tablets" -> "tablet", "gummies" -> "gummy". Two-letter units ("ml", "oz")
/// are left alone, and a word ending "ss" is not a plural.
fn singular(word: &str) -> String {
    let n = word.chars().count();
    if n > 4 && word.ends_with("ies") {
        return format!("{}y", &word[..word.len() - 3]);
    }
    if n > 3 && word.ends_with('s') && !word.ends_with("ss") && !word.ends_with("us") {
        return word[..word.len() - 1].to_string();
    }
    word.to_string()
}

// ---------------------------------------------------------------------------
// Nutrient rows
// ---------------------------------------------------------------------------

struct NameMatch {
    nutrient_id: i64,
    start: usize,
    end: usize,
}

/// Whether the name beginning at `start` is introduced as a chemical form.
///
/// A %DV token is stepped over on the way back, because a two-column row prints
/// the left column's percentage immediately before the right column's name; so
/// is a single "of", for "in the form of magnesium oxide". A name at the head
/// of the row can never be caught by this: there is nothing before it.
fn follows_a_form_lead(toks: &[Tok], start: usize) -> bool {
    let mut i = start;
    while i > 0 && toks[i - 1].clean.ends_with('%') {
        i -= 1;
    }
    if i > 0 && toks[i - 1].norm == "of" {
        i -= 1;
    }
    i > 0 && FORM_LEADS.contains(&toks[i - 1].norm.as_str())
}

/// Returns how many nutrient names the row declared, and the readings taken
/// off them. The two counts differ whenever a name was legible but its figure
/// was not, which is a different failure with a different remedy — hence both.
fn readings_from(row: &str, toks: &[Tok]) -> (usize, Vec<SupReading>) {
    let row_norm = toks
        .iter()
        .map(|t| t.norm.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if NOT_PANEL.iter().any(|h| row_norm.starts_with(h)) {
        return (0, Vec::new());
    }

    let mut candidates: Vec<NameMatch> = Vec::new();
    for (nutrient_id, syns) in SYNONYMS {
        for syn in *syns {
            let wordsv: Vec<&str> = syn.split(' ').collect();
            if wordsv.len() > toks.len() {
                continue;
            }
            for start in 0..=(toks.len() - wordsv.len()) {
                // A name inside a parenthesis is the form, not a declaration.
                if toks[start].in_paren {
                    continue;
                }
                // Nor is a name the pack introduced with "as" or "from",
                // whatever punctuation it used around it.
                if follows_a_form_lead(toks, start) {
                    continue;
                }
                if wordsv
                    .iter()
                    .enumerate()
                    .all(|(k, w)| toks[start + k].norm == *w)
                {
                    candidates.push(NameMatch {
                        nutrient_id: *nutrient_id,
                        start,
                        end: start + wordsv.len(),
                    });
                }
            }
        }
    }

    // One match per nutrient, and it is the LEFTMOST one — the opposite of the
    // longest-first rule below, and deliberately so. "Folate 400 mcg DFE"
    // followed by a second folate spelling later on the row must keep the match
    // at the head of the row, or the figure printed after the name would sit
    // behind the accepted match and be lost.
    candidates.sort_by(|a, b| {
        a.nutrient_id
            .cmp(&b.nutrient_id)
            .then(a.start.cmp(&b.start))
            .then((b.end - b.start).cmp(&(a.end - a.start)))
    });
    candidates.dedup_by_key(|c| c.nutrient_id);

    // Longest span first across nutrients: this is what keeps "Calcium
    // Pantothenate" from being read as calcium, and "Ascorbic Acid" from being
    // split. An overlapping shorter name loses.
    candidates.sort_by(|a, b| {
        (b.end - b.start)
            .cmp(&(a.end - a.start))
            .then(a.start.cmp(&b.start))
            .then(a.nutrient_id.cmp(&b.nutrient_id))
    });

    let mut accepted: Vec<NameMatch> = Vec::new();
    for c in candidates {
        let overlaps = accepted
            .iter()
            .any(|a| c.start < a.end && a.start < c.end);
        if !overlaps {
            accepted.push(c);
        }
    }
    accepted.sort_by_key(|m| m.start);

    let nums = numbers_in(toks);
    let named = accepted.len();

    let mut out = Vec::new();
    let mut claimed = vec![false; nums.len()];

    for (k, m) in accepted.iter().enumerate() {
        // A figure may not be read across the next nutrient's name. On a
        // two-column footer "Zinc 11mg • Copper" the 11 belongs to zinc and
        // copper simply printed nothing; lifting the neighbour's figure is the
        // quiet error this app cannot make.
        let bound = accepted
            .get(k + 1)
            .map(|next| next.start)
            .unwrap_or(toks.len());

        let eligible: Vec<usize> = (0..nums.len())
            .filter(|i| !claimed[*i])
            .filter(|i| nums[*i].start >= m.end && nums[*i].end <= bound)
            .collect();

        // The dual-declaration rule. "25 mcg (1,000 IU)" is one dose printed
        // twice; the mcg is taken because it converts without knowing the
        // compound and the IU does not. Within each group the unparenthesised
        // figure wins, which is also what picks "400 mcg DFE" over the
        // "(240 mcg folic acid)" printed beside it.
        let pick = |iu: bool| -> Option<usize> {
            let group: Vec<usize> = eligible
                .iter()
                .copied()
                .filter(|i| (nums[*i].unit == LabelUnit::Iu) == iu)
                .collect();
            group
                .iter()
                .copied()
                .find(|i| !nums[*i].in_paren)
                .or_else(|| group.first().copied())
        };
        let Some(chosen) = pick(false).or_else(|| pick(true)) else {
            continue;
        };
        claimed[chosen] = true;
        let n = &nums[chosen];

        // The form is read from THIS nutrient's own stretch of the row: from
        // the end of its name to the start of the next nutrient's. Reading the
        // whole row would hand every nutrient on a two-column line the first
        // parenthetical printed anywhere on it — "as cholecalciferol" attached
        // to the zinc beside it, which the pack never said, and the vitamin E
        // form the pack DID print overwritten by its neighbour's.
        let from = toks[m.end - 1].at + toks[m.end - 1].raw.len();
        let to = if bound < toks.len() {
            toks[bound].at
        } else {
            row.len()
        };
        let mut label_form = form_in(&row[from..to.max(from)]);

        // A compliant panel prints vitamin A in mcg RAE and folate in mcg DFE —
        // figures the maker has ALREADY put on this app's basis. Naming the
        // compound as well would make `supplement::convert` apply the factor a
        // second time on its mass path: a beta-carotene figure halved, a folate
        // figure multiplied by 1.7. The form is carried for these two only
        // where the pack printed IU, which cannot be converted without it.
        if matches!(
            m.nutrient_id,
            supplement::VITAMIN_A | supplement::FOLATE_DFE
        ) && n.unit != LabelUnit::Iu
        {
            label_form.clear();
        }

        out.push(SupReading {
            nutrient_id: m.nutrient_id,
            label_amount: n.value,
            label_unit: n.unit_text.clone(),
            label_form,
        });
    }

    (named, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(text: &str, x: f64, y: f64, w: f64) -> TextBlock {
        TextBlock {
            text: text.to_string(),
            x,
            y,
            w,
            h: 0.024,
        }
    }

    /// A realistic multivitamin panel laid out the way an OCR engine returns
    /// one: the nutrient name, the amount and the %DV are three separate
    /// blocks at three different x positions on the same line.
    fn multivitamin() -> Vec<TextBlock> {
        let mut v = vec![
            b("Supplement Facts", 0.05, 0.030, 0.60),
            b("Serving Size 2 Tablets", 0.05, 0.080, 0.50),
            b("Servings Per Container 60", 0.05, 0.115, 0.55),
            b("Amount Per Serving", 0.05, 0.160, 0.40),
            b("% Daily Value", 0.72, 0.160, 0.23),
        ];
        let lines: &[(&str, &str, &str)] = &[
            ("Vitamin A (as retinyl palmitate)", "900 mcg", "100%"),
            ("Vitamin C (as ascorbic acid)", "90 mg", "100%"),
            ("Vitamin D3 (as cholecalciferol)", "25 mcg (1,000 IU)", "125%"),
            (
                "Vitamin E (as d-alpha tocopheryl acetate)",
                "18 mg",
                "120%",
            ),
            ("Thiamin (as thiamine mononitrate)", "1.2 mg", "100%"),
            ("Niacin (as niacinamide)", "16 mg NE", "100%"),
            ("Folate", "400 mcg DFE (240 mcg folic acid)", "100%"),
            ("Vitamin B12 (as methylcobalamin)", "2.4 mcg", "100%"),
            ("Magnesium (as magnesium oxide)", "420 mg", "100%"),
            ("Zinc (as zinc gluconate)", "11 mg", "100%"),
            ("Selenium (as sodium selenite)", "55 mcg", "100%"),
        ];
        for (i, (name, amount, dv)) in lines.iter().enumerate() {
            let y = 0.200 + i as f64 * 0.040;
            v.push(b(name, 0.05, y, 0.45));
            v.push(b(amount, 0.52, y, 0.20));
            v.push(b(dv, 0.85, y, 0.10));
        }
        v
    }

    fn got(p: &SupPanel, nutrient_id: i64) -> SupReading {
        p.readings
            .iter()
            .find(|r| r.nutrient_id == nutrient_id)
            .unwrap_or_else(|| panic!("nutrient {nutrient_id} was not read: {:?}", p.readings))
            .clone()
    }

    /// One block per row, stacked far enough apart that rows never merge.
    fn stack(lines: &[&str]) -> Vec<TextBlock> {
        lines
            .iter()
            .enumerate()
            .map(|(i, t)| b(t, 0.05, 0.10 + i as f64 * 0.05, 0.9))
            .collect()
    }

    #[test]
    fn a_multivitamin_panel_reads_every_field_of_its_rows() {
        let p = parse(&multivitamin());
        assert_eq!(p.trouble, None);

        assert_eq!(
            got(&p, 1162),
            SupReading {
                nutrient_id: 1162,
                label_amount: 90.0,
                label_unit: "mg".into(),
                label_form: String::new(),
            }
        );
        assert_eq!(
            got(&p, 1109),
            SupReading {
                nutrient_id: 1109,
                label_amount: 18.0,
                label_unit: "mg".into(),
                // "d-alpha", not "dl-alpha" — one letter, a 1.49x difference.
                label_form: "alpha_tocopherol_natural".into(),
            }
        );
        assert_eq!(
            got(&p, 1167),
            SupReading {
                nutrient_id: 1167,
                label_amount: 16.0,
                // The basis is kept: this is 16 mg of niacin equivalents.
                label_unit: "mg NE".into(),
                label_form: String::new(),
            }
        );
        assert_eq!(got(&p, 1165).label_amount, 1.2);
        assert_eq!(got(&p, 1178).label_amount, 2.4);
        assert_eq!(got(&p, 1090).label_amount, 420.0);
        assert_eq!(got(&p, 1095).label_amount, 11.0);
        assert_eq!(got(&p, 1103).label_amount, 55.0);
        assert_eq!(got(&p, 1106).label_amount, 900.0);
    }

    #[test]
    fn a_form_named_in_a_parenthetical_is_captured() {
        let p = parse(&multivitamin());
        assert_eq!(got(&p, 1114).label_form, "vitamin_d");
        assert_eq!(got(&p, 1109).label_form, "alpha_tocopherol_natural");
    }

    #[test]
    fn a_synthetic_vitamin_e_is_not_read_as_the_natural_one() {
        let p = parse(&stack(&[
            "Vitamin E (as dl-alpha tocopheryl acetate) 30 IU 100%",
        ]));
        assert_eq!(got(&p, 1109).label_form, "alpha_tocopherol_synthetic");
        assert_eq!(got(&p, 1109).label_amount, 30.0);
        assert_eq!(got(&p, 1109).label_unit, "IU");
    }

    #[test]
    fn a_dual_declaration_takes_the_metric_figure_and_not_the_iu() {
        let p = parse(&multivitamin());
        let d = got(&p, 1114);
        assert_eq!(
            d.label_amount, 25.0,
            "25 mcg and 1,000 IU are one dose; the mcg is the one that converts"
        );
        assert_eq!(d.label_unit, "mcg");
    }

    #[test]
    fn an_iu_figure_is_taken_when_it_is_the_only_one_printed() {
        let p = parse(&stack(&["Vitamin A (as retinyl acetate) 5,000 IU 100%"]));
        let a = got(&p, 1106);
        assert_eq!(a.label_amount, 5000.0, "the thousands comma is a separator");
        assert_eq!(a.label_unit, "IU");
        assert_eq!(
            a.label_form, "retinol",
            "an IU figure cannot be converted without the form, so it is carried"
        );
    }

    #[test]
    fn a_metric_figure_wins_even_where_the_pack_prints_the_iu_first() {
        let p = parse(&stack(&["Vitamin D 1,000 IU (25 mcg) 125%"]));
        let d = got(&p, 1114);
        assert_eq!(d.label_amount, 25.0);
        assert_eq!(d.label_unit, "mcg");
    }

    #[test]
    fn a_compound_unit_is_kept_whole_and_its_sub_declaration_ignored() {
        let p = parse(&multivitamin());
        let f = got(&p, 1190);
        assert_eq!(f.label_amount, 400.0);
        assert_eq!(
            f.label_unit, "mcg DFE",
            "the basis is part of what the pack said"
        );
        assert_eq!(
            f.label_form, "",
            "a mcg DFE figure has already had the folic-acid factor applied; \
             naming the form would apply it twice"
        );
    }

    #[test]
    fn a_percent_daily_value_never_becomes_an_amount() {
        // Every row here prints 100% beside its figure, and the vitamin C row
        // prints nothing else that could be confused for one.
        let p = parse(&multivitamin());
        for r in &p.readings {
            assert_ne!(
                r.label_amount, 100.0,
                "a %DV was read as an amount: {r:?}"
            );
        }
        // And a row whose only figure IS a percentage yields nothing at all.
        let bare = parse(&stack(&["Chromium 100%"]));
        assert!(
            bare.readings.is_empty(),
            "a %DV alone is not an amount: {:?}",
            bare.readings
        );
    }

    #[test]
    fn servings_per_container_is_not_the_serving_size() {
        let p = parse(&multivitamin());
        assert_eq!(p.serving_units, Some(2.0), "two tablets, not sixty");
        assert_eq!(p.unit_noun.as_deref(), Some("tablet"));
        assert_eq!(p.serving_label.as_deref(), Some("2 Tablets"));

        // On its own, with no serving-size row anywhere, it must yield nothing.
        let alone = parse(&stack(&["Servings Per Container 60"]));
        assert_eq!(alone.serving_units, None);
        assert_eq!(alone.unit_noun, None);
    }

    #[test]
    fn a_serving_counts_the_measure_and_not_the_weight_beside_it() {
        let p = parse(&stack(&["Serving Size: 1 Level Scoop (10 g)"]));
        assert_eq!(p.serving_units, Some(1.0));
        assert_eq!(
            p.unit_noun.as_deref(),
            Some("scoop"),
            "\"level\" describes the scoop; the scoop is what is counted"
        );
        assert_eq!(p.serving_label.as_deref(), Some("1 Level Scoop (10 g)"));
    }

    #[test]
    fn gummies_singularise_without_losing_their_stem() {
        let p = parse(&stack(&["Serving Size 2 Gummies"]));
        assert_eq!(p.unit_noun.as_deref(), Some("gummy"));
    }

    #[test]
    fn a_name_inside_a_form_parenthetical_is_not_a_declaration() {
        // "Selenium (as sodium selenite)" declares selenium. Reading the word
        // "sodium" out of the parenthetical would put 55 mcg of sodium into a
        // day's arithmetic.
        let p = parse(&multivitamin());
        assert!(
            !p.readings.iter().any(|r| r.nutrient_id == 1093),
            "sodium came from a chemical form, not from a panel line: {:?}",
            p.readings
        );
        assert_eq!(got(&p, 1103).label_amount, 55.0);
    }

    #[test]
    fn a_form_named_without_brackets_is_still_not_a_declaration() {
        // The bracket is the only thing separating these four spellings, and a
        // pack prints all of them. Read as a declaration, the compound's own
        // name takes the row's figure through the `bound` rule and the real
        // nutrient is dropped: 55 mcg of sodium, or half a day of calcium
        // invented out of a vitamin C row.
        for row in [
            "Selenium, as sodium selenite, 55 mcg 100%",
            "Selenium [as sodium selenite] 55 mcg 100%",
            // One faint glyph lost by the recogniser.
            "Selenium as sodium selenite) 55 mcg 100%",
            "Selenium in the form of sodium selenite 55 mcg 100%",
        ] {
            let p = parse(&stack(&[row]));
            assert!(
                !p.readings.iter().any(|r| r.nutrient_id == 1093),
                "sodium is part of the compound in {row:?}: {:?}",
                p.readings
            );
            assert_eq!(got(&p, 1103).label_amount, 55.0, "{row:?}");
        }

        let p = parse(&stack(&["Vitamin C as calcium ascorbate 500 mg 556%"]));
        assert!(
            !p.readings.iter().any(|r| r.nutrient_id == 1087),
            "calcium ascorbate declares vitamin C: {:?}",
            p.readings
        );
        assert_eq!(got(&p, 1162).label_amount, 500.0);
    }

    #[test]
    fn a_form_wording_that_repeats_the_nutrient_still_reads_as_that_nutrient() {
        // The guard must not swallow the declaration itself: the leading name
        // has nothing before it, so only the compound's copy is rejected.
        let p = parse(&stack(&["Magnesium, from magnesium citrate, 200 mg 48%"]));
        assert_eq!(got(&p, 1090).label_amount, 200.0);
    }

    #[test]
    fn a_form_stays_with_the_nutrient_whose_parenthetical_it_is() {
        // Two nutrients on one row, each with its own form. Reading the form
        // off the whole row gives the first parenthetical to both: a form the
        // pack never printed for zinc, and the vitamin E form it DID print
        // overwritten by its neighbour's.
        let p = parse(&stack(&[
            "Zinc (as zinc oxide) 11 mg 100% Vitamin D3 (as cholecalciferol) 25 mcg 125%",
        ]));
        assert_eq!(
            got(&p, 1095).label_form,
            "",
            "the pack named no form this app's arithmetic distinguishes for zinc"
        );
        assert_eq!(got(&p, 1114).label_form, "vitamin_d");

        let p = parse(&stack(&[
            "Vitamin D3 (as cholecalciferol) 25 mcg 125% Vitamin E (as d-alpha tocopheryl acetate) 30 IU 100%",
        ]));
        assert_eq!(got(&p, 1114).label_form, "vitamin_d");
        assert_eq!(
            got(&p, 1109),
            SupReading {
                nutrient_id: 1109,
                label_amount: 30.0,
                label_unit: "IU".into(),
                // Without this the IU figure cannot be converted at all.
                label_form: "alpha_tocopherol_natural".into(),
            }
        );
    }

    #[test]
    fn hyphenated_pack_typography_reads_as_the_same_nutrient() {
        // "Vitamin B-12" is ordinary printing; names match on exact tokens, so
        // without its own spelling the whole row is dropped.
        let p = parse(&stack(&["Vitamin B-12 (as methylcobalamin) 2.4 mcg 100%"]));
        assert_eq!(got(&p, 1178).label_amount, 2.4);

        let p = parse(&stack(&["Vitamin B-6 2 mg 100%"]));
        assert_eq!(got(&p, 1175).label_amount, 2.0);

        let p = parse(&stack(&["Vitamin D-3 25 mcg 125%"]));
        assert_eq!(got(&p, 1114).label_amount, 25.0);
    }

    #[test]
    fn a_two_column_row_does_not_lend_one_nutrient_the_others_figure() {
        let p = parse(&stack(&["Zinc 11 mg 100% \u{2022} Copper"]));
        assert_eq!(got(&p, 1095).label_amount, 11.0);
        assert!(
            !p.readings.iter().any(|r| r.nutrient_id == 1098),
            "copper printed no figure and must not borrow zinc's"
        );
    }

    #[test]
    fn calcium_pantothenate_is_pantothenic_acid_and_not_calcium() {
        let p = parse(&stack(&["Calcium Pantothenate 5 mg 100%"]));
        assert_eq!(got(&p, 1170).label_amount, 5.0);
        assert!(
            !p.readings.iter().any(|r| r.nutrient_id == 1087),
            "the longer name wins the tokens it covers"
        );
    }

    #[test]
    fn other_ingredients_naming_a_mineral_is_not_a_declaration_of_it() {
        let p = parse(&stack(&[
            "Other Ingredients: Magnesium Stearate 2 mg, Silica",
        ]));
        assert!(
            p.readings.is_empty(),
            "an excipient list is not a panel: {:?}",
            p.readings
        );
    }

    #[test]
    fn a_photo_of_something_that_is_not_a_panel_says_so() {
        let p = parse(&stack(&[
            "Nature's Own Daily Wellness",
            "120 Tablets",
            "Made in the USA",
        ]));
        assert!(p.readings.is_empty());
        let t = p.trouble.expect("nothing read is trouble");
        assert!(
            t.contains("Supplement Facts"),
            "the sentence should say where to look: {t}"
        );
    }

    #[test]
    fn an_empty_photo_and_an_unreadable_panel_get_different_sentences() {
        let empty = parse(&[]).trouble.expect("no text is trouble");
        assert!(empty.contains("No text was found"), "{empty}");

        // A panel whose names are legible but whose figures were lost to glare.
        let glared = parse(&stack(&[
            "Supplement Facts",
            "Vitamin C",
            "Vitamin D",
            "Zinc",
        ]));
        let t = glared.trouble.expect("names without figures is trouble");
        assert!(t.contains("legible"), "{t}");
        assert_ne!(t, empty, "three failures, three things to try");
    }

    #[test]
    fn a_decimal_comma_is_not_a_thousands_separator() {
        // What a European pack prints, and what OCR returns when it reads a
        // full stop as a comma. Deleting it would log 15 mg instead of 1.5.
        let p = parse(&stack(&["Vitamin B6 1,5 mg 88%"]));
        assert_eq!(got(&p, 1175).label_amount, 1.5);
    }

    #[test]
    fn an_amount_printed_against_its_unit_still_reads() {
        let p = parse(&stack(&["Biotin 300mcg 1000%"]));
        assert_eq!(got(&p, 1176).label_amount, 300.0);
        assert_eq!(got(&p, 1176).label_unit, "mcg");
    }

    #[test]
    fn readings_come_back_in_the_order_the_panel_prints_them() {
        let p = parse(&multivitamin());
        let ids: Vec<i64> = p.readings.iter().map(|r| r.nutrient_id).collect();
        assert_eq!(
            ids,
            vec![1106, 1162, 1114, 1109, 1165, 1167, 1190, 1178, 1090, 1095, 1103]
        );
    }

    #[test]
    fn the_panels_own_furniture_is_counted_as_unmatched_rather_than_hidden() {
        let p = parse(&multivitamin());
        // "Supplement Facts", "Servings Per Container 60" and the
        // "Amount Per Serving / % Daily Value" header row.
        assert_eq!(p.unmatched_rows, 3);
    }
}
