// Tauri's own `invoke` inside the app; the browser design fixture outside it.
// See lib/bridge.ts — the real backend is never bypassed in a Tauri window.
import { invoke } from "./lib/bridge";
import type { ExportKind } from "./lib/exportSheet";
import type {
  BarcodeScan,
  CustomFood,
  CustomFoodDetail,
  DayView,
  ExportLog,
  FoodDetail,
  FoodHit,
  FrequentFood,
  ImportRowInput,
  ImportSummary,
  IngredientsScan,
  LabelForm,
  LabelUnit,
  Meal,
  GoalsView,
  NutrientMeta,
  Origin,
  HouseholdView,
  PairCodeScan,
  PairingOffer,
  PairingState,
  Profile,
  SyncOutcome,
  Probe,
  RangeView,
  Cook,
  CookDraft,
  Recipe,
  RecipeIngredient,
  RecipeServing,
  Scan,
  Supplement,
  SupplementDetail,
  SupplementNutrient,
  SupplementScan,
  Vessel,
  Bottle,
  EntrySnapshotView,
  CorrectableKind,
  BackupStatus,
  RestoreOutcome,
} from "./types";

/**
 * Which food a log entry is for. Exactly one shape, because an entry references
 * exactly one source — the backend rejects any other combination rather than
 * picking one.
 */
type LogSource =
  | { fdcId: number }
  | { recipeId: string }
  | { cookId: string }
  | { customFoodId: string }
  | { supplementId: string };

/**
 * Every key is sent explicitly, including the ones that are null. Omitting a
 * key sends `undefined`, which Tauri drops from the payload entirely — the
 * command then fails with "missing required key" rather than with the clean
 * rejection the backend is written to give.
 */
const sourceArgs = (source: LogSource) => ({
  fdcId: "fdcId" in source ? source.fdcId : null,
  recipeId: "recipeId" in source ? source.recipeId : null,
  cookId: "cookId" in source ? source.cookId : null,
  customFoodId: "customFoodId" in source ? source.customFoodId : null,
  supplementId: "supplementId" in source ? source.supplementId : null,
});

/** The user's own answers about a dish. Absent means they have not said. */
export interface EntryTags {
  origin?: Origin | null;
  cuisine?: string | null;
}

const tagArgs = (t: EntryTags = {}) => ({
  origin: t.origin ?? null,
  cuisine: t.cuisine ?? null,
});

/**
 * The user's own foods first, then the bundled reference data. A generic entry
 * one of their foods replaces comes back as that food, not as itself.
 *
 * `includeOverridden` turns that substitution off, which is what choosing the
 * entry a food replaces needs: the entry has to stay pickable, or a food's own
 * base could never be re-picked once set.
 */
export const searchFoods = (query: string, limit = 40, includeOverridden = false) =>
  invoke<FoodHit[]>("search_foods", { query, limit, includeOverridden });

export const getFoodDetail = (fdcId: number) =>
  invoke<FoodDetail>("get_food_detail", { fdcId });

/**
 * What this person has been logging most days over the past three months —
 * reference foods and their own transcribed packs, never a pot, a supplement or
 * water.
 *
 * A shortcut into the portion step and not a summary of anything. The caller
 * must land the user on the amount panel and let them press Add; nothing here
 * logs, and the list carries no figure that may be drawn on a row.
 *
 * The three months is fixed in the backend rather than passed from here, so
 * that the sentence the screen prints beside the list cannot become a lie.
 */
export const frequentFoods = (limit = 6) =>
  invoke<FrequentFood[]>("frequent_foods", { limit });

export const getDay = (loggedOn: string) =>
  invoke<DayView>("get_day", { loggedOn });

/**
 * A log entry references exactly one of a bundled food, a saved recipe, or one
 * of the user's own foods.
 */
export const addLogEntry = (
  loggedOn: string,
  meal: Meal,
  source: LogSource,
  description: string,
  grams: number,
  tags: EntryTags = {},
) =>
  invoke<string>("add_log_entry", {
    loggedOn,
    meal,
    ...sourceArgs(source),
    description,
    grams,
    units: null,
    grossG: null,
    vesselIds: null,
    ...tagArgs(tags),
  });

/**
 * Log a supplement, counted in its own units rather than weighed.
 *
 * A separate entry point rather than a fourth optional number on `addLogEntry`:
 * a dose takes neither weight path and cannot carry a tare, and three named
 * functions say that more plainly than one function where two of three numbers
 * must be null.
 */
export const addSupplementLogEntry = (
  loggedOn: string,
  meal: Meal,
  supplementId: string,
  description: string,
  units: number,
) =>
  invoke<string>("add_log_entry", {
    loggedOn,
    meal,
    ...sourceArgs({ supplementId }),
    description,
    grams: null,
    units,
    grossG: null,
    vesselIds: null,
    // A supplement is not a dish: it has no origin and no cuisine.
    origin: null,
    cuisine: null,
  });

/**
 * Log what the scale actually read, with the vessels that were under the food.
 * Only the vessel ids go over the wire: the backend subtracts the weights it has
 * stored, so a screen holding a stale weight cannot write a net figure that
 * disagrees with the library.
 */
export const addWeighedLogEntry = (
  loggedOn: string,
  meal: Meal,
  source: LogSource,
  description: string,
  grossG: number,
  vesselIds: string[],
  tags: EntryTags = {},
) =>
  invoke<string>("add_log_entry", {
    loggedOn,
    meal,
    ...sourceArgs(source),
    description,
    grams: null,
    units: null,
    grossG,
    vesselIds,
    ...tagArgs(tags),
  });

export const deleteLogEntry = (id: string) =>
  invoke<void>("delete_log_entry", { id });

export const loggedDates = () => invoke<string[]>("logged_dates");

export const getRange = (from: string, to: string) =>
  invoke<RangeView>("get_range", { from, to });

/* ── origin and cuisine ────────────────────────────────────────────────── */

/**
 * The user's own last answer for this food, to pre-fill the pickers.
 *
 * Never a guess from a name: the backend reads rows the user wrote, or returns
 * nothing. A blank picker is the correct outcome for a food they have not
 * tagged before.
 */
export const recallTags = (source: LogSource) =>
  invoke<{ origin: Origin | null; cuisine: string | null }>("recall_tags", {
    fdcId: "fdcId" in source ? source.fdcId : null,
    recipeId: "recipeId" in source ? source.recipeId : null,
    cookId: "cookId" in source ? source.cookId : null,
    customFoodId: "customFoodId" in source ? source.customFoodId : null,
  });

/** Add or change the tags on an entry already logged. */
export const setEntryTags = (id: string, origin: Origin | null, cuisine: string | null) =>
  invoke<void>("set_entry_tags", { id, origin, cuisine });

/** The cuisines this user has actually used, most-used first. */
export const listCuisines = () => invoke<string[]>("list_cuisines");

/* ── supplements ───────────────────────────────────────────────────────── */

/**
 * Every nutrient this app displays, in display order.
 *
 * The supplement editor works from this because a Supplement Facts panel is not
 * a fixed form — it declares whatever the product contains, so lines are picked
 * rather than filled in.
 */
export const listNutrients = () => invoke<NutrientMeta[]>("list_nutrients");

/* ── profile and targets ───────────────────────────────────────────────── */

/**
 * Everything the profile and settings screens need: who the targets are for,
 * what each nutrient is being read against, and what would apply if the user
 * cleared a figure of their own.
 */
export const getGoals = () => invoke<GoalsView>("get_goals");

/**
 * Replace the profile wholesale.
 *
 * Every field goes every time, so clearing one really clears it. A partial
 * update would make "leave my height alone" and "I no longer want to say how
 * tall I am" the same request, and the second has to stay expressible — it is
 * what turns the energy estimate back off.
 */
export const saveProfile = (profile: Profile) => invoke<void>("save_profile", { profile });

/**
 * Set one nutrient's target, or clear it by passing null.
 *
 * Clearing returns the nutrient to whichever published figure applies. It is
 * not a deletion: the nutrient keeps a target, it just stops being this one.
 */
export const setNutrientTarget = (
  nutrientId: number,
  amount: number | null,
  note: string | null = null,
) => invoke<void>("set_nutrient_target", { nutrientId, amount, note });

export const listSupplements = () => invoke<Supplement[]>("list_supplements");

export const getSupplement = (id: string) => invoke<Supplement>("get_supplement", { id });

/**
 * One entry point for adding a supplement and for correcting one: pass an `id`
 * to replace it in place, omit it to record a new one. The panel rows are
 * replaced wholesale, so removing a line really removes it.
 */
export const saveSupplement = (supplement: Supplement, id: string | null = null) =>
  invoke<string>("save_supplement", { id, supplement });

/** Soft delete. Days that already took it keep what they were logged with. */
export const deleteSupplement = (id: string) => invoke<void>("delete_supplement", { id });

/**
 * The full panel with every value's provenance — what the pack prints, what
 * this app could not convert, and what the pack's silence is worth under its
 * own labelling regime. Use this rather than `getSupplement` wherever values
 * are shown.
 */
export const getSupplementDetail = (id: string) =>
  invoke<SupplementDetail>("get_supplement_detail", { id });

/**
 * Put one printed figure onto this app's basis, live, while transcribing.
 *
 * Returns a row whose `kind` is `not_converted` — with a sentence saying why —
 * when the pack's figure cannot be placed at all. 400 IU of vitamin E is 268 mg
 * if it is natural and 180 mg if it is synthetic, and the screen has to say so
 * rather than pick one.
 */
export const convertLabelFigure = (
  nutrientId: number,
  amount: number,
  unit: LabelUnit,
  form: LabelForm,
) =>
  invoke<SupplementNutrient>("convert_label_figure", { nutrientId, amount, unit, form });

export const listRecipes = () => invoke<Recipe[]>("list_recipes");

export const getRecipe = (id: string) => invoke<Recipe>("get_recipe", { id });

export const deleteRecipe = (id: string) => invoke<void>("delete_recipe", { id });

/**
 * Save a recipe: ingredients in proportion, and the reference batch they add
 * up to.
 *
 * `servings` is last among the optionals and defaults to null, because the
 * count is a note the user may volunteer and not a property of the dish. It is
 * deliberately not a positional argument any more — a required parameter is
 * what made every recipe answer a question it cannot answer.
 */
export const saveRecipe = (
  name: string,
  yieldG: number,
  ingredients: RecipeIngredient[],
  servingOptions: RecipeServing[] = [],
  notes: string | null = null,
  defaults: EntryTags = {},
  servings: number | null = null,
) =>
  invoke<string>("save_recipe", {
    name,
    yieldG,
    servings,
    notes,
    ingredients,
    servingOptions,
    defaultOrigin: defaults.origin ?? null,
    defaultCuisine: defaults.cuisine ?? null,
  });

/**
 * Open a cook from a recipe, without saving anything.
 *
 * The scaling happens in the backend so there is one definition of what "half
 * this recipe" means, and so the amounts the dials are centred on came from the
 * same place the stored ones will.
 */
export const draftCook = (recipeId: string, scale = 1) =>
  invoke<Cook>("draft_cook", { recipeId, scale });

/**
 * Save a pot, new or edited. Unlike a recipe, a cook is editable in place — you
 * add the second onion later, and re-weigh when it comes off the heat. Nothing
 * already logged from it moves: an entry's nutrition was frozen when written.
 */
export const saveCook = (cook: CookDraft, id: string | null = null) =>
  invoke<string>("save_cook", { id, cook });

/** Pots with food still in them, newest first. What "Available" lists. */
export const listOpenCooks = () => invoke<Cook[]>("list_open_cooks");

export const getCook = (id: string) => invoke<Cook>("get_cook", { id });

/**
 * Mark a pot empty, or re-open it. Always the user's own act — nothing closes
 * a pot because the arithmetic says it is nearly gone.
 */
export const finishCook = (id: string, finished = true) =>
  invoke<void>("finish_cook", { id, finished });

export const deleteCook = (id: string) => invoke<void>("delete_cook", { id });

export const listCustomFoods = () => invoke<CustomFood[]>("list_custom_foods");

export const getCustomFood = (id: string) =>
  invoke<CustomFood>("get_custom_food", { id });

/**
 * One entry point for creating a food and for editing one: pass an `id` to
 * replace that food in place, omit it to record a new one. The nutrient rows
 * are replaced wholesale, so removing a line here really removes it.
 */
export const saveCustomFood = (food: CustomFood, id: string | null = null) =>
  invoke<string>("save_custom_food", { id, food });

/**
 * Soft delete. Days already logged against this food keep the values they were
 * logged with. Its photos are left on disk rather than unlinked, but no screen
 * shows them once the food is gone — do not promise the user otherwise.
 */
export const deleteCustomFood = (id: string) =>
  invoke<void>("delete_custom_food", { id });

/**
 * The full 47-nutrient panel with every value's provenance — what came off the
 * pack, what was borrowed from the overridden entry, and what is simply not
 * known. Use this rather than `getCustomFood` wherever values are shown.
 */
export const getCustomFoodDetail = (id: string) =>
  invoke<CustomFoodDetail>("get_custom_food_detail", { id });

/**
 * Store a photo of the pack. Takes bare base64 with no `data:` prefix, and
 * returns the base filename to keep on the food — the backend decides both the
 * directory and the extension, from the bytes rather than from anything said
 * about them here.
 */
export const saveFoodPhoto = (dataBase64: string) =>
  invoke<string>("save_food_photo", { dataBase64 });

/** Read a stored photo back as base64, by the base filename it was saved under. */
export const readFoodPhoto = (name: string) =>
  invoke<string>("read_food_photo", { name });

/**
 * Read the nutrition panel in a stored photo, by the base filename
 * `saveFoodPhoto` returned. Recognition runs on this device.
 *
 * What comes back is a set of suggestions for the user to check against the
 * photo, and nothing here is written to a food — see `Scan`. Call it after the
 * photo is stored and never in front of the form: a scan that fails, or that
 * reads half the pack, must leave typing the panel in by hand exactly as it
 * was, because that is the path that always works.
 */
export const scanLabelPhoto = (name: string) => invoke<Scan>("scan_label_photo", { name });

/**
 * Read the ingredient statement in a stored photo, by the base filename
 * `saveFoodPhoto` returned. Recognition runs on this device.
 *
 * What comes back is a suggestion, not a value — see `IngredientsScan`. Offer
 * it beside the field and let the user accept it; never write it into a food on
 * its own, and never over text they have already typed, which is theirs.
 */
export const scanIngredientsPhoto = (name: string) =>
  invoke<IngredientsScan>("scan_ingredients_photo", { name });

/**
 * Read the Supplement Facts panel in a stored photo, by the base filename
 * `saveFoodPhoto` returned. Recognition runs on this device.
 *
 * Every figure that comes back is a suggestion, not a value — see
 * `SupplementScan`. Nothing here is converted or stored until the user confirms
 * the row it came from, and `regime` and `panel_complete` are never among the
 * things a scan can offer.
 */
export const scanSupplementPhoto = (name: string) =>
  invoke<SupplementScan>("scan_supplement_photo", { name });

/**
 * Read a barcode out of one captured frame. Takes bare base64 with no `data:`
 * prefix, as `saveFoodPhoto` does, but stores nothing: the digits are the whole
 * point of the photograph, and keeping the image afterwards buys nothing.
 *
 * What comes back is a suggestion, not a value — see `BarcodeScan`. Check
 * `trusted` before offering it: a payload that failed its own check digit was
 * misread and has to be shown as such, not handed over as a code that scanned.
 * And read `check_digit_verified`, not `trusted`, before telling the user
 * anything was verified — Code 128 and QR are trusted only because they carry
 * no check digit for anything to test.
 */
export const scanBarcode = (dataBase64: string) =>
  invoke<BarcodeScan>("scan_barcode", { dataBase64 });

/**
 * How much of a panel is legible in one live preview frame, for the indicator
 * that tells the user whether to move closer.
 *
 * Takes bare base64 with no `data:` prefix, as `saveFoodPhoto` does. This runs
 * repeatedly while the camera is open, so send a small frame: it answers "is a
 * panel in shot", not "what does it say".
 */
export const probeFrame = (dataBase64: string) =>
  invoke<Probe>("probe_frame", { dataBase64 });

/** Most recently used first, never-used last — the vessel you reached for last. */
export const listVessels = () => invoke<Vessel[]>("list_vessels");

/**
 * One entry point for adding a vessel and for re-weighing one: pass an `id` to
 * update that object in place, omit it to record a new one.
 */
export const saveVessel = (name: string, grams: number, id: string | null = null) =>
  invoke<string>("save_vessel", { id, name, grams });

/** Soft delete. Days logged with this vessel keep the weight they were logged with. */
export const deleteVessel = (id: string) => invoke<void>("delete_vessel", { id });

/** Most recently used first, never-used last — the bottle you reached for last. */
export const listBottles = () => invoke<Bottle[]>("list_bottles");

/**
 * One entry point for adding a bottle and for re-weighing one: pass an `id` to
 * update that object in place, omit it to record a new one.
 */
export const saveBottle = (
  name: string,
  fullG: number,
  emptyG: number | null,
  volumeMl: number | null,
  id: string | null = null,
) => invoke<string>("save_bottle", { id, name, fullG, emptyG, volumeMl });

/** Soft delete. Days logged with this bottle keep the amount they were logged with. */
export const deleteBottle = (id: string) => invoke<void>("delete_bottle", { id });

/**
 * Log how much of a bottle was drunk: the difference between its full weight
 * and what it reads now. A separate entry point from `addLogEntry` for the
 * same reason a supplement gets one — the reading is checked against the
 * bottle's own registered full weight rather than trusted at face value.
 */
/**
 * No meal parameter, deliberately. Water belongs to no sitting — see the
 * `meal` column in store.rs — and the backend now refuses one for it.
 */
export const logWater = (loggedOn: string, bottleId: string, currentG: number) =>
  invoke<string>("log_water", { loggedOn, bottleId, currentG });

/* ── spreadsheet import ───────────────────────────────────────────────── */

/**
 * Write a batch of already-parsed rows (see `src/lib/spreadsheet.ts`) as log
 * entries. Processed one row at a time on the Rust side, so one bad row never
 * holds the rest of a large import hostage — check `failed` even when
 * `imported` is also nonzero.
 */
export const importLogRows = (rows: ImportRowInput[]) =>
  invoke<ImportSummary>("import_log_rows", { rows });

/**
 * Which of these dates already carry at least one import-only entry, so a
 * re-run over the same file (or an overlapping one) can be caught before it
 * silently doubles those days' totals.
 */
export const datesWithExistingImports = (dates: string[]) =>
  invoke<string[]>("dates_with_existing_imports", { dates });

/* ── exporting the log ─────────────────────────────────────────────────── */

/**
 * Assemble the log for a period out of what each entry was FROZEN with.
 *
 * Nothing is recomputed — the command does not even open the reference
 * database — so an export of March still says what March said after a pack was
 * reformulated in June. See `src-tauri/src/export.rs`.
 */
export const exportLog = (from: string, to: string) =>
  invoke<ExportLog>("export_log", { from, to });

/**
 * Hand already-encoded bytes to the platform's own save panel — a native panel
 * on the Mac, the Storage Access Framework on Android.
 *
 * Resolves to the name the file was actually saved under, which is not always
 * the name that was suggested: the Android picker silently turns a second
 * export of the same period into "… (1).xlsx". Resolves to null when nothing
 * was written. Do not report that as an error, and do not report it as a
 * cancellation either — from here the two are indistinguishable on Android.
 */
export const saveExportedFile = (suggestedName: string, kind: ExportKind, dataBase64: string) =>
  invoke<string | null>("save_exported_file", { suggestedName, kind, dataBase64 });

/** Local calendar date as YYYY-MM-DD. Never use toISOString(), which is UTC. */
export function todayIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return todayIso(dt);
}

export function humanDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const today = todayIso();
  if (iso === today) return "Today";
  if (iso === shiftIso(today, -1)) return "Yesterday";
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/* ── correcting what a day recorded ────────────────────────────────────── */

/**
 * What an entry recorded, so a mistake in it can be found and fixed.
 *
 * These are the values the day is actually built from — frozen when the entry
 * was logged — not a fresh reading of the food it came from.
 */
export const getEntrySnapshot = (entryId: string) =>
  invoke<EntrySnapshotView>("get_entry_snapshot", { entryId });

/**
 * Correct how much was eaten. What it was made of is untouched: the pack has
 * not changed, only the reading of the scale, so every part is rescaled by the
 * same ratio and the recorded values stay exactly as they were.
 *
 * Pass `grams` for anything weighed and `units` for a counted dose — never
 * both. A scale reading and its vessels are cleared, because they no longer
 * explain the corrected number.
 */
export const correctEntryAmount = (
  entryId: string,
  grams: number | null,
  units: number | null,
) => invoke<void>("correct_entry_amount", { entryId, grams, units });

/**
 * Correct one recorded value on one part of an entry.
 *
 * `amount` belongs to `measured`; `upper` is the limit for `label_zero`,
 * `below_loq` and `trace`; `unknown` needs neither and removes the value.
 */
export const correctEntryValue = (
  entryId: string,
  ordinal: number,
  nutrientId: number,
  kind: CorrectableKind,
  amount: number | null,
  upper: number | null,
) => invoke<void>("correct_entry_value", { entryId, ordinal, nutrientId, kind, amount, upper });

/**
 * Value an entry again from what is known now.
 *
 * For when the food or recipe behind it has since been fixed and that should
 * apply to a day already logged. It is the one thing in the app that reaches
 * back into history with current data, and only ever when asked — the result
 * is stored as a correction rather than as what was originally recorded.
 */
export const refreezeEntry = (entryId: string) => invoke<void>("refreeze_entry", { entryId });

// ---------------------------------------------------------------------------
// Household
// ---------------------------------------------------------------------------

/** This device, the ones it is paired with, and how the last sync went. */
export const getHousehold = () => invoke<HouseholdView>("get_household");

/** Rename this device as the rest of the household sees it. */
export const renameDevice = (name: string) => invoke<void>("rename_device", { name });

/**
 * Start listening for a device to pair with, and return the QR code to show it.
 *
 * The offer expires on its own. A pairing token that stayed valid would be a
 * standing invitation lying on a screen.
 */
export const beginPairing = () => invoke<PairingOffer>("begin_pairing");

/** Where the current pairing attempt has got to. Polled while the QR is up. */
export const pairingState = () => invoke<PairingState>("pairing_state");

/**
 * Answer the six-digit comparison.
 *
 * `false` is not a cancel — it is the user saying the device that connected is
 * not the one they are holding, which is the whole point of the check.
 */
export const confirmPairing = (matches: boolean) =>
  invoke<void>("confirm_pairing", { matches });

/** Stop offering to pair, without having paired. */
export const cancelPairing = () => invoke<void>("cancel_pairing");

/**
 * Join the household whose code was just scanned.
 *
 * The other half of `beginPairing`: that one shows a code and listens, this one
 * reads a code and dials. Both then poll `pairingState`, both are asked the
 * same six digits, and neither writes the other down until both have said yes.
 */
export const joinPairing = (payload: string) =>
  invoke<void>("join_pairing", { payload });

/**
 * Read a pairing code out of one camera frame.
 *
 * Separate from `scanBarcode` because that one ranks what it finds as a product
 * code and runs it through a check-digit rule that says nothing at all about a
 * QR. Stores nothing: a photograph of a pairing code is worth nothing once it
 * has been read, and worth something to somebody else if it is kept.
 */
export const scanPairCode = (dataBase64: string) =>
  invoke<PairCodeScan>("scan_pair_code", { dataBase64 });

/**
 * Forget a device.
 *
 * Local only, and the screen says so: it stops this device syncing with that
 * one, and cannot reach back into the copy that device already holds. With no
 * server there is nothing to propagate it, so a third device has to be told
 * separately.
 */
export const unpairDevice = (deviceId: string) =>
  invoke<void>("unpair_device", { deviceId });

/** Sync now with every paired device that answers. */
export const syncNow = () => invoke<SyncOutcome[]>("sync_now");

/**
 * Hold the device's screen open, or let it go.
 *
 * Android only in effect. On the Mac and iOS builds this succeeds and does
 * nothing, which is deliberate: a caller asks for what it wants and never for
 * what platform it is on.
 *
 * Do not call this from a screen. `useKeepAwake` in lib/awake.ts owns the
 * pairing of the two calls, and an unpaired `true` is a phone burning its
 * screen on a kitchen counter all night.
 */
export const setKeepAwake = (on: boolean) => invoke<void>("set_keep_awake", { on });
/* ── the encrypted log, and the sealed copy ─────────────────────────────── */

/**
 * What is encrypted, what is sealed, when, how big, and what this phone's
 * keystore actually turned out to be.
 *
 * The one command in this group that does not refuse off Android. It answers
 * with `supported: false` instead, so the screen can explain the platform in
 * its own words rather than showing an alert where a page should be.
 */
export const backupStatus = () => invoke<BackupStatus>("backup_status");

/**
 * Encrypt the log, setting the recovery passphrase that is the only thing able
 * to get it back.
 *
 * One act, because it is one decision: an encrypted log with no recovery
 * passphrase is a log the operating system can take away. Making a copy that
 * Google may carry is a SEPARATE act — see `sealBackupNow`.
 */
export const enableLogEncryption = (passphrase: string, confirm: string) =>
  invoke<BackupStatus>("enable_log_encryption", { passphrase, confirm });

/** Turn encryption off again. Takes the passphrase, because it removes a
 *  protection. */
export const disableLogEncryption = (passphrase: string) =>
  invoke<BackupStatus>("disable_log_encryption", { passphrase });

/**
 * Change the recovery passphrase.
 *
 * `current` is required, not optional, and it is checked against the wrap on
 * disk before anything is written — otherwise anybody holding an unlocked phone
 * could revoke the passphrase protecting every copy of the log that has ever
 * left it.
 *
 * The copy on this phone is re-sealed under the new passphrase. A copy already
 * carried elsewhere still opens with the old one, because the passphrase that
 * wrapped a file's key is recorded inside that file.
 */
export const changeBackupPassphrase = (
  current: string,
  passphrase: string,
  confirm: string,
) => invoke<BackupStatus>("change_backup_passphrase", { current, passphrase, confirm });

/**
 * Write a fresh sealed copy now.
 *
 * This does NOT upload anything. Only Google's backup service does that, on its
 * own schedule.
 */
export const sealBackupNow = () => invoke<BackupStatus>("seal_backup_now");

/** Whether the app re-seals on its own once the log has moved on. */
export const setAutoReseal = (on: boolean) =>
  invoke<BackupStatus>("set_auto_reseal", { on });

/**
 * Delete the sealed copy, which is how the consent to upload is withdrawn.
 *
 * Local only. What Google has already taken is Google's to expire; this reaches
 * the file on the phone and nothing else.
 */
export const removeSealedBackup = () => invoke<BackupStatus>("remove_sealed_backup");

/**
 * Replace this phone's log with the sealed copy.
 *
 * The database being replaced is renamed, never deleted, and the outcome says
 * where it went.
 */
export const restoreBackup = (passphrase: string) =>
  invoke<RestoreOutcome>("restore_backup", { passphrase });

/** Open an encrypted log this session could not unlock silently. */
export const unlockLog = (passphrase: string) =>
  invoke<BackupStatus>("unlock_log", { passphrase });
