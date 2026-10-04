//! The forms of one family: what each is called, and the order they are
//! offered in.

use std::collections::{HashMap, HashSet};

use super::{Family, Form};
use crate::tidy::{self, SURVEY};

/// Cooking methods that make a generic "cooked" beside them say nothing more.
#[rustfmt::skip]
const METHOD_WORDS: &[&str] = &[
    "boiled", "steamed", "baked", "roasted", "stir-fried", "microwaved", "braised", "simmered",
    "fried", "stewed", "mashed", "dry roasted", "dry-roasted", "oil roasted", "oil-roasted",
];

/// The words of a description its family name does not already say, rewritten
/// to read as a choice: "boiled" rather than "cooked, boiled, drained, without
/// salt". `twin_hidden` drops "without salt" from a row whose salted twin is not
/// being offered beside it.
fn label(desc: &str, twin_hidden: bool) -> Vec<String> {
    let (cased, mask) = tidy::identity_mask(desc);
    let lab: Vec<String> = cased
        .into_iter()
        .zip(mask)
        .filter(|(_, m)| !*m)
        .map(|(c, _)| c)
        .collect();
    let low: Vec<String> = lab.iter().map(|x| x.to_lowercase()).collect();
    // USDA writes the generic word first, "cooked, boiled", and a "cooked"
    // that follows the method is a second state, not a repeat of it: roasted
    // buckwheat groats are sold roasted, and "roasted, cooked" is the cooked
    // groats (92 kcal), where "roasted, dry" is what goes on a scale (346).
    let method_after = |k: usize| {
        low[k + 1..]
            .iter()
            .any(|x| METHOD_WORDS.contains(&x.as_str()))
    };
    let mut out = Vec::new();
    for (k, (c, l)) in lab.iter().zip(&low).enumerate() {
        if l == "mature seeds"
            || (l == "cooked" && method_after(k))
            || (l == "drained" && k > 0 && low[k - 1] == "boiled")
            || (l == "without salt" && twin_hidden)
        {
            continue;
        }
        out.push(match l.as_str() {
            "with salt" => "salted".to_string(),
            "drained solids" => "drained".to_string(),
            "solids and liquids" => "with liquid".to_string(),
            _ => c.clone(),
        });
    }
    // "raw" beside a method describes the ingredient, not the form.
    let cooked = [
        "boiled",
        "cooked",
        "microwave",
        "steamed",
        "baked",
        "roasted",
        "fried",
    ];
    let low: Vec<String> = out.iter().map(|x| x.to_lowercase()).collect();
    if low.iter().any(|x| x == "raw") && low.iter().any(|x| tidy::has_word(x, &cooked)) {
        out.retain(|x| x.to_lowercase() != "raw");
    }
    // The survey's "NFS" and "NS as to …" are coding terms ("not further
    // specified"), said here in plain words.
    out.into_iter()
        .map(|x| match x.to_lowercase().as_str() {
            "solids and liquid" => "with liquid".to_string(),
            "without salt" => "no salt".to_string(),
            "nfs" => "unspecified".to_string(),
            "ns as to form" => "form unspecified".to_string(),
            "ns as to fat" => "fat unspecified".to_string(),
            "ns as to fat type" => "fat type unspecified".to_string(),
            _ => x,
        })
        .collect()
}

/// Words that say a form has not been cooked. A recipe or a pot weighs every
/// ingredient raw, and its picker takes a food's first form, so a form saying
/// one of these has to lead.
const UNCOOKED: &[&str] = &["raw", "dry", "uncooked", "unroasted"];

fn segments(label: &str) -> impl Iterator<Item = String> + '_ {
    label.split(',').map(|s| s.trim().to_lowercase())
}

fn says_uncooked(label: &str) -> bool {
    segments(label).any(|s| UNCOOKED.contains(&s.as_str()))
}

/// Salt stated as added: a product sold salted ("dry roasted, with salt
/// added") follows the same product without, as a kitchen-salted twin does.
fn adds_salt(label: &str) -> bool {
    segments(label).any(|s| {
        s == "salted"
            || s == "lightly salted"
            || s == "with added salt"
            || s.starts_with("with salt")
    })
}

/// Where a form sits among its siblings: uncooked first, then cooked, then fat
/// stated, canned, frozen, anything else.
///
/// A form with nothing to say beside its siblings is the food as bought when
/// it is an SR or Foundation row ("Nuts, pecans"), but not when it is a survey
/// row: the survey records food as eaten, so its bare "Millet" is cooked millet
/// (118 kcal against 378 raw) and its "Chicken, ground" is cooked. Nothing in
/// such a label says which, so it is ranked with anything else, after every
/// form that says what it is.
fn rank(label: &str, survey: bool) -> i32 {
    let l = label.to_lowercase();
    let fat = [
        "fat added",
        "with oil",
        "with butter or margarine",
        "made with",
        "fat unspecified",
        "fat type unspecified",
    ];
    #[rustfmt::skip]
    let cooked = [
        "boiled", "cooked", "steamed", "baked", "roasted", "stir-fried", "microwaved", "sauteed",
    ];
    if l.contains("canned") {
        4
    } else if l.contains("frozen") {
        5
    } else if fat.iter().any(|f| l.contains(f)) {
        3
    } else if (l.is_empty() && !survey) || says_uncooked(&l) {
        0
    } else if tidy::has_word(&l, &cooked)
        || l.contains("no added fat")
        || l.contains("as ingredient")
    {
        1
    } else {
        6
    }
}

/// What the whole reference database says that form order needs.
pub(super) struct Facts<'a> {
    pub foods: &'a HashMap<i64, (String, String)>,
    pub salt_twin: &'a HashMap<i64, i64>,
    pub salt_base: &'a HashSet<i64>,
    pub canon: &'a HashMap<i64, i64>,
    /// Rows with an energy figure. A Foundation row often has none ("Mushroom,
    /// oyster"), and a recipe line made of one would add no energy at all.
    pub energy: &'a HashSet<i64>,
    /// Rows an Indian name points to: the form that name means.
    pub alias_ids: &'a HashSet<i64>,
}

/// One family's forms in form order, with their labels and chips.
pub(super) fn build_family(canons: &[i64], facts: &Facts) -> Family {
    let Facts {
        foods,
        salt_twin,
        salt_base,
        canon,
        energy,
        alias_ids,
    } = *facts;
    let desc = |c: &i64| foods[c].0.as_str();
    let joined = |l: &[String]| l.join(", ");
    let distinct = |ls: &[Vec<String>]| {
        ls.iter()
            .map(|l| joined(l).to_lowercase())
            .collect::<HashSet<_>>()
            .len()
    };
    let mut labels: [Vec<String>; 2] = [Vec::new(), Vec::new()];
    for (v, out) in labels.iter_mut().enumerate() {
        let salt_q = v == 1;
        let mut lab: Vec<Vec<String>> = canons
            .iter()
            .map(|c| label(desc(c), salt_base.contains(c) && !salt_q))
            .collect();
        // Dropped only where that makes no two labels the same.
        for word in ["regular pack", "unprepared"] {
            let trial: Vec<Vec<String>> = lab
                .iter()
                .map(|l| {
                    let low: Vec<String> = l.iter().map(|x| x.to_lowercase()).collect();
                    if word == "unprepared" && !low.iter().any(|x| x == "frozen" || x == "raw") {
                        l.clone()
                    } else {
                        l.iter()
                            .filter(|x| x.to_lowercase() != word)
                            .cloned()
                            .collect()
                    }
                })
                .collect();
            if distinct(&trial) == distinct(&lab) {
                lab = trial;
            }
        }
        *out = lab.iter().map(|l| joined(l)).collect();
    }
    let at: HashMap<i64, usize> = canons.iter().enumerate().map(|(i, c)| (*c, i)).collect();
    // Form order. Within a rank: a form with an energy figure, then one that
    // says it is uncooked ("raw" before a bare name, "frozen, uncooked" before
    // "frozen, cooked"), then the form an Indian name points to ("Semolina,
    // unenriched" for rava, rather than the enriched row), then unsalted before
    // salted, the SR or Foundation row before the survey's, and the shorter
    // description, as search ranks them. The first form is what a recipe
    // takes, so this order is a default for what goes in, not only a list.
    let mut order: Vec<i64> = canons.to_vec();
    order.sort_by_key(|c| {
        let l = &labels[0][at[c]];
        let survey = foods[c].1 == SURVEY;
        (
            rank(l, survey),
            !energy.contains(c),
            !says_uncooked(l),
            !alias_ids.contains(c),
            adds_salt(l),
            survey,
            desc(c).chars().count(),
            *c,
        )
    });
    for c in order.clone() {
        if let Some(t) = salt_twin
            .get(&c)
            .map(|t| canon[t])
            .filter(|t| order.contains(t))
        {
            order.retain(|x| *x != c);
            let i = order
                .iter()
                .position(|x| *x == t)
                .map_or(order.len(), |i| i + 1);
            order.insert(i, c);
        }
    }
    let chips = [
        chips(canons, &labels[0], foods),
        chips(canons, &labels[1], foods),
    ];
    Family {
        name: tidy::family_name(desc(&order[0])),
        forms: order
            .iter()
            .map(|c| Form {
                canon: *c,
                label: [labels[0][at[c]].clone(), labels[1][at[c]].clone()],
                chip: [chips[0][c].clone(), chips[1][c].clone()],
            })
            .collect(),
    }
}

/// What each form's chip reads. Two forms that would read alike: the survey one
/// says so, and if that is not enough both fall back to the full description.
/// A form with nothing to say beside its siblings is the plain one — unless it
/// is a survey row, which records food as eaten and is usually cooked: calling
/// cooked millet "plain" beside "raw" would hide that, so it says "as eaten".
fn chips(
    canons: &[i64],
    labels: &[String],
    foods: &HashMap<i64, (String, String)>,
) -> HashMap<i64, String> {
    let mut lab: HashMap<i64, String> = canons
        .iter()
        .zip(labels)
        .map(|(c, l)| (*c, l.to_lowercase()))
        .collect();
    let tally = |lab: &HashMap<i64, String>| {
        let mut n: HashMap<String, usize> = HashMap::new();
        for l in lab.values() {
            *n.entry(l.clone()).or_default() += 1;
        }
        n
    };
    let n = tally(&lab);
    let survey = |c: &i64| foods[c].1 == SURVEY;
    for c in canons {
        if n[&lab[c]] > 1 && survey(c) {
            let l = &lab[c];
            let l = if l.is_empty() {
                "as eaten".to_string()
            } else {
                format!("{l}, as eaten")
            };
            lab.insert(*c, l);
        }
    }
    let n = tally(&lab);
    for c in canons {
        if n[&lab[c]] > 1 {
            lab.insert(*c, tidy::norm(&foods[c].0));
        }
    }
    for (c, l) in lab.iter_mut().filter(|(_, l)| l.is_empty()) {
        *l = if survey(c) { "as eaten" } else { "plain" }.into();
    }
    lab
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_form_is_named_by_what_tells_it_apart() {
        let boiled = "Mungo beans, mature seeds, cooked, boiled, without salt";
        let salted = "Mungo beans, mature seeds, cooked, boiled, with salt";
        assert_eq!(label(boiled, true).join(", "), "boiled");
        assert_eq!(label(boiled, false).join(", "), "boiled, no salt");
        assert_eq!(label(salted, false).join(", "), "boiled, salted");
        assert_eq!(
            label("Spinach, canned, regular pack, drained solids", false).join(", "),
            "canned, regular pack, drained"
        );
        assert_eq!(
            (
                rank("raw", false),
                rank("boiled", false),
                rank("canned, drained", false)
            ),
            (0, 1, 4)
        );
        assert_eq!(
            (
                rank("fresh, cooked with oil", false),
                rank("frozen", false),
                rank("mature", false)
            ),
            (3, 5, 6)
        );
    }

    #[test]
    fn a_bare_survey_row_is_not_taken_for_the_uncooked_form() {
        // SR "Nuts, pecans" is the nuts as bought; survey "Millet" is cooked.
        assert_eq!(rank("", false), 0);
        assert_eq!(rank("", true), 6);
        assert_eq!(rank("unroasted", true), 0, "survey nuts sold raw");
        assert_eq!(rank("roasted, dry", false), 0);
        assert!(says_uncooked("frozen, uncooked") && !says_uncooked("frozen, cooked"));
        assert!(adds_salt("dry roasted, With Salt Added") && adds_salt("lightly salted"));
        assert!(!adds_salt("unsalted") && !adds_salt("dry roasted, without salt added"));
    }

    #[test]
    fn a_cooked_after_the_method_is_kept() {
        // 92 kcal cooked against 346 dry: "roasted" alone would read as the dry groats.
        assert_eq!(
            label("Buckwheat groats, roasted, cooked", false).join(", "),
            "roasted, cooked"
        );
        assert_eq!(
            label("Buckwheat groats, roasted, dry", false).join(", "),
            "roasted, dry"
        );
        assert_eq!(
            label("Spinach, cooked, boiled, drained, without salt", true).join(", "),
            "boiled"
        );
    }

    #[test]
    fn survey_coding_terms_are_said_in_plain_words() {
        assert_eq!(label("Fish, tuna, NFS", false).join(", "), "unspecified");
        assert_eq!(
            label("Spinach, NS as to form, cooked", false).join(", "),
            "form unspecified, cooked"
        );
        assert_eq!(
            rank("cooked, fat unspecified", true),
            3,
            "fat is still stated"
        );
    }
}
