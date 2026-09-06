//! Reading an ingredient list off a pack.
//!
//! Pure, like [`crate::panel`], and built on the same reassembled rows — an
//! ingredient list is a paragraph, and an OCR engine returns a paragraph as one
//! block per printed line with no idea which lines belong together.
//!
//! The list is the one thing on a pack that is worth **nothing** if it is
//! tidied. A comma moved, a capital lowered or a parenthesis dropped changes
//! what the pack asserts, and this text is shown back to the user as what the
//! pack says. So the only edits made here are the ones that undo the printing:
//! rejoining wrapped lines and collapsing the whitespace OCR invented. Spelling,
//! case and punctuation are left exactly as read.
//!
//! Nothing here is an accepted value. The text is a suggestion the user reads
//! against the pack in their hand before it is stored.

use crate::panel::{self, TextBlock};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ingredients {
    /// The list as printed, wrapped lines rejoined. Empty when none was found.
    pub text: String,
    /// A "CONTAINS: WHEAT, MILK" allergen statement, kept separate because it
    /// is a different assertion from the list itself: the list says what was
    /// put in, the statement says what a regulator makes the maker warn about.
    /// Merging them would turn a warning into an ingredient.
    pub contains: Option<String>,
    pub trouble: Option<String>,
}

/// Read an ingredient list out of positioned OCR text.
///
/// Handles both headers a pack prints: `INGREDIENTS` on a food, and
/// `OTHER INGREDIENTS` on a supplement bottle, where the actives are in the
/// Supplement Facts panel and only the excipients are listed underneath.
/// Whichever appears first starts the list; the other ends it.
pub fn parse(blocks: &[TextBlock]) -> Ingredients {
    let rows = panel::rows_from(blocks);

    // The allergen statement is looked for across the whole photo rather than
    // only after the header. A frame cropped to the bottom of a pack can catch
    // the statement without the list, and half an answer beats none.
    //
    // Every candidate is collected rather than the first taken. A pack prints
    // its marketing above the regulator's declaration — "Contains No Artificial
    // Flavors" sits a row above "CONTAINS: TREE NUTS (ALMONDS)" — and stopping
    // at the first row that opens with the word would show a claim about
    // flavourings as the pack's allergen warning and drop the warning itself.
    let statements: Vec<String> = rows.iter().filter_map(|r| allergen_statement(r)).collect();
    let contains = statements
        .iter()
        .find(|s| names_an_allergen(s))
        .or_else(|| statements.first())
        .cloned();

    let Some(start) = rows.iter().position(|r| strip_header(r).is_some()) else {
        return Ingredients {
            text: String::new(),
            contains,
            trouble: Some(
                "No ingredient list was found in this photo. Look for the paragraph headed \
                 \"INGREDIENTS\" — on a supplement bottle it is headed \"OTHER INGREDIENTS\" \
                 — and retake the photo with the whole paragraph in the frame."
                    .into(),
            ),
        };
    };

    // The list very often begins ON the header row: the fig-bar photo this app
    // was tested against produced "INGREDIENTS: Whole Wheat Flour, Fig Paste,
    // Cane" as a single row. Dropping the header row and starting at the next
    // one would lose the first three ingredients without a trace.
    let mut parts: Vec<String> = Vec::new();
    let head = strip_header(&rows[start]).unwrap_or("");
    if !head.trim().is_empty() {
        parts.push(squash(head));
    }

    for row in &rows[start + 1..] {
        if ends_the_list(row) {
            break;
        }
        let s = squash(row);
        if s.is_empty() {
            continue;
        }
        parts.push(s);
    }

    let text = rejoin(&parts);

    let trouble = if text.is_empty() {
        Some(
            "An ingredients heading was found but no list followed it in this photo. Retake it \
             with the lines below the heading in the frame."
                .into(),
        )
    } else {
        None
    };

    Ingredients {
        text,
        contains,
        trouble,
    }
}

// ---------------------------------------------------------------------------
// Joining wrapped lines
// ---------------------------------------------------------------------------

/// Rejoin printed lines into the paragraph they were before the pack wrapped
/// them.
///
/// A hyphen ATTACHED TO A WORD is a wrap point, so the next line is joined with
/// no space either way — but the hyphen itself is only removed when the next
/// line begins with a lowercase letter. "Su-" + "gar" is one soft-wrapped word
/// and becomes "Sugar"; "Non-" + "GMO" is a real hyphenated compound the wrap
/// happened to land inside, and "NonGMO" would be a word no pack printed.
///
/// A dash standing on its own at the end of a line is punctuation, not a wrap:
/// imported packs separate ingredients with it. "Salt -" + "Natural Flavor"
/// joined without the space would print "Salt -Natural", a word the pack never
/// printed, in the one field that is meant to be exactly what it did.
fn rejoin(parts: &[String]) -> String {
    let mut out = String::new();
    for part in parts {
        if out.is_empty() {
            out.push_str(part);
            continue;
        }
        // The character BEFORE the dash is what decides: attached to a word it
        // is a wrap, standing alone it is punctuation.
        let wrapped = out.ends_with('-')
            && out.chars().rev().nth(1).is_some_and(char::is_alphanumeric);
        if wrapped {
            let soft = part
                .chars()
                .next()
                .is_some_and(|c| c.is_lowercase() && c.is_alphabetic());
            if soft {
                out.pop();
            }
            out.push_str(part);
        } else {
            out.push(' ');
            out.push_str(part);
        }
    }
    out.trim().to_string()
}

/// Runs of whitespace collapsed to one space, and nothing else touched.
fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// Headers and section boundaries
// ---------------------------------------------------------------------------

/// A word with its edge punctuation removed, uppercased, for matching a header
/// against what a pack actually prints: "INGREDIENTS:", "Ingredients-",
/// "INGREDIENTS—".
fn key(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_alphanumeric())
        .to_uppercase()
}

/// Words of `s` as `(byte offset of the word, the word)`, so a prefix can be
/// removed from the ORIGINAL text and what follows keeps its own capitalisation.
fn words(s: &str) -> Vec<(usize, &str)> {
    s.split_whitespace()
        .map(|w| {
            // `split_whitespace` yields subslices of `s`, so pointer arithmetic
            // against the base gives the offset without a second scan.
            let off = w.as_ptr() as usize - s.as_ptr() as usize;
            (off, w)
        })
        .collect()
}

/// `Some(remainder)` when this row opens an ingredient list, carrying whatever
/// the row printed after the header. The remainder is empty when the header sat
/// on a line of its own.
fn strip_header(row: &str) -> Option<&str> {
    let w = words(row);
    let first = key(w.first()?.1);
    let mut consumed = if first == "INGREDIENT" || first == "INGREDIENTS" {
        1
    } else if first == "OTHER" {
        let second = key(w.get(1)?.1);
        if second == "INGREDIENT" || second == "INGREDIENTS" {
            2
        } else {
            return None;
        }
    } else {
        return None;
    };

    // "INGREDIENT STATEMENT:" and "INGREDIENTS LIST:" are the header a US
    // private-label or foodservice pack prints. Consuming only the first word
    // would leave "STATEMENT:" standing at the head of a field whose whole
    // contract is that it holds what the pack printed as ingredients.
    if let Some((_, next)) = w.get(consumed) {
        if matches!(key(next).as_str(), "STATEMENT" | "STATEMENTS" | "LIST") {
            consumed += 1;
        }
    }

    let (off, word) = w[consumed - 1];
    let rest = &row[off + word.len()..];
    Some(rest.trim_start_matches(|c: char| c.is_whitespace() || SEPARATORS.contains(&c)))
}

/// Punctuation a pack puts between the header and the first ingredient.
const SEPARATORS: &[char] = &[':', '-', '\u{2013}', '\u{2014}', '.', '\u{2022}'];

/// The headings that mean the ingredient list has ended. Matched on the row's
/// opening words, so a mention of one of these inside the list — a flavouring
/// "made in a dairy facility" mid-paragraph — does not truncate it.
const CLOSERS: &[&str] = &[
    "CONTAINS",
    "DISTRIBUTED",
    "MANUFACTURED",
    "MADE IN",
    "NUTRITION FACTS",
    "SUPPLEMENT FACTS",
    "OTHER INGREDIENT",
    "OTHER INGREDIENTS",
    "WARNING",
    "WARNINGS",
    "STORE",
    "BEST BY",
    "BEST BEFORE",
    "KEEP OUT OF REACH",
    // "MAY CONTAIN TRACES OF MILK" is a third assertion, neither the list nor a
    // CONTAINS declaration: it says the product MIGHT hold the allergen. Left
    // to run on into the paragraph it would read to an allergy user as milk
    // being an ingredient, which is the one misreading this module is built to
    // prevent. It ends the list and is carried no further.
    "MAY CONTAIN",
    "ALLERGEN",
    // The tail of a back panel: none of it is prose about the recipe.
    "PRODUCT OF",
    "PRODUCED",
    "PACKED",
    "PACKAGED",
    "NET WT",
    "NET WEIGHT",
    "QUESTIONS",
    "COMMENTS",
    // Panel furniture, for a frame that caught the panel but not its title.
    "SERVING SIZE",
    "SERVINGS PER",
    "AMOUNT PER",
    "CALORIES",
];

fn ends_the_list(row: &str) -> bool {
    // A row that is mostly figures is the panel, a lot code or a price — never
    // prose. Checked before the headings so a stray "2% 13% 0%" row from a
    // panel that crept into the frame cannot be swallowed into the list.
    if mostly_numeric(row) {
        return true;
    }
    // A panel row carries words, so it never reaches `mostly_numeric`: "Total
    // Fat 15g 19%" has more letters than figures. Its shape is what gives it
    // away — a %DV column standing on its own at the end of the row. The
    // percent has to be a bare token: "Sea Salt (2%)" is an ingredient.
    if ends_in_a_daily_value(row) {
        return true;
    }
    // A web address or an e-mail is the bottom of the pack, not a recipe.
    if is_contact_line(row) {
        return true;
    }

    let upper = squash(row).to_uppercase();
    // Strip the edge punctuation the headings are printed with, so
    // "WARNING:" and "**WARNING**" both match "WARNING".
    let cleaned: String = upper
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    let cleaned = squash(&cleaned);

    CLOSERS.iter().any(|h| {
        cleaned == *h
            || cleaned
                .strip_prefix(h)
                .is_some_and(|rest| rest.starts_with(' '))
    }) && !continues_the_list(&cleaned)
}

/// "CONTAINS 2% OR LESS OF" and "CONTAINS LESS THAN 2% OF" are not allergen
/// statements — they are the phrase a US pack uses to open the tail of its own
/// ingredient list, where the minor ingredients need not be in weight order.
/// Treating those as the end of the list would drop every ingredient after
/// them, which on a processed food is most of them.
///
/// "CONTAINS ONE OR MORE OF THE FOLLOWING" is the same phrase for an oil blend,
/// where the maker is naming which oils it may have used. Both express the
/// maker's own uncertainty about its own recipe; neither warns about anything.
/// Plain "CONTAINS THE FOLLOWING" is deliberately absent — "Contains the
/// following allergens: wheat, milk" is a real declaration.
fn continues_the_list(cleaned: &str) -> bool {
    let Some(rest) = cleaned.strip_prefix("CONTAINS ") else {
        return false;
    };
    rest.starts_with("LESS THAN")
        || rest.starts_with("ONE OR MORE")
        || rest.starts_with("EACH OF THE FOLLOWING")
        || rest
            .chars()
            .next()
            .is_some_and(|c: char| c.is_ascii_digit())
}

/// `Some(statement)` when this row is a "CONTAINS: WHEAT, MILK" allergen
/// statement, without the keyword.
fn allergen_statement(row: &str) -> Option<String> {
    let w = words(row);
    let (off, word) = *w.first()?;
    if key(word) != "CONTAINS" {
        return None;
    }
    let rest = &row[off + word.len()..];
    let rest = squash(rest.trim_start_matches(|c: char| c.is_whitespace() || SEPARATORS.contains(&c)));
    if rest.is_empty() {
        return None;
    }
    // The same guard as above: this is the ingredient list's own tail, not a
    // statement about allergens.
    let cleaned: String = squash(row)
        .to_uppercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    if continues_the_list(&squash(&cleaned)) {
        return None;
    }
    // "Contains No Artificial Flavors or Preservatives" opens with the same
    // word and asserts the opposite of a warning. Accepting it would put a
    // marketing claim in the field the user reads as the pack's allergen
    // declaration.
    if is_a_negation(&rest) {
        return None;
    }
    Some(rest)
}

/// Whether a CONTAINS row's remainder negates rather than declares.
fn is_a_negation(rest: &str) -> bool {
    let first = rest.split_whitespace().next().unwrap_or("");
    matches!(key(first).as_str(), "NO" | "NONE" | "ZERO" | "NOT")
}

/// The allergens a declaration names. Used ONLY to choose between two rows
/// that both open with "CONTAINS", never to edit or filter what one says: the
/// statement is shown back to the user verbatim, and a pack may well name an
/// allergen this list has not met.
const ALLERGEN_WORDS: &[&str] = &[
    "MILK", "DAIRY", "EGG", "EGGS", "FISH", "SHELLFISH", "CRUSTACEAN", "CRUSTACEANS", "TREE",
    "NUT", "NUTS", "PEANUT", "PEANUTS", "WHEAT", "SOY", "SOYA", "SOYBEAN", "SOYBEANS", "SESAME",
    "GLUTEN", "ALMOND", "ALMONDS", "CASHEW", "CASHEWS", "WALNUT", "WALNUTS", "PECAN", "PECANS",
    "HAZELNUT", "HAZELNUTS", "PISTACHIO", "PISTACHIOS", "COCONUT", "MUSTARD", "CELERY", "LUPIN",
    "MOLLUSC", "MOLLUSCS", "MOLLUSK", "MOLLUSKS", "SULPHITE", "SULPHITES", "SULFITE", "SULFITES",
];

/// Whether a statement names something a regulator makes a maker warn about.
fn names_an_allergen(statement: &str) -> bool {
    statement
        .to_uppercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| ALLERGEN_WORDS.contains(&w))
}

/// Whether the row's last token is a bare "19%" — the %DV column a nutrition
/// panel prints at the end of every line. Bracketed percentages are left
/// alone: "Sea Salt (2%)" is an ingredient with its proportion beside it.
fn ends_in_a_daily_value(row: &str) -> bool {
    let Some(last) = row.split_whitespace().last() else {
        return false;
    };
    let Some(head) = last.strip_suffix('%') else {
        return false;
    };
    head.chars().any(|c| c.is_ascii_digit())
        && head
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
}

/// Whether a row is the maker's web address or e-mail. Both sit under the
/// ingredient list on a back panel and neither is an ingredient.
fn is_contact_line(row: &str) -> bool {
    let l = row.to_lowercase();
    l.contains("www.")
        || l.contains("http://")
        || l.contains("https://")
        || l.contains(".com")
        || l.contains(".net")
        || l.contains(".org")
        || l.contains('@')
}

/// Whether a row carries more figures than letters. A percentage or a digit is
/// counted against the row; letters count for it.
fn mostly_numeric(row: &str) -> bool {
    let mut letters = 0usize;
    let mut figures = 0usize;
    for c in row.chars() {
        if c.is_alphabetic() {
            letters += 1;
        } else if c.is_ascii_digit() || c == '%' {
            figures += 1;
        }
    }
    figures > 0 && figures >= letters
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(text: &str, y: f64) -> TextBlock {
        TextBlock {
            text: text.to_string(),
            x: 0.05,
            y,
            w: 0.9,
            h: 0.03,
        }
    }

    /// Stack rows down the frame, one block per row, 0.04 apart — far enough
    /// that `rows_from` never merges two of them.
    fn stack(lines: &[&str]) -> Vec<TextBlock> {
        lines
            .iter()
            .enumerate()
            .map(|(i, t)| b(t, 0.10 + i as f64 * 0.04))
            .collect()
    }

    #[test]
    fn the_list_beginning_on_the_header_row_is_not_lost() {
        // The row shape the real fig-bar photo produced.
        let g = parse(&stack(&[
            "INGREDIENTS: Whole Wheat Flour, Fig Paste, Cane",
            "Sugar, Invert Cane Sugar, Canola Oil.",
        ]));
        assert_eq!(
            g.text,
            "Whole Wheat Flour, Fig Paste, Cane Sugar, Invert Cane Sugar, Canola Oil."
        );
        assert_eq!(g.trouble, None);
        assert_eq!(g.contains, None);
    }

    #[test]
    fn a_list_split_across_four_rows_rejoins_in_order() {
        let g = parse(&stack(&[
            "INGREDIENTS",
            "Organic Rolled Oats, Organic Cane Sugar,",
            "Organic Sunflower Oil, Sea Salt, Natural",
            "Flavor, Mixed Tocopherols (to preserve",
            "freshness).",
        ]));
        assert_eq!(
            g.text,
            "Organic Rolled Oats, Organic Cane Sugar, Organic Sunflower Oil, Sea Salt, \
             Natural Flavor, Mixed Tocopherols (to preserve freshness)."
        );
    }

    #[test]
    fn contains_ends_the_list_and_is_kept_apart_from_it() {
        let g = parse(&stack(&[
            "INGREDIENTS: Enriched Wheat Flour, Water, Yeast,",
            "Salt.",
            "CONTAINS WHEAT.",
            "Distributed by Some Bakery Co., Phoenix AZ",
        ]));
        assert_eq!(g.text, "Enriched Wheat Flour, Water, Yeast, Salt.");
        assert_eq!(g.contains.as_deref(), Some("WHEAT."));
        assert!(
            !g.text.contains("Distributed"),
            "an address is not an ingredient"
        );
    }

    #[test]
    fn contains_two_percent_or_less_is_the_list_continuing_not_an_allergen_line() {
        // The failure this guard exists for: stopping here drops most of the
        // ingredients on a processed food.
        let g = parse(&stack(&[
            "INGREDIENTS: Chicken Broth, Carrots, Peas,",
            "Contains 2% or less of: Salt, Onion Powder,",
            "Celery Extract.",
        ]));
        assert!(
            g.text.contains("Celery Extract."),
            "the tail of the list must survive: {}",
            g.text
        );
        assert_eq!(
            g.contains, None,
            "\"Contains 2% or less of\" is not an allergen statement"
        );
    }

    #[test]
    fn a_photo_with_no_ingredients_row_says_so_and_stores_nothing() {
        let g = parse(&stack(&[
            "Nature's Best Granola",
            "Net Wt 12 oz (340g)",
            "Nutrition Facts",
        ]));
        assert_eq!(g.text, "");
        let t = g.trouble.expect("no list found is trouble");
        assert!(
            t.contains("INGREDIENTS"),
            "the sentence should name what to look for: {t}"
        );
    }

    #[test]
    fn a_soft_wrapped_hyphen_closes_but_a_real_one_survives() {
        let g = parse(&stack(&[
            "INGREDIENTS: Cane Su-",
            "gar, Non-",
            "GMO Soy Lecithin.",
        ]));
        assert_eq!(g.text, "Cane Sugar, Non-GMO Soy Lecithin.");
    }

    #[test]
    fn other_ingredients_is_read_as_its_own_list() {
        let g = parse(&stack(&[
            "OTHER INGREDIENTS: Microcrystalline Cellulose,",
            "Vegetable Stearate, Silica.",
        ]));
        assert_eq!(
            g.text,
            "Microcrystalline Cellulose, Vegetable Stearate, Silica."
        );
    }

    #[test]
    fn an_ingredients_list_stops_where_other_ingredients_begins() {
        let g = parse(&stack(&[
            "INGREDIENTS: Fish Oil Concentrate, Gelatin.",
            "OTHER INGREDIENTS: Glycerin, Purified Water.",
        ]));
        assert_eq!(g.text, "Fish Oil Concentrate, Gelatin.");
    }

    #[test]
    fn capitalisation_and_punctuation_are_returned_verbatim() {
        let g = parse(&stack(&[
            "Ingredients - ORGANIC QUINOA, water,  Sea   Salt (2%)",
        ]));
        assert_eq!(
            g.text, "ORGANIC QUINOA, water, Sea Salt (2%)",
            "only invented whitespace is collapsed; nothing is re-cased"
        );
    }

    #[test]
    fn a_row_of_percentages_never_joins_the_list() {
        let g = parse(&stack(&[
            "INGREDIENTS: Almonds, Sea Salt.",
            "13% 28% 0% 4%",
        ]));
        assert_eq!(g.text, "Almonds, Sea Salt.");
    }

    #[test]
    fn a_marketing_negation_never_displaces_the_packs_allergen_statement() {
        // The marketing line is printed ABOVE the regulator's declaration, so
        // taking the first row that opens with the word takes the wrong one.
        let g = parse(&stack(&[
            "INGREDIENTS: Almonds, Sea Salt.",
            "Contains No Artificial Flavors or Preservatives",
            "CONTAINS: TREE NUTS (ALMONDS).",
        ]));
        assert_eq!(g.text, "Almonds, Sea Salt.");
        assert_eq!(
            g.contains.as_deref(),
            Some("TREE NUTS (ALMONDS)."),
            "the pack's own warning is the statement, not the claim above it"
        );
    }

    #[test]
    fn a_front_of_pack_negation_alone_declares_no_allergen() {
        let g = parse(&stack(&["Contains no added sugar"]));
        assert_eq!(
            g.contains, None,
            "\"contains no added sugar\" warns about nothing"
        );
        assert!(g.trouble.is_some());
    }

    #[test]
    fn contains_one_or_more_of_the_following_is_the_list_continuing() {
        // An oil blend: the maker is naming which oils it may have used, not
        // warning about an allergen. Stopping here drops four ingredients.
        let g = parse(&stack(&[
            "INGREDIENTS: Enriched Flour, Vegetable Oil",
            "Contains One or More of the Following: Canola",
            "Oil, Soybean Oil, Salt, Sugar.",
        ]));
        assert!(
            g.text.ends_with("Salt, Sugar."),
            "the tail of the list must survive: {}",
            g.text
        );
        assert_eq!(
            g.contains, None,
            "a sentence fragment is not an allergen statement"
        );
    }

    #[test]
    fn a_may_contain_advisory_is_never_appended_to_the_list() {
        // "MAY CONTAIN" says the product MIGHT hold the allergen. Run into the
        // paragraph it reads as milk and tree nuts being ingredients.
        let g = parse(&stack(&[
            "INGREDIENTS: Whole Wheat Flour, Fig Paste, Cane",
            "Sugar, Invert Cane Sugar, Canola Oil.",
            "MAY CONTAIN TRACES OF MILK AND TREE NUTS.",
            "Net Wt. 2 oz (57g)",
            "PRODUCT OF USA",
            "Questions or comments? Call 1-800-555-0199",
            "www.naturesbakery.com",
        ]));
        assert_eq!(
            g.text,
            "Whole Wheat Flour, Fig Paste, Cane Sugar, Invert Cane Sugar, Canola Oil."
        );
        assert_eq!(g.contains, None, "a may-contain advisory is not a declaration");
    }

    #[test]
    fn panel_rows_that_crept_into_the_frame_never_join_the_list() {
        // No "Nutrition Facts" title row — a cropped or stylised panel.
        let g = parse(&stack(&[
            "INGREDIENTS: Almonds, Sea Salt.",
            "Serving Size 1 oz (28g)",
            "Calories 170",
            "Total Fat 15g 19%",
            "Saturated Fat 1g 5%",
        ]));
        assert_eq!(g.text, "Almonds, Sea Salt.");
    }

    #[test]
    fn a_row_ending_in_a_daily_value_ends_the_list_but_a_bracketed_percent_does_not() {
        let g = parse(&stack(&[
            "INGREDIENTS: Sea Salt (2%), Cane Sugar,",
            "Sunflower Oil.",
            "Total Fat 15g 19%",
        ]));
        assert_eq!(
            g.text, "Sea Salt (2%), Cane Sugar, Sunflower Oil.",
            "an ingredient's own proportion is not a %DV column"
        );
    }

    #[test]
    fn a_free_standing_dash_keeps_the_space_the_pack_printed() {
        let g = parse(&stack(&[
            "INGREDIENTS: Water, Sugar,",
            "Salt -",
            "Natural Flavor.",
        ]));
        assert_eq!(
            g.text, "Water, Sugar, Salt - Natural Flavor.",
            "a dash on its own is punctuation, not a soft wrap"
        );
    }

    #[test]
    fn a_two_word_header_leaves_no_word_behind_in_the_list() {
        let g = parse(&stack(&["INGREDIENT STATEMENT: Water, Sugar, Salt."]));
        assert_eq!(g.text, "Water, Sugar, Salt.");

        let g = parse(&stack(&["INGREDIENTS LIST: Water, Sugar, Salt."]));
        assert_eq!(g.text, "Water, Sugar, Salt.");
    }

    #[test]
    fn a_heading_with_nothing_under_it_is_trouble_rather_than_an_empty_list() {
        let g = parse(&stack(&["INGREDIENTS:", "WARNING: Choking hazard."]));
        assert_eq!(g.text, "");
        let t = g.trouble.expect("a heading with no list is trouble");
        assert!(
            t.contains("heading"),
            "this sentence is about the frame, not about looking elsewhere: {t}"
        );
    }
}
