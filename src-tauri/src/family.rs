//! One search row per food, with the food's forms chosen once on the amount
//! panel.
//!
//! USDA files a food that comes in several forms as near-identical rows, and
//! the same food again under several fdc_ids. The user chose to see ONE row per
//! food and pick the form at the scale ("Pick at the scale"). This module holds
//! the index that makes that cheap: every reference row sorted, once, into
//!
//! - a repeat group: the same food under several fdc_ids, represented by one
//!   canonical member (an alias target first, then the fullest row);
//! - a family: the repeat groups that are one food in different forms.
//!
//! Nothing is removed from the reference database. A row folded away here still
//! resolves through `db::detail`, and an entry logs the exact fdc_id and full
//! description of the form chosen, so history never depends on this grouping.

mod build;
mod forms;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::db::{FoodFamily, FoodForm, FoodHit};
use crate::tidy::{self, SURVEY};

/// One repeat group's place in its family. Labels are kept in two readings:
/// `[0]` when the query does not ask about salt, `[1]` when it does.
struct Form {
    canon: i64,
    /// As a name reads it, in USDA's casing: "boiled", "NS as to form, cooked".
    label: [String; 2],
    /// As a chip reads it: lower-case, never empty, never equal to a sibling's.
    chip: [String; 2],
}

struct Family {
    name: String,
    forms: Vec<Form>,
}

/// The static grouping of the whole reference database.
pub struct Index {
    foods: HashMap<i64, (String, String)>,
    /// A kitchen-salted row and the twin cooked without salt.
    salt_twin: HashMap<i64, i64>,
    canon: HashMap<i64, i64>,
    members: HashMap<i64, Vec<i64>>,
    family_of: HashMap<i64, usize>,
    families: Vec<Family>,
    aliases: HashMap<String, Vec<i64>>,
}

/// What this user has done that search has to honour (`store::fdc_choices`).
pub struct User<'a> {
    /// When each fdc_id was last logged: the form a food opens on.
    pub logged: &'a HashMap<i64, String>,
    /// When each fdc_id was last chosen anywhere, recipes and pots included.
    pub used: &'a HashMap<i64, String>,
    /// fdc_ids a live custom food replaces.
    pub overridden: &'a HashSet<i64>,
}

/// A search entry, and whether every form in it is a survey row — which is
/// what decides who gives way when two entries would share a name.
pub struct Entry {
    pub hit: FoodHit,
    survey: bool,
}

/// A place in the result list: a family, or a row the index cannot place.
enum Slot {
    Family(usize),
    Loose(Box<Entry>),
}

pub struct Grouped {
    pub entries: Vec<Entry>,
    /// Overridden fdc_ids the query reached, in order, for `lib.rs` to replace
    /// with the custom food that stands in for each.
    pub replaced: Vec<i64>,
}

static CACHE: Mutex<Vec<(String, Arc<Index>)>> = Mutex::new(Vec::new());

/// The index for this reference database, built on first use and kept for the
/// life of the process. Building reads every row once (a fraction of a second);
/// each search afterwards is map lookups. A database with no file behind it is
/// indexed afresh every time rather than cached under a name it does not have.
pub fn index(conn: &Connection) -> Result<Arc<Index>, String> {
    let Some(path) = conn.path().filter(|p| !p.is_empty()).map(str::to_string) else {
        return Index::build(conn).map(Arc::new);
    };
    cached(path, || Index::build(conn))
}

/// [`index`] for the database file at `path`, built on a connection of its own
/// if nobody has built it yet — for a caller that must not hold the shared
/// connection's lock while it waits for the launch-time build to finish.
pub fn index_at(path: &str) -> Result<Arc<Index>, String> {
    cached(path.to_string(), || {
        Index::build(&crate::db::open(&std::path::PathBuf::from(path))?)
    })
}

fn cached(
    path: String,
    build: impl FnOnce() -> Result<Index, String>,
) -> Result<Arc<Index>, String> {
    // Held while building, so a search arriving during the warm-up at launch
    // waits for that build instead of starting a second one.
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, ix)) = cache.iter().find(|(p, _)| *p == path) {
        return Ok(Arc::clone(ix));
    }
    let ix = Arc::new(build()?);
    cache.push((path, Arc::clone(&ix)));
    Ok(ix)
}

/// The index cache's lock, held by a test standing in for a slow build.
#[cfg(test)]
pub(crate) fn hold_index_cache() -> std::sync::MutexGuard<'static, Vec<(String, Arc<Index>)>> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the query asks about salt: a term starting "salt", or three or more
/// letters of "salted", read the way the search index reads terms. Only then is
/// a kitchen-salted twin worth offering beside the food cooked without it.
pub fn asks_for_salt(query: &str) -> bool {
    query.split_whitespace().any(|t| {
        let t: String = t
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '\'')
            .collect();
        let t = t.to_lowercase();
        t.starts_with("salt") || (t.chars().count() >= 3 && "salted".starts_with(t.as_str()))
    })
}

impl Index {
    fn desc(&self, f: i64) -> &str {
        &self.foods[&f].0
    }

    fn data_type(&self, f: i64) -> &str {
        &self.foods[&f].1
    }

    /// The member that stands for a repeat group, or `None` when the group is
    /// not offered: replaced by the user's own food, or a kitchen-salted twin
    /// nobody asked for. `force` is a member that must be offered as itself.
    fn rep(
        &self,
        canon: i64,
        salt_q: bool,
        user: &User,
        with_ov: bool,
        force: Option<i64>,
    ) -> Option<i64> {
        let ms = &self.members[&canon];
        if let Some(f) = force.filter(|f| ms.contains(f)) {
            return Some(f);
        }
        let ov = ms.iter().copied().find(|m| user.overridden.contains(m));
        match ov {
            Some(_) if !with_ov => return None,
            Some(_) => return ov,
            None => {}
        }
        let used = ms.iter().any(|m| user.used.contains_key(m));
        if self.salt_twin.contains_key(&canon) && !salt_q && !used {
            return None;
        }
        Some(self.latest(ms.iter().copied(), user).unwrap_or(canon))
    }

    /// Of these fdc_ids, the one this user chose most recently: logged first,
    /// as the choice made at the scale, then put into a recipe or a pot.
    fn latest(&self, ids: impl Iterator<Item = i64>, user: &User) -> Option<i64> {
        ids.filter(|m| user.used.contains_key(m))
            .max_by_key(|m| (user.logged.get(m), user.used.get(m)))
    }

    /// Of these fdc_ids, the one this user logged most recently.
    fn last_logged(&self, ids: impl Iterator<Item = i64>, user: &User) -> Option<i64> {
        ids.filter_map(|m| user.logged.get(&m).map(|at| (at, m)))
            .max()
            .map(|(_, m)| m)
    }

    fn short_name(&self, fm: &Form, v: usize) -> String {
        let name = tidy::family_name(self.desc(fm.canon));
        if fm.label[v].is_empty() {
            name
        } else {
            format!("{name}, {}", fm.label[v])
        }
    }

    fn hit(
        &self,
        f: i64,
        name: String,
        forms: Vec<FoodForm>,
        about: (Option<String>, bool),
    ) -> FoodHit {
        FoodHit {
            kind: "reference".into(),
            fdc_id: Some(f),
            custom_food_id: None,
            description: self.desc(f).to_string(),
            brand: None,
            data_type: self.data_type(f).to_string(),
            note: about.0,
            matched_alias: about.1,
            name: Some(name),
            forms,
        }
    }

    /// The forms of a family on offer to this user, each with the fdc_id that
    /// stands for it.
    fn offered(
        &self,
        fi: usize,
        salt_q: bool,
        user: &User,
        with_ov: bool,
        force: Option<i64>,
    ) -> Vec<(i64, &Form)> {
        let forms = self.families[fi].forms.iter();
        forms
            .filter_map(|fm| {
                self.rep(fm.canon, salt_q, user, with_ov, force)
                    .map(|r| (r, fm))
            })
            .collect()
    }

    /// Fold reference hits, in search order, into one entry per food.
    ///
    /// A family sits where its first hit sat and carries every form it is
    /// offered in — not just the forms this query happened to match, so a food
    /// is never split across the list. `flat` lists every form as an entry of
    /// its own instead, for the one picker where the form is the decision.
    pub fn group(
        &self,
        hits: Vec<FoodHit>,
        query: &str,
        user: &User,
        with_ov: bool,
        flat: bool,
    ) -> Grouped {
        let salt_q = asks_for_salt(query);
        let v = usize::from(salt_q);
        let exact: &[i64] = self
            .aliases
            .get(&query.trim().to_lowercase())
            .map_or(&[], Vec::as_slice);
        let mut order: Vec<Slot> = Vec::new();
        let mut about: HashMap<usize, (Option<String>, bool)> = HashMap::new();
        let mut by_fdc: HashMap<i64, (Option<String>, bool)> = HashMap::new();
        let mut replaced = Vec::new();
        for hit in hits {
            let Some(mut f) = hit.fdc_id.filter(|f| self.canon.contains_key(f)) else {
                // A row this index has never seen cannot be grouped; offer it as
                // it came rather than lose it.
                let survey = hit.data_type == SURVEY;
                let name = Some(hit.description.clone());
                order.push(Slot::Loose(Box::new(Entry {
                    hit: FoodHit { name, ..hit },
                    survey,
                })));
                continue;
            };
            // A kitchen-salted row nobody asked for gives its place to the twin
            // cooked without salt.
            if let Some(&t) = self.salt_twin.get(&f) {
                if !salt_q && !user.overridden.contains(&f) && !user.used.contains_key(&f) {
                    f = t;
                }
            }
            let c = self.canon[&f];
            if !with_ov {
                if let Some(&o) = self.members[&c]
                    .iter()
                    .find(|m| user.overridden.contains(m))
                {
                    if !replaced.contains(&o) {
                        replaced.push(o);
                    }
                    continue;
                }
            }
            let fi = self.family_of[&c];
            let slot = about.entry(fi).or_insert_with(|| {
                order.push(Slot::Family(fi));
                (None, false)
            });
            if slot.0.is_none() {
                slot.0.clone_from(&hit.note);
            }
            slot.1 |= hit.matched_alias;
            by_fdc.entry(f).or_insert((hit.note, hit.matched_alias));
        }

        let mut entries = Vec::new();
        for slot in order {
            let fi = match slot {
                Slot::Family(fi) => fi,
                Slot::Loose(e) => {
                    entries.push(*e);
                    continue;
                }
            };
            let forms = self.offered(fi, salt_q, user, with_ov, None);
            let Some(&(first, only)) = forms.first() else {
                continue;
            };
            if flat {
                for (r, fm) in forms {
                    let at = by_fdc.get(&r).cloned().unwrap_or_default();
                    let hit = self.hit(r, self.short_name(fm, v), Vec::new(), at);
                    entries.push(Entry {
                        hit,
                        survey: self.data_type(r) == SURVEY,
                    });
                }
                continue;
            }
            // The form this user logged last; else the one the typed Indian
            // name means; else the first in form order. A recipe or a pot
            // weighs its ingredients raw, so a line in one says nothing about
            // the form someone eats and does not move this.
            let named = forms
                .iter()
                .find(|(_, fm)| self.members[&fm.canon].iter().any(|m| exact.contains(m)));
            let open = self
                .last_logged(forms.iter().map(|(r, _)| *r), user)
                .or(named.map(|(r, _)| *r))
                .unwrap_or(first);
            let survey = forms.iter().all(|(r, _)| self.data_type(*r) == SURVEY);
            let (name, shown) = if forms.len() >= 2 {
                let shown = forms
                    .iter()
                    .map(|(r, fm)| FoodForm {
                        fdc_id: *r,
                        label: fm.chip[v].clone(),
                        description: self.desc(*r).to_string(),
                    })
                    .collect();
                (self.families[fi].name.clone(), shown)
            } else {
                (self.short_name(only, v), Vec::new())
            };
            let at = about.remove(&fi).unwrap_or_default();
            entries.push(Entry {
                hit: self.hit(open, name, shown, at),
                survey,
            });
        }
        Grouped { entries, replaced }
    }

    /// Every form of the food `fdc_id` belongs to, for an amount panel opened
    /// on it. The requested row is always one of them, even when it is a
    /// salted twin or a repeat that search would have folded away.
    pub fn family(&self, fdc_id: i64, user: &User) -> Option<FoodFamily> {
        let c = *self.canon.get(&fdc_id)?;
        let fi = self.family_of[&c];
        let forms: Vec<FoodForm> = self
            .offered(fi, false, user, false, Some(fdc_id))
            .into_iter()
            .map(|(r, fm)| FoodForm {
                fdc_id: r,
                label: fm.chip[0].clone(),
                description: self.desc(r).to_string(),
            })
            .collect();
        if forms.len() >= 2 {
            return Some(FoodFamily {
                name: self.families[fi].name.clone(),
                forms,
            });
        }
        let own = self.families[fi].forms.iter().find(|fm| fm.canon == c)?;
        Some(FoodFamily {
            name: self.short_name(own, 0),
            forms: Vec::new(),
        })
    }

    /// What a logged entry or a quick-add row of `fdc_id` is called on screen:
    /// the name search gives its food, with the form where the food comes in
    /// several, worded as `food_forms` words its chip ("Mungo beans, boiled"),
    /// or a single food's tidied name ("Spinach, baby"). Shown beside the
    /// stored description, never written over it.
    ///
    /// `None` unless `stored`, the description the entry carries, is still
    /// this row's description. A later dataset may reword a row or hand its
    /// id to another food, and a name worked out from today's data would then
    /// be today's claim about a past day, so that entry keeps its own words.
    /// `None` too where the form is already called by its description: in a
    /// family named by one form's own description (the panel's title,
    /// `familyTitle`, and an ingredient tile, `formName`), and where its chip
    /// fell back to the full description to stay apart.
    ///
    /// The name is search's, so it rests on the row's siblings as well as on
    /// the row: a dataset that adds or drops another form of the food can
    /// shorten an unchanged entry differently ("Oats" becoming "Oats, plain"),
    /// or not at all. It never names another food, and what was logged is
    /// untouched, but holding the wording still would mean storing it.
    ///
    /// Worked out for no user in particular, so nothing done since (a salted
    /// twin logged, a sibling replaced by a pack of one's own) renames an
    /// entry already on a day. That is why the chip is the one a query not
    /// about salt shows, though a search for "spinach salted" put "boiled, no
    /// salt" on the panel; and where only this user is offered a sibling (a
    /// salted twin they once logged), the panel may name the form where the
    /// entry gives the food's tidied name alone.
    pub fn entry_name(&self, fdc_id: i64, stored: &str) -> Option<String> {
        if self.foods.get(&fdc_id)?.0 != stored {
            return None;
        }
        let (none, kept) = (HashMap::new(), HashSet::new());
        let nobody = User {
            logged: &none,
            used: &none,
            overridden: &kept,
        };
        let fam = self.family(fdc_id, &nobody)?;
        if fam.forms.len() < 2 {
            return Some(fam.name);
        }
        let form = fam.forms.iter().find(|f| f.fdc_id == fdc_id)?;
        let fell_back = form.label == tidy::norm(self.desc(self.canon[&fdc_id]));
        if fell_back || fam.forms.iter().any(|f| f.description == fam.name) {
            return None;
        }
        Some(format!("{}, {}", fam.name, form.label))
    }

    /// When two shown entries would share a name, the survey one says so; if
    /// that is not enough, both fall back to the full description.
    ///
    /// A food in several forms has no one full description. Named after the
    /// form it opens on, its title would go on saying "Fish, tuna, raw" over
    /// the canned form chosen beneath it, so such an entry is listed form by
    /// form instead, each under its own description, with nothing to switch.
    pub fn guard_names(&self, mut entries: Vec<Entry>) -> Vec<Entry> {
        let key = |e: &Entry| e.hit.name.clone().unwrap_or_default().to_lowercase();
        let count = |es: &[Entry]| {
            let mut n: HashMap<String, usize> = HashMap::new();
            for e in es {
                *n.entry(key(e)).or_default() += 1;
            }
            n
        };
        let n = count(&entries);
        for e in entries.iter_mut().filter(|e| e.survey && n[&key(e)] > 1) {
            e.hit.name = e.hit.name.take().map(|s| format!("{s}, survey"));
        }
        let n = count(&entries);
        let mut out = Vec::with_capacity(entries.len());
        for mut e in entries {
            if n[&key(&e)] <= 1 {
                out.push(e);
            } else if e.hit.forms.len() < 2 {
                e.hit.name = Some(e.hit.description.clone());
                out.push(e);
            } else {
                // The note belongs to the form the entry opened on.
                let open = e.hit.fdc_id;
                let about = (e.hit.note.take(), e.hit.matched_alias);
                for f in std::mem::take(&mut e.hit.forms) {
                    let at = if Some(f.fdc_id) == open {
                        about.clone()
                    } else {
                        (None, false)
                    };
                    let survey = self.data_type(f.fdc_id) == SURVEY;
                    let hit = self.hit(f.fdc_id, f.description, Vec::new(), at);
                    out.push(Entry { hit, survey });
                }
            }
        }
        out
    }
}
