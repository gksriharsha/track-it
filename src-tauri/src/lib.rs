mod awake;
mod backup;
mod db;
mod export;
mod keystore;
mod store;
mod sync;
mod vault;
mod vision;
mod widgets;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use trackit_core::aggregate::{sum, Contribution, DailyTotal};
use trackit_core::barcode;
use trackit_core::ingredients;
use trackit_core::label::{self, LabelEntry};
use trackit_core::panel;
use trackit_core::suppanel;
use trackit_core::dri;
use trackit_core::supplement;
use trackit_core::targets;
use trackit_core::NutrientValue;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Serialize)]
pub struct NutrientTotal {
    pub id: i64,
    pub name: String,
    /// Full FDC laboratory name, shown on hover.
    pub full_name: String,
    pub magnitude: String,
    pub tier: String,
    pub group: String,
    pub total: DailyTotal,
    /// The target this nutrient is being read against, or `None` where no
    /// reference system publishes one. Never defaulted — a made-up denominator
    /// would render a confident percentage out of nothing.
    pub target: Option<f64>,
    /// Which system the target came from: the user's own figure, an RDA, an
    /// Adequate Intake, or the FDA Daily Value. Carried alongside the number
    /// because a percentage is meaningless without saying what it is a
    /// percentage OF, and because an AI and an RDA support very different
    /// conclusions from the same shortfall.
    pub target_basis: Option<String>,
    /// True when the daily value is a ceiling to stay under rather than a goal
    /// to reach, so only a genuine breach gets alarm treatment.
    pub is_limit: bool,
}

/// What a supplement, as it reaches a day's totals, is made of.
#[derive(Debug, Serialize)]
pub struct SupplementPanelRow {
    pub id: i64,
    pub name: String,
    pub magnitude: String,
    pub group: String,
    pub tier: String,
    /// Per label serving, on this app's basis.
    pub value: NutrientValue,
    /// "label" for a line the panel prints, "omitted" for one it does not.
    pub provenance: String,
    /// The printed figure, its unit and the form named beside it — kept so a
    /// conversion can be checked against the pack rather than trusted.
    pub label_text: Option<String>,
    /// Why a printed figure could not be put on this app's basis.
    pub convert_note: Option<String>,
}

/// A supplement's panel, resolved onto the full nutrient list.
#[derive(Debug, Serialize)]
pub struct SupplementDetail {
    pub supplement: store::Supplement,
    pub nutrients: Vec<SupplementPanelRow>,
    pub from_label: usize,
    /// Lines the pack prints that this app could not put on its own basis.
    pub unconverted: usize,
    /// Nutrients the panel does not mention at all.
    pub omitted: usize,
    /// How many of those omissions the labelling regime actually bounds.
    pub omitted_bounded: usize,
}

/// One resolved component of a logged entry: either the food itself, one
/// ingredient of a recipe, or the single provenance line a custom food or a
/// supplement stands behind.
#[derive(Debug, Serialize, Clone)]
pub struct Component {
    pub description: String,
    pub fdc_id: Option<i64>,
    /// The mass this component contributed, or `None` for a supplement, which
    /// contributed a dose and no mass at all. Never read this as `0`.
    pub grams: Option<f64>,
    /// False when no composition data exists, so the UI can show the gap
    /// rather than quietly omitting the row.
    pub has_data: bool,
}

#[derive(Debug, Serialize)]
pub struct EntryBreakdown {
    pub entry_id: String,
    /// Empty for a plain food; one row per ingredient for a recipe.
    pub components: Vec<Component>,
    pub recipe_name: Option<String>,
    pub recipe_yield_g: Option<f64>,
    pub recipe_servings: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct DayView {
    pub logged_on: String,
    pub entries: Vec<store::LogEntry>,
    pub breakdowns: Vec<EntryBreakdown>,
    pub totals: Vec<NutrientTotal>,
    /// What the day's energy is being read against, or `None` when the profile
    /// supplies neither a figure of the user's own nor enough to estimate one.
    /// `None` means the dashboard shows what was eaten and draws no rail.
    pub energy_target: Option<EnergyTarget>,
    /// The macronutrient ranges that energy figure works out to.
    pub macro_ranges: Vec<MacroRange>,
}

/// The description of one reference food, or `None` when nothing carries that
/// `fdc_id`.
///
/// A lookup failure is not distinguished from a missing row on purpose: both
/// mean this build cannot name the food, and every caller here treats that the
/// same way — by saying nothing about a base rather than by guessing at one.
fn base_description(conn: &rusqlite::Connection, fdc_id: i64) -> Option<String> {
    conn.query_row(
        "SELECT description FROM foods WHERE fdc_id = ?1",
        [fdc_id],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

/// Search the user's own foods and the bundled reference data as one list.
///
/// Two rules, both of them the point of the feature rather than presentation
/// detail:
///
/// 1. The user's own foods come first. What the pack says about the bar in
///    their hand beats a generic entry for the category it belongs to.
/// 2. A reference food that a live custom food declares it overrides is
///    REPLACED BY that food, in its own place in the results. Leaving both
///    invites logging the generic one by mistake, which is the confusion the
///    override exists to remove — but simply dropping it was worse: the custom
///    food is only in `own` when the query matched ITS name, brand or barcode,
///    so "candies" against a bar called "Hershey's" returned neither row and the
///    food became less findable after being overridden than before.
///
/// `include_overridden` turns rule 2 off. Choosing which entry a food replaces
/// is exactly the case where the replaced entry must still be visible —
/// otherwise a food's own base can never be re-picked once it is set.
///
/// The result stays a flat `Vec<FoodHit>` with `kind` on each hit, so callers
/// that only want reference foods (a recipe ingredient, which has nowhere to
/// put a custom food) can filter rather than learn a new shape.
#[tauri::command]
fn search_foods(
    query: String,
    limit: Option<u32>,
    include_overridden: Option<bool>,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<Vec<db::FoodHit>, String> {
    let limit = limit.unwrap_or(40);
    let conn = refdb.0.lock().map_err(|e| e.to_string())?;
    let uc = user.0.lock().map_err(|e| e.to_string())?;

    let own = store::search_custom_foods(&uc, &query, limit)?;
    let overridden = store::overridden_fdc_ids(&uc)?;
    merge_hits(
        &conn,
        &uc,
        &query,
        own,
        &overridden,
        include_overridden.unwrap_or(false),
        limit,
    )
}

/// One of the user's own foods as a search hit.
fn custom_hit(
    id: String,
    name: String,
    brand: Option<String>,
    note: Option<String>,
) -> db::FoodHit {
    db::FoodHit {
        kind: "custom".into(),
        // A custom food has no USDA identity; naming the entry it replaces here
        // would log the generic one.
        fdc_id: None,
        custom_food_id: Some(id),
        description: name,
        brand,
        data_type: "custom_food".into(),
        note,
        matched_alias: false,
    }
}

/// The two rules of [`search_foods`], with the databases already read.
#[allow(clippy::too_many_arguments)]
fn merge_hits(
    conn: &rusqlite::Connection,
    userconn: &rusqlite::Connection,
    query: &str,
    own: Vec<store::CustomFood>,
    overridden: &[i64],
    include_overridden: bool,
    limit: u32,
) -> Result<Vec<db::FoodHit>, String> {
    let mut hits: Vec<db::FoodHit> = own
        .into_iter()
        .map(|f| {
            let note = f
                .overrides_fdc_id
                .and_then(|id| base_description(conn, id))
                .map(|d| format!("Replaces the generic entry “{d}”"));
            custom_hit(f.id, f.name, f.brand, note)
        })
        .collect();
    let mut listed: std::collections::HashSet<String> =
        hits.iter().filter_map(|h| h.custom_food_id.clone()).collect();

    // A food standing in for the entry the query actually matched is still one
    // of the user's own foods, so it belongs above the reference data rather
    // than at the position of the row it replaced.
    let mut stand_ins: Vec<db::FoodHit> = Vec::new();
    let mut refs: Vec<db::FoodHit> = Vec::new();

    for hit in db::search(conn, query, limit)? {
        // The lookup only runs for an entry something actually replaces, which
        // is why the cheap id list is worth reading first.
        let replacement = match hit.fdc_id {
            Some(id) if !include_overridden && overridden.contains(&id) => {
                store::custom_food_overriding(userconn, id)?
            }
            _ => None,
        };
        match replacement {
            Some(f) => {
                // Unless it is already up there because the query matched its
                // own name. The generic entry's description is what the user
                // searched for, so it is what the stand-in explains itself by.
                if listed.insert(f.id.clone()) {
                    stand_ins.push(custom_hit(
                        f.id,
                        f.name,
                        f.brand,
                        Some(format!("Replaces the generic entry “{}”", hit.description)),
                    ));
                }
            }
            None => refs.push(hit),
        }
    }

    // Reference hits fill whatever the user's own foods leave of the limit.
    // Someone with enough matching foods of their own to fill it has told us
    // everything they know about this query already. Truncating last is what
    // keeps a stand-in from being crowded out by the rows it outranks.
    hits.append(&mut stand_ins);
    hits.append(&mut refs);
    hits.truncate(limit as usize);
    Ok(hits)
}

#[tauri::command]
fn get_food_detail(fdc_id: i64, refdb: State<'_, db::Db>) -> Result<db::FoodDetail, String> {
    let conn = refdb.0.lock().map_err(|e| e.to_string())?;
    db::detail(&conn, fdc_id)
}

/// Log an entry from either a net weight or a scale reading with vessels on it.
///
/// Exactly one of `grams` and `gross_g` is given. When it is `gross_g`, the tare
/// is summed from the weights held in the vessel library and NEVER from a figure
/// the client sent: a screen that loaded the library before a katori was
/// re-weighed would otherwise write a net weight that disagrees with the library
/// it claims to have used, and a log entry is not something we can recompute
/// afterwards.
///
/// Exactly one of `fdc_id`, `recipe_id` and `custom_food_id` is given too;
/// `store::add` is what enforces that, so the rule lives with the row.
/// Log one thing eaten or taken.
///
/// Three shapes reach here and exactly one may be used at a time: a net weight
/// typed in, a scale reading with the vessels that were under the food, or a
/// dose counted in a supplement's own units. The combinations are checked here
/// rather than left to the table, because a constraint code is not something a
/// screen can show a person.
/// Log an entry and freeze what it contained, both or neither.
///
/// Every path that creates an entry goes through here. Resolving first and
/// writing both rows in one transaction is what guarantees the invariant the
/// day reader depends on: an entry that exists has nutrition attached to it,
/// taken from what was known at this moment and never revisited.
#[allow(clippy::too_many_arguments)]
fn add_frozen(
    refconn: &rusqlite::Connection,
    conn: &mut rusqlite::Connection,
    logged_on: &str,
    // `None` only for water — see the `meal` column in store.rs.
    meal: Option<&str>,
    source: store::Source<'_>,
    description: &str,
    quantity: store::Quantity,
    tare: Option<&store::Tare>,
    tags: &store::Tags,
) -> Result<String, String> {
    let (recipe, components) = resolve_contribution(refconn, conn, source, description, quantity)?;
    let snap = store::Snapshot {
        basis: store::SnapBasis::Logged,
        frozen_at: store::now_iso(conn)?,
        corrected_at: None,
        recipe,
        components,
    };
    store::add_with_snapshot(
        conn,
        logged_on,
        meal,
        source,
        description,
        quantity,
        tare,
        tags,
        &snap,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn add_log_entry(
    logged_on: String,
    meal: String,
    fdc_id: Option<i64>,
    recipe_id: Option<String>,
    cook_id: Option<String>,
    custom_food_id: Option<String>,
    supplement_id: Option<String>,
    description: String,
    grams: Option<f64>,
    units: Option<f64>,
    gross_g: Option<f64>,
    vessel_ids: Option<Vec<String>>,
    origin: Option<String>,
    cuisine: Option<String>,
    app: AppHandle,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    // Reference before user, the order every command holding both already uses.
    // A consistent order is what keeps two of them from deadlocking.
    let refconn = refdb.0.lock().map_err(|e| e.to_string())?;
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;

    let source = match (
        fdc_id,
        recipe_id.as_deref(),
        cook_id.as_deref(),
        custom_food_id.as_deref(),
        supplement_id.as_deref(),
    ) {
        (Some(id), None, None, None, None) => store::Source::Food(id),
        (None, Some(id), None, None, None) => store::Source::Recipe(id),
        (None, None, Some(id), None, None) => store::Source::Cook(id),
        (None, None, None, Some(id), None) => store::Source::Custom(id),
        (None, None, None, None, Some(id)) => store::Source::Supplement(id),
        _ => {
            return Err(
                "a log entry references exactly one of a food, a recipe, a pot you cooked, \
                 one of your own foods or a supplement"
                    .into(),
            )
        }
    };

    let tags = store::Tags { origin, cuisine };

    // A dose is counted and never weighed, so it takes neither of the two
    // weight paths and cannot carry a tare.
    if let Some(u) = units {
        if grams.is_some() || gross_g.is_some() {
            return Err("a supplement is taken by count, not weighed".into());
        }
        return after_write(
            &app,
            add_frozen(
                &refconn,
                &mut conn,
                &logged_on,
                Some(&meal),
                source,
                &description,
                store::Quantity::Units(u),
                None,
                &tags,
            ),
        );
    }

    match (grams, gross_g) {
        (Some(_), Some(_)) => {
            Err("a log entry takes either a net weight or a scale reading, not both".into())
        }
        (None, None) => Err("a log entry needs either a net weight or a scale reading".into()),
        (Some(grams), None) => after_write(
            &app,
            add_frozen(
                &refconn,
                &mut conn,
                &logged_on,
                Some(&meal),
                source,
                &description,
                store::Quantity::Grams(grams),
                None,
                &tags,
            ),
        ),
        (None, Some(gross_g)) => {
            // No vessels with a scale reading is a legitimate case: an untared
            // scale, nothing under the food, tare 0.
            let ids = vessel_ids.unwrap_or_default();
            let vessels = store::vessels_by_id(&conn, &ids)?;
            let tare_g: f64 = vessels.iter().map(|v| v.grams).sum();
            let note = vessels
                .iter()
                .map(|v| v.name.as_str())
                .collect::<Vec<_>>()
                .join(" + ");
            let net_g = gross_g - tare_g;
            if !(net_g.is_finite() && net_g > 0.0) {
                return Err(format!(
                    "the scale read {gross_g:.1} g and the vessels weigh {tare_g:.1} g, \
                     which leaves no food to log"
                ));
            }
            let id = add_frozen(
                &refconn,
                &mut conn,
                &logged_on,
                Some(&meal),
                source,
                &description,
                store::Quantity::Grams(net_g),
                Some(&store::Tare {
                    gross_g,
                    tare_g,
                    note,
                }),
                &tags,
            )?;
            // Only after the row is written, so a rejected entry does not
            // reorder the picker.
            store::touch_vessels(&conn, &ids)?;
            republish_widgets(&app);
            Ok(id)
        }
    }
}

/// Log how much of a bottle was drunk: the difference between its full weight
/// and what it reads now.
///
/// Deliberately its own command rather than another `add_log_entry` branch —
/// a bottle is resolved by id to a `full_g` the way a food is resolved by
/// `fdc_id` to a nutrient panel, so the reading a caller supplies is checked
/// against the library's own figure rather than trusted at face value.
#[tauri::command]
fn log_water(
    logged_on: String,
    bottle_id: String,
    current_g: f64,
    app: AppHandle,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    let refconn = refdb.0.lock().map_err(|e| e.to_string())?;
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;
    let bottle = store::get_bottle(&conn, &bottle_id)?;
    if !(current_g.is_finite() && current_g >= 0.0) {
        return Err("what the bottle reads now must be zero or a positive number".into());
    }
    let consumed_g = bottle.full_g - current_g;
    if !(consumed_g.is_finite() && consumed_g > 0.0) {
        return Err(format!(
            "{} reads {current_g:.0} g, which is not less than its full weight of {:.0} g — nothing to log",
            bottle.name, bottle.full_g
        ));
    }
    let id = add_frozen(
        &refconn,
        &mut conn,
        // No meal, and not merely a defaulted one. A bottle is refilled and
        // sipped from across a whole day, so there is no sitting it was part
        // of — and the schema now refuses to store a guess.
        &logged_on,
        None,
        store::Source::Water(&bottle_id),
        &bottle.name,
        store::Quantity::Grams(consumed_g),
        Some(&store::Tare {
            gross_g: bottle.full_g,
            tare_g: current_g,
            note: String::new(),
        }),
        &store::Tags::default(),
    )?;
    // Only after the row is written, so a rejected entry does not reorder the
    // picker.
    store::touch_bottle(&conn, &bottle_id)?;
    republish_widgets(&app);
    Ok(id)
}

/// The user's own last answer for a food, to pre-fill the tag pickers.
///
/// Never a guess from a name: see `store::recall_tags`.
#[tauri::command]
fn recall_tags(
    fdc_id: Option<i64>,
    recipe_id: Option<String>,
    cook_id: Option<String>,
    custom_food_id: Option<String>,
    user: State<'_, store::Store>,
) -> Result<RecalledTags, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    let source = match (
        fdc_id,
        recipe_id.as_deref(),
        cook_id.as_deref(),
        custom_food_id.as_deref(),
    ) {
        (Some(id), None, None, None) => store::Source::Food(id),
        (None, Some(id), None, None) => store::Source::Recipe(id),
        (None, None, Some(id), None) => store::Source::Cook(id),
        (None, None, None, Some(id)) => store::Source::Custom(id),
        _ => return Err("recall needs exactly one food".into()),
    };
    let t = store::recall_tags(&conn, source)?;
    Ok(RecalledTags {
        origin: t.origin,
        cuisine: t.cuisine,
    })
}

#[derive(Debug, Serialize)]
pub struct RecalledTags {
    pub origin: Option<String>,
    pub cuisine: Option<String>,
}

/// Add or change the tags on an entry already logged.
#[tauri::command]
fn set_entry_tags(
    id: String,
    origin: Option<String>,
    cuisine: Option<String>,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::set_tags(&conn, &id, &store::Tags { origin, cuisine })
}

/// The cuisines this user has actually used, most-used first.
#[tauri::command]
fn list_cuisines(user: State<'_, store::Store>) -> Result<Vec<String>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::list_cuisines(&conn, 24)
}

#[tauri::command]
fn save_recipe(
    name: String,
    yield_g: f64,
    // Absent unless the user volunteered a count. `Option` rather than a
    // sentinel so "did not say" survives the trip across IPC intact — Tauri
    // supplies `None` for an argument the frontend omits entirely.
    servings: Option<f64>,
    notes: Option<String>,
    ingredients: Vec<store::RecipeIngredient>,
    serving_options: Vec<store::RecipeServing>,
    default_origin: Option<String>,
    default_cuisine: Option<String>,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;
    store::save_recipe(
        &mut conn,
        &name,
        yield_g,
        servings,
        notes.as_deref(),
        &ingredients,
        &serving_options,
        &store::Tags {
            origin: default_origin,
            cuisine: default_cuisine,
        },
    )
}

// ---------------------------------------------------------------------------
// Supplements
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Profile and targets
// ---------------------------------------------------------------------------

/// One nutrient on the settings screen: what it is being read against now, and
/// what it would fall back to if the user cleared their own figure.
#[derive(Debug, Serialize)]
pub struct GoalRow {
    pub id: i64,
    pub name: String,
    pub magnitude: String,
    pub group: String,
    pub tier: String,
    pub amount: Option<f64>,
    pub basis: Option<String>,
    pub is_limit: bool,
    /// The user's own figure, when they set one.
    pub user_amount: Option<f64>,
    pub user_note: Option<String>,
    /// What would apply if that figure were cleared — shown beside the box so
    /// "clear this" is a visible choice rather than a leap.
    pub published_amount: Option<f64>,
    pub published_basis: Option<String>,
}

/// Everything the profile and settings screens need, in one call.
#[derive(Debug, Serialize)]
pub struct GoalsView {
    pub profile: store::Profile,
    /// How the DRI tables name this person's column, or `None` when age and sex
    /// do not place them in one.
    pub group_label: Option<String>,
    pub energy_target: Option<EnergyTarget>,
    /// What the body in the profile estimates to, whether or not it is being
    /// used — so someone with a figure of their own can still see it, and
    /// someone without one can see what filling in the profile would give them.
    pub estimated_kcal: Option<f64>,
    pub estimated_resting: Option<f64>,
    pub macro_ranges: Vec<MacroRange>,
    pub rows: Vec<GoalRow>,
}

#[tauri::command]
fn get_goals(refdb: State<'_, db::Db>, user: State<'_, store::Store>) -> Result<GoalsView, String> {
    let (profile, overrides) = {
        let uc = user.0.lock().map_err(|e| e.to_string())?;
        (store::get_profile(&uc)?, store::list_targets(&uc)?)
    };
    let goals = goals_from(&profile, &overrides);

    // What the published tables alone would say — the figure behind any of the
    // user's own, so the screen can show what clearing one returns to.
    let published: HashMap<i64, targets::Goal> = targets::resolve(goals.group, &[])
        .into_iter()
        .map(|g| (g.nutrient_id, g))
        .collect();

    let sex = profile.sex.as_deref().and_then(dri::Sex::parse);
    let age = age_from(profile.birth_year);
    let activity = profile.activity.as_deref().and_then(dri::Activity::parse);
    let estimate = dri::energy_estimate(sex, age, profile.height_cm, profile.weight_kg, activity);

    let conn = refdb.0.lock().map_err(|e| e.to_string())?;
    let rows = db::displayed_nutrients(&conn)?
        .into_iter()
        .map(|m| {
            let goal = goals.by_nutrient.get(&m.id);
            let mine = overrides.iter().find(|o| o.nutrient_id == m.id);
            let pub_goal = published.get(&m.id);
            GoalRow {
                id: m.id,
                name: m.short_name,
                magnitude: m.magnitude,
                group: m.display_group,
                tier: m.tier,
                amount: goal.map(|g| g.amount),
                basis: goal.map(|g| g.basis.as_str().to_string()),
                is_limit: goal.map(|g| g.is_limit).unwrap_or(false),
                user_amount: mine.map(|o| o.amount),
                user_note: mine.and_then(|o| o.note.clone()),
                published_amount: pub_goal.map(|g| g.amount),
                published_basis: pub_goal.map(|g| g.basis.as_str().to_string()),
            }
        })
        .collect();

    Ok(GoalsView {
        profile,
        group_label: goals.group.map(|g| g.label().to_string()),
        energy_target: goals.energy.clone(),
        estimated_kcal: estimate.map(|e| e.total),
        estimated_resting: estimate.map(|e| e.resting),
        macro_ranges: goals.macro_ranges.clone(),
        rows,
    })
}

/// Replace the profile. Every field is sent every time — see `store::save_profile`.
#[tauri::command]
fn save_profile(
    profile: store::Profile,
    app: AppHandle,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    // The profile is where an energy figure of the person's own comes from, and
    // that figure is the reference the aggregate widget prints beside its middle
    // day. Setting one has to reach the home screen, or the line would appear
    // there only after the next meal was logged.
    after_write(&app, store::save_profile(&conn, &profile))
}

/// Set one nutrient's target, or clear it by passing no amount.
#[tauri::command]
fn set_nutrient_target(
    nutrient_id: i64,
    amount: Option<f64>,
    note: Option<String>,
    app: AppHandle,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    after_write(
        &app,
        store::set_target(&conn, nutrient_id, amount, note.as_deref()),
    )
}

#[tauri::command]
fn list_supplements(user: State<'_, store::Store>) -> Result<Vec<store::Supplement>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::list_supplements(&conn)
}

#[tauri::command]
fn get_supplement(id: String, user: State<'_, store::Store>) -> Result<store::Supplement, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::get_supplement(&conn, &id)
}

/// One entry point for adding a supplement and for correcting one: pass an `id`
/// to replace it in place, omit it to record a new one.
#[tauri::command]
fn save_supplement(
    id: Option<String>,
    supplement: store::Supplement,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;
    store::save_supplement(&mut conn, id.as_deref(), &supplement)
}

/// Soft delete. Days that already took it keep what they were logged with.
#[tauri::command]
fn delete_supplement(id: String, user: State<'_, store::Store>) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::delete_supplement(&conn, &id)
}

#[tauri::command]
fn list_recipes(user: State<'_, store::Store>) -> Result<Vec<store::Recipe>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::list_recipes(&conn)
}

#[tauri::command]
fn get_recipe(id: String, user: State<'_, store::Store>) -> Result<store::Recipe, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::get_recipe(&conn, &id)
}

#[tauri::command]
fn delete_recipe(id: String, user: State<'_, store::Store>) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::delete_recipe(&conn, &id)
}

// ---------------------------------------------------------------------------
// Cooks
// ---------------------------------------------------------------------------

/// Open a cook from a recipe, without saving anything.
///
/// The scaling is done here rather than in the screen so there is one
/// definition of what "×0.5 of this recipe" means, and so the numbers the dial
/// is centred on came from the same place the stored ones will.
#[tauri::command]
fn draft_cook(
    recipe_id: String,
    scale: f64,
    user: State<'_, store::Store>,
) -> Result<store::Cook, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    let recipe = store::get_recipe(&conn, &recipe_id)?;
    if !(scale.is_finite() && scale > 0.0) {
        return Err("the batch scale must be a positive number".into());
    }
    let today = store::today_iso(&conn)?;
    Ok(store::Cook {
        id: String::new(),
        recipe_id: Some(recipe.id.clone()),
        name: recipe.name.clone(),
        cooked_on: today,
        cooked_at: String::new(),
        scale,
        // Half the recipe makes half as much. This is the divisor until the
        // pot goes on a scale, and it is frozen onto the pot when it is saved:
        // rewriting the recipe next month must not re-portion food already in
        // the fridge.
        expected_yield_g: recipe.yield_g * scale,
        weighed_yield_g: None,
        gross_g: None,
        tare_g: None,
        tare_note: None,
        // The user's own statement about their own construct, copied forward.
        // Nothing here is inferred from the dish's name — see D15.
        default_origin: recipe.default_origin.clone(),
        default_cuisine: recipe.default_cuisine.clone(),
        notes: None,
        finished_at: None,
        ingredients: recipe
            .ingredients
            .iter()
            .map(|i| store::CookIngredient {
                id: String::new(),
                position: i.position,
                fdc_id: i.fdc_id,
                description: i.description.clone(),
                custom_food_id: i.custom_food_id.clone(),
                // Raw, like everything else about an ingredient: it is the
                // amount that will be weighed out and tipped in.
                planned_g: i.raw_g * scale,
                raw_g: i.raw_g * scale,
                substituted_for: None,
            })
            .collect(),
        logged_g: 0.0,
        yield_g: 0.0,
        remaining_g: 0.0,
    }
    .seal())
}

#[tauri::command]
fn save_cook(
    id: Option<String>,
    cook: store::CookDraft,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;
    let input = cook.into_input();
    let saved = store::save_cook(&mut conn, id.as_deref(), &input)?;
    // Only after the row is written, so a rejected pot does not reorder the
    // vessel picker — the same ordering `add_log_entry` keeps.
    store::touch_vessels(&conn, &input.vessel_ids)?;
    Ok(saved)
}

#[tauri::command]
fn list_open_cooks(user: State<'_, store::Store>) -> Result<Vec<store::Cook>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::list_open_cooks(&conn)
}

#[tauri::command]
fn get_cook(id: String, user: State<'_, store::Store>) -> Result<store::Cook, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::get_cook(&conn, &id)
}

#[tauri::command]
fn finish_cook(
    id: String,
    finished: bool,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::finish_cook(&conn, &id, finished)
}

#[tauri::command]
fn delete_cook(id: String, user: State<'_, store::Store>) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::delete_cook(&conn, &id)
}

#[tauri::command]
fn list_vessels(user: State<'_, store::Store>) -> Result<Vec<store::Vessel>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::list_vessels(&conn)
}

/// `id` absent adds a vessel, `id` present re-weighs or renames the one it names.
#[tauri::command]
fn save_vessel(
    id: Option<String>,
    name: String,
    grams: f64,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::save_vessel(&conn, id.as_deref(), &name, grams)
}

#[tauri::command]
fn delete_vessel(id: String, user: State<'_, store::Store>) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::delete_vessel(&conn, &id)
}

#[tauri::command]
fn list_bottles(user: State<'_, store::Store>) -> Result<Vec<store::Bottle>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::list_bottles(&conn)
}

/// `id` absent adds a bottle, `id` present re-weighs or renames the one it names.
#[tauri::command]
fn save_bottle(
    id: Option<String>,
    name: String,
    full_g: f64,
    empty_g: Option<f64>,
    volume_ml: Option<f64>,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::save_bottle(&conn, id.as_deref(), &name, full_g, empty_g, volume_ml)
}

#[tauri::command]
fn delete_bottle(id: String, user: State<'_, store::Store>) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::delete_bottle(&conn, &id)
}

#[tauri::command]
fn delete_log_entry(
    id: String,
    app: AppHandle,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    after_write(&app, store::remove(&conn, &id))
}

#[tauri::command]
fn logged_dates(user: State<'_, store::Store>) -> Result<Vec<String>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::logged_dates(&conn, 60)
}

/// How much wider the ranking is asked to look than the caller wants.
///
/// A multiplier and not a size, because the filter below drops rows: a
/// reference food the dataset no longer carries disappears after the ranking
/// has already spent one of its slots on it. Ask for exactly six and a screen
/// that should show six shows four, silently, and the only symptom is a list
/// that looks like the user logs less than they do.
const FREQUENT_POOL_FACTOR: u32 = 3;

/// The quick-add list: what this person has been logging most days lately.
///
/// Both databases, reference before user — the order every command holding
/// both already uses, and the only thing keeping two of them from deadlocking.
/// The user database is where the ranking lives; the reference database is
/// consulted for one reason, and it is not decoration.
///
/// `usda_core.db` is replaced wholesale by a dataset upgrade
/// (`docs/architecture-app.md` D3), so an `fdc_id` the log denormalised years
/// ago may name nothing at all today. Left alone, that food would still be
/// offered as a row, and tapping it would put "food 16033: Query returned no
/// rows" in the error bar — a dead link the app itself drew. Rows whose entry
/// has gone are dropped here instead, and the ones that survive take the
/// description the reference data carries NOW rather than the one frozen into
/// the log. That second part closes a quieter version of the same bug: the
/// commit path logs the freshly fetched description, so a row showing an old
/// name would have written a new one.
///
/// A reference food the user has since REPLACED with their own pack is dropped
/// for a different reason, and it is the reason the override exists at all.
/// Once a live custom food declares `overrides_fdc_id`, `search_foods` stops
/// offering the generic entry (see its rule 2) — but this list is built from
/// the log, which still remembers every day the generic one was eaten, so
/// without this the one path that no longer offers a food would sit beside the
/// one that offers it most prominently. Tapping it would log USDA's figures for
/// the category while the user has a transcribed pack for the actual product,
/// and logged history being immutable, that entry would keep them for good.
///
/// The frozen description is not lost by this and is not meant to be — every
/// entry already in the log keeps its own, which is the whole point of
/// denormalising it. This is a shortcut to logging the food AS IT IS NOW.
///
/// The window is not a parameter — see [`store::FREQUENT_WINDOW_DAYS`].
#[tauri::command]
fn frequent_foods(
    limit: Option<u32>,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<Vec<store::FrequentFood>, String> {
    let want = limit.unwrap_or(6);
    let refconn = refdb.0.lock().map_err(|e| e.to_string())?;
    let conn = user.0.lock().map_err(|e| e.to_string())?;

    let since = store::days_ago_iso(&conn, store::FREQUENT_WINDOW_DAYS)?;
    let candidates = store::frequent_foods(&conn, &since, want.saturating_mul(FREQUENT_POOL_FACTOR))?;
    let overridden = store::overridden_fdc_ids(&conn)?;
    Ok(resolve_frequent(&refconn, candidates, &overridden, want))
}

/// The reference-database half of [`frequent_foods`], with both databases
/// already read — split out for the reason [`merge_hits`] is: a `State` cannot
/// be built in a test, and this is the half worth testing.
fn resolve_frequent(
    refconn: &rusqlite::Connection,
    candidates: Vec<store::FrequentFood>,
    overridden: &[i64],
    want: u32,
) -> Vec<store::FrequentFood> {
    let mut out: Vec<store::FrequentFood> = Vec::with_capacity(want as usize);
    for mut f in candidates {
        if let Some(id) = f.fdc_id {
            if overridden.contains(&id) {
                continue;
            }
            match base_description(refconn, id) {
                Some(d) => f.description = d,
                None => continue,
            }
        }
        out.push(f);
        if out.len() >= want as usize {
            break;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// The user's own foods
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_custom_foods(user: State<'_, store::Store>) -> Result<Vec<store::CustomFood>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::list_custom_foods(&conn)
}

#[tauri::command]
fn get_custom_food(id: String, user: State<'_, store::Store>) -> Result<store::CustomFood, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::get_custom_food(&conn, &id)
}

/// `id` absent records a new food, `id` present replaces the one it names.
#[tauri::command]
fn save_custom_food(
    id: Option<String>,
    food: store::CustomFood,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;
    store::save_custom_food(&mut conn, id.as_deref(), &food)
}

/// Soft delete: a day logged against this food still has to expand, so the row
/// stays. Its photos are left on disk rather than unlinked, but nothing shows
/// them once the food is deleted — what a past day keeps is its values.
#[tauri::command]
fn delete_custom_food(
    id: String,
    app: AppHandle,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    // A quick-add row may be pointing at this food. Republishing takes it off
    // the home screen; without this, tapping the row would open the app on a
    // food its owner has thrown away.
    after_write(&app, store::delete_custom_food(&conn, &id))
}

/// One nutrient value read off a spreadsheet row, already resolved to a
/// nutrient id and a plain number by the frontend's header matching
/// (src/lib/spreadsheet.ts) — a blank cell never reaches here at all, which is
/// how "not tracked that day" stays absent rather than becoming a zero.
#[derive(Debug, Deserialize)]
pub struct ImportNutrientInput {
    pub nutrient_id: i64,
    pub amount: f64,
}

/// One spreadsheet row, already parsed and date-normalised by the frontend.
/// Untrusted input regardless: it came from a file the user picked, same as
/// an OCR reading, so this side re-validates everything that touches the
/// database rather than trusting the frontend's own cleanup.
#[derive(Debug, Deserialize)]
pub struct ImportRowInput {
    pub logged_on: String,
    pub meal: String,
    pub description: String,
    pub nutrients: Vec<ImportNutrientInput>,
    /// The row this came from in the user's own file, 1-based with the header
    /// as row 1. Carried across the boundary rather than counted here: the
    /// frontend has already dropped the rows it could not read a date from, so
    /// this batch's own indices stopped matching the file the moment any row
    /// was skipped — and a failure that names the wrong row is worse than one
    /// that names none.
    pub source_row: usize,
}

/// Why one row of a batch import did not become a log entry. `row` is
/// 1-based, matching a spreadsheet's own row numbering, so the message can be
/// acted on by opening the file rather than counted from zero.
#[derive(Debug, Serialize)]
pub struct ImportRowFailure {
    pub row: usize,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct ImportSummary {
    pub imported: usize,
    pub failed: Vec<ImportRowFailure>,
}

/// Mirrors the `log_entries.meal` CHECK constraint's own list, so a bad meal
/// is refused with a sentence here rather than a constraint code from SQLite.
const IMPORT_MEALS: [&str; 4] = ["breakfast", "lunch", "dinner", "snack"];

/// True for a string that is both `YYYY-MM-DD` shaped and a real calendar
/// date — rejects a plainly invalid date like 2024-02-30 rather than trusting
/// the frontend's own normalisation. No date library is pulled in for this:
/// the range check is a handful of comparisons once the three fields are
/// known to be numeric and grouped correctly.
fn valid_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !b[0..4].iter().all(u8::is_ascii_digit)
        || !b[5..7].iter().all(u8::is_ascii_digit)
        || !b[8..10].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    let year: i32 = s[0..4].parse().unwrap();
    let month: u32 = s[5..7].parse().unwrap();
    let day: u32 = s[8..10].parse().unwrap();
    if !(1..=12).contains(&month) {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => unreachable!("month already checked to be 1..=12"),
    };
    (1..=days_in_month).contains(&day)
}

/// Import one already-parsed spreadsheet row into exactly what a transcribed
/// pack already is in this app: one `custom_foods` row plus one `log_entries`
/// row pointing at it via `Source::Custom`. `serving_g: 100.0` paired with
/// logging `Quantity::Grams(100.0)` is the whole trick — nutrient storage is
/// per-100g-scaled-from-per-serving, so with serving and grams equal that
/// scaling is the identity and the number typed into the spreadsheet is
/// exactly the number that lands in the day's total. 100 is a nominal
/// placeholder mass, not a claim about how much food that represents.
fn import_one_row(
    refconn: &rusqlite::Connection,
    conn: &mut rusqlite::Connection,
    row: &ImportRowInput,
) -> Result<(), String> {
    if !valid_iso_date(&row.logged_on) {
        return Err(format!("\"{}\" is not a valid date", row.logged_on));
    }
    if !IMPORT_MEALS.contains(&row.meal.as_str()) {
        return Err(format!(
            "\"{}\" is not one of the meals this app records ({})",
            row.meal,
            IMPORT_MEALS.join(", ")
        ));
    }
    // The contract's own rule: a row with literally nothing in it must not
    // become a 100 g entry with zero measured nutrients — that would actively
    // lower the day's mass-weighted coverage, worse than not touching that
    // day at all. Reported as its own failure reason so the summary can tell
    // "nothing to import here" apart from "this row was wrong".
    if row.nutrients.is_empty() {
        return Err("no nutrient values were recognised in this row".into());
    }

    let description = {
        let d = row.description.trim();
        if d.is_empty() {
            "Imported entry".to_string()
        } else {
            d.to_string()
        }
    };

    let food = store::CustomFood {
        id: String::new(),
        name: description.clone(),
        brand: None,
        overrides_fdc_id: None,
        serving_g: 100.0,
        serving_label: None,
        ingredients: None,
        barcode: None,
        photo_label: None,
        photo_ingredients: None,
        // A typed 0 on a personal tracking spreadsheet is an asserted zero,
        // not a manufacturer's rounding threshold, so it becomes a plain
        // "measured" amount rather than being run through label::to_value —
        // that reasoning is specific to a printed label and does not apply
        // to someone typing their own numbers into their own tracker.
        nutrients: row
            .nutrients
            .iter()
            .map(|n| store::CustomNutrient {
                nutrient_id: n.nutrient_id,
                kind: "measured".into(),
                amount: Some(n.amount),
                upper: None,
            })
            .collect(),
        import_only: true,
    };

    let food_id = store::save_custom_food(conn, None, &food)?;

    let tags = store::Tags {
        origin: None,
        cuisine: None,
    };
    // Frozen like any other entry. An imported row is history by definition —
    // it describes a day already lived — so it must not be re-valued later
    // either.
    let logged = add_frozen(
        refconn,
        conn,
        &row.logged_on,
        // An imported row always names a meal — it is validated against
        // IMPORT_MEALS before we get here — and it lands as a custom food,
        // never as water.
        Some(&row.meal),
        store::Source::Custom(&food_id),
        &description,
        store::Quantity::Grams(100.0),
        None,
        &tags,
    );

    if let Err(e) = logged {
        // An import-only food with no log entry pointing at it is a leaked
        // row, not merely an invisible one — clean it up rather than leaving
        // it behind just because it will never show up in search.
        let _ = store::delete_custom_food(conn, &food_id);
        return Err(e);
    }

    Ok(())
}

/// Bulk-import past tracking from a spreadsheet the frontend has already
/// parsed (src/lib/spreadsheet.ts) into custom-food + log-entry pairs.
///
/// Processed one row at a time and never aborted for one bad row: a 300-row
/// import should not be held hostage by row 217. `rows` is trusted no further
/// than any other input from a file the user picked — every row is
/// re-validated here even though the frontend already normalised it.
#[tauri::command]
fn import_log_rows(
    rows: Vec<ImportRowInput>,
    app: AppHandle,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<ImportSummary, String> {
    // Reference before user, the order every command holding both uses.
    let refconn = refdb.0.lock().map_err(|e| e.to_string())?;
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;
    let mut imported = 0usize;
    let mut failed = Vec::new();

    for row in rows.iter() {
        match import_one_row(&refconn, &mut conn, row) {
            Ok(()) => imported += 1,
            Err(reason) => failed.push(ImportRowFailure {
                row: row.source_row,
                reason,
            }),
        }
    }

    // ONCE, here, and never inside the loop above. A three-hundred-row
    // spreadsheet is one import, and republishing per row would spend three
    // hundred thirty-day aggregations to arrive at the figure the last one
    // computes anyway. The `after_write` gate is not used because a partial
    // import is still an import: rows that landed have changed the period even
    // when others were refused.
    if imported > 0 {
        republish_widgets(&app);
    }
    Ok(ImportSummary { imported, failed })
}

/// Which of the given dates already carry at least one import-only entry, so
/// the importer can warn before a second pass over the same file — or an
/// overlapping one — silently doubles those days' totals.
#[tauri::command]
fn dates_with_existing_imports(
    dates: Vec<String>,
    user: State<'_, store::Store>,
) -> Result<Vec<String>, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::dates_with_existing_imports(&conn, &dates)
}

/// One nutrient of a custom food's panel, with where its value came from.
///
/// `provenance` is not decoration. A pack prints about fifteen numbers and this
/// panel has forty-seven rows, so most of what is shown was either borrowed
/// from the entry this food overrides or is not known at all — and those are
/// different kinds of knowledge from a figure read off the pack.
#[derive(Debug, Clone, Serialize)]
pub struct CustomNutrientRow {
    pub id: i64,
    pub name: String,
    pub magnitude: String,
    pub basis: String,
    pub tier: String,
    pub group: String,
    pub value: NutrientValue,
    /// Exactly one of "label", "inherited", "unknown".
    pub provenance: String,
}

#[derive(Debug, Serialize)]
pub struct CustomFoodDetail {
    pub food: store::CustomFood,
    /// Every displayed nutrient, in display order.
    pub nutrients: Vec<CustomNutrientRow>,
    /// Name of the reference food being overridden, if any.
    pub base_description: Option<String>,
    pub from_label: usize,
    pub from_base: usize,
    pub unknown: usize,
}

/// A custom food's panel, resolved once.
struct ResolvedPanel {
    rows: Vec<CustomNutrientRow>,
    base_description: Option<String>,
    from_label: usize,
    from_base: usize,
    unknown: usize,
}

impl ResolvedPanel {
    /// The panel as a lookup, for summing a day.
    fn values(&self) -> HashMap<i64, NutrientValue> {
        self.rows.iter().map(|r| (r.id, r.value.clone())).collect()
    }
}

/// How much of a panel the pack actually accounts for, as one sentence.
///
/// Shown wherever a custom food is expanded, because "43 g of a Hershey's bar"
/// on its own does not say that most of what the day counts for it was borrowed
/// or is missing.
fn provenance_line(panel: &ResolvedPanel) -> String {
    let total = panel.rows.len();
    match &panel.base_description {
        Some(base) => format!(
            "{} of {total} values off the pack, {} borrowed from “{base}”, {} unmeasured",
            panel.from_label, panel.from_base, panel.unknown
        ),
        None => format!(
            "{} of {total} values off the pack, {} unmeasured",
            panel.from_label, panel.unknown
        ),
    }
}

/// Put one per-serving figure on the app's per-100 g basis.
///
/// Delegates to `label::to_value` rather than multiplying here, so the whole app
/// has exactly one implementation of the conversion — including its rejection of
/// a serving that cannot divide.
fn per_100(amount: f64, nutrient_id: i64, serving_g: f64) -> Result<f64, String> {
    match label::to_value(&LabelEntry::Printed { amount }, nutrient_id, serving_g)? {
        NutrientValue::Measured { amount } => Ok(amount),
        other => Err(format!(
            "rescaling {amount} for nutrient {nutrient_id} produced {other:?}, which is a bug"
        )),
    }
}

/// One stored label row as a per-100 g value.
///
/// The stored kind decides what the value *is* — `NutrientValue::from_db` is the
/// single mapping for that — and only the arithmetic is delegated. A stored
/// `label_zero` keeps the bound it was saved with rather than having the
/// regulation's ceiling recomputed here: the bound is what this food asserts,
/// and re-deriving it would quietly change a saved food when the table moves.
fn label_value(n: &store::CustomNutrient, serving_g: f64) -> Result<NutrientValue, String> {
    let id = n.nutrient_id;
    Ok(match NutrientValue::from_db(&n.kind, n.amount, n.upper) {
        NutrientValue::Measured { amount } => NutrientValue::Measured {
            amount: per_100(amount, id, serving_g)?,
        },
        NutrientValue::BelowLoq { upper } => NutrientValue::BelowLoq {
            upper: per_100(upper, id, serving_g)?,
        },
        NutrientValue::LabelZero { upper } => NutrientValue::LabelZero {
            upper: per_100(upper, id, serving_g)?,
        },
        NutrientValue::Trace { upper } => NutrientValue::Trace {
            upper: per_100(upper, id, serving_g)?,
        },
        // The table's CHECK admits only those four kinds, so this is a database
        // written by something other than this app. Refusing beats inventing.
        other => {
            return Err(format!(
                "nutrient {id} of this food is stored as {other:?}, which no label can say"
            ))
        }
    })
}

/// Resolve a custom food onto the full nutrient panel, once.
///
/// The order is the whole design: what the pack prints wins; what it omits is
/// borrowed from the generic entry this food overrides, if it names one; and
/// what neither supplies is `Absent` — unknown and unbounded above, never zero.
///
/// **This is the only place that resolution happens.** The panel a person reads
/// before saving and the totals their day is built from come from this function,
/// so the two cannot drift into disagreeing about the same food.
fn resolve_panel(
    refconn: &rusqlite::Connection,
    food: &store::CustomFood,
) -> Result<ResolvedPanel, String> {
    let mut from_label: HashMap<i64, NutrientValue> = HashMap::new();
    for n in &food.nutrients {
        from_label.insert(n.nutrient_id, label_value(n, food.serving_g)?);
    }

    // A base whose row is no longer in the reference data (an fdc_id retired by
    // a dataset rebuild) leaves its nutrients unknown rather than failing: a day
    // logged last week must still open. What it must never do is keep calling
    // them "inherited", which would credit a food we can no longer read.
    let (base, base_description) = match food.overrides_fdc_id {
        Some(fdc_id) => match base_description(refconn, fdc_id) {
            Some(desc) => (Some(db::nutrients_of(refconn, fdc_id)?), Some(desc)),
            None => {
                eprintln!(
                    "custom food {} overrides fdc_id {fdc_id}, which is not in this \
                     reference database; its borrowed values now read as unknown",
                    food.id
                );
                (None, None)
            }
        },
        None => (None, None),
    };

    let mut rows: Vec<CustomNutrientRow> = Vec::new();
    let (mut n_label, mut n_base, mut n_unknown) = (0usize, 0usize, 0usize);

    for meta in db::displayed_nutrients(refconn)? {
        // `Absent` from the base means the reference food has no measurement
        // either. Inheriting it inherits the gap, so it is reported as unknown
        // rather than as something the base food told us.
        let (value, provenance) = match from_label.get(&meta.id) {
            Some(v) => (v.clone(), "label"),
            None => match base.as_ref().and_then(|m| m.get(&meta.id)) {
                Some(v) if !matches!(v, NutrientValue::Absent) => (v.clone(), "inherited"),
                _ => (NutrientValue::Absent, "unknown"),
            },
        };
        match provenance {
            "label" => n_label += 1,
            "inherited" => n_base += 1,
            _ => n_unknown += 1,
        }
        rows.push(CustomNutrientRow {
            id: meta.id,
            name: meta.short_name,
            magnitude: meta.magnitude,
            basis: meta.basis,
            tier: meta.tier,
            group: meta.display_group,
            value,
            provenance: provenance.to_string(),
        });
    }

    Ok(ResolvedPanel {
        rows,
        base_description,
        from_label: n_label,
        from_base: n_base,
        unknown: n_unknown,
    })
}

/// A supplement's panel, resolved once.
struct ResolvedSupplement {
    rows: Vec<SupplementPanelRow>,
    from_label: usize,
    unconverted: usize,
    omitted: usize,
    omitted_bounded: usize,
}

impl ResolvedSupplement {
    /// The panel as a lookup, for summing a day. Values are per LABEL SERVING.
    fn values(&self) -> HashMap<i64, NutrientValue> {
        self.rows.iter().map(|r| (r.id, r.value.clone())).collect()
    }
}

/// How much of a panel this app could actually read, as one sentence.
///
/// The two ways an omission becomes a bound are worded differently on purpose.
/// A US panel's mandatory fifteen are bounded by the regulation, which is a
/// fact about the pack; everything else is bounded only because the user said
/// the panel lists the lot, which is their judgement. Describing the second as
/// the first would put words in the regulation's mouth and hide whose claim the
/// day's numbers are resting on.
fn supplement_provenance_line(p: &ResolvedSupplement, complete: bool) -> String {
    let mut parts = vec![format!("{} off the panel", p.from_label)];
    if p.unconverted > 0 {
        parts.push(format!("{} this app could not convert", p.unconverted));
    }
    if p.omitted_bounded > 0 {
        parts.push(if complete {
            format!("{} counted as none because you said the panel is complete", p.omitted_bounded)
        } else {
            format!("{} bounded by what the panel must declare", p.omitted_bounded)
        });
    }
    let unbounded = p.omitted - p.omitted_bounded;
    if unbounded > 0 {
        parts.push(format!("{unbounded} the panel does not mention"));
    }
    parts.join(", ")
}

/// Turn one stored panel line into a value on this app's basis, per serving.
///
/// The stored row already holds the converted figure — the conversion happens
/// once, when the supplement is saved, so that a factor table changing in a
/// later build cannot silently restate a transcription the user already checked
/// against the pack. This only maps the stored kind onto the value type.
fn supplement_line(n: &store::SupplementNutrient) -> NutrientValue {
    match n.kind.as_str() {
        // The pack printed a figure this app could not put on its own basis —
        // an IU with no compound named. Unknown and unbounded, which is the
        // truth: we know the pack says something and not what it means here.
        "not_converted" => NutrientValue::Absent,
        kind => NutrientValue::from_db(kind, n.amount, n.upper),
    }
}

/// Resolve a supplement onto the full nutrient panel, once.
///
/// **This is the only place that resolution happens**, so the panel a person
/// reads before saving and the totals their day is built from cannot drift into
/// disagreeing about the same bottle.
///
/// What a panel's SILENCE is worth is the whole difficulty, and it is decided
/// by `trackit_core::supplement::omission` rather than here: a US panel must
/// not declare one of fifteen mandatory nutrients below the declarable-zero
/// threshold, so omitting one bounds it; every other nutrient is voluntary and
/// its omission bounds nothing; and only the user's own assertion that the
/// panel lists everything can make an omission a true zero.
fn resolve_supplement_panel(
    refconn: &rusqlite::Connection,
    sup: &store::Supplement,
) -> Result<ResolvedSupplement, String> {
    let regime = match sup.regime.as_str() {
        "us" => supplement::Regime::Us,
        _ => supplement::Regime::Other,
    };

    let printed: HashMap<i64, &store::SupplementNutrient> = sup
        .nutrients
        .iter()
        .map(|n| (n.nutrient_id, n))
        .collect();

    let mut rows: Vec<SupplementPanelRow> = Vec::new();
    let (mut from_label, mut unconverted, mut omitted, mut omitted_bounded) = (0, 0, 0, 0);

    for meta in db::displayed_nutrients(refconn)? {
        let (value, provenance, label_text, convert_note) = match printed.get(&meta.id) {
            Some(n) => {
                let v = supplement_line(n);
                if n.kind == "not_converted" {
                    unconverted += 1;
                } else {
                    from_label += 1;
                }
                let form = if n.label_form == "unspecified" {
                    String::new()
                } else {
                    format!(" ({})", n.label_form.replace('_', " "))
                };
                (
                    v,
                    "label",
                    Some(format!("{} {}{}", n.label_amount, n.label_unit, form)),
                    n.convert_note.clone(),
                )
            }
            None => {
                let v = supplement::omission(meta.id, regime, sup.panel_complete);
                omitted += 1;
                if v.is_covered() {
                    omitted_bounded += 1;
                }
                (v, "omitted", None, None)
            }
        };
        rows.push(SupplementPanelRow {
            id: meta.id,
            name: meta.short_name,
            magnitude: meta.magnitude,
            group: meta.display_group,
            tier: meta.tier,
            value,
            provenance: provenance.to_string(),
            label_text,
            convert_note,
        });
    }

    Ok(ResolvedSupplement {
        rows,
        from_label,
        unconverted,
        omitted,
        omitted_bounded,
    })
}

/// The full panel for one supplement, every value labelled with where it came
/// from and what the pack's silence about it is worth.
#[tauri::command]
fn get_supplement_detail(
    id: String,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<SupplementDetail, String> {
    let sup = {
        let uc = user.0.lock().map_err(|e| e.to_string())?;
        store::get_supplement(&uc, &id)?
    };
    let conn = refdb.0.lock().map_err(|e| e.to_string())?;
    let panel = resolve_supplement_panel(&conn, &sup)?;
    Ok(SupplementDetail {
        supplement: sup,
        nutrients: panel.rows,
        from_label: panel.from_label,
        unconverted: panel.unconverted,
        omitted: panel.omitted,
        omitted_bounded: panel.omitted_bounded,
    })
}

/// Every nutrient this app displays, in display order.
///
/// The supplement editor needs it because a Supplement Facts panel is not the
/// fixed fifteen lines of a Nutrition Facts panel — it declares whatever the
/// product contains, so the transcriber picks lines rather than filling in a
/// form the app decided on.
#[tauri::command]
fn list_nutrients(refdb: State<'_, db::Db>) -> Result<Vec<db::NutrientMeta>, String> {
    let conn = refdb.0.lock().map_err(|e| e.to_string())?;
    db::displayed_nutrients(&conn)
}

/// Put one printed panel figure onto this app's basis.
///
/// Exposed to the transcription screen so it can show, live, what a line will
/// count as — including a refusal, which is the whole point: 400 IU of vitamin
/// E means 268 mg if it is natural and 180 mg if it is synthetic, and the
/// screen has to say so rather than pick one.
#[tauri::command]
fn convert_label_figure(
    nutrient_id: i64,
    amount: f64,
    unit: String,
    form: String,
    refdb: State<'_, db::Db>,
) -> Result<store::SupplementNutrient, String> {
    let conn = refdb.0.lock().map_err(|e| e.to_string())?;
    let meta = db::displayed_nutrients(&conn)?
        .into_iter()
        .find(|m| m.id == nutrient_id)
        .ok_or_else(|| format!("nutrient {nutrient_id} is not one this app displays"))?;

    let label_unit = supplement::LabelUnit::parse(&unit)
        .ok_or_else(|| format!("{unit} is not a unit a panel prints"))?;
    let label_form = supplement::Form::parse(&form)
        .ok_or_else(|| format!("{form} is not a chemical form this app knows"))?;

    let mut row = store::SupplementNutrient {
        nutrient_id,
        position: 0,
        label_amount: amount,
        label_unit: label_unit.as_str().to_string(),
        label_form: label_form.as_str().to_string(),
        kind: String::new(),
        amount: None,
        upper: None,
        convert_note: None,
    };
    match supplement::convert(nutrient_id, &meta.magnitude, amount, label_unit, label_form) {
        // A printed zero is a rounding threshold, not a measurement of absence.
        // 21 CFR 101.36 permits declaring zero below the 101.9(c) figures, so
        // the pack is asserting "less than that" — an interval, and the same
        // treatment a custom food's declared zero already gets through
        // `label::to_value`. Storing it as `Measured { amount: 0.0 }` would let
        // a pack earn a certainty only a laboratory can.
        Ok(converted) if converted == 0.0 => match trackit_core::label::rounding_ceiling(nutrient_id) {
            Some(upper) => {
                row.kind = "label_zero".into();
                row.upper = Some(upper);
            }
            // No fixed ceiling and no Daily Value, so the regulation gives
            // nothing to bound this zero with. Refusing keeps it out of the
            // day's upper bound rather than inventing a limit.
            None => {
                row.kind = "not_converted".into();
                row.convert_note = Some(
                    "The pack prints zero for this, but there is no Daily Value or fixed                      threshold to say how far below zero-declarable it is — so this app                      cannot bound it."
                        .into(),
                );
            }
        },
        Ok(converted) => {
            row.kind = "measured".into();
            row.amount = Some(converted);
        }
        Err(why) => {
            row.kind = "not_converted".into();
            row.convert_note = Some(why);
        }
    }
    Ok(row)
}

/// The full panel for one of the user's own foods, every value labelled with
/// where it came from.
#[tauri::command]
fn get_custom_food_detail(
    id: String,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<CustomFoodDetail, String> {
    let food = {
        let uc = user.0.lock().map_err(|e| e.to_string())?;
        store::get_custom_food(&uc, &id)?
    };
    let conn = refdb.0.lock().map_err(|e| e.to_string())?;
    let panel = resolve_panel(&conn, &food)?;
    Ok(CustomFoodDetail {
        food,
        nutrients: panel.rows,
        base_description: panel.base_description,
        from_label: panel.from_label,
        from_base: panel.from_base,
        unknown: panel.unknown,
    })
}

// ---------------------------------------------------------------------------
// Photos of the pack
// ---------------------------------------------------------------------------

/// Decoded ceiling for one photo. A re-encoded label panel is 200-400 KB; this
/// leaves room for an unshrunk phone photo and stops well short of anything that
/// would be a memory problem on a phone.
const MAX_PHOTO_BYTES: usize = 6 * 1024 * 1024;

/// The image types this app stores, each recognised by its own magic bytes.
///
/// The extension is derived from the sniff and NEVER from anything the caller
/// said. A filename or a MIME type sent from the frontend is a claim about
/// content, not evidence of it, and this is the one place in the app where
/// untrusted bytes are given a name on the filesystem.
fn sniff_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// Whether `name` is one of the names this app writes: a bare id and one of its
/// own extensions, with no path in it at all.
///
/// Rejecting rather than sanitising is deliberate. A separator, a `..`, a drive
/// letter or an absolute path here would let a caller read any file the user can
/// read, and there is no repair for such a name that is safer than refusing it.
fn is_photo_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if !matches!(ext, "jpg" | "png" | "webp") {
        return false;
    }
    // The ids this app writes: 32 lowercase hex digits, dashed as a UUID or not.
    // Anything else — a separator, a dot, a `..`, an absolute path — fails the
    // character test, so there is nothing left to sanitise.
    stem.chars().filter(|c| *c != '-').count() == 32
        && stem
            .chars()
            .all(|c| c == '-' || c.is_ascii_digit() || matches!(c, 'a'..='f'))
}

/// Turn base64 from the webview into image bytes, or say why they are not
/// acceptable. Returns the extension the sniff decided on.
///
/// The single gate every inbound image passes: the one that gets stored and the
/// one that is only looked at. Two gates would be two things to keep in step,
/// and the weaker one would become the way in.
fn decode_photo(data_base64: &str) -> Result<(Vec<u8>, &'static str), String> {
    // Checked against the encoded length first, so an oversized photo is refused
    // before anything allocates room for it. Four base64 characters carry three
    // bytes, and the whitespace a caller might have wrapped it in is slack.
    if data_base64.len() / 4 * 3 > MAX_PHOTO_BYTES {
        return Err("that photo is larger than 6 MB. Take it again at a smaller size.".into());
    }
    let bytes = b64_decode(data_base64)?;
    if bytes.len() > MAX_PHOTO_BYTES {
        return Err("that photo is larger than 6 MB. Take it again at a smaller size.".into());
    }
    let ext = sniff_extension(&bytes)
        .ok_or("that file is not a JPEG, PNG or WebP image, so it was not saved")?;
    Ok((bytes, ext))
}

fn photo_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // `data_root` and not `app_data_dir`, so a debug run under
    // `TRACKIT_DATA_DIR` moves the pictures with the database. Two databases
    // against one photos directory would let one instance read the other's
    // photographs, which is exactly the thing the photo columns are excluded
    // from the feed to prevent.
    let dir = data_root(app)
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("photos");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Store one photo of a pack and return the base filename to keep on the food.
///
/// Takes bare base64 — no `data:` prefix — because the prefix is a claim about
/// the type that this command deliberately ignores in favour of the bytes.
#[tauri::command]
fn save_food_photo(
    data_base64: String,
    app: AppHandle,
    user: State<'_, store::Store>,
) -> Result<String, String> {
    let (bytes, ext) = decode_photo(&data_base64)?;

    // The same source of ids as every row in the user database: SQLite's own
    // randomblob, so a photo name cannot collide with one already on disk.
    let id: String = {
        let uc = user.0.lock().map_err(|e| e.to_string())?;
        uc.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))
            .map_err(|e| e.to_string())?
    };
    let name = format!("{id}.{ext}");
    let path = photo_dir(&app)?.join(&name);
    std::fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(name)
}

/// Read one stored photo's bytes, by the base filename it was saved under.
///
/// The one place a photo name becomes a path. Everything that opens a stored
/// photo — showing it, and reading a panel out of it — comes through here, so
/// there is a single name check to keep strict rather than two to keep in step.
fn photo_bytes(name: &str, app: &AppHandle) -> Result<Vec<u8>, String> {
    if !is_photo_name(name) {
        return Err(format!("{name} is not the name of a photo this app saved"));
    }
    let path = photo_dir(app)?.join(name);
    std::fs::read(&path).map_err(|e| format!("read {name}: {e}"))
}

/// Read one stored photo back as base64, by the base filename it was saved
/// under.
#[tauri::command]
fn read_food_photo(name: String, app: AppHandle) -> Result<String, String> {
    Ok(b64_encode(&photo_bytes(&name, &app)?))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 (RFC 4648, padded).
fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Decode standard base64, strictly.
///
/// Anything outside the alphabet is an error rather than something to skip over:
/// a photo that arrived corrupted must fail here, not become a shorter file that
/// opens as garbage. Written out rather than taken as a dependency because it is
/// thirty lines and this is the only place the app needs it.
fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    const BAD: &str = "that photo did not arrive as valid base64";
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return Err(BAD.into());
    }
    let sextet = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };

    let chunks = bytes.len() / 4;
    let mut out = Vec::with_capacity(chunks * 3);
    for (i, chunk) in bytes.chunks(4).enumerate() {
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        // Padding ends the data. In any other chunk it is a malformed stream,
        // and accepting it would silently drop everything after it.
        if pad > 0 && i + 1 != chunks {
            return Err(BAD.into());
        }
        if pad > 2 {
            return Err(BAD.into());
        }
        let mut acc = 0u32;
        for &c in &chunk[..4 - pad] {
            acc = (acc << 6) | sextet(c).ok_or(BAD)?;
        }
        acc <<= 6 * pad;
        out.push((acc >> 16) as u8);
        if pad < 2 {
            out.push((acc >> 8) as u8);
        }
        if pad < 1 {
            out.push(acc as u8);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Reading the panel off a photo
// ---------------------------------------------------------------------------

/// One value read off a pack, in the shape a saved nutrient already has, so the
/// editor can accept a suggestion without translating it.
///
/// It is deliberately NOT a `store::CustomNutrient`: the type on the way in
/// says "the user typed this", and nothing the camera produced has earned that
/// yet. It becomes one only where the user accepts it.
#[derive(Debug, Serialize, Clone)]
pub struct ScanReading {
    pub nutrient_id: i64,
    /// measured | label_zero | below_loq — the same vocabulary the store uses.
    pub kind: String,
    pub amount: Option<f64>,
    pub upper: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct Scan {
    pub serving_g: Option<f64>,
    pub serving_label: Option<String>,
    /// What the panel yielded. Suggestions, every one of them.
    pub readings: Vec<ScanReading>,
    /// Label nutrients this photo produced nothing for, so the editor can name
    /// what it missed rather than let a silence read as "the pack says none".
    pub missing: Vec<i64>,
    /// Lines of text the recogniser found, whether or not they were understood.
    pub lines: usize,
    pub unmatched_rows: usize,
    /// Set when the photo did not yield a panel, with a sentence saying what to
    /// do about it. `None` when values came back.
    pub trouble: Option<String>,
}

/// What a live preview frame looks like to the recogniser.
#[derive(Debug, Serialize)]
pub struct Probe {
    pub lines: usize,
    /// Of those, the ones that look like panel content rather than whatever
    /// else is on the table.
    pub panel_lines: usize,
    /// Whether a capture now would probably be worth taking.
    pub ok: bool,
}

/// Panel lines needed before a frame is called worth capturing.
///
/// One match is noise — "iron" is stamped on a pan and "protein" is printed on
/// the front of the pack. Three lines of it is a panel in frame.
const PANEL_LINES_OK: usize = 3;

/// Words that only appear on a Nutrition Facts panel, or near enough.
///
/// This is a classifier for the live indicator, not a parser: it answers "is
/// the camera pointed at a panel", never "what does it say". The amounts come
/// from `panel::parse` and from nowhere else, so a loose match here can cost a
/// wasted probe and can never produce a value.
const PANEL_WORDS: &[&str] = &[
    "nutrition facts",
    "serving size",
    "servings per container",
    "amount per serving",
    "daily value",
    "calories",
    // Each nutrient is listed by its shortest distinctive word, because the
    // match is on whole words: "fat" already finds "Total Fat" and "Sat. Fat"
    // without finding "fatty acids". The abbreviations packs actually print are
    // listed beside their full forms, since neither contains the other.
    "fat",
    "saturates",
    "trans",
    "cholesterol",
    "cholest",
    "sodium",
    "carbohydrate",
    "carb",
    "fiber",
    "fibre",
    "sugars",
    "protein",
    "vitamin d",
    "vit d",
    "calcium",
    "iron",
    "potassium",
    "potas",
];

/// Lowercase, drop punctuation, collapse runs of space, and pad with one space
/// at each end so a marker can be matched on word boundaries — "fat" must find
/// "Total Fat 5g" and not "fatty acids" in an ingredient list.
fn normalise_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push(' ');
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    if !out.ends_with(' ') {
        out.push(' ');
    }
    out
}

fn looks_like_panel_line(text: &str) -> bool {
    let n = normalise_line(text);
    let b = n.as_bytes();
    PANEL_WORDS.iter().any(|w| {
        n.match_indices(w)
            .any(|(i, _)| i > 0 && b[i - 1] == b' ' && b.get(i + w.len()) == Some(&b' '))
    })
}

/// Put one parsed entry into the shape the editor suggests from.
///
/// A declared zero carries the bound the regulation gives it, the same bound
/// `label::to_value` would apply, because the store will not accept a zero
/// without one — and because a pack printing 0 g of fat has said "under half a
/// gram", not "none".
fn scan_reading(reading: &panel::Reading) -> Option<ScanReading> {
    let (kind, amount, upper) = match reading.entry {
        LabelEntry::Printed { amount } => ("measured", Some(amount), None),
        LabelEntry::LessThan { upper } => ("below_loq", None, Some(upper)),
        // No fixed ceiling and no Daily Value leaves nothing to bound the zero
        // with, so there is no row to offer. Returning it unbounded would only
        // fail on save; leaving it out puts the nutrient among the ones the
        // user still has to look at, which is what is actually true.
        LabelEntry::DeclaredZero => (
            "label_zero",
            None,
            Some(label::rounding_ceiling(reading.nutrient_id)?),
        ),
    };
    Some(ScanReading {
        nutrient_id: reading.nutrient_id,
        kind: kind.into(),
        amount,
        upper,
    })
}

/// The sentence for a photo the recogniser saw no text in at all, whatever was
/// being read off it.
///
/// One failure with one remedy — the photo, not the parse — so it is written
/// once and every scan borrows it, naming what should have filled the frame.
fn no_text_trouble(subject: &str) -> String {
    format!(
        "No text was found in this photo at all. It is likely too far away, too dark or too \
         blurry — fill the frame with {subject} and hold the camera steady."
    )
}

/// The sentence for a scan that produced nothing.
///
/// Three different failures, three different things for the user to do. Saying
/// "0 nutrients" for all of them is what made this feature feel broken: it
/// describes the result and not the cause, so there is nothing to try next.
fn trouble_for(readings: usize, lines: usize, panel_lines: usize) -> Option<String> {
    if readings > 0 {
        return None;
    }
    if lines == 0 {
        return Some(no_text_trouble("the panel"));
    }
    if panel_lines == 0 {
        return Some(
            "No nutrition panel was found in this photo. There is text on it, but none of it \
             belongs to a Nutrition Facts panel — that panel is usually on the back or the \
             side of the pack."
                .into(),
        );
    }
    Some(
        "The panel was legible, but none of its lines could be read as a value. Retake it \
         square-on with the whole panel in the frame and no glare across the numbers, or type \
         the values in below."
            .into(),
    )
}

/// Vision's lines in the shape the parsers read them in.
///
/// The whole of the translation between the recogniser and the core crate,
/// which knows nothing about Vision and must not learn: every parser here —
/// nutrition panel, ingredients, supplement panel — is fed through this one
/// function so a change in what a line carries lands in a single place.
fn blocks_from(lines: &[crate::vision::Line]) -> Vec<panel::TextBlock> {
    lines
        .iter()
        .map(|l| panel::TextBlock {
            text: l.text.clone(),
            x: l.x,
            y: l.y,
            w: l.w,
            h: l.h,
        })
        .collect()
}

/// Read the nutrition panel in a stored pack photo.
///
/// The accurate pass, and the slow one — it runs once, after the photo is
/// already saved, so a failure here costs the user nothing they had.
///
/// Everything this returns is a SUGGESTION. A misread "1.5" as "15" would
/// poison every day it was logged in, so nothing here is written anywhere: the
/// editor shows these against the photo and the user confirms them one by one.
/// `async` is load-bearing, not decoration: without it tauri runs the body
/// inline on the thread that delivered the IPC message, which on macOS is the
/// WKWebView's main thread. An accurate Vision pass over a 1600px photo takes
/// seconds, and the editor spends them telling the user to carry on typing —
/// which a blocked main thread makes impossible, since that is the thread the
/// window's key events are dispatched on.
#[tauri::command(async)]
fn scan_label_photo(name: String, app: AppHandle) -> Result<Scan, String> {
    let bytes = photo_bytes(&name, &app)?;
    let lines = crate::vision::recognize(&app, &bytes, false)?;
    let panel_lines = lines
        .iter()
        .filter(|l| looks_like_panel_line(&l.text))
        .count();

    let parsed = panel::parse(&blocks_from(&lines));

    let readings: Vec<ScanReading> = parsed.readings.iter().filter_map(scan_reading).collect();

    // A reading that could not be given the shape a saved row needs is, to the
    // user, a value this photo did not produce. It belongs with the rest of
    // what they still have to fill in, not silently nowhere.
    let mut missing = parsed.missing.clone();
    for r in &parsed.readings {
        if !readings.iter().any(|s| s.nutrient_id == r.nutrient_id)
            && !missing.contains(&r.nutrient_id)
        {
            missing.push(r.nutrient_id);
        }
    }
    missing.sort_unstable();

    Ok(Scan {
        serving_g: parsed.serving_g,
        serving_label: parsed.serving_label,
        trouble: trouble_for(readings.len(), lines.len(), panel_lines),
        readings,
        missing,
        lines: lines.len(),
        unmatched_rows: parsed.unmatched_rows,
    })
}

/// Count what the recogniser can see in one live preview frame.
///
/// The fast pass, behind the camera's distance indicator. It deliberately
/// parses nothing: a preview frame is a moving target and any value read out of
/// one would be a value nobody chose to take a photo of.
/// Off the main thread for the same reason as `scan_label_photo`, and with more
/// of a claim on it: this one fires every 1.2 seconds while the camera sheet is
/// open, so each pass would hitch the very preview it is measuring.
#[tauri::command(async)]
fn probe_frame(data_base64: String, app: AppHandle) -> Result<Probe, String> {
    let (bytes, _ext) = decode_photo(&data_base64)?;
    let lines = crate::vision::recognize(&app, &bytes, true)?;
    let panel_lines = lines
        .iter()
        .filter(|l| looks_like_panel_line(&l.text))
        .count();
    Ok(Probe {
        lines: lines.len(),
        panel_lines,
        ok: panel_lines >= PANEL_LINES_OK,
    })
}

// ---------------------------------------------------------------------------
// Reading the rest of the pack: ingredients, barcode, supplement panel
// ---------------------------------------------------------------------------

/// The ingredient list one photo produced.
///
/// `text` is the pack's own wording, verbatim and untidied, because it is shown
/// back as a quotation of the pack. It is a SUGGESTION beside the field and is
/// never written into it: a recogniser that dropped "milk" out of an allergen
/// line would have told a lie in the manufacturer's voice.
#[derive(Debug, Serialize)]
pub struct IngredientsScan {
    /// The list as printed, wrapped lines rejoined. Empty when none was found —
    /// never a placeholder, and never the word "none".
    pub text: String,
    /// A "CONTAINS: WHEAT, MILK" statement, kept apart from the list because it
    /// is a different assertion: what the pack warns about rather than what it
    /// declares it is made of.
    pub contains: Option<String>,
    /// Lines of text the recogniser found, whether or not any were understood.
    pub lines: usize,
    /// Set when the photo yielded no list, with a sentence saying what to do.
    pub trouble: Option<String>,
}

/// What one frame of a barcode came to.
///
/// Both `payload` and `trusted` are reported, and the second is not a detail of
/// the first: a code whose check digit does not compute has still been read,
/// and showing the user the digits it read is how they see WHY it is being
/// refused. The editor offers it for acceptance only when `trusted`.
#[derive(Debug, Serialize)]
pub struct BarcodeScan {
    /// The digits as decoded — present even when they did not verify, so the
    /// user can compare them against the pack rather than be told only that
    /// something failed.
    pub payload: Option<String>,
    /// The symbology in the spelling a person reads: "EAN-13", "Code 128" —
    /// `barcode::display_name`'s wording, not the recogniser's constant. It is
    /// for showing, never for deciding: what a screen needs to know about the
    /// arithmetic is `check_digit_verified`.
    pub symbology: Option<String>,
    /// True only when nothing contradicts the reading: a GS1 check digit that
    /// computes, or a symbology that carries no check digit to test at all.
    pub trusted: bool,
    /// True only when a check digit was actually computed and matched.
    ///
    /// Carried across explicitly rather than left for the frontend to infer
    /// from `symbology`: the arithmetic happens here, and a screen that
    /// re-derived it from a display string would sooner or later word an
    /// assurance nobody gave. Code 128 and QR are `trusted` and NOT verified —
    /// they carry no check digit, so nothing about them could be tested.
    pub check_digit_verified: bool,
    pub trouble: Option<String>,
}

/// One line of a Supplement Facts panel as the camera read it.
///
/// The three label fields are carried across exactly as printed. They are what
/// makes the stored figure auditable against the bottle later, and they are the
/// same three the supplement editor already keeps verbatim beside the converted
/// value — so a suggestion accepted here loses nothing on the way in.
#[derive(Debug, Serialize, Clone)]
pub struct SupplementScanReading {
    pub nutrient_id: i64,
    pub label_amount: f64,
    pub label_unit: String,
    pub label_form: String,
}

/// A Supplement Facts panel as one photo read it.
///
/// Deliberately carries no `regime` and no `panel_complete`. Nothing on a
/// bottle says which market printed the panel, and no photograph can assert
/// that the panel lists everything in the product — both are the user's own
/// claim, and the day's arithmetic leans on them. A scan that quietly set
/// either would turn that claim into a machine guess.
#[derive(Debug, Serialize)]
pub struct SupplementScan {
    pub serving_units: Option<f64>,
    pub serving_label: Option<String>,
    pub unit_noun: Option<String>,
    /// What the panel yielded. Suggestions, every one of them.
    pub readings: Vec<SupplementScanReading>,
    /// Rows that grouped as panel lines but named no nutrient this app knows,
    /// so the editor can say how much of the panel went unread.
    pub unmatched_rows: usize,
    pub lines: usize,
    pub trouble: Option<String>,
}

/// The sentence for a scan of a stored photo that produced nothing.
///
/// Three states with three different remedies: no text on the photo at all, the
/// wrong part of the pack, or the right part read badly. The parser knows the
/// last of those best, so its own sentence is preferred where it wrote one;
/// this only supplies what the parser cannot see, which is the photograph.
fn scan_trouble(
    produced: bool,
    lines: usize,
    subject: &str,
    from_parser: Option<String>,
) -> Option<String> {
    if produced {
        return None;
    }
    if lines == 0 {
        return Some(no_text_trouble(subject));
    }
    Some(from_parser.unwrap_or_else(|| {
        format!(
            "There is text in this photo, but none of it reads as {subject}. It is usually on \
             the back or the side of the pack."
        )
    }))
}

/// Where one decoded code ranks against the others in the same frame.
///
/// A pack often carries more than one: a product code and a QR to a website.
/// Higher is better — a code whose check digit computed beats one where nothing
/// could be tested, either beats a misread, and a numeric code beats a QR that
/// happens to read more confidently, because the numeric one is what the
/// barcode field is for. Vision reports confidence 1.0 for symbologies where
/// confidence means nothing, so an all-digit Code 128 lot number would
/// otherwise outrank the product's own EAN-13. This is an ordering preference
/// and NOT a check: whether a code can be believed is `barcode::check`'s answer
/// alone, carried here in `trusted` and `verified`.
fn barcode_rank(checked: &barcode::Checked, confidence: f32) -> (u8, u8, u8, f32) {
    let numeric = checked.payload.bytes().all(|b| b.is_ascii_digit());
    (
        checked.verified as u8,
        checked.trusted as u8,
        numeric as u8,
        confidence,
    )
}

/// The one code out of a frame worth showing the user, already checked.
///
/// Returns `None` when the frame decoded nothing usable. A blank payload is not
/// a candidate: Vision reports an observation it could not turn into a string,
/// and offering "" as a barcode would be offering a failure as a result.
fn best_barcode(found: &[crate::vision::Barcode]) -> Option<barcode::Checked> {
    found
        .iter()
        .filter(|b| !b.payload.trim().is_empty())
        .map(|b| (barcode::check(&b.payload, &b.symbology), b.confidence))
        .max_by(|(a, ac), (b, bc)| {
            barcode_rank(a, *ac)
                .partial_cmp(&barcode_rank(b, *bc))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(checked, _)| checked)
}

/// Read the ingredient list off a stored pack photo.
///
/// The list comes back as text to put BESIDE the field, never into it. The user
/// reads it against the photo and accepts it, exactly as they do a panel value:
/// an ingredient list is the one field in this app a person may later search
/// for an allergen in, so a word the camera invented would be worse than a
/// field left empty.
///
/// `async` for the reason `scan_label_photo` is: the accurate Vision pass takes
/// seconds, and on macOS the IPC message arrives on the thread the window's key
/// events are dispatched on.
#[tauri::command(async)]
fn scan_ingredients_photo(name: String, app: AppHandle) -> Result<IngredientsScan, String> {
    let bytes = photo_bytes(&name, &app)?;
    let lines = crate::vision::recognize(&app, &bytes, false)?;
    let parsed = ingredients::parse(&blocks_from(&lines));

    // Trouble is measured against the LIST, not against the whole scan. A frame
    // cropped to the bottom of a pack can catch the allergen statement without
    // the list above it; that statement is still offered, and the user is still
    // told the list itself did not come back rather than left to notice.
    let found_list = !parsed.text.trim().is_empty();

    Ok(IngredientsScan {
        trouble: scan_trouble(
            found_list,
            lines.len(),
            "the ingredient list",
            parsed.trouble,
        ),
        text: parsed.text,
        contains: parsed.contains,
        lines: lines.len(),
    })
}

/// Read the Supplement Facts panel off a stored bottle photo.
///
/// Everything it returns is a suggestion, including the serving size: a panel
/// that reads "Serving Size 2 tablets" is offered, not applied, because that
/// figure divides every amount below it and a misread 2 for a 3 would scale the
/// whole bottle wrongly for as long as it is logged.
#[tauri::command(async)]
fn scan_supplement_photo(name: String, app: AppHandle) -> Result<SupplementScan, String> {
    let bytes = photo_bytes(&name, &app)?;
    let lines = crate::vision::recognize(&app, &bytes, false)?;
    let parsed = suppanel::parse(&blocks_from(&lines));

    let readings: Vec<SupplementScanReading> = parsed
        .readings
        .iter()
        .map(|r| SupplementScanReading {
            nutrient_id: r.nutrient_id,
            label_amount: r.label_amount,
            label_unit: r.label_unit.clone(),
            label_form: r.label_form.clone(),
        })
        .collect();

    Ok(SupplementScan {
        trouble: scan_trouble(
            !readings.is_empty(),
            lines.len(),
            "a Supplement Facts panel",
            parsed.trouble,
        ),
        serving_units: parsed.serving_units,
        serving_label: parsed.serving_label,
        unit_noun: parsed.unit_noun,
        readings,
        unmatched_rows: parsed.unmatched_rows,
        lines: lines.len(),
    })
}

/// Read a barcode out of one captured frame.
///
/// Stores nothing. A photograph of a barcode is worth nothing once the digits
/// are read, so this takes the frame directly and lets it go — the photo store
/// is for pictures of the pack a person might want to look at again.
///
/// The frame still passes the same gate a stored photo does: the decoded-size
/// cap and the magic-byte sniff, because the bytes are just as untrusted for
/// being on their way to the recogniser rather than to the disk.
#[tauri::command(async)]
fn scan_barcode(data_base64: String, app: AppHandle) -> Result<BarcodeScan, String> {
    let (bytes, _ext) = decode_photo(&data_base64)?;
    let found = crate::vision::detect_barcodes(&app, &bytes)?;

    let Some(checked) = best_barcode(&found) else {
        return Ok(BarcodeScan {
            payload: None,
            symbology: None,
            trusted: false,
            check_digit_verified: false,
            trouble: Some(
                "No barcode was found in that frame. Hold the camera a hand's width from the \
                 pack, square-on to the stripes, and let it focus before capturing."
                    .into(),
            ),
        });
    };

    // A failed check digit is a misread, not a barcode. It is reported with the
    // digits it read and with `trusted` false, so the editor can show what came
    // back while refusing to offer it as a value — the same refusal the rest of
    // this app makes of any figure nobody has confirmed.
    //
    // `check` names both the failure and the remedy in its own sentence, so it
    // is passed through whole; a second sentence bolted on here would only tell
    // the user to retake the photo twice.
    let trouble = (!checked.trusted).then(|| {
        checked.note.clone().unwrap_or_else(|| {
            "That code did not verify, so it is not offered. Retake it square-on with the whole \
             code in the frame, or type the digits in from the pack."
                .into()
        })
    });

    Ok(BarcodeScan {
        payload: Some(checked.payload),
        symbology: Some(checked.symbology),
        trusted: checked.trusted,
        check_digit_verified: checked.verified,
        trouble,
    })
}

type Dim = Vec<(i64, String, String, String, String, String)>;

/// Every primary nutrient in display order — the dimension both the day and the
/// range roll-ups join outward from, so a nutrient never vanishes just because
/// nothing measured it.
fn nutrient_dim(conn: &rusqlite::Connection) -> Result<Dim, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, short_name, name, magnitude, tier, COALESCE(display_group,'')
             FROM nutrients WHERE role = 'primary' ORDER BY display_order, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut dim: Dim = Vec::new();
    for row in rows {
        dim.push(row.map_err(|e| e.to_string())?);
    }
    Ok(dim)
}

/// Resolve one day's entries into per-nutrient contributions.
///
/// A recipe expands into its ingredients scaled by the fraction eaten, so a
/// dish's gaps propagate: an ingredient with no composition data contributes
/// `Absent` for every nutrient AND still counts its mass against coverage.
///
/// One of the user's own foods is resolved through `resolve_panel`, the same
/// function that builds the panel they read before saving it, so a nutrient the
/// pack does not print contributes exactly what that panel showed — an
/// inherited value as itself, an unknown one as `Absent`, and never a zero.
///
/// A supplement goes through `resolve_supplement_panel` for the same reason and
/// arrives as a `Dose`: its amounts are per label serving and scale by the
/// number taken, so it never enters the mass-weighted coverage denominator. A
/// tablet has a mass, but that mass is not what its nutrients arrived in
/// proportion to.

/// One frozen value, as the correction screen shows it.
#[derive(Serialize)]
pub struct EntryValueView {
    pub nutrient_id: i64,
    pub value: NutrientValue,
}

/// One frozen part of an entry — a whole food, or one ingredient of a dish.
#[derive(Serialize)]
pub struct EntryPartView {
    pub ordinal: i64,
    pub description: String,
    pub fdc_id: Option<i64>,
    /// Exactly one of these is set, the same way the stored row is.
    pub grams: Option<f64>,
    pub servings: Option<f64>,
    pub has_data: bool,
    pub values: Vec<EntryValueView>,
}

/// What a day already recorded for one entry, and where those numbers came
/// from — the read side of correcting a mistake.
#[derive(Serialize)]
pub struct EntrySnapshotView {
    pub entry_id: String,
    pub description: String,
    pub basis: store::SnapBasis,
    pub frozen_at: String,
    pub corrected_at: Option<String>,
    /// The entry's own amount, which is what a correction to "how much" changes.
    pub grams: Option<f64>,
    pub units: Option<f64>,
    pub unit_noun: Option<String>,
    pub recipe_name: Option<String>,
    pub parts: Vec<EntryPartView>,
}

/// The kinds a person may assert when correcting a value.
///
/// `measured_zero` and `assumed_zero` are deliberately absent. Both mean a
/// laboratory looked and reported absence, which is a claim about someone
/// else's work that a user correcting their own log is not in a position to
/// make. Everything a person can honestly say — a number, a label-rounded zero,
/// a "less than", a trace, or "nobody knew" — is here.
const CORRECTABLE_KINDS: [&str; 5] = ["measured", "label_zero", "below_loq", "trace", "unknown"];

#[tauri::command]
fn get_entry_snapshot(
    entry_id: String,
    user: State<'_, store::Store>,
) -> Result<EntrySnapshotView, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    let entry = store::entry_by_id(&conn, &entry_id)?;
    let Some(snap) = store::snapshot_of(&conn, &entry_id)? else {
        return Err(format!(
            "{} has no stored nutrition yet — reopen the day it was logged on and try again",
            entry.description
        ));
    };
    // A supplement's own word for one of itself, so the correction screen can
    // say "2 tablets" rather than "2 units".
    let unit_noun = match entry.supplement_id.as_deref() {
        Some(sid) => store::get_supplement_for_history(&conn, sid)
            .ok()
            .map(|s| s.unit_noun),
        None => None,
    };
    Ok(EntrySnapshotView {
        entry_id: entry.id.clone(),
        description: entry.description.clone(),
        basis: snap.basis,
        frozen_at: snap.frozen_at.clone(),
        corrected_at: snap.corrected_at.clone(),
        grams: entry.grams,
        units: entry.units,
        unit_noun,
        recipe_name: snap.recipe.as_ref().map(|r| r.name.clone()),
        parts: snap
            .components
            .iter()
            .enumerate()
            .map(|(i, c)| EntryPartView {
                ordinal: i as i64,
                description: c.description.clone(),
                fdc_id: c.fdc_id,
                grams: match c.quantity {
                    store::SnapQuantity::Grams(g) => Some(g),
                    store::SnapQuantity::Servings(_) => None,
                },
                servings: match c.quantity {
                    store::SnapQuantity::Servings(u) => Some(u),
                    store::SnapQuantity::Grams(_) => None,
                },
                has_data: c.has_data,
                values: c
                    .values
                    .iter()
                    .map(|(id, v)| EntryValueView {
                        nutrient_id: *id,
                        value: v.clone(),
                    })
                    .collect(),
            })
            .collect(),
    })
}

/// Correct how much was eaten. What it was made of is untouched.
#[tauri::command]
fn correct_entry_amount(
    entry_id: String,
    grams: Option<f64>,
    units: Option<f64>,
    app: AppHandle,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    let quantity = match (grams, units) {
        (Some(g), None) => store::Quantity::Grams(g),
        (None, Some(u)) => store::Quantity::Units(u),
        _ => return Err("a correction sets either a weight or a count, not both".into()),
    };
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;
    after_write(
        &app,
        store::correct_amount(&mut conn, &entry_id, quantity),
    )
}

/// Correct one recorded value on one part of an entry.
#[tauri::command]
fn correct_entry_value(
    entry_id: String,
    ordinal: i64,
    nutrient_id: i64,
    kind: String,
    amount: Option<f64>,
    upper: Option<f64>,
    app: AppHandle,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    if !CORRECTABLE_KINDS.contains(&kind.as_str()) {
        return Err(format!(
            "\"{kind}\" is not something a correction can assert"
        ));
    }
    // Validated here rather than left to `from_db`, which turns anything it does
    // not recognise into `Absent`. A typo silently erasing a value the user
    // meant to set would be the worst outcome available.
    let value = match kind.as_str() {
        "unknown" => None,
        "measured" => {
            let a = amount.ok_or("a measured value needs a number")?;
            if !(a.is_finite() && a >= 0.0) {
                return Err("a measured amount cannot be negative".into());
            }
            Some(NutrientValue::Measured { amount: a })
        }
        other => {
            let u = upper.ok_or("this kind needs the limit it is below")?;
            if !(u.is_finite() && u > 0.0) {
                return Err("that limit must be greater than zero".into());
            }
            match other {
                "label_zero" => Some(NutrientValue::LabelZero { upper: u }),
                "below_loq" => Some(NutrientValue::BelowLoq { upper: u }),
                _ => Some(NutrientValue::Trace { upper: u }),
            }
        }
    };
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;
    after_write(
        &app,
        store::correct_value(&mut conn, &entry_id, ordinal, nutrient_id, value),
    )
}

/// Value an entry again from what is known now.
///
/// For when the food or recipe it came from has since been fixed and the user
/// wants that applied to a day already logged. This is the only thing in the
/// app that reaches back into history with current data, and it happens only
/// when asked — the result is stored as a correction, not as the original.
#[tauri::command]
fn refreeze_entry(
    entry_id: String,
    app: AppHandle,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<(), String> {
    let refconn = refdb.0.lock().map_err(|e| e.to_string())?;
    let mut conn = user.0.lock().map_err(|e| e.to_string())?;
    let entry = store::entry_by_id(&conn, &entry_id)?;
    let snap = resolve_entry(&refconn, &conn, &entry, store::SnapBasis::Corrected)?;
    after_write(&app, store::recorrect_entry(&mut conn, &entry_id, snap))
}

/// Resolve what a log entry contributes, against the data as it stands NOW.
///
/// This is the only place that reads a recipe, a custom food, a supplement or
/// the reference database in order to value an entry, and its result is written
/// once and then never recomputed. Everything downstream — a day, a range, an
/// average — reads the frozen copy instead.
///
/// Splitting it out is what makes the freeze trustworthy: the values stored
/// when an entry is logged are produced by the same code that used to produce
/// them on every read, so freezing changed when the work happens and not what
/// it computes.
fn resolve_contribution(
    refconn: &rusqlite::Connection,
    uconn: &rusqlite::Connection,
    source: store::Source<'_>,
    description: &str,
    quantity: store::Quantity,
) -> Result<(Option<store::SnapRecipe>, Vec<store::SnapComponent>), String> {
    // A weighed entry must have a mass, and a counted one a dose. The caller
    // has already enforced the pairing; this only unpacks it.
    let grams = match quantity {
        store::Quantity::Grams(g) => Some(g),
        store::Quantity::Units(_) => None,
    };

    match source {
        // The user's own foods carry their values with them rather than through
        // an fdc_id, so they never reach the reference lookup below.
        store::Source::Custom(cid) => {
            // Deliberately includes deleted foods: an entry being frozen may
            // reference one the user has since removed.
            let food = store::get_custom_food_for_history(uconn, cid)?;
            let panel = resolve_panel(refconn, &food)?;
            let grams = grams.ok_or("one of your own foods is logged by weight")?;
            let values = panel.values().into_iter().collect::<Vec<_>>();
            Ok((
                None,
                vec![store::SnapComponent {
                    description: format!("{} — {}", food.name, provenance_line(&panel)),
                    // A custom food has no USDA identity, and borrowing the
                    // overridden food's would name the wrong thing here.
                    fdc_id: None,
                    quantity: store::SnapQuantity::Grams(grams),
                    has_data: panel.from_label + panel.from_base > 0,
                    values,
                }],
            ))
        }

        // A supplement is counted, not weighed. Its values are per label serving
        // and are multiplied by the number of servings taken, with no mass
        // anywhere in the arithmetic.
        store::Source::Supplement(sid) => {
            let sup = store::get_supplement_for_history(uconn, sid)?;
            let panel = resolve_supplement_panel(refconn, &sup)?;
            let store::Quantity::Units(units) = quantity else {
                return Err("a supplement is taken by count, not weighed".into());
            };
            // The panel is per SERVING; the entry counts UNITS. One tablet of a
            // two-tablet serving is half a serving. Freezing the RESULT of this
            // division rather than the divisor is deliberate: re-portioning the
            // supplement later must not re-scale a dose already taken.
            let servings = units / sup.serving_units;
            if !(servings.is_finite() && servings > 0.0) {
                return Err(format!(
                    "{} records a serving size that cannot scale a dose",
                    sup.name
                ));
            }
            let values = panel.values().into_iter().collect::<Vec<_>>();
            Ok((
                None,
                vec![store::SnapComponent {
                    description: format!(
                        "{} — {}",
                        sup.name,
                        supplement_provenance_line(&panel, sup.panel_complete)
                    ),
                    fdc_id: None,
                    quantity: store::SnapQuantity::Servings(servings),
                    has_data: panel.from_label > 0,
                    values,
                }],
            ))
        }

        // A recipe expands into its ingredients scaled by the fraction eaten, so
        // a dish's gaps propagate: an ingredient with no composition data
        // contributes nothing AND still counts its mass against coverage.
        //
        // The share of each ingredient is its RAW weight, because nutrient mass
        // is conserved through cooking: 300 g of dry rajma carries the same
        // protein whether it is still dry or has swollen to 900 g in a pot. The
        // yield is where the swelling is accounted for — it is the mass that
        // protein ends up dissolved in, and dividing by it is what turns "a
        // third of the dish" into "a third of its ingredients". See D22.
        store::Source::Recipe(rid) => {
            let recipe = store::get_recipe_for_history(uconn, rid)?;
            let grams = grams.ok_or("a recipe is logged by weight")?;
            if !(recipe.yield_g.is_finite() && recipe.yield_g > 0.0) {
                return Err(format!("recipe {} records no yield to portion", recipe.name));
            }
            let fraction = grams / recipe.yield_g;
            let mut components = Vec::new();
            for ing in &recipe.ingredients {
                let portion = ing.raw_g * fraction;
                // An ingredient scaled to nothing would violate the component
                // table's positivity CHECK. Dropping it loses no nutrition and
                // keeps a zero-gram ingredient from failing the whole entry.
                if !(portion.is_finite() && portion > 0.0) {
                    continue;
                }
                let (description, has_data, values) = ingredient_values(
                    refconn,
                    uconn,
                    ing.fdc_id,
                    ing.custom_food_id.as_deref(),
                    &ing.description,
                )?;
                components.push(store::SnapComponent {
                    description,
                    fdc_id: ing.fdc_id,
                    quantity: store::SnapQuantity::Grams(portion),
                    has_data,
                    values,
                });
            }
            Ok((
                Some(store::SnapRecipe {
                    name: recipe.name.clone(),
                    yield_g: recipe.yield_g,
                    servings: recipe.servings,
                }),
                components,
            ))
        }

        // A pot that was actually made. Structurally the recipe arm above, and
        // deliberately so — what differs is only which numbers it reads.
        //
        // The divisor is `cook.yield_g`, which is what the pot WEIGHED where
        // there is a reading and what the recipe says the dish comes out at,
        // scaled, where there is not (see `Cook::seal`). It is never the summed
        // line weights: those are raw, and a pot of rajma weighs three times its
        // dry beans. That is what makes a reduced pot come out right:
        // water leaves a pot and nutrients do not, so 250 g of a dal that was
        // written to make 300 g is more concentrated, and dividing by the
        // measurement rather than the estimate is what says so.
        //
        // A line dialled to zero contributes nothing AND does not appear in the
        // breakdown, because it was not in the food. That is the opposite
        // treatment from an ingredient with no composition data, which
        // contributes nothing but stays visible and keeps its mass in the day's
        // coverage denominator — the difference between "not in the dish" and
        // "in the dish and unmeasured" is exactly what this app exists to keep.
        store::Source::Cook(cid) => {
            // Deliberately includes deleted pots: a day that ate from a pot
            // since thrown out must still be valuable.
            let cook = store::get_cook_for_history(uconn, cid)?;
            let grams = grams.ok_or("a cooked dish is logged by weight")?;
            if !(cook.yield_g.is_finite() && cook.yield_g > 0.0) {
                return Err(format!(
                    "{} records nothing that came out of the pot, so a portion of it \
                     cannot be valued",
                    cook.name
                ));
            }
            let fraction = grams / cook.yield_g;
            let mut components = Vec::new();
            for ing in &cook.ingredients {
                let portion = ing.raw_g * fraction;
                if !(portion.is_finite() && portion > 0.0) {
                    continue;
                }
                // What was eaten, naming what it stood in for. Both, because
                // the substitute is the food and the original is why the
                // amounts read as they do.
                let named = match &ing.substituted_for {
                    Some(was) => format!("{} (instead of {was})", ing.description),
                    None => ing.description.clone(),
                };
                let (description, has_data, values) = ingredient_values(
                    refconn,
                    uconn,
                    ing.fdc_id,
                    ing.custom_food_id.as_deref(),
                    &named,
                )?;
                components.push(store::SnapComponent {
                    description,
                    fdc_id: ing.fdc_id,
                    quantity: store::SnapQuantity::Grams(portion),
                    has_data,
                    values,
                });
            }
            Ok((
                // The snapshot's recipe slot carries the pot: its name is what
                // labels a past entry, and its yield is the divisor the
                // breakdown was built with. No `servings` — a pot feeds whoever
                // was there, and that was never recorded.
                Some(store::SnapRecipe {
                    name: cook.name.clone(),
                    yield_g: cook.yield_g,
                    servings: None,
                }),
                components,
            ))
        }

        store::Source::Food(fdc_id) => {
            let grams = grams.ok_or("a food is logged by weight")?;
            Ok((
                None,
                vec![store::SnapComponent {
                    description: description.to_string(),
                    fdc_id: Some(fdc_id),
                    quantity: store::SnapQuantity::Grams(grams),
                    has_data: true,
                    values: reference_values(refconn, Some(fdc_id))?,
                }],
            ))
        }

        // Water by definition rather than by measurement: no reference lookup
        // is needed or wanted, because borrowing an arbitrary USDA "Water" food
        // for its trace-mineral values would claim a provenance this bottle
        // does not have. `description` is already the bottle's denormalised
        // name, and `grams` is already the frozen amount consumed.
        //
        // Energy and the three macros are asserted zero, not left `Absent`,
        // because they are the same claim: energy IS protein, fat and carb
        // combined, so leaving those three unknown while calling energy
        // confidently zero would be inconsistent on its own terms, and it
        // would silently understate coverage for them on any day a bottle was
        // logged. Everything else — sodium, calcium, every mineral a water
        // source can genuinely vary in — stays `Absent`: this bottle's true
        // mineral content is not knowable from its weight alone.
        store::Source::Water(_bottle_id) => {
            let grams = grams.ok_or("water is logged by weight")?;
            Ok((
                None,
                vec![store::SnapComponent {
                    description: description.to_string(),
                    fdc_id: None,
                    quantity: store::SnapQuantity::Grams(grams),
                    has_data: true,
                    values: vec![
                        (1051, NutrientValue::Measured { amount: 100.0 }), // Water, 100% by mass
                        (1008, NutrientValue::AssumedZero),                // Energy
                        (1003, NutrientValue::AssumedZero),                // Protein
                        (1004, NutrientValue::AssumedZero),                // Total fat
                        (1005, NutrientValue::AssumedZero),                // Carbohydrate
                    ],
                }],
            ))
        }
    }
}

/// Every nutrient the reference database has for one food, per 100 g.
///
/// A food with no id, or one whose id a later dataset retired, yields nothing —
/// which freezes as "we knew nothing about this", not as a zero.
/// What one line of a dish is worth per 100 g, and what to call it.
///
/// A line is a reference food, one of the user's own, or neither. The third
/// case is not a failure: it contributes nothing AND keeps its mass in the
/// day's coverage denominator, which is the difference between "not in the
/// dish" and "in the dish and unmeasured".
///
/// One of the user's own foods carries its provenance into the description the
/// same way a directly logged one does — "18 of 34 values off the pack, 11
/// borrowed from ..." — because a dish assembled out of packs is mostly gaps,
/// and a breakdown row that did not say so would look as solid as a lab
/// measurement.
fn ingredient_values(
    refconn: &rusqlite::Connection,
    uconn: &rusqlite::Connection,
    fdc_id: Option<i64>,
    custom_food_id: Option<&str>,
    description: &str,
) -> Result<(String, bool, Vec<(i64, NutrientValue)>), String> {
    match custom_food_id {
        Some(cid) => {
            // Deliberately the history read: a dish must still expand after the
            // food one of its lines names has been deleted.
            let food = store::get_custom_food_for_history(uconn, cid)?;
            let panel = resolve_panel(refconn, &food)?;
            Ok((
                format!("{} — {}", description, provenance_line(&panel)),
                panel.from_label + panel.from_base > 0,
                panel.values().into_iter().collect(),
            ))
        }
        None => Ok((
            description.to_string(),
            fdc_id.is_some(),
            reference_values(refconn, fdc_id)?,
        )),
    }
}

fn reference_values(
    refconn: &rusqlite::Connection,
    fdc_id: Option<i64>,
) -> Result<Vec<(i64, NutrientValue)>, String> {
    let Some(fdc_id) = fdc_id else {
        return Ok(Vec::new());
    };
    Ok(db::nutrients_of(refconn, fdc_id)?.into_iter().collect())
}

/// The same, for an entry that already exists — the freeze-on-write path and
/// the backfill path resolving through one function.
fn resolve_entry(
    refconn: &rusqlite::Connection,
    uconn: &rusqlite::Connection,
    entry: &store::LogEntry,
    basis: store::SnapBasis,
) -> Result<store::Snapshot, String> {
    let source = match (
        &entry.source_kind[..],
        entry.fdc_id,
        entry.recipe_id.as_deref(),
        entry.cook_id.as_deref(),
        entry.custom_food_id.as_deref(),
        entry.supplement_id.as_deref(),
        entry.bottle_id.as_deref(),
    ) {
        ("food", Some(id), _, _, _, _, _) => store::Source::Food(id),
        ("recipe", _, Some(id), _, _, _, _) => store::Source::Recipe(id),
        ("cook", _, _, Some(id), _, _, _) => store::Source::Cook(id),
        ("custom", _, _, _, Some(id), _, _) => store::Source::Custom(id),
        ("supplement", _, _, _, _, Some(id), _) => store::Source::Supplement(id),
        ("water", _, _, _, _, _, Some(id)) => store::Source::Water(id),
        _ => {
            return Err(format!(
                "log entry {} says it is a {} but does not name one",
                entry.id, entry.source_kind
            ))
        }
    };
    let quantity = match (entry.grams, entry.units) {
        (Some(g), None) => store::Quantity::Grams(g),
        (None, Some(u)) => store::Quantity::Units(u),
        _ => {
            return Err(format!(
                "log entry {} records neither a weight nor a dose",
                entry.id
            ))
        }
    };
    let (recipe, components) =
        resolve_contribution(refconn, uconn, source, &entry.description, quantity)?;
    Ok(store::Snapshot {
        basis,
        frozen_at: store::now_iso(uconn)?,
        corrected_at: None,
        recipe,
        components,
    })
}

/// Freeze every live entry that has no snapshot yet.
///
/// Entries logged before this feature existed cannot have their original values
/// recovered — nothing recorded them — so they are frozen at what the app can
/// work out today and marked `backfilled` to say exactly that. Running at every
/// startup also repairs an entry that somehow reached the table unfrozen,
/// rather than leaving it to be silently recomputed forever.
fn backfill_snapshots(
    refconn: &rusqlite::Connection,
    uconn: &mut rusqlite::Connection,
) -> Result<usize, String> {
    let pending = store::entries_missing_snapshots(uconn)?;
    if pending.is_empty() {
        return Ok(0);
    }
    let mut frozen = 0usize;
    for id in &pending {
        let entry = match store::entry_by_id(uconn, id) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("could not read log entry {id} to freeze it: {e}");
                continue;
            }
        };
        // One unresolvable entry must not stop the rest from being frozen, and
        // must not stop the app from starting. It stays unfrozen and is retried
        // next launch, which is the same state it is in today.
        match resolve_entry(refconn, uconn, &entry, store::SnapBasis::Backfilled) {
            Ok(snap) => match store::freeze_entry(uconn, id, &snap) {
                Ok(()) => frozen += 1,
                Err(e) => eprintln!("could not freeze log entry {id}: {e}"),
            },
            Err(e) => eprintln!("could not resolve log entry {id} to freeze it: {e}"),
        }
    }
    Ok(frozen)
}

fn collect_day(
    refconn: &rusqlite::Connection,
    user: &store::Store,
    dim: &Dim,
    logged_on: &str,
) -> Result<(Vec<store::LogEntry>, Vec<EntryBreakdown>, HashMap<i64, Vec<Contribution>>), String> {
    let (entries, mut snapshots) = {
        let uc = user.0.lock().map_err(|e| e.to_string())?;
        (
            store::day(&uc, logged_on)?,
            store::day_snapshots(&uc, logged_on)?,
        )
    };

    let mut breakdowns: Vec<EntryBreakdown> = Vec::new();
    let mut by_nutrient: HashMap<i64, Vec<Contribution>> = HashMap::new();

    for entry in &entries {
        // Startup freezes anything unfrozen, so this is normally a no-op. It
        // stays because the alternative on a miss — resolving live, as this
        // function used to do for everything — is what made a past day change
        // when a recipe or the reference data changed. Freezing on sight means
        // an entry can be valued from today's data at most once, ever.
        if !snapshots.contains_key(&entry.id) {
            let snap = {
                let uc = user.0.lock().map_err(|e| e.to_string())?;
                resolve_entry(refconn, &uc, entry, store::SnapBasis::Backfilled)?
            };
            {
                let mut uc = user.0.lock().map_err(|e| e.to_string())?;
                store::freeze_entry(&mut uc, &entry.id, &snap)?;
            }
            snapshots.insert(entry.id.clone(), snap);
        }
        let snap = snapshots
            .get(&entry.id)
            .expect("just inserted when it was missing");

        let mut b = EntryBreakdown {
            entry_id: entry.id.clone(),
            components: Vec::new(),
            recipe_name: snap.recipe.as_ref().map(|r| r.name.clone()),
            recipe_yield_g: snap.recipe.as_ref().map(|r| r.yield_g),
            recipe_servings: snap.recipe.as_ref().and_then(|r| r.servings),
        };

        for c in &snap.components {
            // A plain reference food, or water, is its own breakdown: the
            // entry's own description already names it, and repeating it as a
            // single component would print the same line twice.
            if entry.source_kind != "food" && entry.source_kind != "water" {
                b.components.push(Component {
                    description: c.description.clone(),
                    fdc_id: c.fdc_id,
                    grams: match c.quantity {
                        store::SnapQuantity::Grams(g) => Some(g),
                        store::SnapQuantity::Servings(_) => None,
                    },
                    has_data: c.has_data,
                });
            }

            let values: HashMap<i64, NutrientValue> = c.values.iter().cloned().collect();
            for (id, _, _, _, _, _) in dim {
                // A nutrient with no frozen row is `Absent`: at the moment this
                // was logged, nothing knew a value for it. That is a gap the
                // day reports, never a zero it counts.
                let value = values.get(id).cloned().unwrap_or(NutrientValue::Absent);
                by_nutrient
                    .entry(*id)
                    .or_default()
                    .push(match c.quantity {
                        // Mass enters the coverage denominator; a dose never
                        // does, because a tablet's nutrients did not arrive in
                        // proportion to its weight.
                        store::SnapQuantity::Grams(grams) => Contribution::Food { value, grams },
                        store::SnapQuantity::Servings(units) => Contribution::Dose { value, units },
                    });
            }
        }
        breakdowns.push(b);
    }

    Ok((entries, breakdowns, by_nutrient))
}

/// The whole reference set for one request: who the user is, what each nutrient
/// is being read against, and what a day's energy target is.
///
/// Resolved once and threaded through, so a single day's screen cannot end up
/// comparing one nutrient against an RDA and another against a Daily Value
/// without saying so.
pub struct Goals {
    group: Option<dri::Group>,
    by_nutrient: HashMap<i64, targets::Goal>,
    energy: Option<EnergyTarget>,
    macro_ranges: Vec<MacroRange>,
}

/// What a day's energy is being measured against, and where it came from.
#[derive(Debug, Clone, Serialize)]
pub struct EnergyTarget {
    pub kcal: f64,
    /// "user_set" or "estimated".
    pub basis: String,
    /// For an estimate, its working: resting expenditure and the activity
    /// multiplier applied to it. Shown rather than hidden — an estimate that
    /// cannot be interrogated is just a number someone has to take on faith.
    pub resting: Option<f64>,
    pub factor: Option<f64>,
}

/// A macronutrient's acceptable range, in grams, at the day's energy target.
///
/// A range and not a point. There is no single right amount of fat, and
/// printing the midpoint of 20–35% as "the target" would invent a precision the
/// evidence does not have.
#[derive(Debug, Clone, Serialize)]
pub struct MacroRange {
    pub nutrient_id: i64,
    pub low_g: f64,
    pub high_g: f64,
    pub low_pct: f64,
    pub high_pct: f64,
}

/// Read the profile and the user's own targets, and resolve everything once.
fn resolve_goals(user: &store::Store) -> Result<Goals, String> {
    let (profile, overrides) = {
        let uc = user.0.lock().map_err(|e| e.to_string())?;
        (store::get_profile(&uc)?, store::list_targets(&uc)?)
    };
    Ok(goals_from(&profile, &overrides))
}

/// The pure half of the above, so it can be tested without a database.
fn goals_from(profile: &store::Profile, overrides: &[store::NutrientTarget]) -> Goals {
    let sex = profile.sex.as_deref().and_then(dri::Sex::parse);
    let stage = profile
        .life_stage
        .as_str()
        .pipe_parse()
        .unwrap_or(dri::LifeStage::Standard);
    let age = age_from(profile.birth_year);
    let group = dri::group_for(sex, age, stage);

    let pairs: Vec<(i64, f64)> = overrides.iter().map(|o| (o.nutrient_id, o.amount)).collect();
    let by_nutrient = targets::resolve(group, &pairs)
        .into_iter()
        .map(|g| (g.nutrient_id, g))
        .collect();

    // The user's own figure first; an estimate only when the body is complete
    // enough to make one; otherwise nothing at all. A day with no energy target
    // shows what was eaten and draws no rail — which is what replaced a
    // hard-coded 2,200 kcal that described nobody.
    let activity = profile.activity.as_deref().and_then(dri::Activity::parse);
    let estimate = dri::energy_estimate(sex, age, profile.height_cm, profile.weight_kg, activity);
    let energy = match (profile.energy_kcal, estimate) {
        (Some(kcal), _) => Some(EnergyTarget {
            kcal,
            basis: "user_set".into(),
            resting: None,
            factor: None,
        }),
        (None, Some(e)) => Some(EnergyTarget {
            kcal: e.total,
            basis: "estimated".into(),
            resting: Some(e.resting),
            factor: Some(e.factor),
        }),
        (None, None) => None,
    };

    // A macronutrient range is a share of energy, so it exists only where an
    // energy figure does.
    let macro_ranges = match (&energy, group) {
        (Some(e), Some(g)) => dri::amdrs(g)
            .iter()
            .map(|a| {
                let (low_g, high_g) = dri::amdr_grams(a, e.kcal);
                MacroRange {
                    nutrient_id: a.nutrient_id,
                    low_g,
                    high_g,
                    low_pct: a.low_pct,
                    high_pct: a.high_pct,
                }
            })
            .collect(),
        _ => Vec::new(),
    };

    Goals {
        group,
        by_nutrient,
        energy,
        macro_ranges,
    }
}

/// Age in whole years, from a birth year.
///
/// Accurate to within a year by construction, which is all the DRI bands need —
/// they are years wide. The only cost is the few days either side of a
/// birthday that falls on a band boundary.
fn age_from(birth_year: Option<i64>) -> Option<u32> {
    let year = birth_year?;
    let now: i64 = current_year()?;
    let age = now - year;
    if (0..=130).contains(&age) {
        Some(age as u32)
    } else {
        None
    }
}

/// This year, from the same clock the store stamps rows with, so the app has
/// exactly one idea of what time it is.
fn current_year() -> Option<i64> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    // Civil-from-days, valid for any date this app will see.
    let days = secs / 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    Some(if mp >= 10 { y + 1 } else { y })
}

/// `str::parse` for a life stage, without an orphan trait impl.
trait PipeParse {
    fn pipe_parse(&self) -> Option<dri::LifeStage>;
}
impl PipeParse for str {
    fn pipe_parse(&self) -> Option<dri::LifeStage> {
        dri::LifeStage::parse(self)
    }
}

fn totals_from(
    dim: &Dim,
    by_nutrient: &HashMap<i64, Vec<Contribution>>,
    goals: &Goals,
) -> Vec<NutrientTotal> {
    dim.iter()
        .map(|(id, name, full_name, magnitude, tier, group)| {
            let goal = goals.by_nutrient.get(id);
            NutrientTotal {
                total: sum(by_nutrient.get(id).map(|v| v.as_slice()).unwrap_or(&[])),
                target: goal.map(|g| g.amount),
                target_basis: goal.map(|g| g.basis.as_str().to_string()),
                // A nutrient with no target at all cannot be a limit either:
                // there is nothing to be over.
                is_limit: goal.map(|g| g.is_limit).unwrap_or(false),
                id: *id,
                name: name.clone(),
                full_name: full_name.clone(),
                magnitude: magnitude.clone(),
                tier: tier.clone(),
                group: group.clone(),
            }
        })
        .collect()
}

/// Build a day's dashboard.
///
/// The aggregation deliberately happens in Rust, using the unit-tested
/// `trackit_core::aggregate`, rather than in SQL. `SUM()` skips NULLs
/// silently, so a SQL rollup over foods where three of five lack a selenium
/// measurement would report the two-food subtotal as the day's intake — with no
/// indication anything was missing.
#[tauri::command]
fn get_day(
    logged_on: String,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<DayView, String> {
    let goals = resolve_goals(&user)?;
    let conn = refdb.0.lock().map_err(|e| e.to_string())?;
    let dim = nutrient_dim(&conn)?;
    let (entries, breakdowns, by_nutrient) = collect_day(&conn, &user, &dim, &logged_on)?;
    Ok(DayView {
        logged_on,
        entries,
        breakdowns,
        totals: totals_from(&dim, &by_nutrient, &goals),
        energy_target: goals.energy.clone(),
        macro_ranges: goals.macro_ranges.clone(),
    })
}

#[derive(Debug, Serialize)]
pub struct DaySummary {
    pub date: String,
    pub items: i64,
    /// Mass of FOOD logged that day. Neither a supplement nor a bottle of
    /// water contributes to this.
    pub grams: f64,
    /// Energy for the day, or `None` where nothing logged measured it.
    pub kcal: Option<f64>,
    /// Entries that were an actual dish, entries that were supplements, and
    /// entries that were water. A day with `food_items == 0` had only a
    /// vitamin and/or a bottle on it: that is not a day whose intake can be
    /// averaged, and the calendar has to say so rather than draw it as a day
    /// of almost no food.
    pub food_items: i64,
    pub supplement_items: i64,
    pub water_items: i64,
    /// Water drunk that day in millilitres, or `None` on a day no bottle was
    /// logged. Water is drunk by volume and weighed by mass; this is the volume
    /// its bottles say that mass came to.
    pub water_ml: Option<f64>,
    /// How that day's dishes were tagged, so a calendar cell can show the mix
    /// without a second round trip. Untagged dishes are counted in
    /// `untagged_origin`, never silently dropped.
    pub origins: Vec<DayTag>,
    pub cuisines: Vec<DayTag>,
    pub untagged_origin: i64,
    pub untagged_cuisine: i64,
}

/// One tag and how many of a day's dishes carried it.
#[derive(Debug, Serialize, Clone)]
pub struct DayTag {
    pub key: String,
    pub label: String,
    pub entries: i64,
}

/// How a period's dishes split across one dimension.
#[derive(Debug, Serialize)]
pub struct TagBreakdown {
    /// `None` is the untagged group. It is reported rather than hidden: how
    /// much has not been said is part of what the chart shows.
    pub key: Option<String>,
    /// What to print. For a cuisine this is the user's own most recent
    /// spelling of it; for an origin, the stored code.
    pub label: Option<String>,
    pub entries: i64,
    pub days: i64,
    pub grams: f64,
}

#[derive(Debug, Serialize)]
pub struct RangeView {
    pub from: String,
    pub to: String,
    /// Days in the range that have at least one entry. Averages divide by THIS,
    /// never by the calendar length — logging three days of a week and dividing
    /// by seven understates intake by more than half.
    pub days_logged: usize,
    /// Days in the range on which at least one supplement was taken. Counted
    /// separately because such a day is not one whose food intake can be
    /// averaged, and `days_logged` deliberately excludes days with no food.
    pub days_with_supplements: usize,
    /// Days in the range on which a bottle of water was logged. Counted
    /// separately for the same reason as `days_with_supplements`: finishing a
    /// bottle is not a claim about what, or whether, anything was eaten.
    pub days_with_water: usize,
    pub days: Vec<DaySummary>,
    /// Per-nutrient totals across the whole period. `lower`/`upper` are period
    /// sums; divide by `days_logged` for a daily average.
    ///
    /// Covers only days with food on them, matching `days_logged` exactly. A
    /// day on which nothing was eaten cannot characterise intake, and including
    /// its supplements while excluding it from the divisor would overstate
    /// every nutrient they carried.
    pub totals: Vec<NutrientTotal>,
    /// How the period's dishes split by where they came from and what they
    /// were. Both include an untagged group rather than hiding it.
    pub origins: Vec<TagBreakdown>,
    pub cuisines: Vec<TagBreakdown>,
}

/// Roll nutrients up over a date range.
///
/// Contributions from every logged day are accumulated into one list per
/// nutrient and summed once, so coverage stays mass-weighted across the whole
/// period and a single unmeasured item anywhere leaves the period unbounded —
/// exactly as it would for one day.
#[tauri::command]
fn get_range(
    from: String,
    to: String,
    refdb: State<'_, db::Db>,
    user: State<'_, store::Store>,
) -> Result<RangeView, String> {
    range_view(&refdb, &user, from, to)
}

/// The body of [`get_range`], reachable without a running Tauri app.
///
/// Split out so the Android home-screen widget's snapshot can be built from the
/// SAME aggregation the Statistics screen reads. A `#[tauri::command]` takes
/// `State<'_, T>`, and a `State` cannot be constructed outside a live `App` — so
/// with the rollup trapped inside the command there were only two ways to give a
/// widget a middle day, and both were worse: a second implementation of the
/// period aggregation, which is exactly the drift this file spends its comments
/// preventing, or one that no test could ever reach. This signature takes the
/// two databases by reference, which `State` derefs to, so the command is a
/// one-line delegate and the widget and the screen cannot disagree about what a
/// middle day was.
fn range_view(
    refdb: &db::Db,
    user: &store::Store,
    from: String,
    to: String,
) -> Result<RangeView, String> {
    if from > to {
        return Err("the start of the range must not be after its end".into());
    }
    let goals = resolve_goals(&user)?;
    let conn = refdb.0.lock().map_err(|e| e.to_string())?;
    let dim = nutrient_dim(&conn)?;

    let (logged, water) = {
        let uc = user.0.lock().map_err(|e| e.to_string())?;
        (
            store::logged_days_between(&uc, &from, &to)?,
            store::water_ml_between(&uc, &from, &to)?,
        )
    };

    let mut merged: HashMap<i64, Vec<Contribution>> = HashMap::new();
    let mut days: Vec<DaySummary> = Vec::new();

    for day in &logged {
        let (entries, _b, by_nutrient) = collect_day(&conn, &user, &dim, &day.date)?;
        let energy = by_nutrient
            .get(&1008)
            .map(|c| sum(c))
            // `coverage` is None when nothing with a mass was logged. A
            // supplement-only day has no food energy to report, and reporting
            // its lower bound would draw a near-empty bar on the calendar that
            // reads as "you ate almost nothing".
            .filter(|t| t.coverage.is_some_and(|c| c > 0.0))
            .map(|t| t.lower);

        let (origins, untagged_origin) = tally(&entries, |e| e.origin.as_deref());
        let (cuisines, untagged_cuisine) = tally(&entries, |e| e.cuisine.as_deref());

        days.push(DaySummary {
            date: day.date.clone(),
            items: day.items,
            grams: day.grams,
            kcal: energy,
            food_items: day.food_items,
            supplement_items: day.supplement_items,
            water_items: day.water_items,
            water_ml: water.get(&day.date).copied(),
            origins,
            cuisines,
            untagged_origin,
            untagged_cuisine,
        });
        // Only days that hold FOOD enter the period rollup, because
        // `days_logged` — the divisor every average uses — counts exactly
        // those. Summing a supplement-only day's contributions here while
        // dividing by food days would inflate every nutrient it touched, which
        // is the same numerator/denominator mismatch `days_logged` exists to
        // prevent in the other direction. What was taken on such a day is still
        // shown on the day itself.
        if day.food_items > 0 {
            for (id, contribs) in by_nutrient {
                merged.entry(id).or_default().extend(contribs);
            }
        }
    }

    let (origin_totals, cuisine_totals) = {
        let uc = user.0.lock().map_err(|e| e.to_string())?;
        (
            store::origin_counts(&uc, &from, &to)?,
            store::cuisine_counts(&uc, &from, &to)?,
        )
    };
    let as_breakdown = |v: Vec<store::TagCount>| -> Vec<TagBreakdown> {
        v.into_iter()
            .map(|t| TagBreakdown {
                key: t.key,
                label: t.label,
                entries: t.entries,
                days: t.days,
                grams: t.grams,
            })
            .collect()
    };

    Ok(RangeView {
        from,
        to,
        // Days with FOOD on them. A day holding only a multivitamin is a logged
        // day in every other sense, but dividing a period's nutrient totals by
        // it would understate intake in exactly the way this divisor exists to
        // prevent — the same reasoning that makes it days-logged rather than
        // calendar length.
        days_logged: logged.iter().filter(|d| d.food_items > 0).count(),
        days_with_supplements: logged.iter().filter(|d| d.supplement_items > 0).count(),
        days_with_water: logged.iter().filter(|d| d.water_items > 0).count(),
        days,
        totals: totals_from(&dim, &merged, &goals),
        origins: as_breakdown(origin_totals),
        cuisines: as_breakdown(cuisine_totals),
    })
}

/// Count a day's dishes by one tag, returning the tally and how many carried no
/// answer at all. Supplements and water are skipped: a vitamin or a bottle is
/// not a dish and has no cuisine, so counting either as untagged would invent
/// a gap.
fn tally(
    entries: &[store::LogEntry],
    field: impl Fn(&store::LogEntry) -> Option<&str>,
) -> (Vec<DayTag>, i64) {
    let mut counts: Vec<DayTag> = Vec::new();
    let mut untagged = 0i64;
    for e in entries {
        if e.source_kind == "supplement" || e.source_kind == "water" {
            continue;
        }
        match field(e) {
            None => untagged += 1,
            Some(v) => {
                let key = v.trim().to_lowercase();
                match counts.iter_mut().find(|c| c.key == key) {
                    Some(c) => c.entries += 1,
                    None => counts.push(DayTag {
                        key,
                        label: v.to_string(),
                        entries: 1,
                    }),
                }
            }
        }
    }
    counts.sort_by(|a, b| b.entries.cmp(&a.entries).then(a.key.cmp(&b.key)));
    (counts, untagged)
}

// ---------------------------------------------------------------------------
// Household
//
// The kitchen is shared between the devices in a house; the diary is not.
// These read and write the local side of that, and `sync` carries it between
// devices — one code shown on one screen and read by another, two devices on
// one network, and nothing in between.
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_household(app: AppHandle, user: State<'_, store::Store>) -> Result<store::HouseholdView, String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    let mut view = store::household(&conn)?;
    // `store::household` cannot know how the last run went: the outcomes live
    // in the Hub, in memory, because they are a fact about this session and not
    // about the kitchen. The store builds the view and this puts the run on top
    // of it.
    if let Some(hub) = app.try_state::<std::sync::Arc<sync::Hub>>() {
        view.last = hub.last();
    }
    Ok(view)
}

#[tauri::command]
fn rename_device(user: State<'_, store::Store>, name: String) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::rename_device(&conn, &name)
}

#[tauri::command]
fn unpair_device(user: State<'_, store::Store>, device_id: String) -> Result<(), String> {
    let conn = user.0.lock().map_err(|e| e.to_string())?;
    store::unpair(&conn, &device_id)
}

/// The Hub, or a sentence saying why there is not one.
///
/// Resolved inside each command body rather than taken as a `State<'_, _>` in
/// the signature, so a command that is `(async)` — and therefore runs off the
/// thread the IPC message arrived on — never holds a borrow of app state across
/// the dispatch.
fn hub_of(app: &AppHandle) -> Result<std::sync::Arc<sync::Hub>, String> {
    app.try_state::<std::sync::Arc<sync::Hub>>()
        .map(|s| std::sync::Arc::clone(&s))
        .ok_or_else(|| "the household is not ready yet — try again in a moment".into())
}

/// Show a code and listen for a device to pair with.
///
/// `(async)` because it binds a socket, mints a key on first use and draws a QR
/// — none of which belongs on the thread the window's key events are dispatched
/// on, as `scan_label_photo` already records.
#[tauri::command(async)]
fn begin_pairing(app: AppHandle) -> Result<sync::PairingOffer, String> {
    let hub = hub_of(&app)?;
    sync::begin_pairing(sync::AppKitchen(app), hub)
}

#[tauri::command]
fn pairing_state(app: AppHandle) -> Result<sync::PairingState, String> {
    Ok(hub_of(&app)?.state())
}

#[tauri::command]
fn confirm_pairing(matches: bool, app: AppHandle) -> Result<(), String> {
    hub_of(&app)?.answer(matches);
    Ok(())
}

#[tauri::command]
fn cancel_pairing(app: AppHandle) -> Result<(), String> {
    // Nothing to stop is not an error, which is what this command has always
    // returned and what the screen's unmount cleanup relies on.
    if let Ok(hub) = hub_of(&app) {
        hub.cancel();
    }
    Ok(())
}

/// Join the household whose code was just scanned.
///
/// The other half of `begin_pairing`: that one shows a code and listens, this
/// one reads a code and dials. Both then poll `pairing_state`, both are asked
/// the same six digits, and neither writes the other down until both have said
/// yes.
#[tauri::command(async)]
fn join_pairing(payload: String, app: AppHandle) -> Result<(), String> {
    let hub = hub_of(&app)?;
    sync::join_pairing(sync::AppKitchen(app), hub, payload)
}

#[tauri::command(async)]
fn sync_now(app: AppHandle) -> Result<Vec<store::SyncOutcome>, String> {
    let hub = hub_of(&app)?;
    sync::sync_now(sync::AppKitchen(app), hub)
}

/// What one camera frame held, when looking for a pairing code.
#[derive(Debug, Clone, Serialize)]
pub struct PairCodeScan {
    /// `None` when the frame held no QR at all, which is the ordinary case
    /// while the camera is still being pointed — not an error.
    pub payload: Option<String>,
    /// Why nothing came back, in the user's terms. `None` when something did.
    pub trouble: Option<String>,
}

/// Whether one thing a camera found could be a pairing code.
///
/// The two spellings are the two engines: "QR" is what the Android bridge's
/// `canonicalBarcodeFormat` returns for `Barcode.FORMAT_QR_CODE`, and
/// "VNBarcodeSymbologyQR" is the framework constant Vision hands back on macOS.
/// A function with a test on it rather than a closure inside the command,
/// because getting either string wrong makes pairing by camera quietly
/// impossible — the sheet would sit on "point the camera at the code" for ever
/// with a perfectly good code in the frame, and nothing anywhere would say why.
fn is_pair_qr(b: &crate::vision::Barcode) -> bool {
    let s = b.symbology.as_str();
    (s == "QR" || s == "VNBarcodeSymbologyQR") && !b.payload.trim().is_empty()
}

/// Read a pairing code out of one camera frame.
///
/// A separate command from `scan_barcode` and not a widening of it.
/// `best_barcode` ranks candidates as PRODUCT codes and runs them through
/// `barcode::check`, which is a check-digit rule for EAN and UPC and says
/// nothing useful about a QR at all. This filters for the QR symbology instead
/// — see [`is_pair_qr`] — and hands the payload back untouched, because the
/// exact bytes are hashed into the handshake.
///
/// Stores nothing. A photograph of a pairing code is worth nothing once it has
/// been read, and worth something to somebody else if it is kept.
#[tauri::command(async)]
fn scan_pair_code(data_base64: String, app: AppHandle) -> Result<PairCodeScan, String> {
    let (bytes, _ext) = decode_photo(&data_base64)?;
    let found = crate::vision::detect_barcodes(&app, &bytes)?;
    let qr = found.iter().find(|b| is_pair_qr(b));
    let Some(qr) = qr else {
        return Ok(PairCodeScan {
            payload: None,
            trouble: None,
        });
    };
    // Parsed here rather than on the screen, so a code from some other app is
    // refused with a sentence at the moment the camera reads it instead of
    // being carried into a handshake that would fail for a reason nobody could
    // relate to what they pointed the phone at.
    match sync::parse_code(&qr.payload) {
        Ok(_) => Ok(PairCodeScan {
            payload: Some(qr.payload.clone()),
            trouble: None,
        }),
        Err(e) => Ok(PairCodeScan {
            payload: None,
            trouble: Some(e),
        }),
    }
}

// ---------------------------------------------------------------------------
// Encryption and the sealed backup — see `vault.rs` and docs/decisions.md D18
// ---------------------------------------------------------------------------

/// Where `user.db`, the photographs and the key material all live.
///
/// On Android this is `activity.dataDir`, which is one level ABOVE
/// `getFilesDir()` — the directory an Android backup rules file addresses as
/// `domain="file"`. Nothing here is eligible for backup as a consequence, which
/// is why the sealed file is written where `keystore::dir` says instead.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))
}

/// What is encrypted, what is sealed, when, how big, and what the phone's own
/// keystore actually turned out to be.
///
/// The one command here that does NOT answer with a sentence off Android. It
/// comes back with `supported: false` instead, so the screen can explain the
/// platform in its own words rather than showing an alert where a page should
/// be.
#[tauri::command]
fn backup_status(
    app: AppHandle,
    user: State<'_, store::Store>,
    vault: State<'_, vault::Vault>,
) -> Result<vault::BackupStatus, String> {
    let dir = data_dir(&app)?;
    vault::status(&app, &dir, &user, &vault)
}

/// Encrypt the log, setting the recovery passphrase that is the only thing able
/// to get it back.
///
/// One act, because they are one decision: an encrypted log with no recovery
/// passphrase is a log the operating system can take away, and this app does not
/// offer that. Sealing a copy Google may carry is a SEPARATE act — see
/// `seal_backup_now`.
#[tauri::command]
fn enable_log_encryption(
    app: AppHandle,
    user: State<'_, store::Store>,
    vault: State<'_, vault::Vault>,
    passphrase: String,
    confirm: String,
) -> Result<vault::BackupStatus, String> {
    let dir = data_dir(&app)?;
    vault::enable(&app, &dir, &user, &vault, &passphrase, &confirm)
}

/// Turn encryption off again, which takes the passphrase.
#[tauri::command]
fn disable_log_encryption(
    app: AppHandle,
    user: State<'_, store::Store>,
    vault: State<'_, vault::Vault>,
    passphrase: String,
) -> Result<vault::BackupStatus, String> {
    let dir = data_dir(&app)?;
    vault::disable(&app, &dir, &user, &vault, &passphrase)
}

/// Change the recovery passphrase, proving knowledge of the current one first.
#[tauri::command]
fn change_backup_passphrase(
    app: AppHandle,
    user: State<'_, store::Store>,
    vault: State<'_, vault::Vault>,
    current: String,
    passphrase: String,
    confirm: String,
) -> Result<vault::BackupStatus, String> {
    let dir = data_dir(&app)?;
    vault::change_passphrase(&app, &dir, &user, &vault, &current, &passphrase, &confirm)
}

/// Write a fresh sealed copy now.
///
/// This does NOT upload anything. Only Google's backup service does that, on
/// its own schedule, and the screen says so where the button is.
#[tauri::command]
fn seal_backup_now(
    app: AppHandle,
    user: State<'_, store::Store>,
    vault: State<'_, vault::Vault>,
) -> Result<vault::BackupStatus, String> {
    let dir = data_dir(&app)?;
    vault::seal_now(&app, &dir, &user, &vault)
}

/// Whether the app re-seals on its own once the log has moved on.
#[tauri::command]
fn set_auto_reseal(
    app: AppHandle,
    user: State<'_, store::Store>,
    vault: State<'_, vault::Vault>,
    on: bool,
) -> Result<vault::BackupStatus, String> {
    let dir = data_dir(&app)?;
    vault::set_auto_reseal(&app, &dir, &user, &vault, on)
}

/// Delete the sealed copy, which is how the consent to upload is withdrawn.
#[tauri::command]
fn remove_sealed_backup(
    app: AppHandle,
    user: State<'_, store::Store>,
    vault: State<'_, vault::Vault>,
) -> Result<vault::BackupStatus, String> {
    let dir = data_dir(&app)?;
    vault::remove_sealed(&app, &dir, &user, &vault)
}

/// Replace this phone's log with the sealed copy.
#[tauri::command]
fn restore_backup(
    app: AppHandle,
    user: State<'_, store::Store>,
    vault: State<'_, vault::Vault>,
    passphrase: String,
) -> Result<vault::RestoreOutcome, String> {
    let dir = data_dir(&app)?;
    vault::restore(&app, &dir, &user, &vault, &passphrase)
}

/// Open an encrypted log this session could not unlock silently.
#[tauri::command]
fn unlock_log(
    app: AppHandle,
    user: State<'_, store::Store>,
    vault: State<'_, vault::Vault>,
    passphrase: String,
) -> Result<vault::BackupStatus, String> {
    let dir = data_dir(&app)?;
    vault::unlock(&app, &dir, &user, &vault, &passphrase)
}

// ---------------------------------------------------------------------------
// The two Android home-screen widgets
// ---------------------------------------------------------------------------

/// How far back the quick-add shortcut looks for what somebody eats often.
///
/// Three months rather than all of history. A food logged forty times two years
/// ago would otherwise sit permanently above this month's staples, and a
/// shortcut that offers what you used to eat is not a shortcut. Wider than the
/// aggregate widget's thirty days on purpose: a habit is a slower thing than a
/// period's figures, and a fortnight away from home should not empty the list.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const QUICK_WINDOW_DAYS: i64 = 90;

/// Build both widget snapshots.
///
/// Everything a home screen will show is decided here and in `widgets.rs`, in
/// Rust, and crosses to Kotlin as finished strings. The aggregate goes through
/// [`range_view`] — the same function `get_range` serves the Statistics screen
/// from — so the widget and the screen cannot disagree about what a middle day
/// was. See `docs/decisions.md` D19.
///
/// See the note at the top of `widgets.rs` for why this carries an `allow`.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn widget_payloads(
    refdb: &db::Db,
    user: &store::Store,
) -> Result<(widgets::Aggregate, widgets::QuickAdd), String> {
    let want = widgets::QUICK_ROWS as u32;
    let (from, to, stamp, candidates, overridden) = {
        let uc = user.0.lock().map_err(|e| e.to_string())?;
        let to = store::today_iso(&uc)?;
        let from = store::shift_iso(&uc, &to, -(widgets::PERIOD_DAYS - 1))?;
        let since = store::shift_iso(&uc, &to, -(QUICK_WINDOW_DAYS - 1))?;
        let stamp = widgets::stamp(&store::local_stamp(&uc)?);
        // The SAME query the Quick add section on the Foods screen is built
        // from, asked for the same oversized pool, and finished through the
        // same `resolve_frequent`. Not a tidiness point: that second half is
        // where a food the dataset has dropped stops being offered and where a
        // reference food the user has replaced with their own pack is removed.
        // A widget with a ranking of its own would keep offering both — a tile
        // whose tap dies in an error, and a tile whose tap logs USDA's figures
        // for a category the person has a transcribed pack for. Two definitions
        // of "the foods you log most" is the kind of pair that drifts silently,
        // and the home screen is where nobody would notice it had.
        let candidates =
            store::frequent_foods(&uc, &since, want.saturating_mul(FREQUENT_POOL_FACTOR))?;
        let overridden = store::overridden_fdc_ids(&uc)?;
        (from, to, stamp, candidates, overridden)
    };
    // The user lock is dropped by the block above, and it has to be: `range_view`
    // takes both databases for itself and would wait forever behind a guard this
    // function was still holding.
    let view = range_view(refdb, user, from, to)?;
    // And the reference lock only after `range_view` has given both back.
    let frequent = {
        let rc = refdb.0.lock().map_err(|e| e.to_string())?;
        resolve_frequent(&rc, candidates, &overridden, want)
    };
    Ok((
        widgets::aggregate_from(&view, widgets::PERIOD_DAYS, &stamp),
        widgets::quickadd_from(&frequent, &stamp),
    ))
}

/// How long a burst of writes is allowed to settle into one snapshot.
///
/// A spreadsheet import is one command and publishes once, but twenty helpings
/// typed in one sitting are twenty commands, and each snapshot is a thirty-day
/// aggregation over `collect_day`. Without this the last of them would be
/// competing with the first for both database mutexes.
#[cfg(target_os = "android")]
const WIDGET_SETTLE: std::time::Duration = std::time::Duration::from_millis(600);

/// Whether a snapshot is already waiting to be written.
#[cfg(target_os = "android")]
static WIDGET_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Recompute both snapshots, off the calling thread and never in its way.
///
/// Best-effort BY CONTRACT. A widget that failed to redraw must never fail the
/// log entry that triggered it, which is the same posture `init_state` takes
/// toward a failed backfill — so nothing in here returns a `Result` to a caller
/// and nothing in here can panic a logging path. That last part is why the
/// snapshot is written with `std::fs` and not through the mobile-plugin bridge:
/// release builds set `panic = "abort"` (src-tauri/Cargo.toml), and a JNI call
/// made from a detached thread whose Activity has just been swiped out of
/// recents would take the whole process down rather than merely fail to repaint.
/// Telling the launcher to redraw is left to `MainActivity`, which knows by
/// definition that it is alive.
///
/// `spawn_blocking` is not tidiness either. The caller is a mutating command
/// still holding one or both database mutexes for the whole of its body, so
/// publishing inline would deadlock on the first lock this function takes; the
/// spawned thread takes them afresh a moment later, which is a wait and not a
/// cycle.
#[cfg(target_os = "android")]
fn republish_widgets(app: &AppHandle) {
    use std::sync::atomic::Ordering;

    if WIDGET_PENDING.swap(true, Ordering::SeqCst) {
        // Somebody is already asleep on the settle. Their write will see this
        // entry too, because it reads the database rather than a payload handed
        // to it when it was scheduled.
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(WIDGET_SETTLE);
        // Cleared BEFORE the work rather than after. A helping logged while the
        // snapshot is being written has to be able to schedule another one, or
        // the last entry of a burst would be the one the widget never showed.
        WIDGET_PENDING.store(false, Ordering::SeqCst);

        let dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("widget snapshot not written: no data directory: {e}");
                return;
            }
        };
        let refdb = app.state::<db::Db>();
        let user = app.state::<store::Store>();
        match widget_payloads(&refdb, &user).and_then(|(a, q)| widgets::write(&dir, &a, &q)) {
            Ok(()) => {}
            Err(e) => eprintln!("widget snapshot not written: {e}"),
        }
    });
}

/// A no-op everywhere there is no widget host, so no caller has to branch.
///
/// Not merely unnecessary off Android — actively wrong. Writing a snapshot into
/// `no_backup/` on a Mac would leave a file nothing on that machine ever reads,
/// and the desktop build's whole claim is that it carries none of the mobile
/// stack.
#[cfg(not(target_os = "android"))]
fn republish_widgets(_app: &AppHandle) {}

/// Republish the widgets when a write actually succeeded, and pass the result
/// straight through.
///
/// A combinator rather than one line at the end of each mutating command,
/// because half of them END in a tail call whose `Result` is returned directly
/// and have no final `Ok(...)` to put a statement in front of. `add_log_entry`
/// is the clearest case: it has two `Err` exits, a tail call to `add_frozen` and
/// one `Ok(id)`, so "add a line before the final Ok" would have landed only in
/// the scale-reading arm and the commonest path — a typed net weight — would
/// never have republished at all.
///
/// Gating on `is_ok` matters as much. A refused entry — a supplement with a
/// weight on it, a scale reading swallowed by its own tare — changed nothing,
/// and repainting a home screen for it would spend a thirty-day aggregation to
/// print exactly what was already there.
///
/// What deliberately does NOT go through here is worth naming, because the
/// absence looks like an oversight otherwise. `set_entry_tags` writes an origin
/// and a cuisine, and neither widget shows either: the aggregate prints energy,
/// water and coverage, and the quick-add prints names. Saving a recipe, a
/// vessel, a bottle or a supplement changes the kitchen rather than the record,
/// and `frequent_foods` admits none of those shelves. Adding them would cost a
/// thirty-day rollup to redraw two strings that cannot have changed.
fn after_write<T>(app: &AppHandle, out: Result<T, String>) -> Result<T, String> {
    if out.is_ok() {
        republish_widgets(app);
    }
    out
}

/// Where a home-screen widget asked the app to land, if it did.
///
/// Pulled by the front end once after mount rather than pushed at it. On a cold
/// start the Intent exists long before React has mounted, and a hash written
/// then is simply dropped; by the time this is called the app is up, so writing
/// the hash always takes.
///
/// A plain synchronous command, and worth saying why given how much of this
/// feature is arranged around threading: there is no bridge here at all. Kotlin
/// wrote a file and this reads it, which is one small `std::fs` read and no
/// mutex, so there is nothing for `(async)` to keep off the IPC thread.
#[tauri::command]
fn take_widget_landing(app: AppHandle) -> Result<Option<widgets::Landing>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    widgets::take_landing(&dir)
}

fn init_state(app: &AppHandle) -> Result<(), String> {
    let ref_path = db::resolve(app)?;
    let ref_conn = db::open(&ref_path)?;
    let ref_db = db::Db(Mutex::new(ref_conn));

    // `data_root` rather than `app_data_dir` directly: it honours the debug-only
    // relocation the transport's end-to-end test needs, and every path below —
    // the interrupted-restore recovery, the key material, the log itself — has
    // to agree about where this installation lives or a relocated instance
    // would encrypt one database and read another.
    let data_dir = data_root(app)?;

    // BEFORE the database is opened, and that order is the whole point. A
    // restore or a one-time conversion to SQLCipher renames `user.db` out of the
    // way and then renames a replacement in, and a process that dies between
    // those two calls leaves no `user.db` at all — at which point `store::open`
    // would cheerfully create an empty one and a year of meals would be gone
    // with no error reported anywhere. See `backup::recover_interrupted`.
    match backup::recover_interrupted(&data_dir) {
        Ok(backup::Recovered::Nothing) => {}
        Ok(backup::Recovered::PutBackPlaintext) => {
            eprintln!("put the log back: an earlier attempt to encrypt it did not finish")
        }
        Ok(backup::Recovered::PutBackSuperseded) => {
            eprintln!("put the log back: an earlier restore did not finish")
        }
        Ok(backup::Recovered::DiscardedStaged) => {
            eprintln!("discarded a half-written database left by an earlier attempt")
        }
        // Never fatal. A recovery pass that cannot read the directory is not a
        // reason somebody cannot open their log, and the ordinary path below
        // will say something more useful if the database is genuinely missing.
        Err(e) => eprintln!("could not check for an interrupted restore: {e}"),
    }

    // Plaintext or SQLCipher-keyed, decided by asking the file. A phone whose
    // keystore has lost the key comes back LOCKED rather than failing to start:
    // the recovery passphrase still opens it, and refusing to launch would put
    // the way back in behind a door that will not open.
    let (mut user_conn, session) = vault::open_log(app, &data_dir)?;
    let locked = session.locked;
    if let Some(note) = &session.note {
        eprintln!("the log is locked: {note}");
    }

    // Entries written before history was frozen have no snapshot, and their
    // original values were never recorded. Freezing them now at what the app
    // can still work out is the best available answer; they are marked
    // `backfilled` so the difference is never claimed to be more than it is.
    // A failure here must not stop the app: the entries stay unfrozen and are
    // retried next launch, which is exactly the state they are in today.
    //
    // Skipped entirely while the log is locked. There is no log to freeze
    // anything in — the connection is an empty throwaway — and running it would
    // report a failure about a database nobody has opened yet.
    if !locked {
        let refconn = ref_db.0.lock().map_err(|e| e.to_string())?;
        match backfill_snapshots(&refconn, &mut user_conn) {
            Ok(0) => {}
            Ok(n) => eprintln!("froze {n} log entries that predate stored nutrition"),
            Err(e) => eprintln!("could not freeze older log entries: {e}"),
        }
    }

    // Before anything can need it, and never rewritten afterwards. `NULL` in
    // `this_device.static_pk` is a real state — a database that has just
    // migrated has an identity and no key — and this is what ends it.
    if let Err(e) = sync::ensure_identity(&user_conn) {
        eprintln!("this device has no household key yet: {e}");
    }
    let peers = store::peers_to_dial(&user_conn).unwrap_or_default();

    app.manage(ref_db);
    app.manage(store::Store(Mutex::new(user_conn)));
    app.manage(vault::Vault(Mutex::new(session)));

    // Re-seal on its own thread, and only when the user has asked for that.
    //
    // A thread rather than the setup path, because a seal copies every page of
    // the database, compresses it and runs an AEAD over the result — and
    // `store::open`'s own comment records what this app has already been
    // punished for once, when a 4 MB write-ahead log turned a cold launch into
    // 25-30 seconds of an apparently frozen screen. The seal takes the store's
    // mutex only for a moment; the copy itself goes through a second, read-only
    // connection. Every failure inside is an `eprintln!`, never a refusal to
    // start.
    if !locked {
        let handle = app.clone();
        let dir = data_dir.clone();
        std::thread::spawn(move || vault::reseal_if_stale(&handle, &dir));
    }

    let hub = std::sync::Arc::new(sync::Hub::new());
    app.manage(std::sync::Arc::clone(&hub));

    // A device paired with nobody binds no socket at all. The alternative —
    // listening only while the Household screen is open — would mean a sync
    // from the Mac succeeded only if somebody happened to be holding the phone
    // on that exact screen, which is not a feature.
    if !peers.is_empty() {
        if let Err(e) = sync::serve(sync::AppKitchen(app.clone()), hub) {
            eprintln!("this device cannot be reached by the rest of the household: {e}");
        }
    }

    // After the state is managed, because the snapshot is built by reading it.
    // Here rather than only after a mutation so that a fresh install and a
    // restored one both fill their widgets before the user opens a screen —
    // otherwise a widget placed on the home screen of a phone whose owner has
    // been logging for months would say "Open TrackIt" until they next ate.
    republish_widgets(app);
    Ok(())
}

/// Hold the device's screen open, or let it go.
///
/// Android only in effect; everywhere else this succeeds and does nothing,
/// which is what lets the front end ask for what it wants without first asking
/// what it is running on. A failure here leaves the screen dimming on its
/// ordinary timeout, so the caller swallows it rather than putting an alert in
/// front of somebody with their hands in a pot.
///
/// Callers do not reach this directly: `useKeepAwake` in `src/lib/awake.ts`
/// owns the pairing of the two calls, and an unpaired `true` is a phone that
/// burns its screen all night.
#[tauri::command]
fn set_keep_awake(on: bool, app: AppHandle) -> Result<(), String> {
    awake::set(&app, on)
}

/// Where this installation keeps its own data.
///
/// `TRACKIT_DATA_DIR` exists so two desktop instances can be run against two
/// databases on one machine and actually paired with each other, which is the
/// only way to exercise the transport end to end without two devices. It is
/// gated on a debug build on purpose: an environment variable that relocates
/// the user's database in a shipped app is a footgun, and one that relocated
/// the database WITHOUT the photos beside it would be worse — instance B would
/// serve instance A's pictures and the photo-portability rules would appear to
/// hold for the wrong reason.
fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("TRACKIT_DATA_DIR") {
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        return Ok(dir);
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_fs::init());

    // The save panel an export is put in front of, on the platforms that have
    // one. Android is excluded here AND in Cargo.toml: saving there goes
    // through the Storage Access Framework, which `export::init()` below asks
    // for directly, so the dialog plugin is not even in that target's graph.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_dialog::init());

    // The bridge is registered only for Android. Its Kotlin class and ML Kit
    // dependencies are likewise in the Android source set, so desktop bundles
    // cannot accidentally carry a second vision stack.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(vision::init());

    // The same arrangement for the screen flag, and a second plugin rather
    // than a second command on the vision one: an OCR bridge is where a screen
    // flag goes to never be found again.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(awake::init());

    // And again for the document picker: `ExportPlugin.kt` sits beside
    // `VisionPlugin.kt` in the Android source set, so nothing about it reaches
    // a desktop bundle either.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(export::init());

    // And the Android Keystore bridge, for the same reason a third time: its
    // Kotlin lives in the Android source set, so no desktop bundle carries a
    // second key store it could never reach.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(keystore::init());

    builder
        .setup(|app| {
            if let Err(e) = init_state(app.handle()) {
                // Fail loudly. A missing reference database silently yielding an
                // empty app would look like "no results" rather than a setup bug.
                eprintln!("\n!! TrackIt failed to start: {e}\n");
                return Err(e.into());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search_foods,
            get_food_detail,
            add_log_entry,
            delete_log_entry,
            logged_dates,
            get_range,
            save_recipe,
            list_recipes,
            get_recipe,
            delete_recipe,
            draft_cook,
            save_cook,
            list_open_cooks,
            get_household,
            rename_device,
            unpair_device,
            begin_pairing,
            pairing_state,
            confirm_pairing,
            cancel_pairing,
            join_pairing,
            scan_pair_code,
            sync_now,
            get_cook,
            finish_cook,
            delete_cook,
            list_vessels,
            save_vessel,
            delete_vessel,
            list_bottles,
            save_bottle,
            delete_bottle,
            log_water,
            frequent_foods,
            list_custom_foods,
            get_custom_food,
            save_custom_food,
            delete_custom_food,
            get_custom_food_detail,
            save_food_photo,
            read_food_photo,
            scan_label_photo,
            scan_ingredients_photo,
            scan_supplement_photo,
            scan_barcode,
            probe_frame,
            get_day,
            list_supplements,
            get_supplement,
            save_supplement,
            delete_supplement,
            get_supplement_detail,
            convert_label_figure,
            recall_tags,
            set_entry_tags,
            list_cuisines,
            list_nutrients,
            import_log_rows,
            export::export_log,
            export::save_exported_file,
            get_entry_snapshot,
            correct_entry_amount,
            correct_entry_value,
            refreeze_entry,
            dates_with_existing_imports,
            get_goals,
            save_profile,
            set_nutrient_target,
            set_keep_awake,
            backup_status,
            enable_log_encryption,
            disable_log_encryption,
            change_backup_passphrase,
            seal_backup_now,
            set_auto_reseal,
            remove_sealed_backup,
            restore_backup,
            unlock_log,
            take_widget_landing
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// A Hershey's-sized bar, the serving the whole feature was designed around.
    const BAR: f64 = 43.0;

    /// The bundled reference database, or `None` when it has not been built yet
    /// (`python3 tools/build_reference_db.py`).
    fn refdb() -> Option<Connection> {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("usda_core.db");
        if !p.exists() {
            eprintln!("skipping: {} not built", p.display());
            return None;
        }
        db::open(&p).ok()
    }

    /// An empty user database in the shape this build expects.
    ///
    /// The last two calls are not decoration. `SCHEMA` alone leaves a database
    /// with no device identity and no change-tracking triggers, which is a
    /// state the real app is never in — `open` mints one and installs the
    /// other — and a test running against it would report a pot that never
    /// empties and change tracking that never fires. Both would pass while the
    /// shipped app failed.
    fn user_db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(store::SCHEMA).unwrap();
        store::ensure_device_identity(&c).unwrap();
        store::install_sync_triggers(&c).unwrap();
        c
    }

    fn nutrient(id: i64, kind: &str, amount: Option<f64>, upper: Option<f64>) -> store::CustomNutrient {
        store::CustomNutrient {
            nutrient_id: id,
            kind: kind.into(),
            amount,
            upper,
        }
    }

    /// A bar declaring 13 g of fat and 0 mg of sodium per 43 g serving.
    fn bar(overrides: Option<i64>) -> store::CustomFood {
        store::CustomFood {
            id: String::new(),
            name: "Milk chocolate bar".into(),
            brand: Some("Hershey's".into()),
            overrides_fdc_id: overrides,
            serving_g: BAR,
            serving_label: Some("1 bar (43 g)".into()),
            ingredients: Some("Sugar, milk, chocolate".into()),
            barcode: None,
            photo_label: None,
            photo_ingredients: None,
            nutrients: vec![
                nutrient(1004, "measured", Some(13.0), None),
                nutrient(1093, "label_zero", None, Some(5.0)),
            ],
            import_only: false,
        }
    }

    /// A B12 tablet: 1,000 µg per tablet, one tablet a serving. Nothing about
    /// it is per 100 g and it has no mass this app knows.
    fn b12_tablet() -> store::Supplement {
        store::Supplement {
            id: String::new(),
            name: "B12".into(),
            brand: None,
            unit_noun: "tablet".into(),
            serving_units: 1.0,
            serving_label: Some("1 tablet".into()),
            default_units: Some(1.0),
            regime: "us".into(),
            panel_complete: false,
            other_ingredients: None,
            barcode: None,
            photo_panel: None,
            photo_ingredients: None,
            nutrients: vec![store::SupplementNutrient {
                nutrient_id: 1178,
                position: 0,
                label_amount: 1000.0,
                label_unit: "ug".into(),
                label_form: "unspecified".into(),
                kind: "measured".into(),
                amount: Some(1000.0),
                upper: None,
                convert_note: None,
            }],
        }
    }

    fn saved(conn: &mut Connection, f: &store::CustomFood) -> store::CustomFood {
        let id = store::save_custom_food(conn, None, f).unwrap();
        store::get_custom_food(conn, &id).unwrap()
    }

    fn row(p: &ResolvedPanel, id: i64) -> &CustomNutrientRow {
        p.rows.iter().find(|r| r.id == id).expect("nutrient in panel")
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn a_labels_per_serving_figure_lands_on_the_apps_per_100g_basis() {
        let Some(rc) = refdb() else { return };
        let mut uc = user_db();
        let food = saved(&mut uc, &bar(None));
        let panel = resolve_panel(&rc, &food).unwrap();

        match row(&panel, 1004).value {
            NutrientValue::Measured { amount } => {
                assert!(close(amount, 13.0 * 100.0 / BAR), "got {amount} g per 100 g")
            }
            ref other => panic!("13 g of fat off the pack must be measured, got {other:?}"),
        }
        assert_eq!(row(&panel, 1004).provenance, "label");
    }

    #[test]
    fn a_declared_zero_reaches_the_panel_as_a_bound_never_as_a_measured_zero() {
        let Some(rc) = refdb() else { return };
        let mut uc = user_db();
        let food = saved(&mut uc, &bar(None));
        let panel = resolve_panel(&rc, &food).unwrap();

        let sodium = &row(&panel, 1093).value;
        match sodium {
            NutrientValue::LabelZero { upper } => {
                assert!(close(*upper, 5.0 * 100.0 / BAR), "got {upper}")
            }
            other => panic!("a pack's 0 mg of sodium must stay a bound, got {other:?}"),
        }
        assert_ne!(*sodium, NutrientValue::MeasuredZero);
        // The bound has a floor of nothing: the pack says "under 5 mg", not "5 mg".
        assert_eq!(sodium.lower(), 0.0);
    }

    #[test]
    fn a_nutrient_no_label_prints_and_no_base_supplies_is_unknown_not_zero() {
        let Some(rc) = refdb() else { return };
        let mut uc = user_db();
        let food = saved(&mut uc, &bar(None));
        let panel = resolve_panel(&rc, &food).unwrap();

        // Iodine is on no nutrition panel and there is no base to borrow from.
        let iodine = row(&panel, 1100);
        assert_eq!(iodine.value, NutrientValue::Absent);
        assert_eq!(iodine.provenance, "unknown");
        assert_eq!(iodine.value.upper(), None, "an unknown must not claim a ceiling");
        assert_eq!(panel.base_description, None);
        assert_eq!(panel.from_label, 2);
        assert_eq!(panel.from_base, 0);
    }

    #[test]
    fn what_the_pack_omits_is_borrowed_from_the_entry_it_overrides() {
        let Some(rc) = refdb() else { return };
        let base_id = db::search(&rc, "chocolate milk candies", 1)
            .unwrap()
            .first()
            .and_then(|h| h.fdc_id)
            .expect("a reference food to override");
        let base = db::nutrients_of(&rc, base_id).unwrap();
        // A nutrient the base measured and the label does not print.
        let (&borrowed_id, borrowed) = base
            .iter()
            .find(|(id, v)| ![1004, 1093].contains(id) && matches!(v, NutrientValue::Measured { .. }))
            .expect("the base food to measure something no label prints");

        let mut uc = user_db();
        let food = saved(&mut uc, &bar(Some(base_id)));
        let panel = resolve_panel(&rc, &food).unwrap();

        let r = row(&panel, borrowed_id);
        assert_eq!(r.provenance, "inherited");
        assert_eq!(&r.value, borrowed, "an inherited value is the base's own");
        assert!(panel.base_description.is_some(), "the borrowed-from food is named");
        // What the pack does print still wins over the generic entry.
        assert_eq!(row(&panel, 1004).provenance, "label");
    }

    #[test]
    fn every_row_is_accounted_for_by_exactly_one_provenance() {
        let Some(rc) = refdb() else { return };
        let mut uc = user_db();
        for overrides in [None, db::search(&rc, "cheddar", 1).unwrap()[0].fdc_id] {
            let food = saved(&mut uc, &bar(overrides));
            let panel = resolve_panel(&rc, &food).unwrap();
            assert!(panel.rows.len() > 30, "the panel should be the full spine");
            assert_eq!(
                panel.from_label + panel.from_base + panel.unknown,
                panel.rows.len(),
                "the three counts must add up to the panel the user is shown"
            );
            for r in &panel.rows {
                assert!(matches!(&r.provenance[..], "label" | "inherited" | "unknown"));
            }
        }
    }

    /// The day and the panel must agree, because they are the same resolution.
    #[test]
    fn a_day_with_one_of_the_users_own_foods_sums_what_the_pack_said() {
        let Some(rc) = refdb() else { return };
        let dim = nutrient_dim(&rc).unwrap();
        let mut uc = user_db();
        let food = saved(&mut uc, &bar(None));
        // Two bars: 86 g of a food whose serving is 43 g.
        store::add(
            &uc,
            "2026-09-04",
            Some("snack"),
            store::Source::Custom(&food.id),
            "Milk chocolate bar",
            store::Quantity::Grams(2.0 * BAR),
            None,
            &store::Tags::default(),
        )
        .unwrap();
        let user = store::Store(Mutex::new(uc));

        let (entries, breakdowns, by_nutrient) =
            collect_day(&rc, &user, &dim, "2026-09-04").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source_kind, "custom");

        let fat = sum(&by_nutrient[&1004]);
        assert!(close(fat.lower, 26.0), "two 13 g bars are 26 g of fat, got {}", fat.lower);
        assert_eq!(fat.upper, Some(26.0), "a measured value bounds itself");

        // The gap has to propagate: an unknown nutrient drags the day's coverage
        // down rather than reading as a confident zero.
        let iodine = sum(&by_nutrient[&1100]);
        assert_eq!(iodine.lower, 0.0);
        assert_eq!(iodine.upper, None, "an unmeasured nutrient bounds nothing");
        assert_eq!(iodine.coverage, Some(0.0));
        assert_eq!(iodine.items_total, 1, "the food still counts against coverage");

        let line = &breakdowns[0].components[0].description;
        assert!(line.contains("Milk chocolate bar"), "the breakdown names the food");
        assert!(line.contains("2 of"), "and says how many values came off the pack");
    }

    #[test]
    fn deleting_one_of_your_foods_does_not_break_a_day_that_already_used_it() {
        let Some(rc) = refdb() else { return };
        let dim = nutrient_dim(&rc).unwrap();
        let mut uc = user_db();
        let food = saved(&mut uc, &bar(None));
        store::add(
            &uc,
            "2026-09-04",
            Some("snack"),
            store::Source::Custom(&food.id),
            "Milk chocolate bar",
            store::Quantity::Grams(BAR),
            None,
            &store::Tags::default(),
        )
        .unwrap();
        store::delete_custom_food(&uc, &food.id).unwrap();
        let user = store::Store(Mutex::new(uc));

        let (entries, _b, by_nutrient) = collect_day(&rc, &user, &dim, "2026-09-04").unwrap();
        assert_eq!(entries.len(), 1, "the day still opens");
        assert!(
            close(sum(&by_nutrient[&1004]).lower, 13.0),
            "and still says what the pack said"
        );
    }

    #[test]
    fn a_serving_that_cannot_divide_is_refused_rather_than_producing_infinity() {
        for bad in [0.0, -43.0, f64::NAN, f64::INFINITY] {
            let mut food = bar(None);
            food.serving_g = bad;
            let Some(rc) = refdb() else { return };
            assert!(
                resolve_panel(&rc, &food).is_err(),
                "a serving of {bad} must not resolve"
            );
        }
    }

    /// The inversion the whole feature was asked for: the pack in your hand
    /// beats the generic entry, and the generic entry it replaces goes away.
    #[test]
    fn your_own_foods_come_first_and_the_entry_one_replaces_disappears() {
        let Some(rc) = refdb() else { return };
        let generic = db::search(&rc, "chocolate", 1).unwrap()[0]
            .fdc_id
            .expect("a reference hit carries an fdc_id");

        let mut uc = user_db();
        let mut f = bar(Some(generic));
        f.name = "Chocolate bar".into();
        let food = saved(&mut uc, &f);
        let own = store::search_custom_foods(&uc, "chocolate", 40).unwrap();
        assert_eq!(own.len(), 1, "the user's own food matches the query");
        let overridden = store::overridden_fdc_ids(&uc).unwrap();

        let hits = merge_hits(&rc, &uc, "chocolate", own, &overridden, false, 40).unwrap();
        assert_eq!(hits[0].kind, "custom", "your own food ranks above the reference data");
        assert_eq!(hits[0].custom_food_id.as_deref(), Some(&food.id[..]));
        assert_eq!(hits[0].fdc_id, None, "a custom hit has no USDA identity");
        assert!(
            hits[0].note.as_deref().unwrap_or("").contains("Replaces"),
            "and says which generic entry it replaces"
        );
        assert!(
            hits.iter().all(|h| h.fdc_id != Some(generic)),
            "the entry it replaces must not also be offered"
        );
        assert!(
            hits.iter().any(|h| h.kind == "reference"),
            "the rest of the reference data is still searchable"
        );

        // Deleting the food gives the generic entry back: otherwise the user
        // could no longer log the food at all.
        store::delete_custom_food(&uc, &food.id).unwrap();
        let overridden = store::overridden_fdc_ids(&uc).unwrap();
        let hits = merge_hits(&rc, &uc, "chocolate", vec![], &overridden, false, 40).unwrap();
        assert!(hits.iter().any(|h| h.fdc_id == Some(generic)));
    }

    /// The override must PROMOTE the food, never hide it. A pack's name rarely
    /// contains the USDA category word the generic entry leads with, so the
    /// query that finds the entry usually does not find the food replacing it.
    #[test]
    fn a_replaced_entry_is_offered_as_the_food_that_replaced_it() {
        let Some(rc) = refdb() else { return };
        let generic = db::search(&rc, "chocolate", 1).unwrap()[0]
            .fdc_id
            .expect("a reference hit carries an fdc_id");

        let mut uc = user_db();
        let mut f = bar(Some(generic));
        // Nothing in the name, brand or barcode matches the query below.
        f.name = "Dairy Milk".into();
        f.brand = Some("Cadbury".into());
        let food = saved(&mut uc, &f);

        let own = store::search_custom_foods(&uc, "chocolate", 40).unwrap();
        assert!(own.is_empty(), "the food itself does not match the query");
        let overridden = store::overridden_fdc_ids(&uc).unwrap();

        let hits = merge_hits(&rc, &uc, "chocolate", own, &overridden, false, 40).unwrap();
        assert!(
            hits.iter().all(|h| h.fdc_id != Some(generic)),
            "the replaced entry is not offered"
        );
        let stand_in = hits
            .iter()
            .find(|h| h.custom_food_id.as_deref() == Some(&food.id[..]))
            .expect("the food that replaced it is offered in its place");
        assert_eq!(stand_in.kind, "custom");
        assert!(
            stand_in.note.as_deref().unwrap_or("").contains("Replaces"),
            "and says which entry it stands in for"
        );
        assert!(
            hits.iter().position(|h| h.kind == "reference").unwrap()
                > hits
                    .iter()
                    .position(|h| h.custom_food_id.is_some())
                    .unwrap(),
            "a stand-in is one of the user's own foods and outranks the reference data"
        );
        assert_eq!(
            hits.iter()
                .filter(|h| h.custom_food_id.as_deref() == Some(&food.id[..]))
                .count(),
            1,
            "and it is offered once, however many of its entries matched"
        );
    }

    /// Picking which entry a food replaces is the one case where the replaced
    /// entry has to stay visible — including to the food that replaced it,
    /// whose base could otherwise never be re-picked.
    #[test]
    fn the_base_picker_still_sees_the_entry_a_food_replaces() {
        let Some(rc) = refdb() else { return };
        let generic = db::search(&rc, "chocolate", 1).unwrap()[0].fdc_id.unwrap();

        let mut uc = user_db();
        let mut f = bar(Some(generic));
        f.name = "Dairy Milk".into();
        saved(&mut uc, &f);
        let overridden = store::overridden_fdc_ids(&uc).unwrap();

        let hits = merge_hits(&rc, &uc, "chocolate", vec![], &overridden, true, 40).unwrap();
        assert!(hits.iter().any(|h| h.fdc_id == Some(generic)));
    }

    #[test]
    fn only_the_three_image_types_this_app_stores_are_recognised() {
        assert_eq!(sniff_extension(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00]), Some("jpg"));
        assert_eq!(
            sniff_extension(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]),
            Some("png")
        );
        let mut webp = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        webp.push(0);
        assert_eq!(sniff_extension(&webp), Some("webp"));

        // A GIF, an SVG, a PDF and a shell script are all "image/jpeg" if the
        // caller says so; none of them are stored.
        assert_eq!(sniff_extension(b"GIF89a....."), None);
        assert_eq!(sniff_extension(b"<svg xmlns=..."), None);
        assert_eq!(sniff_extension(b"%PDF-1.7"), None);
        assert_eq!(sniff_extension(b"#!/bin/sh\n"), None);
        assert_eq!(sniff_extension(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(sniff_extension(&[]), None);
    }

    #[test]
    fn a_photo_name_that_is_a_path_is_refused_not_repaired() {
        assert!(is_photo_name("0f8fad5bd9cb469fa16570867728950e.jpg"));
        assert!(is_photo_name("0f8fad5b-d9cb-469f-a165-70867728950e.png"));
        assert!(is_photo_name("0f8fad5b-d9cb-469f-a165-70867728950e.webp"));

        for bad in [
            "../../../../etc/passwd",
            "../0f8fad5bd9cb469fa16570867728950e.jpg",
            "photos/0f8fad5bd9cb469fa16570867728950e.jpg",
            "photos\\0f8fad5bd9cb469fa16570867728950e.jpg",
            "/etc/passwd",
            "0f8fad5bd9cb469fa16570867728950e.jpg/../../secrets",
            "0f8fad5bd9cb469fa16570867728950e",
            "0f8fad5bd9cb469fa16570867728950e.exe",
            "0f8fad5bd9cb469fa16570867728950e.jpg.sh",
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.jpg",
            "0f8fad5b.jpg",
            ".jpg",
            "",
        ] {
            assert!(!is_photo_name(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn base64_round_trips_at_every_padding() {
        for n in 0..40usize {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 37 % 251) as u8).collect();
            let encoded = b64_encode(&bytes);
            if n == 0 {
                assert!(encoded.is_empty());
                continue;
            }
            assert_eq!(encoded.len() % 4, 0);
            assert_eq!(b64_decode(&encoded).unwrap(), bytes, "round trip of {n} bytes");
        }
        // A known vector, so an error in both directions cannot cancel out.
        assert_eq!(b64_encode(b"any carnal pleasure."), "YW55IGNhcm5hbCBwbGVhc3VyZS4=");
        assert_eq!(b64_decode("/w==").unwrap(), vec![0xFFu8]);
    }

    #[test]
    fn malformed_base64_fails_rather_than_decoding_to_something_shorter() {
        for bad in [
            "",
            "YW55",             // fine
            "YW5",              // not a multiple of four
            "YW55!GNh",         // outside the alphabet
            "YW55 IGNh=cm5h",   // padding in the middle
            "====",
            "Y===",
            "-_-_",             // url-safe alphabet is not what the frontend sends
        ] {
            let r = b64_decode(bad);
            if bad == "YW55" {
                assert!(r.is_ok());
            } else {
                assert!(r.is_err(), "{bad:?} must be refused");
            }
        }
        // Whitespace a caller wrapped it in is not corruption.
        assert_eq!(b64_decode("YW55\n IGNh").unwrap(), b"any ca".to_vec());
    }
    #[test]
    fn a_dose_raises_the_day_without_touching_how_well_the_food_is_measured() {
        let Some(rc) = refdb() else { return };
        let dim = nutrient_dim(&rc).unwrap();
        let mut uc = user_db();

        // A plain food day first, so there is something to compare against.
        store::add(
            &uc,
            "2026-09-04",
            Some("lunch"),
            store::Source::Food(328637), // "Cheese, cheddar" — measures B12 at 1.06 µg/100 g
            "Cheddar",
            store::Quantity::Grams(100.0),
            None,
            &store::Tags::default(),
        )
        .unwrap();
        let sid = store::save_supplement(&mut uc, None, &b12_tablet()).unwrap();
        store::add(
            &uc,
            "2026-09-04",
            Some("breakfast"),
            store::Source::Supplement(&sid),
            "B12",
            store::Quantity::Units(2.0),
            None,
            &store::Tags::default(),
        )
        .unwrap();

        let user = store::Store(Mutex::new(uc));
        let (entries, breakdowns, by_nutrient) =
            collect_day(&rc, &user, &dim, "2026-09-04").unwrap();
        assert_eq!(entries.len(), 2);

        let b12 = sum(by_nutrient.get(&1178).unwrap());
        // Two tablets of 1,000 µg. The food's own B12 is on top of that, so the
        // test asserts the dose's share rather than the exact total.
        let from_pills = b12.from_supplements.as_ref().expect("a dose was logged");
        assert!(
            (from_pills.lower - 2000.0).abs() < 1e-6,
            "two tablets are 2,000 µg, got {}",
            from_pills.lower
        );
        assert!(b12.lower >= 2000.0, "the day includes what the pill supplied");

        // The pill has no mass, so it cannot have moved the mass-weighted
        // coverage in either direction.
        let coverage = b12.coverage.expect("food was logged, so coverage exists");
        assert!(
            (coverage - 1.0).abs() < 1e-9,
            "cheddar measures B12, so the FOOD side is fully covered; got {coverage}"
        );

        // The breakdown names the dose, and reports no grams rather than zero.
        let pill = breakdowns
            .iter()
            .find(|b| b.components.iter().any(|c| c.description.starts_with("B12")))
            .expect("the supplement has a breakdown");
        assert_eq!(pill.components[0].grams, None);
    }

    #[test]
    fn a_water_entry_contributes_its_mass_as_water_and_nothing_else() {
        let Some(rc) = refdb() else { return };
        let dim = nutrient_dim(&rc).unwrap();
        let uc = user_db();
        let bid = store::save_bottle(&uc, None, "Steel bottle", 1050.0, None, None).unwrap();
        store::add(
            &uc, "2026-09-04", None, store::Source::Water(&bid), "Steel bottle",
            store::Quantity::Grams(500.0), None, &store::Tags::default(),
        )
        .unwrap();

        let user = store::Store(Mutex::new(uc));
        let (entries, _breakdowns, by_nutrient) =
            collect_day(&rc, &user, &dim, "2026-09-04").unwrap();
        assert_eq!(entries.len(), 1);

        // The bottle's own mass, in full, as water.
        let water = sum(by_nutrient.get(&1051).unwrap());
        assert!((water.lower - 500.0).abs() < 1e-6);
        assert_eq!(water.coverage, Some(1.0));

        // Energy is a confident zero, by definition rather than by measurement.
        let energy = sum(by_nutrient.get(&1008).unwrap());
        assert_eq!(energy.lower, 0.0);
        assert_eq!(energy.upper, Some(0.0));
        assert_eq!(
            energy.coverage,
            Some(1.0),
            "AssumedZero counts as covered — it is an assertion, not a gap"
        );

        // Anything this bottle's weight cannot settle — iron, here — stays
        // genuinely unknown rather than a silent zero, and the bottle's mass
        // still counts against how well the day covers it.
        let iron = sum(by_nutrient.get(&1089).unwrap());
        assert_eq!(iron.lower, 0.0);
        assert_eq!(iron.upper, None, "unmeasured, never a bound at zero");
        assert_eq!(
            iron.coverage,
            Some(0.0),
            "500 g were logged and none of it settled iron"
        );
    }

    #[test]
    fn a_supplement_panel_bounds_only_what_its_regime_actually_bounds() {
        let Some(rc) = refdb() else { return };

        // A US panel. Sodium is one of the fifteen it must declare, so leaving
        // it out is an assertion that there is less than 5 mg — bounded, and
        // counted as covered. Selenium is voluntary, so its absence says
        // nothing at all and stays unknown.
        let us = b12_tablet();
        let panel = resolve_supplement_panel(&rc, &us).unwrap();
        let values = panel.values();
        assert!(
            matches!(values.get(&1093), Some(NutrientValue::LabelZero { .. })),
            "omitted sodium on a US panel is a bound, got {:?}",
            values.get(&1093)
        );
        assert_eq!(values.get(&1103), Some(&NutrientValue::Absent));

        // The same bottle with an Indian panel bounds neither: FSSAI has no
        // mandatory list and no declarable-zero threshold.
        let mut other = b12_tablet();
        other.regime = "other".into();
        let values = resolve_supplement_panel(&rc, &other).unwrap().values();
        assert_eq!(values.get(&1093), Some(&NutrientValue::Absent));
        assert_eq!(values.get(&1103), Some(&NutrientValue::Absent));

        // And only the user's own assertion makes an omission a true zero.
        let mut complete = b12_tablet();
        complete.panel_complete = true;
        let values = resolve_supplement_panel(&rc, &complete).unwrap().values();
        assert_eq!(values.get(&1103), Some(&NutrientValue::AssumedZero));
    }

    #[test]
    fn one_tablet_of_a_two_tablet_serving_is_half_the_panel() {
        let Some(rc) = refdb() else { return };
        let dim = nutrient_dim(&rc).unwrap();
        let mut uc = user_db();

        let mut two = b12_tablet();
        two.serving_units = 2.0;
        two.serving_label = Some("2 tablets".into());
        let sid = store::save_supplement(&mut uc, None, &two).unwrap();
        store::add(
            &uc,
            "2026-09-04",
            Some("breakfast"),
            store::Source::Supplement(&sid),
            "B12",
            store::Quantity::Units(1.0),
            None,
            &store::Tags::default(),
        )
        .unwrap();

        let user = store::Store(Mutex::new(uc));
        let (_e, _b, by_nutrient) = collect_day(&rc, &user, &dim, "2026-09-04").unwrap();
        let b12 = sum(by_nutrient.get(&1178).unwrap());
        let from_pills = b12.from_supplements.as_ref().unwrap();
        assert!(
            (from_pills.lower - 500.0).abs() < 1e-6,
            "one tablet of a 1,000 µg two-tablet serving is 500 µg, got {}",
            from_pills.lower
        );
    }

    #[test]
    fn a_supplement_only_day_is_left_out_of_the_period_rollup_it_is_not_divided_by() {
        // The numerator and the denominator have to describe the same days.
        // Summing a vitamin taken on a day nothing was eaten, while dividing by
        // days that had food, inflates every nutrient that vitamin carried.
        let Some(rc) = refdb() else { return };
        let dim = nutrient_dim(&rc).unwrap();
        let mut uc = user_db();
        let sid = store::save_supplement(&mut uc, None, &b12_tablet()).unwrap();

        // One day of food, one day of nothing but a tablet.
        store::add(
            &uc, "2026-09-05", Some("lunch"), store::Source::Food(328637), "Cheddar",
            store::Quantity::Grams(100.0), None, &store::Tags::default(),
        )
        .unwrap();
        store::add(
            &uc, "2026-09-04", Some("breakfast"), store::Source::Supplement(&sid), "B12",
            store::Quantity::Units(1.0), None, &store::Tags::default(),
        )
        .unwrap();

        let logged = store::logged_days_between(&uc, "2026-09-01", "2026-09-30").unwrap();
        assert_eq!(logged.len(), 2, "both days hold something");

        let mut merged: HashMap<i64, Vec<Contribution>> = HashMap::new();
        let user = store::Store(Mutex::new(uc));
        let mut food_days = 0usize;
        for day in &logged {
            let (_e, _b, by_nutrient) = collect_day(&rc, &user, &dim, &day.date).unwrap();
            if day.food_items > 0 {
                food_days += 1;
                for (id, c) in by_nutrient {
                    merged.entry(id).or_default().extend(c);
                }
            }
        }
        assert_eq!(food_days, 1);
        let b12 = sum(merged.get(&1178).unwrap());
        assert!(
            b12.from_supplements.is_none(),
            "the tablet was taken on a day with no food, so it is not in the rollup \
             that gets divided by food days"
        );
    }

    #[test]
    fn a_water_only_day_is_left_out_of_the_period_rollup_it_is_not_divided_by() {
        // Finishing a bottle is not a claim about what, or whether, anything
        // was eaten — the same reasoning that keeps a supplement-only day out
        // of this same rollup.
        let Some(rc) = refdb() else { return };
        let dim = nutrient_dim(&rc).unwrap();
        let uc = user_db();
        let bid = store::save_bottle(&uc, None, "Steel bottle", 1050.0, None, None).unwrap();

        // One day of food, one day of nothing but water.
        store::add(
            &uc, "2026-09-05", Some("lunch"), store::Source::Food(328637), "Cheddar",
            store::Quantity::Grams(100.0), None, &store::Tags::default(),
        )
        .unwrap();
        store::add(
            &uc, "2026-09-04", None, store::Source::Water(&bid), "Steel bottle",
            store::Quantity::Grams(500.0), None, &store::Tags::default(),
        )
        .unwrap();

        let logged = store::logged_days_between(&uc, "2026-09-01", "2026-09-30").unwrap();
        assert_eq!(logged.len(), 2, "both days hold something");

        let mut merged: HashMap<i64, Vec<Contribution>> = HashMap::new();
        let user = store::Store(Mutex::new(uc));
        let mut food_days = 0usize;
        for day in &logged {
            let (_e, _b, by_nutrient) = collect_day(&rc, &user, &dim, &day.date).unwrap();
            if day.food_items > 0 {
                food_days += 1;
                for (id, c) in by_nutrient {
                    merged.entry(id).or_default().extend(c);
                }
            }
        }
        assert_eq!(food_days, 1);
        // The water-only day's bottle must not appear in the merged total at
        // all — only Cheddar's own component, from the one day with food —
        // or a period average would understate every nutrient's coverage by a
        // bottle that carried no food.
        assert_eq!(
            merged.get(&1051).unwrap().len(),
            1,
            "the bottle from the water-only day must not have been merged in"
        );
    }

    #[test]
    fn a_zero_printed_on_a_panel_is_stored_as_a_bound_not_as_a_measurement() {
        // 21 CFR 101.36 lets a pack print 0 below a threshold, so a printed zero
        // is "less than that" and never an observed absence. This is the same
        // rule a custom food's declared zero already goes through.
        let Some(conn) = refdb() else { return };

        // Sodium: 21 CFR 101.9(c)(4) puts the ceiling at 5 mg.
        let meta = db::displayed_nutrients(&conn)
            .unwrap()
            .into_iter()
            .find(|m| m.id == 1093)
            .unwrap();
        let converted =
            supplement::convert(1093, &meta.magnitude, 0.0, supplement::LabelUnit::Mg, supplement::Form::Unspecified)
                .unwrap();
        assert_eq!(converted, 0.0);
        assert_eq!(
            trackit_core::label::rounding_ceiling(1093),
            Some(5.0),
            "the bound a printed zero earns comes from the regulation, not from here"
        );
    }

    // -----------------------------------------------------------------------
    // Reading the panel off a photo
    // -----------------------------------------------------------------------

    #[test]
    fn panel_lines_are_told_apart_from_whatever_else_is_on_the_table() {
        for line in [
            "Nutrition Facts",
            "Serving Size 1 package (57g)",
            "Total Fat 5g       6%",
            "Includes 14g Added Sugars",
            "Vit. D 0.6mcg 4%",
            "Potas. 150mg 4%",
            "Cholest. 0mg",
            "% Daily Value*",
        ] {
            assert!(looks_like_panel_line(line), "{line:?} is panel content");
        }
        for line in [
            "Nature's Bakery",
            "BEST BY 09/2026",
            "Distributed by Nature's Bakery LLC, Reno NV",
            "esc  F1  F2  F3",
            "",
        ] {
            assert!(!looks_like_panel_line(line), "{line:?} is not panel content");
        }
    }

    #[test]
    fn a_word_inside_a_longer_word_is_not_a_panel_line() {
        // The indicator must not call a keyboard or an ingredient list a panel
        // just because a nutrient name is a substring of something on it.
        assert!(!looks_like_panel_line("contains hydrogenated fatty acids"));
        assert!(!looks_like_panel_line("Ironbound Coffee Roasters"));
        assert!(looks_like_panel_line("Total Fat 5g"));
    }

    #[test]
    fn a_photo_with_nothing_readable_says_so_rather_than_reporting_zero_nutrients() {
        let t = trouble_for(0, 0, 0).expect("a photo with no text at all is trouble");
        assert!(t.contains("No text was found"), "{t}");

        let t = trouble_for(0, 9, 0).expect("text but no panel is trouble");
        assert!(t.contains("No nutrition panel was found"), "{t}");
        assert!(
            !t.contains("No text was found"),
            "a legible photo of the wrong side of the pack is a different problem"
        );

        let t = trouble_for(0, 22, 14).expect("a legible panel yielding nothing is trouble");
        assert!(t.contains("legible"), "{t}");
        assert!(
            !t.contains("No nutrition panel"),
            "the panel WAS found; what failed was reading its layout"
        );

        assert!(
            trouble_for(15, 22, 14).is_none(),
            "a scan that produced values is not trouble"
        );
        assert!(
            trouble_for(1, 3, 1).is_none(),
            "nor is a thin one — the editor reports how many of fifteen it got"
        );
    }

    #[test]
    fn a_printed_zero_is_suggested_as_a_bound_and_never_as_a_measured_zero() {
        let z = scan_reading(&panel::Reading {
            nutrient_id: 1258,
            entry: LabelEntry::DeclaredZero,
        })
        .expect("saturated fat has a ceiling in 101.9(c)");
        assert_eq!(z.kind, "label_zero");
        assert_eq!(z.amount, None, "a declared zero carries no measured amount");
        assert_eq!(z.upper, Some(0.5));

        let m = scan_reading(&panel::Reading {
            nutrient_id: 1004,
            entry: LabelEntry::Printed { amount: 5.0 },
        })
        .unwrap();
        assert_eq!(m.kind, "measured");
        assert_eq!(m.amount, Some(5.0), "5 g of fat, not the 6% beside it");
        assert_eq!(m.upper, None);

        let l = scan_reading(&panel::Reading {
            nutrient_id: 1079,
            entry: LabelEntry::LessThan { upper: 1.0 },
        })
        .unwrap();
        assert_eq!(l.kind, "below_loq");
        assert_eq!(l.amount, None);
        assert_eq!(l.upper, Some(1.0));
    }

    #[test]
    fn every_suggested_row_is_one_the_store_would_accept() {
        // A suggestion the user confirms goes straight into `save_custom_food`,
        // which refuses a measured row without a number and a bounded row
        // without a bound. If a suggestion could not survive that, the accept
        // control would be a dead end.
        for id in [
            1008, 1004, 1258, 1257, 1253, 1093, 1005, 1079, 2000, 1235, 1003, 1114, 1089, 1087,
            1092,
        ] {
            for entry in [
                LabelEntry::Printed { amount: 3.0 },
                LabelEntry::DeclaredZero,
                LabelEntry::LessThan { upper: 1.0 },
            ] {
                let Some(r) = scan_reading(&panel::Reading {
                    nutrient_id: id,
                    entry,
                }) else {
                    // Only a nutrient with no ceiling at all may be dropped, and
                    // only for a declared zero.
                    assert_eq!(label::rounding_ceiling(id), None, "nutrient {id}");
                    continue;
                };
                assert!(
                    ["measured", "label_zero", "below_loq"].contains(&r.kind.as_str()),
                    "nutrient {id}: {:?} is not a kind the store stores",
                    r.kind
                );
                if r.kind == "measured" {
                    assert!(r.amount.is_some() && r.upper.is_none(), "nutrient {id}");
                    assert!(r.amount.unwrap() >= 0.0, "nutrient {id}");
                } else {
                    assert!(r.amount.is_none(), "nutrient {id}: a bound is not a point");
                    let upper = r.upper.unwrap_or_else(|| panic!("nutrient {id} needs a bound"));
                    assert!(upper > 0.0, "nutrient {id}: a bound must be positive");
                }
            }
        }
    }

    /// Build one decoded observation the way the recogniser hands it over.
    fn seen(payload: &str, symbology: &str, confidence: f32) -> crate::vision::Barcode {
        crate::vision::Barcode {
            payload: payload.into(),
            symbology: symbology.into(),
            confidence,
        }
    }

    #[test]
    fn a_scan_that_found_nothing_says_which_of_the_three_things_went_wrong() {
        let t = scan_trouble(false, 0, "the ingredient list", None)
            .expect("a photo with no text at all is trouble");
        assert!(t.contains("No text was found"), "{t}");
        assert!(
            t.contains("the ingredient list"),
            "the sentence names what should have filled the frame: {t}"
        );

        let t = scan_trouble(false, 14, "a Supplement Facts panel", None)
            .expect("text but no panel is trouble");
        assert!(!t.contains("No text was found"), "{t}");
        assert!(t.contains("a Supplement Facts panel"), "{t}");

        // The parser saw the rows and knows better than this function why they
        // did not read, so its sentence is the one the user gets.
        let t = scan_trouble(
            false,
            22,
            "the ingredient list",
            Some("The list was found but ran off the edge of the frame.".into()),
        )
        .expect("a parser that reported trouble is trouble");
        assert_eq!(t, "The list was found but ran off the edge of the frame.");

        assert!(
            scan_trouble(true, 22, "the ingredient list", None).is_none(),
            "a scan that produced something is not trouble"
        );
        assert!(
            scan_trouble(true, 22, "the ingredient list", Some("some quibble".into())).is_none(),
            "nor is it trouble because the parser also had something to say"
        );
    }

    #[test]
    fn a_pairing_code_is_recognised_from_either_engines_spelling_and_nothing_else() {
        // Both engines, because a household is a Mac and a phone and the string
        // is not the same on the two. Getting one of them wrong is a camera
        // sheet that never finds a code that is plainly in the frame.
        assert!(is_pair_qr(&seen(
            "trackit-household-1|192.168.0.7|51733|AAAA|2026-09-10T12:00:00Z",
            "VNBarcodeSymbologyQR",
            1.0
        )));
        assert!(is_pair_qr(&seen(
            "trackit-household-1|192.168.0.7|51733|AAAA|2026-09-10T12:00:00Z",
            "QR",
            0.4
        )));
        // An EAN off a packet of beans is not a way into somebody's household,
        // and neither is a QR that decoded to nothing at all.
        assert!(!is_pair_qr(&seen("9780201379624", "VNBarcodeSymbologyEAN13", 1.0)));
        assert!(!is_pair_qr(&seen("   ", "QR", 1.0)));
    }

    #[test]
    fn the_product_code_wins_over_a_website_qr_in_the_same_frame() {
        // A pack carrying both. The QR reads perfectly and is still not the
        // thing the barcode field is for.
        let found = [
            seen("https://example.com/fig-bars", "VNBarcodeSymbologyQR", 1.0),
            seen("9780201379624", "VNBarcodeSymbologyEAN13", 0.55),
        ];
        let best = best_barcode(&found).expect("a frame with two codes has a best one");
        assert_eq!(best.payload, "9780201379624");
        assert!(best.trusted, "its check digit computes");
    }

    #[test]
    fn a_verified_code_beats_a_misread_one_however_confidently_it_was_read() {
        let found = [
            // Last digit changed: a misread, whatever Vision thinks of it.
            seen("9780201379625", "VNBarcodeSymbologyEAN13", 1.0),
            seen("036000291452", "VNBarcodeSymbologyUPCA", 0.30),
        ];
        let best = best_barcode(&found).expect("one of the two is offerable");
        assert_eq!(best.payload, "036000291452");
        assert!(best.trusted);
    }

    #[test]
    fn a_code_that_does_not_verify_comes_back_untrusted_and_not_absent() {
        let found = [seen("9780201379625", "VNBarcodeSymbologyEAN13", 0.9)];
        let best = best_barcode(&found).expect("it was read; it just cannot be believed");
        assert_eq!(
            best.payload, "9780201379625",
            "the digits are kept so the user can see what was misread"
        );
        assert!(
            !best.trusted,
            "a failed check digit must never come back as a value"
        );
    }

    #[test]
    fn a_verified_code_reports_the_display_name_and_says_its_digits_were_checked() {
        // The two sides of the IPC boundary, pinned together: a screen wording
        // an assurance reads `check_digit_verified`, and `symbology` is the
        // human spelling rather than the recogniser's constant.
        let best = best_barcode(&[seen("5449000000996", "VNBarcodeSymbologyEAN13", 0.9)])
            .expect("a valid EAN-13 is a result");
        assert_eq!(best.symbology, "EAN-13");
        assert!(best.trusted);
        assert!(best.verified, "its check digit computes");

        // A symbology with nothing to check: offerable, but no arithmetic ran.
        let qr = best_barcode(&[seen("https://example.com/x", "VNBarcodeSymbologyQR", 1.0)])
            .expect("a QR is still a decode");
        assert_eq!(qr.symbology, "QR");
        assert!(qr.trusted, "nothing contradicts it");
        assert!(
            !qr.verified,
            "a QR carries no check digit, so nothing about it was verified"
        );
    }

    #[test]
    fn an_observation_with_no_payload_is_not_a_barcode() {
        assert!(
            best_barcode(&[seen("", "VNBarcodeSymbologyEAN13", 0.99)]).is_none(),
            "an empty decode is a failure, not a result"
        );
        assert!(
            best_barcode(&[seen("   ", "VNBarcodeSymbologyCode128", 0.99)]).is_none(),
            "nor is whitespace"
        );
        assert!(best_barcode(&[]).is_none(), "an empty frame yields nothing");
    }

    #[test]
    fn ranking_prefers_verified_then_numeric_then_confidence() {
        let numeric_ok = barcode::Checked {
            payload: "036000291452".into(),
            symbology: "UPC-A".into(),
            trusted: true,
            verified: true,
            note: None,
        };
        let text_ok = barcode::Checked {
            payload: "FIGBAR-12".into(),
            symbology: "Code 128".into(),
            trusted: true,
            verified: false,
            note: Some("Code 128 carries no check digit.".into()),
        };
        let numeric_bad = barcode::Checked {
            payload: "036000291453".into(),
            symbology: "UPC-A".into(),
            trusted: false,
            verified: false,
            note: Some("its check digit does not compute".into()),
        };
        assert!(barcode_rank(&numeric_ok, 0.1) > barcode_rank(&text_ok, 1.0));
        assert!(barcode_rank(&text_ok, 0.1) > barcode_rank(&numeric_bad, 1.0));
        assert!(barcode_rank(&numeric_ok, 0.9) > barcode_rank(&numeric_ok, 0.4));
        assert!(
            barcode_rank(&numeric_ok, 0.3) > barcode_rank(&text_ok, 1.0),
            "a code whose arithmetic ran beats an all-digit lot code Vision is sure of"
        );
    }
    fn profile_of(
        sex: Option<&str>,
        birth_year: Option<i64>,
        height: Option<f64>,
        weight: Option<f64>,
        activity: Option<&str>,
        energy: Option<f64>,
    ) -> store::Profile {
        store::Profile {
            sex: sex.map(String::from),
            birth_year,
            height_cm: height,
            weight_kg: weight,
            activity: activity.map(String::from),
            life_stage: "standard".into(),
            energy_kcal: energy,
        }
    }

    #[test]
    fn an_empty_profile_gives_no_energy_target_rather_than_a_made_up_one() {
        // This is what replaced the hard-coded 2,200 kcal. A number that
        // describes nobody in particular is worse than no number: the dashboard
        // was drawing a progress rail against it.
        let g = goals_from(&profile_of(None, None, None, None, None, None), &[]);
        assert!(g.energy.is_none());
        assert!(g.macro_ranges.is_empty(), "a share of no energy is not a range");
        assert!(g.group.is_none());
    }

    #[test]
    fn a_partial_body_still_gives_no_estimate() {
        // Height but no weight, or no activity level: guessing at the missing
        // one would produce a fiction with a plausible number attached.
        let g = goals_from(
            &profile_of(Some("male"), Some(1990), Some(175.0), None, Some("light"), None),
            &[],
        );
        assert!(g.energy.is_none());
        // ...but age and sex alone are enough to place them in the DRI tables,
        // which is the more important half.
        assert!(g.group.is_some());
        assert_eq!(g.by_nutrient.get(&1089).unwrap().amount, 8.0);
    }

    #[test]
    fn a_complete_body_is_estimated_and_says_it_is_an_estimate() {
        let g = goals_from(
            &profile_of(Some("male"), Some(1990), Some(175.0), Some(70.0), Some("sedentary"), None),
            &[],
        );
        let e = g.energy.expect("a complete body estimates");
        assert_eq!(e.basis, "estimated");
        // The working is carried so the screen can show it rather than asking
        // the user to take the figure on faith.
        assert!(e.resting.is_some());
        assert!(e.factor.is_some());
        assert!(e.kcal > e.resting.unwrap());
    }

    #[test]
    fn the_users_own_energy_figure_beats_the_estimate() {
        let g = goals_from(
            &profile_of(Some("male"), Some(1990), Some(175.0), Some(70.0), Some("sedentary"), Some(2600.0)),
            &[],
        );
        let e = g.energy.unwrap();
        assert_eq!(e.kcal, 2600.0);
        assert_eq!(e.basis, "user_set");
        assert!(e.resting.is_none(), "there is no working behind a figure they gave");
    }

    #[test]
    fn macro_ranges_follow_whichever_energy_figure_is_in_force() {
        let g = goals_from(
            &profile_of(Some("male"), Some(1990), Some(175.0), Some(70.0), Some("sedentary"), Some(2000.0)),
            &[],
        );
        let carb = g
            .macro_ranges
            .iter()
            .find(|m| m.nutrient_id == 1005)
            .expect("carbohydrate has an AMDR");
        // 45-65% of 2,000 kcal at 4 kcal/g is 225-325 g.
        assert!((carb.low_g - 225.0).abs() < 1e-9, "got {}", carb.low_g);
        assert!((carb.high_g - 325.0).abs() < 1e-9, "got {}", carb.high_g);
    }

    #[test]
    fn a_profile_changes_the_denominator_a_day_is_read_against() {
        // The same logged day, read against two different people. Iron is the
        // clearest case: the Daily Value says 18 mg for everybody.
        let man = goals_from(&profile_of(Some("male"), Some(1990), None, None, None, None), &[]);
        let woman = goals_from(&profile_of(Some("female"), Some(1990), None, None, None, None), &[]);
        let nobody = goals_from(&profile_of(None, None, None, None, None, None), &[]);

        assert_eq!(man.by_nutrient.get(&1089).unwrap().amount, 8.0);
        assert_eq!(woman.by_nutrient.get(&1089).unwrap().amount, 18.0);
        assert_eq!(nobody.by_nutrient.get(&1089).unwrap().amount, 18.0);
        // And each says which system it came from, so no screen can print a
        // percentage without being able to name its denominator.
        assert_eq!(man.by_nutrient.get(&1089).unwrap().basis.as_str(), "rda");
        assert_eq!(nobody.by_nutrient.get(&1089).unwrap().basis.as_str(), "daily_value");
    }

    #[test]
    fn a_users_own_target_survives_resolution_into_the_day() {
        let g = goals_from(
            &profile_of(Some("male"), Some(1990), None, None, None, None),
            &[store::NutrientTarget { nutrient_id: 1089, amount: 25.0, note: None }],
        );
        let iron = g.by_nutrient.get(&1089).unwrap();
        assert_eq!(iron.amount, 25.0);
        assert_eq!(iron.basis.as_str(), "user_set");
    }

    #[test]
    fn age_is_derived_to_within_a_year_and_refuses_nonsense() {
        let now = current_year().expect("the clock works");
        assert_eq!(age_from(Some(now - 30)), Some(30));
        assert_eq!(age_from(None), None);
        // A birth year in the future, or one implying an impossible age, is not
        // an age at all.
        assert_eq!(age_from(Some(now + 5)), None);
        assert_eq!(age_from(Some(now - 200)), None);
    }


    /// Freezing history.
    ///
    /// Each test here changes the thing an entry was resolved from AFTER it was
    /// logged, and asserts the logged day did not move. Every one also carries a
    /// positive control — a second entry logged after the change — because a
    /// test that froze nothing and resolved nothing would otherwise pass.
    mod frozen_history {
        use super::*;

        const DAY: &str = "2026-03-01";
        const LATER: &str = "2026-06-01";
        const FAT: i64 = 1004;
        const B12: i64 = 1178;

        fn no_tags() -> store::Tags {
            store::Tags {
                origin: None,
                cuisine: None,
            }
        }

        /// The lower bound a day reports for one nutrient — what the screen puts
        /// in front of the user.
        fn lower_on(
            refconn: &Connection,
            user: &store::Store,
            dim: &Dim,
            date: &str,
            nutrient_id: i64,
        ) -> f64 {
            let (_, _, by) = collect_day(refconn, user, dim, date).unwrap();
            let empty: Vec<Contribution> = Vec::new();
            trackit_core::aggregate::sum(by.get(&nutrient_id).unwrap_or(&empty)).lower
        }

        #[test]
        fn a_dish_built_on_your_own_pack_counts_the_pack_and_says_where_it_came_from() {
            // The point of letting a recipe name one of the user's own foods.
            // A dish assembled out of packs is mostly gaps, so the breakdown row
            // has to carry the pack's provenance the way a directly logged one
            // does — otherwise 400 g of "Costco extra-firm tofu" reads as solid
            // as a lab measurement when most of its panel is missing.
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            // 13 g of fat per 43 g serving, which is what `bar` prints.
            let own = store::save_custom_food(&mut uc, None, &bar(None)).unwrap();
            let rid = store::save_recipe(
                &mut uc, "Chocolate thing", 100.0, None, None,
                &[store::RecipeIngredient {
                    id: String::new(), position: 0, fdc_id: None,
                    custom_food_id: Some(own), description: "Milk chocolate bar".into(),
                    raw_g: 43.0, optional: false,
                }],
                &[], &store::Tags::default(),
            )
            .unwrap();

            // The whole 100 g dish, so the fraction is 1 and the whole bar is in.
            add_frozen(
                &refconn, &mut uc, DAY, Some("snack"), store::Source::Recipe(&rid),
                "Chocolate thing", store::Quantity::Grams(100.0), None, &no_tags(),
            )
            .unwrap();

            let store = store::Store(Mutex::new(uc));
            let fat = lower_on(&refconn, &store, &dim, DAY, FAT);
            assert!(
                (fat - 13.0).abs() < 1e-6,
                "the dish must be worth what its one line's pack prints — got {fat}"
            );
        }

        #[test]
        fn a_line_naming_one_of_your_own_foods_carries_its_provenance_into_the_breakdown() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();
            let own = store::save_custom_food(&mut uc, None, &bar(None)).unwrap();
            let rid = store::save_recipe(
                &mut uc, "Chocolate thing", 100.0, None, None,
                &[store::RecipeIngredient {
                    id: String::new(), position: 0, fdc_id: None,
                    custom_food_id: Some(own), description: "Milk chocolate bar".into(),
                    raw_g: 43.0, optional: false,
                }],
                &[], &store::Tags::default(),
            )
            .unwrap();
            add_frozen(
                &refconn, &mut uc, DAY, Some("snack"), store::Source::Recipe(&rid),
                "Chocolate thing", store::Quantity::Grams(100.0), None, &no_tags(),
            )
            .unwrap();

            let store = store::Store(Mutex::new(uc));
            let (_, breakdowns, _) = collect_day(&refconn, &store, &dim, DAY).unwrap();
            let line = &breakdowns[0].components[0];
            assert!(
                line.description.contains("Milk chocolate bar")
                    && line.description.contains("off the pack"),
                "the row must name the pack and say how much of its panel is real — got {}",
                line.description
            );
            assert!(line.has_data, "a pack with figures on it is not a gap");
        }

        #[test]
        fn editing_a_food_does_not_change_a_day_already_logged() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            let food_id = store::save_custom_food(&mut uc, None, &bar(None)).unwrap();
            add_frozen(
                &refconn,
                &mut uc,
                DAY,
                Some("snack"),
                store::Source::Custom(&food_id),
                "Milk chocolate bar",
                store::Quantity::Grams(BAR),
                None,
                &no_tags(),
            )
            .unwrap();

            let user = store::Store(Mutex::new(uc));
            let march = lower_on(&refconn, &user, &dim, DAY, FAT);
            assert!(march > 12.9 && march < 13.1, "43 g declaring 13 g: {march}");

            // The manufacturer reformulates and the user corrects the pack.
            {
                let mut c = user.0.lock().unwrap();
                let mut reformulated = bar(None);
                reformulated.nutrients = vec![nutrient(FAT, "measured", Some(4.0), None)];
                store::save_custom_food(&mut c, Some(&food_id), &reformulated).unwrap();

                // The positive control: the SAME food, logged after the edit.
                add_frozen(
                    &refconn,
                    &mut c,
                    LATER,
                    Some("snack"),
                    store::Source::Custom(&food_id),
                    "Milk chocolate bar",
                    store::Quantity::Grams(BAR),
                    None,
                    &store::Tags::default(),
                )
                .unwrap();
            }

            let june = lower_on(&refconn, &user, &dim, LATER, FAT);
            assert!(june > 3.9 && june < 4.1, "the edit must reach a new day: {june}");
            assert_eq!(
                march,
                lower_on(&refconn, &user, &dim, DAY, FAT),
                "March ate the old pack and must still say so"
            );
        }

        #[test]
        fn deleting_a_food_leaves_the_days_it_was_eaten_on_intact() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            let food_id = store::save_custom_food(&mut uc, None, &bar(None)).unwrap();
            add_frozen(
                &refconn,
                &mut uc,
                DAY,
                Some("snack"),
                store::Source::Custom(&food_id),
                "Milk chocolate bar",
                store::Quantity::Grams(BAR),
                None,
                &no_tags(),
            )
            .unwrap();

            let user = store::Store(Mutex::new(uc));
            let before = lower_on(&refconn, &user, &dim, DAY, FAT);
            assert!(before > 0.0);

            {
                let c = user.0.lock().unwrap();
                store::delete_custom_food(&c, &food_id).unwrap();
            }

            assert_eq!(
                before,
                lower_on(&refconn, &user, &dim, DAY, FAT),
                "deleting a food removes it from future logging, not from the past"
            );
        }

        #[test]
        fn deleting_a_recipe_leaves_the_days_it_was_eaten_on_intact() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            // Any real reference food will do; the test is about the recipe
            // surviving, not about which food it is made of.
            let fdc_id: i64 = refconn
                .query_row(
                    "SELECT fn.fdc_id FROM food_nutrients fn
                     WHERE fn.nutrient_id = ?1 AND fn.value_kind = 'measured'
                       AND fn.amount > 5 LIMIT 1",
                    [FAT],
                    |r| r.get(0),
                )
                .unwrap();
            let mut uc = user_db();

            let recipe_id = store::save_recipe(
                &mut uc,
                "Rajma",
                1000.0,
                Some(4.0),
                None,
                &[store::RecipeIngredient {
                    id: String::new(),
                    position: 0,
                    fdc_id: Some(fdc_id),
                    custom_food_id: None,
                    description: "kidney beans".into(),
                    raw_g: 400.0,
                    optional: false,
                }],
                &[],
                &no_tags(),
            )
            .unwrap();
            add_frozen(
                &refconn,
                &mut uc,
                DAY,
                Some("dinner"),
                store::Source::Recipe(&recipe_id),
                "Rajma",
                store::Quantity::Grams(250.0),
                None,
                &no_tags(),
            )
            .unwrap();

            let user = store::Store(Mutex::new(uc));
            let before = lower_on(&refconn, &user, &dim, DAY, FAT);
            assert!(before > 0.0, "the dish must contribute something to test");

            // The recipe's name is part of the frozen record too, so the
            // breakdown still says what was eaten.
            let (_, breakdowns, _) = collect_day(&refconn, &user, &dim, DAY).unwrap();
            assert_eq!(breakdowns[0].recipe_name.as_deref(), Some("Rajma"));

            {
                let c = user.0.lock().unwrap();
                store::delete_recipe(&c, &recipe_id).unwrap();
            }

            assert_eq!(
                before,
                lower_on(&refconn, &user, &dim, DAY, FAT),
                "a deleted recipe must not take its history with it"
            );
            let (_, breakdowns, _) = collect_day(&refconn, &user, &dim, DAY).unwrap();
            assert_eq!(
                breakdowns[0].recipe_name.as_deref(),
                Some("Rajma"),
                "and the dish must still be named"
            );
        }

        /// A pot of one fatty ingredient, for the yield-divisor tests below.
        ///
        /// `expected_g` is what the recipe said the dish comes out at; `weighed`
        /// is what the pot actually read. The 400 g of beans is the same in both
        /// cases, because a raw weight is a fact about what went in and has
        /// nothing to do with how far the pot was reduced.
        fn pot_of(fdc_id: i64, expected_g: f64, weighed: Option<f64>) -> store::CookInput {
            store::CookInput {
                recipe_id: None,
                name: "Rajma".into(),
                cooked_on: DAY.into(),
                scale: 1.0,
                gross_g: None,
                vessel_ids: Vec::new(),
                weighed_yield_g: weighed,
                expected_yield_g: expected_g,
                notes: None,
                defaults: store::Tags::default(),
                ingredients: vec![store::CookIngredient {
                    id: String::new(),
                    position: 0,
                    fdc_id: Some(fdc_id),
                    custom_food_id: None,
                    description: "kidney beans".into(),
                    planned_g: 400.0,
                    raw_g: 400.0,
                    substituted_for: None,
                }],
            }
        }

        /// Any reference food with real fat in it. Which one does not matter —
        /// these tests are about the divisor, not about the ingredient.
        fn a_fatty_food(refconn: &Connection) -> i64 {
            refconn
                .query_row(
                    "SELECT fn.fdc_id FROM food_nutrients fn
                     WHERE fn.nutrient_id = ?1 AND fn.value_kind = 'measured'
                       AND fn.amount > 5 LIMIT 1",
                    [FAT],
                    |r| r.get(0),
                )
                .unwrap()
        }

        #[test]
        fn a_weighed_pot_concentrates_a_portion_and_an_unweighed_one_does_not() {
            // The whole reason `weighed_yield_g` is a separate column. Two pots
            // with identical ingredients, one boiled down to 500 g and one never
            // put on a scale: the same 250 g helping is half the first pot and a
            // quarter of the second, so it carries twice the nutrients.
            //
            // Water leaves a pot; nutrients do not. Dividing by the measurement
            // rather than by the sum of the lines is what says so.
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let fdc_id = a_fatty_food(&refconn);

            let mut estimated = user_db();
            let e_id = store::save_cook(&mut estimated, None, &pot_of(fdc_id, 1000.0, None)).unwrap();
            add_frozen(
                &refconn, &mut estimated, DAY, Some("dinner"),
                store::Source::Cook(&e_id), "Rajma",
                store::Quantity::Grams(250.0), None, &no_tags(),
            )
            .unwrap();

            let mut reduced = user_db();
            let r_id =
                store::save_cook(&mut reduced, None, &pot_of(fdc_id, 1000.0, Some(500.0))).unwrap();
            add_frozen(
                &refconn, &mut reduced, DAY, Some("dinner"),
                store::Source::Cook(&r_id), "Rajma",
                store::Quantity::Grams(250.0), None, &no_tags(),
            )
            .unwrap();

            let e = lower_on(&refconn, &store::Store(Mutex::new(estimated)), &dim, DAY, FAT);
            let r = lower_on(&refconn, &store::Store(Mutex::new(reduced)), &dim, DAY, FAT);
            assert!(e > 0.0, "the pot must contribute something to compare");
            assert!(
                (r / e - 2.0).abs() < 1e-6,
                "a 500 g weighed pot must value a 250 g helping at twice a 1000 g \
                 estimated one — got {r} against {e}"
            );
        }

        #[test]
        fn an_ingredient_left_out_is_absent_from_the_breakdown_not_merely_zero() {
            // The distinction the whole app rests on, one level up. An
            // ingredient with no composition data stays visible and keeps its
            // mass against the day's coverage, because it WAS in the food and is
            // unmeasured. One dialled to zero was not in the food at all, and
            // must not appear — a row reading "0 g of asafoetida" would claim a
            // measurement of something that never went in.
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let fdc_id = a_fatty_food(&refconn);
            let mut uc = user_db();

            let mut input = pot_of(fdc_id, 900.0, Some(900.0));
            input.ingredients.push(store::CookIngredient {
                id: String::new(),
                position: 1,
                fdc_id: None,
                custom_food_id: None,
                description: "home-ground masala".into(),
                planned_g: 20.0,
                raw_g: 20.0,
                substituted_for: None,
            });
            input.ingredients.push(store::CookIngredient {
                id: String::new(),
                position: 2,
                fdc_id: Some(fdc_id),
                custom_food_id: None,
                description: "asafoetida".into(),
                planned_g: 1.0,
                // Left out. Zero here is a measurement, not a missing value.
                raw_g: 0.0,
                substituted_for: None,
            });
            let cid = store::save_cook(&mut uc, None, &input).unwrap();
            add_frozen(
                &refconn, &mut uc, DAY, Some("dinner"),
                store::Source::Cook(&cid), "Rajma",
                store::Quantity::Grams(300.0), None, &no_tags(),
            )
            .unwrap();

            let user = store::Store(Mutex::new(uc));
            let (_, breakdowns, _) = collect_day(&refconn, &user, &dim, DAY).unwrap();
            let names: Vec<&str> = breakdowns[0]
                .components
                .iter()
                .map(|c| c.description.as_str())
                .collect();
            assert!(
                names.iter().any(|n| n.contains("kidney beans")),
                "what went in is listed"
            );
            assert!(
                names.iter().any(|n| n.contains("home-ground masala")),
                "an unmeasured ingredient stays visible — its gap is the point"
            );
            assert!(
                !names.iter().any(|n| n.contains("asafoetida")),
                "but one left out was never in the food, so it must not appear: {names:?}"
            );
            assert_eq!(breakdowns[0].recipe_name.as_deref(), Some("Rajma"));
            assert_eq!(
                breakdowns[0].recipe_servings, None,
                "a pot feeds whoever was there, and that was never recorded"
            );
        }

        #[test]
        fn a_substituted_line_names_both_what_was_eaten_and_what_it_replaced() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let fdc_id = a_fatty_food(&refconn);
            let mut uc = user_db();

            let mut input = pot_of(fdc_id, 800.0, Some(800.0));
            input.ingredients[0].description = "masoor dal".into();
            input.ingredients[0].substituted_for = Some("toor dal".into());
            let cid = store::save_cook(&mut uc, None, &input).unwrap();
            add_frozen(
                &refconn, &mut uc, DAY, Some("lunch"),
                store::Source::Cook(&cid), "Dal",
                store::Quantity::Grams(200.0), None, &no_tags(),
            )
            .unwrap();

            let user = store::Store(Mutex::new(uc));
            let (_, breakdowns, _) = collect_day(&refconn, &user, &dim, DAY).unwrap();
            assert_eq!(
                breakdowns[0].components[0].description,
                "masoor dal (instead of toor dal)",
                "the substitute is what was eaten; the original is why the amounts read as they do"
            );
        }

        #[test]
        fn re_weighing_a_pot_does_not_move_a_helping_already_logged() {
            // The immutability rule, at the layer that most invites breaking it.
            // A pot is editable in place — you re-weigh it when it comes off the
            // heat, and you add the second onion half an hour late. None of that
            // may reach back into a helping already eaten: that entry's values
            // were frozen when it was written, and a later correction to the pot
            // is a fact about the pot, not about a meal already had.
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let fdc_id = a_fatty_food(&refconn);
            let mut uc = user_db();

            let cid = store::save_cook(&mut uc, None, &pot_of(fdc_id, 1000.0, Some(1000.0))).unwrap();
            add_frozen(
                &refconn, &mut uc, DAY, Some("lunch"),
                store::Source::Cook(&cid), "Rajma",
                store::Quantity::Grams(250.0), None, &no_tags(),
            )
            .unwrap();

            let user = store::Store(Mutex::new(uc));
            let before = lower_on(&refconn, &user, &dim, DAY, FAT);
            assert!(before > 0.0, "the helping must contribute something to test");

            {
                let mut c = user.0.lock().unwrap();
                // Halve the pot's weight and double one line: every input to the
                // arithmetic moves, in both directions.
                let mut edited = pot_of(fdc_id, 2000.0, Some(500.0));
                edited.ingredients[0].description = "kidney beans, more of them".into();
                store::save_cook(&mut c, Some(&cid), &edited).unwrap();
            }

            assert_eq!(
                before,
                lower_on(&refconn, &user, &dim, DAY, FAT),
                "editing a pot must not revalue a helping already logged from it"
            );
            let (_, breakdowns, _) = collect_day(&refconn, &user, &dim, DAY).unwrap();
            assert_eq!(
                breakdowns[0].components[0].description, "kidney beans",
                "and the frozen breakdown still names what was actually eaten"
            );

            // Deleting the pot outright is the same rule one step further.
            {
                let c = user.0.lock().unwrap();
                store::delete_cook(&c, &cid).unwrap();
            }
            assert_eq!(
                before,
                lower_on(&refconn, &user, &dim, DAY, FAT),
                "a deleted pot must not take its history with it either"
            );
        }

        #[test]
        fn what_is_left_in_a_pot_goes_back_up_when_a_helping_is_deleted() {
            // Why `remaining_g` is derived and never stored. A counter would
            // have to be decremented on every write and put back on every
            // delete, and the first one it missed would leave the fridge
            // disagreeing with the diary.
            let Some(refconn) = refdb() else { return };
            let fdc_id = a_fatty_food(&refconn);
            let mut uc = user_db();

            let cid = store::save_cook(&mut uc, None, &pot_of(fdc_id, 1000.0, Some(900.0))).unwrap();
            assert_eq!(store::get_cook(&uc, &cid).unwrap().yield_g, 900.0);
            assert_eq!(store::get_cook(&uc, &cid).unwrap().remaining_g, 900.0);

            let entry = add_frozen(
                &refconn, &mut uc, DAY, Some("lunch"),
                store::Source::Cook(&cid), "Rajma",
                store::Quantity::Grams(250.0), None, &no_tags(),
            )
            .unwrap();
            assert_eq!(store::get_cook(&uc, &cid).unwrap().remaining_g, 650.0);

            store::remove(&uc, &entry).unwrap();
            assert_eq!(
                store::get_cook(&uc, &cid).unwrap().remaining_g,
                900.0,
                "deleting a helping puts the food back in the pot"
            );
        }

        #[test]
        fn correcting_a_helping_moves_the_pot_by_the_same_amount() {
            // The third of the three places a helping's projection into
            // `cook_draws` is maintained, and the easiest to leave out: `add`
            // and `remove` are obvious, an entry re-weighed afterwards is not.
            // Miss it and this device's own Available list disagrees with its
            // own log — and the household's copy disagrees for good, because
            // nothing later would touch it.
            let Some(refconn) = refdb() else { return };
            let fdc_id = a_fatty_food(&refconn);
            let mut uc = user_db();

            let cid = store::save_cook(&mut uc, None, &pot_of(fdc_id, 1000.0, Some(800.0))).unwrap();
            let entry = add_frozen(
                &refconn, &mut uc, DAY, Some("dinner"),
                store::Source::Cook(&cid), "Rajma",
                store::Quantity::Grams(200.0), None, &no_tags(),
            )
            .unwrap();
            assert_eq!(store::get_cook(&uc, &cid).unwrap().remaining_g, 600.0);

            store::correct_amount(&mut uc, &entry, store::Quantity::Grams(300.0)).unwrap();
            assert_eq!(
                store::get_cook(&uc, &cid).unwrap().remaining_g,
                500.0,
                "correcting 200 g to 300 g means 100 g more came out of the pot"
            );
        }

        #[test]
        fn eating_more_than_the_pot_was_weighed_at_is_allowed_and_floors_at_nothing() {
            // Going over is the ordinary case, not an error: the yield is one
            // reading of a pot that has since been stirred, served and put in
            // the fridge. Nothing refuses the entry, and nothing reports a
            // negative amount of food.
            let Some(refconn) = refdb() else { return };
            let fdc_id = a_fatty_food(&refconn);
            let mut uc = user_db();

            let cid = store::save_cook(&mut uc, None, &pot_of(fdc_id, 400.0, Some(400.0))).unwrap();
            add_frozen(
                &refconn, &mut uc, DAY, Some("lunch"),
                store::Source::Cook(&cid), "Rajma",
                store::Quantity::Grams(500.0), None, &no_tags(),
            )
            .expect("a helping bigger than the reading is still a helping");

            let cook = store::get_cook(&uc, &cid).unwrap();
            assert_eq!(cook.logged_g, 500.0, "what left the pot is recorded in full");
            assert_eq!(cook.remaining_g, 0.0, "and what is left is nothing, never less");
        }

        #[test]
        fn a_pot_recalls_the_tags_it_was_last_eaten_with() {
            // Recall goes through `cook_id`, not through the recipe behind it —
            // a cook-backed entry carries no `recipe_id` at all, so a lookup
            // through the recipe would find nothing for any pot ever cooked.
            let Some(refconn) = refdb() else { return };
            let fdc_id = a_fatty_food(&refconn);
            let mut uc = user_db();

            let cid = store::save_cook(&mut uc, None, &pot_of(fdc_id, 900.0, Some(900.0))).unwrap();
            add_frozen(
                &refconn, &mut uc, DAY, Some("lunch"),
                store::Source::Cook(&cid), "Rajma",
                store::Quantity::Grams(300.0), None,
                &store::Tags {
                    origin: Some("home".into()),
                    cuisine: Some("North Indian".into()),
                },
            )
            .unwrap();

            let t = store::recall_tags(&uc, store::Source::Cook(&cid)).unwrap();
            assert_eq!(t.origin.as_deref(), Some("home"));
            assert_eq!(t.cuisine.as_deref(), Some("North Indian"));
        }

        #[test]
        fn re_portioning_a_supplement_does_not_rescale_a_dose_already_taken() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            let sid = store::save_supplement(&mut uc, None, &b12_tablet()).unwrap();
            add_frozen(
                &refconn,
                &mut uc,
                DAY,
                Some("breakfast"),
                store::Source::Supplement(&sid),
                "B12",
                store::Quantity::Units(1.0),
                None,
                &no_tags(),
            )
            .unwrap();

            let user = store::Store(Mutex::new(uc));
            let march = lower_on(&refconn, &user, &dim, DAY, B12);
            assert!(march > 0.0, "one tablet must contribute B12");

            // The user corrects the label: it was a two-tablet serving all along.
            {
                let mut c = user.0.lock().unwrap();
                let mut two = b12_tablet();
                two.serving_units = 2.0;
                store::save_supplement(&mut c, Some(&sid), &two).unwrap();
            }

            assert_eq!(
                march,
                lower_on(&refconn, &user, &dim, DAY, B12),
                "the tablet swallowed in March was the tablet the pack described then"
            );
        }

        #[test]
        fn an_entry_written_without_a_snapshot_is_frozen_once_and_then_held() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            let food_id = store::save_custom_food(&mut uc, None, &bar(None)).unwrap();
            // Deliberately the OLD write path — no snapshot — which is the shape
            // every entry logged before this feature is in.
            store::add(
                &uc,
                DAY,
                Some("snack"),
                store::Source::Custom(&food_id),
                "Milk chocolate bar",
                store::Quantity::Grams(BAR),
                None,
                &no_tags(),
            )
            .unwrap();
            assert_eq!(store::entries_missing_snapshots(&uc).unwrap().len(), 1);

            let frozen = backfill_snapshots(&refconn, &mut uc).unwrap();
            assert_eq!(frozen, 1);
            assert!(store::entries_missing_snapshots(&uc).unwrap().is_empty());

            let snaps = store::day_snapshots(&uc, DAY).unwrap();
            let snap = snaps.values().next().unwrap();
            assert_eq!(
                snap.basis,
                store::SnapBasis::Backfilled,
                "the app cannot know what this entry was worth when it was logged, \
                 and must not claim otherwise"
            );

            let user = store::Store(Mutex::new(uc));
            let before = lower_on(&refconn, &user, &dim, DAY, FAT);
            assert!(before > 0.0);

            // From here it is as frozen as any other entry.
            {
                let mut c = user.0.lock().unwrap();
                let mut reformulated = bar(None);
                reformulated.nutrients = vec![nutrient(FAT, "measured", Some(1.0), None)];
                store::save_custom_food(&mut c, Some(&food_id), &reformulated).unwrap();
            }
            assert_eq!(before, lower_on(&refconn, &user, &dim, DAY, FAT));
        }

        #[test]
        fn correcting_the_amount_rescales_the_day_without_re_reading_the_food() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            let food_id = store::save_custom_food(&mut uc, None, &bar(None)).unwrap();
            let entry_id = add_frozen(
                &refconn,
                &mut uc,
                DAY,
                Some("snack"),
                store::Source::Custom(&food_id),
                "Milk chocolate bar",
                store::Quantity::Grams(BAR),
                None,
                &no_tags(),
            )
            .unwrap();

            // The food is edited AFTER logging. A correction to how much was
            // eaten must not quietly pick this up.
            let mut reformulated = bar(None);
            reformulated.nutrients = vec![nutrient(FAT, "measured", Some(99.0), None)];
            store::save_custom_food(&mut uc, Some(&food_id), &reformulated).unwrap();

            // It was half a bar, not a whole one.
            store::correct_amount(&mut uc, &entry_id, store::Quantity::Grams(BAR / 2.0)).unwrap();

            let snap = store::snapshot_of(&uc, &entry_id).unwrap().unwrap();
            assert_eq!(snap.basis, store::SnapBasis::Corrected);
            assert!(snap.corrected_at.is_some());
            assert!(
                !snap.frozen_at.is_empty(),
                "when it was first valued is still recorded"
            );

            let user = store::Store(Mutex::new(uc));
            let after = lower_on(&refconn, &user, &dim, DAY, FAT);
            assert!(
                after > 6.4 && after < 6.6,
                "half of the 13 g the pack said THEN, not of the 99 g it says now: {after}"
            );
        }

        #[test]
        fn correcting_a_dose_counts_tablets_and_not_grams() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            let sid = store::save_supplement(&mut uc, None, &b12_tablet()).unwrap();
            let entry_id = add_frozen(
                &refconn,
                &mut uc,
                DAY,
                Some("breakfast"),
                store::Source::Supplement(&sid),
                "B12",
                store::Quantity::Units(1.0),
                None,
                &no_tags(),
            )
            .unwrap();

            // Correcting a counted entry with a weight is a category error and
            // is refused rather than coerced.
            assert!(
                store::correct_amount(&mut uc, &entry_id, store::Quantity::Grams(500.0)).is_err()
            );

            let one = {
                let user = store::Store(Mutex::new(uc));
                let v = lower_on(&refconn, &user, &dim, DAY, B12);
                uc = Mutex::into_inner(user.0).unwrap();
                v
            };

            store::correct_amount(&mut uc, &entry_id, store::Quantity::Units(2.0)).unwrap();
            let user = store::Store(Mutex::new(uc));
            let two = lower_on(&refconn, &user, &dim, DAY, B12);
            assert!(
                (two - one * 2.0).abs() < 1e-9,
                "two tablets is twice one: {one} -> {two}"
            );
        }

        #[test]
        fn correcting_one_value_leaves_the_others_alone() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            let food_id = store::save_custom_food(&mut uc, None, &bar(None)).unwrap();
            let entry_id = add_frozen(
                &refconn,
                &mut uc,
                DAY,
                Some("snack"),
                store::Source::Custom(&food_id),
                "Milk chocolate bar",
                store::Quantity::Grams(BAR),
                None,
                &no_tags(),
            )
            .unwrap();

            let energy_before = {
                let user = store::Store(Mutex::new(uc));
                let v = lower_on(&refconn, &user, &dim, DAY, 1008);
                uc = Mutex::into_inner(user.0).unwrap();
                v
            };

            // The pack said 13 g of fat; it actually says 3 g. Values are stored
            // per 100 g, which is the basis a correction is given in.
            store::correct_value(
                &mut uc,
                &entry_id,
                0,
                FAT,
                Some(NutrientValue::Measured {
                    amount: 3.0 * 100.0 / BAR,
                }),
            )
            .unwrap();

            let user = store::Store(Mutex::new(uc));
            let fat = lower_on(&refconn, &user, &dim, DAY, FAT);
            assert!(fat > 2.9 && fat < 3.1, "the corrected figure: {fat}");
            assert_eq!(
                energy_before,
                lower_on(&refconn, &user, &dim, DAY, 1008),
                "correcting fat must not disturb energy"
            );
            let snap = {
                let c = user.0.lock().unwrap();
                store::snapshot_of(&c, &entry_id).unwrap().unwrap()
            };
            assert_eq!(snap.basis, store::SnapBasis::Corrected);
        }

        #[test]
        fn a_value_corrected_to_unknown_stops_being_counted_at_all() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            let food_id = store::save_custom_food(&mut uc, None, &bar(None)).unwrap();
            let entry_id = add_frozen(
                &refconn,
                &mut uc,
                DAY,
                Some("snack"),
                store::Source::Custom(&food_id),
                "Milk chocolate bar",
                store::Quantity::Grams(BAR),
                None,
                &no_tags(),
            )
            .unwrap();

            store::correct_value(&mut uc, &entry_id, 0, FAT, None).unwrap();

            let user = store::Store(Mutex::new(uc));
            let (_, _, by) = collect_day(&refconn, &user, &dim, DAY).unwrap();
            let total = trackit_core::aggregate::sum(by.get(&FAT).unwrap());
            assert_eq!(total.lower, 0.0);
            assert_eq!(
                total.upper, None,
                "\"nobody knew\" bounds nothing — it is not a zero"
            );
            assert_eq!(total.items_covered, 0);
        }

        #[test]
        fn re_valuing_an_entry_on_purpose_uses_todays_data_and_says_so() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            let food_id = store::save_custom_food(&mut uc, None, &bar(None)).unwrap();
            let entry_id = add_frozen(
                &refconn,
                &mut uc,
                DAY,
                Some("snack"),
                store::Source::Custom(&food_id),
                "Milk chocolate bar",
                store::Quantity::Grams(BAR),
                None,
                &no_tags(),
            )
            .unwrap();
            let first_frozen = store::snapshot_of(&uc, &entry_id)
                .unwrap()
                .unwrap()
                .frozen_at;

            // The user fixes the pack they had mistyped, then asks for this day
            // to be valued again from it.
            let mut fixed = bar(None);
            fixed.nutrients = vec![nutrient(FAT, "measured", Some(6.0), None)];
            store::save_custom_food(&mut uc, Some(&food_id), &fixed).unwrap();

            let entry = store::entry_by_id(&uc, &entry_id).unwrap();
            let snap =
                resolve_entry(&refconn, &uc, &entry, store::SnapBasis::Corrected).unwrap();
            store::recorrect_entry(&mut uc, &entry_id, snap).unwrap();

            let stored = store::snapshot_of(&uc, &entry_id).unwrap().unwrap();
            assert_eq!(stored.basis, store::SnapBasis::Corrected);
            assert!(stored.corrected_at.is_some());
            assert_eq!(
                stored.frozen_at, first_frozen,
                "re-valuing does not rewrite when the entry was first valued"
            );

            let user = store::Store(Mutex::new(uc));
            let fat = lower_on(&refconn, &user, &dim, DAY, FAT);
            assert!(fat > 5.9 && fat < 6.1, "the fixed pack now applies: {fat}");
        }

        #[test]
        fn a_frozen_gap_stays_a_gap_and_never_becomes_a_zero() {
            let Some(refconn) = refdb() else { return };
            let dim = nutrient_dim(&refconn).unwrap();
            let mut uc = user_db();

            // A recipe whose only ingredient has no composition data at all.
            let recipe_id = store::save_recipe(
                &mut uc,
                "Grandmother's pickle",
                500.0,
                Some(10.0),
                None,
                &[store::RecipeIngredient {
                    id: String::new(),
                    position: 0,
                    fdc_id: None,
                    custom_food_id: None,
                    description: "home-made mango pickle".into(),
                    raw_g: 500.0,
                    optional: false,
                }],
                &[],
                &no_tags(),
            )
            .unwrap();
            add_frozen(
                &refconn,
                &mut uc,
                DAY,
                Some("lunch"),
                store::Source::Recipe(&recipe_id),
                "Grandmother's pickle",
                store::Quantity::Grams(50.0),
                None,
                &no_tags(),
            )
            .unwrap();

            let user = store::Store(Mutex::new(uc));
            let (_, _, by) = collect_day(&refconn, &user, &dim, DAY).unwrap();
            let total = trackit_core::aggregate::sum(by.get(&FAT).unwrap());
            assert_eq!(total.lower, 0.0);
            assert_eq!(
                total.upper, None,
                "an unmeasured ingredient bounds nothing; a frozen zero here \
                 would be an invented measurement"
            );
            assert_eq!(total.items_covered, 0, "and it is not counted as covered");
        }
    }

    // -----------------------------------------------------------------------
    // Quick add
    // -----------------------------------------------------------------------

    /// One log entry of a reference food, on the day given.
    fn logged_food(c: &Connection, fdc: i64, on: &str, description: &str) {
        store::add(
            c,
            on,
            Some("lunch"),
            store::Source::Food(fdc),
            description,
            store::Quantity::Grams(100.0),
            None,
            &store::Tags::default(),
        )
        .unwrap();
    }

    #[test]
    fn the_quick_add_window_is_ninety_days_from_today() {
        // The only test that exercises the arithmetic the command actually
        // performs: everything else hands `frequent_foods` a date literal.
        let uc = user_db();
        let today = store::today_iso(&uc).unwrap();
        let long_ago = store::days_ago_iso(&uc, 200).unwrap();
        logged_food(&uc, 111, &today, "this week's rice");
        logged_food(&uc, 222, &long_ago, "last spring's rice");

        let since = store::days_ago_iso(&uc, store::FREQUENT_WINDOW_DAYS).unwrap();
        let rows = store::frequent_foods(&uc, &since, 6).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].fdc_id, Some(111));
    }

    #[test]
    fn a_reference_food_the_dataset_no_longer_has_is_not_offered_as_a_row() {
        let Some(rc) = refdb() else { return };
        let live = db::search(&rc, "cheddar", 1)
            .unwrap()
            .first()
            .and_then(|h| h.fdc_id)
            .expect("a reference food to log");
        let uc = user_db();
        // A dataset upgrade replaces `usda_core.db` wholesale, so an fdc_id the
        // log froze years ago can name nothing at all today. Offering it would
        // draw a row whose only behaviour is to put a rusqlite sentence in the
        // error bar.
        logged_food(&uc, 999_999_999, "2026-09-04", "a food that has since gone");
        logged_food(&uc, live, "2026-09-04", "Cheddar");

        let candidates = store::frequent_foods(&uc, "2026-08-01", 6).unwrap();
        assert_eq!(candidates.len(), 2, "the log itself still holds both");
        let rows = resolve_frequent(&rc, candidates, &[], 6);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].fdc_id, Some(live));
    }

    #[test]
    fn a_reference_row_is_named_by_the_dataset_and_not_by_the_old_entry() {
        let Some(rc) = refdb() else { return };
        let live = db::search(&rc, "cheddar", 1)
            .unwrap()
            .first()
            .and_then(|h| h.fdc_id)
            .expect("a reference food to log");
        let current = base_description(&rc, live).unwrap();
        let uc = user_db();
        logged_food(&uc, live, "2026-09-04", "whatever this row used to be called");

        let candidates = store::frequent_foods(&uc, "2026-08-01", 6).unwrap();
        assert_eq!(candidates[0].description, "whatever this row used to be called");
        let rows = resolve_frequent(&rc, candidates, &[], 6);
        assert_eq!(
            rows[0].description, current,
            "the commit path logs the description it fetches, so the row has to \
             show the one it will write"
        );
    }

    #[test]
    fn a_reference_food_the_user_has_replaced_with_their_own_pack_is_not_offered() {
        let Some(rc) = refdb() else { return };
        let live = db::search(&rc, "cheddar", 1)
            .unwrap()
            .first()
            .and_then(|h| h.fdc_id)
            .expect("a reference food to log");
        let mut uc = user_db();
        // Eaten as the generic entry on several days, and only later
        // transcribed off the pack. The log keeps every one of those days, so
        // the ranking still knows the fdc_id perfectly well — which is exactly
        // how quick add ends up being the one screen still offering a food that
        // `search_foods` has stopped offering.
        logged_food(&uc, live, "2026-09-04", "Cheddar");
        logged_food(&uc, live, "2026-09-05", "Cheddar");
        store::save_custom_food(&mut uc, None, &bar(Some(live))).unwrap();

        let candidates = store::frequent_foods(&uc, "2026-08-01", 6).unwrap();
        assert_eq!(candidates.len(), 1, "the log itself still holds the days");
        let overridden = store::overridden_fdc_ids(&uc).unwrap();
        assert_eq!(overridden, vec![live]);
        assert!(
            resolve_frequent(&rc, candidates, &overridden, 6).is_empty(),
            "tapping it would log USDA's figures for the category while the \
             user has a pack for the product, and the entry would keep them"
        );
    }

    #[test]
    fn quick_add_never_hands_back_more_rows_than_were_asked_for() {
        // The ranking is asked for a pool several times the size, because the
        // filter above can drop rows and a list that quietly comes back short
        // is the failure that pool exists to avoid. What the caller gets is
        // still exactly what the caller asked for, and a screen that asked for
        // six must not be handed eighteen.
        let Some(rc) = refdb() else { return };
        let live: Vec<i64> = db::search(&rc, "cheese", 4)
            .unwrap()
            .iter()
            .filter_map(|h| h.fdc_id)
            .collect();
        assert!(live.len() >= 2, "two reference foods to log");
        let uc = user_db();
        for (n, fdc) in live.iter().enumerate() {
            logged_food(&uc, *fdc, &format!("2026-09-0{}", n + 1), "Cheese");
        }

        let candidates = store::frequent_foods(&uc, "2026-08-01", 18).unwrap();
        assert!(candidates.len() >= 2, "the pool holds all of them");
        assert_eq!(resolve_frequent(&rc, candidates, &[], 1).len(), 1);
    }

    /// The two Android home-screen widgets, tested where their figures are
    /// decided rather than where they are drawn.
    ///
    /// Nothing here renders anything. What these check is the one thing a
    /// RemoteViews layout cannot: that the strings crossing to Kotlin came out
    /// of the same aggregation the Statistics screen reads, and that a period
    /// with nothing in it produces sentences rather than zeroes.
    mod widget_snapshots {
        use super::*;

        /// A food declaring 200 kcal per 100 g and nothing else, so a day's
        /// energy is exactly twice its grams and the arithmetic under test is
        /// the period's rather than the food's.
        fn energy_food() -> store::CustomFood {
            store::CustomFood {
                id: String::new(),
                name: "Rice, as cooked here".into(),
                brand: None,
                overrides_fdc_id: None,
                serving_g: 100.0,
                serving_label: None,
                ingredients: None,
                barcode: None,
                photo_label: None,
                photo_ingredients: None,
                nutrients: vec![nutrient(1008, "measured", Some(200.0), None)],
                import_only: false,
            }
        }

        #[test]
        fn the_widget_and_the_period_agree_about_the_middle_day() {
            let Some(rc) = refdb() else { return };
            let mut uc = user_db();
            let food = saved(&mut uc, &energy_food());
            let today = store::today_iso(&uc).unwrap();
            // Six days, so a spread exists and its middle is the average of the
            // two central days rather than one of the days themselves — which is
            // the case a mean would silently agree with and a median would not.
            for (back, grams) in [
                (5i64, 100.0),
                (4, 150.0),
                (3, 200.0),
                (2, 250.0),
                (1, 300.0),
                (0, 350.0),
            ] {
                let on = store::shift_iso(&uc, &today, -back).unwrap();
                store::add(
                    &uc,
                    &on,
                    Some("lunch"),
                    store::Source::Custom(&food.id),
                    "Rice",
                    store::Quantity::Grams(grams),
                    None,
                    &store::Tags::default(),
                )
                .unwrap();
            }
            let refdb = db::Db(Mutex::new(rc));
            let user = store::Store(Mutex::new(uc));

            let from = {
                let uc = user.0.lock().unwrap();
                store::shift_iso(&uc, &today, -(widgets::PERIOD_DAYS - 1)).unwrap()
            };
            let view = range_view(&refdb, &user, from, today.clone()).unwrap();
            let kcal: Vec<f64> = view
                .days
                .iter()
                .filter(|d| d.food_items > 0)
                .filter_map(|d| d.kcal)
                .collect();
            assert_eq!(kcal.len(), 6, "six days of food, six figures to average");
            let middle = trackit_core::spread::summarise(&kcal).unwrap().median;
            assert_eq!(middle, 450.0, "the middle of 200..700 by fifties");

            let (aggregate, quick) = widget_payloads(&refdb, &user).unwrap();
            assert_eq!(
                aggregate.rows[0].value, "450 kcal",
                "the home screen prints the period's own middle day"
            );
            assert_eq!(
                aggregate.rows[0].note.as_deref(),
                Some("Half your days: 300 kcal – 600 kcal")
            );
            // Energy is in none of the DRI tables and in none of the Daily Value
            // tables, so with no profile behind it there is nothing published to
            // print — and the line is absent rather than guessed at.
            assert!(aggregate.rows[0].r#ref.is_none());
            // Not one bottle was logged, so water refuses instead of reading as
            // a person who drank nothing.
            assert_eq!(aggregate.rows[1].value, "—");

            assert_eq!(quick.foods.len(), 1, "one food, logged six times");
            assert_eq!(quick.foods[0].kind, "custom");
            assert_eq!(quick.foods[0].id, food.id);
        }

        #[test]
        fn widget_payloads_over_an_empty_database_offer_no_figures_and_no_names() {
            let Some(rc) = refdb() else { return };
            let refdb = db::Db(Mutex::new(rc));
            let user = store::Store(Mutex::new(user_db()));

            let (aggregate, quick) = widget_payloads(&refdb, &user).unwrap();
            assert!(aggregate.rows.is_empty(), "no rows rather than rows of zeroes");
            assert!(aggregate.note.is_some(), "and a sentence in their place");
            assert!(quick.foods.is_empty());
            assert_eq!(quick.note.as_deref(), Some("Nothing to show yet"));

            // Both files parse, and neither carries a figure that scores anybody.
            for json in [
                serde_json::to_string(&aggregate).unwrap(),
                serde_json::to_string(&quick).unwrap(),
            ] {
                for forbidden in ["%", "streak", "goal", "on track"] {
                    assert!(!json.contains(forbidden), "{forbidden:?} in {json}");
                }
            }
        }
    }
}
