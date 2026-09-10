import { useCallback, useEffect, useRef, useState } from "react";
import {
  addLogEntry,
  addSupplementLogEntry,
  addWeighedLogEntry,
  getCustomFoodDetail,
  getFoodDetail,
  listBottles,
  listRecipes,
  listOpenCooks,
  finishCook,
  frequentFoods,
  humanDate,
  listSupplements,
  listVessels,
  logWater,
  recallTags,
  searchFoods,
} from "../api";
import type {
  Origin,
  Supplement,
  Bottle,
  CustomFood,
  CustomFoodDetail,
  CustomNutrientRow,
  FoodDetail,
  FoodHit,
  FrequentFood,
  Meal,
  NutrientValue,
  Portion,
  Cook,
  Recipe,
  Vessel,
} from "../types";
import { MEALS, SOURCE_LABEL, describeVolume } from "../types";
import { fmtAmount, plural } from "../lib/nutrient";
import WeightField from "../components/WeightField";
import TagPicker from "../components/TagPicker";
import type { Weighed } from "../components/WeightField";

interface Props {
  date: string;
  meal: Meal;
  /**
   * False while the vessel library or one of the custom-food screens is covering
   * this one. The screen stays mounted behind them so a search, a picked food
   * and its scale reading survive the detour.
   */
  active: boolean;
  /**
   * A search to open on, from the command palette (⌘K). Null when the screen
   * was reached the ordinary way, which must leave the field blank rather
   * than re-running whatever was searched for last.
   */
  seed?: string | null;
  onMealChange: (m: Meal) => void;
  onLogged: () => void;
  /** Through to the vessel library, from inside the weight field. */
  onManageVessels: () => void;
  /** Re-open the cook sheet on a pot, to correct what went into it. */
  onEditCook: (cookId: string) => void;
  /** The list of the user's own foods. */
  onManageCustomFoods: () => void;
  /** The custom-food editor, on a food that does not exist yet. */
  onCreateCustomFood: () => void;
  /** The supplement library. */
  onManageSupplements: () => void;
  /** The bottle library. */
  onManageBottles: () => void;
}

/**
 * Adding food is a task, so it gets its own screen with one focal point: the
 * search field, centred. Previously it was pinned to the side of the dashboard
 * permanently, competing with the day's data at equal weight.
 *
 * Results are grouped rather than interleaved: the user's own foods under their
 * own heading, the bundled reference data under its. Ranking them into one list
 * would let a weak match on a food you once transcribed outrank an exact match
 * in the reference data, and the two are different kinds of knowledge anyway —
 * one is what a pack says about a specific product, the other is a laboratory
 * mean for a category.
 */
export default function Foods(p: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FoodHit[]>([]);
  /**
   * The quick-add rows, which stand in the place the search results will take.
   * Empty is an ordinary state and not a failure: a new log has nothing to
   * shortcut, and the screen then looks exactly as it did before this existed.
   */
  const [quick, setQuick] = useState<FrequentFood[]>([]);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<FoodDetail | null>(null);
  /** The user's own food, picked. Never set at the same time as `picked`. */
  const [pickedCustom, setPickedCustom] = useState<CustomFoodDetail | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [grams, setGrams] = useState("100");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] =
    useState<"available" | "foods" | "recipes" | "supplements" | "water">("foods");
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [pickedRecipe, setPickedRecipe] = useState<Recipe | null>(null);
  /** Pots with food still in them, and the one being logged from. */
  const [cooks, setCooks] = useState<Cook[]>([]);
  const [pickedCook, setPickedCook] = useState<Cook | null>(null);
  /** Non-null only while the weight came off a scale with vessels on it. */
  const [weighed, setWeighed] = useState<Weighed | null>(null);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [wfKey, setWfKey] = useState(0);
  const seq = useRef(0);

  /**
   * Which result the arrow keys are on, and the field they are pressed in.
   *
   * The highlight lives here rather than on the focused element because focus
   * stays in the search box the whole time: a desktop search where ArrowDown
   * moves focus out of the field is a search you cannot keep typing into to
   * narrow. Enter picks whatever is highlighted, which is row 0 until moved.
   */
  const searchRef = useRef<HTMLInputElement>(null);
  const [activeHit, setActiveHit] = useState(0);

  /** The user's own answers for the thing being logged. */
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [cuisine, setCuisine] = useState<string | null>(null);
  /** Set when the two above were recalled rather than typed, so the UI says so. */
  const [recalled, setRecalled] = useState(false);

  const [supplements, setSupplements] = useState<Supplement[]>([]);
  const [pickedSupplement, setPickedSupplement] = useState<Supplement | null>(null);
  const [doseUnits, setDoseUnits] = useState("1");

  const [bottles, setBottles] = useState<Bottle[]>([]);
  const [pickedBottle, setPickedBottle] = useState<Bottle | null>(null);
  /** What the bottle reads right now — the number the backend subtracts from
   * its registered full weight. Defaults to empty, the common case. */
  const [currentG, setCurrentG] = useState("0");

  /**
   * Pre-fill the tags from the user's OWN last answer for this exact food.
   *
   * Never from the food's name: an alias says "this USDA row is what 'urad dal'
   * means", not "anything containing urad dal is Indian cuisine". A food they
   * have not tagged before gets blank controls, which is the honest outcome.
   */
  const recallSeq = useRef(0);
  const recall = useCallback(
    async (source: Parameters<typeof recallTags>[0]) => {
      // Clear first. The previous food's answers must not sit in the picker
      // while this lookup is in flight — they would be logged against the wrong
      // dish if the user were quick.
      const mine = ++recallSeq.current;
      setOrigin(null);
      setCuisine(null);
      setRecalled(false);
      try {
        const t = await recallTags(source);
        // A newer pick has superseded this lookup.
        if (mine !== recallSeq.current) return;
        setOrigin(t.origin);
        setCuisine(t.cuisine);
        setRecalled(t.origin !== null || t.cuisine !== null);
      } catch {
        /* leave the controls blank, which is the honest outcome */
      }
    },
    [],
  );

  /**
   * Open pots, re-read on every visit rather than cached.
   *
   * What is left in each is derived from the log, so it changes every time
   * anything is logged or deleted — including from another screen. A cached
   * figure here would tell the user there is food in a pot they emptied.
   */
  const loadCooks = useCallback(() => {
    listOpenCooks()
      .then((c) => {
        setCooks(c);
        // The default tab, but only when there is something in it. Landing on
        // an empty "Available" would put a dead end in front of the search.
        setTab((t) => (t === "foods" && c.length > 0 ? "available" : t));
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => { loadCooks(); }, [loadCooks]);

  /**
   * What this person has been logging most days lately, re-read rather than
   * cached for the reason the pots are: it is derived from the log, so it
   * changes the moment anything is logged or deleted — including from another
   * screen, or from another device in the household.
   *
   * A failure is swallowed and the list emptied, the way `recall`'s is. There
   * is nothing here the user can act on and nothing they asked for: an alert
   * bar over a search field, because a shortcut could not be assembled, would
   * be the app complaining about its own convenience.
   */
  const loadQuick = useCallback(() => {
    frequentFoods()
      .then(setQuick)
      .catch(() => setQuick([]));
  }, []);

  useEffect(() => { loadQuick(); }, [loadQuick]);

  useEffect(() => {
    if (tab === "available") loadCooks();
    if (tab === "recipes") listRecipes().then(setRecipes).catch((e) => setError(String(e)));
    if (tab === "supplements") {
      listSupplements().then(setSupplements).catch((e) => setError(String(e)));
    }
    if (tab === "water") listBottles().then(setBottles).catch((e) => setError(String(e)));
  }, [tab, loadCooks]);

  const runSearch = useCallback((q: string) => {
    const mine = ++seq.current;
    setBusy(true);
    searchFoods(q)
      .then((r) => { if (mine === seq.current) setHits(r); })
      .catch((e) => setError(String(e)))
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, []);

  /**
   * A query handed over by the command palette.
   *
   * Keyed on the value rather than run once on mount: this screen stays
   * mounted behind the asides, so a second ⌘K while it is already open has to
   * replace the search rather than be ignored. Any food already picked is
   * dropped — the user has just said what they are looking for, and leaving
   * the previous pick beside a new list would put a stale weight field next to
   * results it has nothing to do with.
   */
  useEffect(() => {
    const q = (p.seed ?? "").trim();
    if (q === "") return;
    setTab("foods");
    setQuery(q);
    setPicked(null); setPickedCustom(null); setPickedRecipe(null);
    setPickedCook(null); setWeighed(null);
    runSearch(q);
    searchRef.current?.focus();
  }, [p.seed, runSearch]);

  /**
   * A changed result set invalidates the highlight — row 3 of the old list is
   * a different food from row 3 of the new one, and Enter must never log
   * something the user has not looked at.
   */
  useEffect(() => { setActiveHit(0); }, [hits]);

  // Re-read on every return to the front. The vessel library and the custom-food
  // screens are separate routes, but this screen stays mounted behind them so the
  // picked food and its scale reading are not thrown away — which means a vessel
  // weighed there, or a food just transcribed from a pack, has to be picked up
  // here explicitly rather than by a remount. Re-running the search is the whole
  // point of the trip out: you go and add the food you were looking for.
  useEffect(() => {
    if (!p.active) return;
    listVessels().then(setVessels).catch((e) => setError(String(e)));
    // The trip out may have been to the cook sheet, and the whole point of that
    // trip is that a pot now exists. Without this the Available tab would not
    // appear until the user happened to switch tabs — and Foods is one of the
    // screens that stays mounted behind the cook sheet, so no remount will do
    // it for us.
    loadCooks();
    // The trip out may equally have been to the custom-food editor, and a pack
    // transcribed there is a pack that can now be logged again.
    loadQuick();
    if (tab === "supplements") {
      listSupplements().then(setSupplements).catch((e) => setError(String(e)));
    }
    if (tab === "water") listBottles().then(setBottles).catch((e) => setError(String(e)));
    const q = query.trim();
    if (q.length >= 2) runSearch(q);
    // Deliberately only on coming forward; `query` is read as it stands then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.active]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); setBusy(false); return; }
    const timer = setTimeout(() => runSearch(q), 160);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  async function pick(hit: FoodHit) {
    setError(null);
    try {
      if (hit.kind === "custom") {
        if (hit.custom_food_id === null) {
          setError("That result is missing its food, so it cannot be opened.");
          return;
        }
        const d = await getCustomFoodDetail(hit.custom_food_id);
        setPicked(null);
        setPickedCustom(d);
        setShowPanel(false);
        setNet(String(round(d.food.serving_g)));
        await recall({ customFoodId: hit.custom_food_id });
      } else {
        if (hit.fdc_id === null) {
          setError("That result has no reference entry behind it.");
          return;
        }
        const d = await getFoodDetail(hit.fdc_id);
        setPickedCustom(null);
        setPicked(d);
        setNet(d.portions[0] ? String(round(d.portions[0].gram_weight)) : "100");
        await recall({ fdcId: hit.fdc_id });
      }
    } catch (e) { setError(String(e)); }
  }

  /**
   * Open a quick-add row.
   *
   * The same journey a search hit makes — the same detail fetch, the same
   * picked panel, the same recalled tags — with one addition: the portion step
   * opens on the weight this food was last logged at rather than on its
   * default serving.
   *
   * The step itself is not skipped, and that is the design rather than
   * caution. A row that logged on one tap would be a button that writes to
   * somebody's history out of a list they never asked to have built; what this
   * does instead is fill in the part they would otherwise have typed. The
   * weight lands in an ordinary editable field, under the meal chips and the
   * tag picker and above an "Add to {meal}" button that still has to be
   * pressed. There is deliberately no second commit path here at all.
   *
   * Going through `setNet` also drops any live scale reading, for the reason
   * that function gives: a gross weight taken for one plate of one dish must
   * not follow the user to the next food.
   */
  async function pickFrequent(f: FrequentFood) {
    setError(null);
    try {
      if (f.source_kind === "custom") {
        if (f.custom_food_id === null) {
          setError("That shortcut is missing its food, so it cannot be opened.");
          return;
        }
        const d = await getCustomFoodDetail(f.custom_food_id);
        setPicked(null);
        setPickedCustom(d);
        setShowPanel(false);
        setNet(String(round(f.last_grams)));
        await recall({ customFoodId: f.custom_food_id });
      } else {
        if (f.fdc_id === null) {
          setError("That shortcut has no reference entry behind it.");
          return;
        }
        const d = await getFoodDetail(f.fdc_id);
        setPickedCustom(null);
        setPicked(d);
        setNet(String(round(f.last_grams)));
        await recall({ fdcId: f.fdc_id });
      }
    } catch (e) {
      // The row goes rather than staying tappable. The backend already drops a
      // food the current reference dataset no longer carries, so reaching this
      // means something changed underneath the list that was drawn — and a
      // shortcut that cannot be opened is worse than one that was never
      // offered, because it can be pressed again and again.
      setQuick((rows) => rows.filter((r) => r.key !== f.key));
      setError(String(e));
    }
  }

  /**
   * Set the net weight from outside the weight field — a serving chip, or the
   * default portion of a newly picked food. That drops any scale reading: the
   * gross weight was taken for one plate of one dish and must not follow the
   * user to the next, and the chip's number is now the one being logged.
   *
   * Remounting the field (via `wfKey`) is what keeps it honest — it returns to
   * direct mode showing this number, rather than sitting in scale mode
   * displaying a derived net that is not what would be saved.
   */
  function setNet(g: string) {
    setGrams(g);
    setWeighed(null);
    setWfKey((k) => k + 1);
  }

  /**
   * Both paths log the same net weight, and in scale mode it arrives already
   * derived from the ticked vessels — so one check covers an empty field and a
   * tare that swallowed the whole reading, which the field reports as no net.
   */
  function netOrError(): number | null {
    const g = Number(grams);
    if (!grams.trim() || !Number.isFinite(g) || g <= 0) {
      setError("Enter a weight greater than zero.");
      return null;
    }
    return g;
  }

  /**
   * Log a portion out of a pot.
   *
   * Deliberately does not check the portion against what is left. Going over
   * is allowed and is not even remarked on: the yield is one measurement of a
   * pot that has been stirred, served and put in the fridge, and a reading that
   * says 40 g remain when there are 60 is the ordinary case. Refusing the entry
   * would make the arithmetic the authority over the food.
   */
  async function commitCook() {
    if (!pickedCook) return;
    const g = netOrError();
    if (g === null) return;
    setSaving(true);
    try {
      if (weighed) {
        await addWeighedLogEntry(p.date, p.meal, { cookId: pickedCook.id }, pickedCook.name,
          weighed.grossG, weighed.vesselIds, { origin, cuisine });
      } else {
        await addLogEntry(p.date, p.meal, { cookId: pickedCook.id }, pickedCook.name, g,
          { origin, cuisine });
      }
      setPickedCook(null); setWeighed(null);
      setOrigin(null); setCuisine(null); setRecalled(false);
      // Re-read before the parent refreshes: what is left has just changed.
      loadCooks();
      p.onLogged();
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }

  async function closePot(c: Cook) {
    if (!window.confirm(`Finished with ${c.name}? Days that ate from it keep their entries.`)) return;
    try {
      await finishCook(c.id, true);
      if (pickedCook?.id === c.id) setPickedCook(null);
      loadCooks();
    } catch (e) { setError(String(e)); }
  }

  async function commitRecipe() {
    if (!pickedRecipe) return;
    const g = netOrError();
    if (g === null) return;
    setSaving(true);
    try {
      if (weighed) {
        await addWeighedLogEntry(p.date, p.meal, { recipeId: pickedRecipe.id }, pickedRecipe.name,
          weighed.grossG, weighed.vesselIds, { origin, cuisine });
      } else {
        await addLogEntry(p.date, p.meal, { recipeId: pickedRecipe.id }, pickedRecipe.name, g,
          { origin, cuisine });
      }
      setPickedRecipe(null); setQuery(""); setWeighed(null);
      setOrigin(null); setCuisine(null); setRecalled(false);
      p.onLogged();
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }

  async function commitCustom() {
    if (!pickedCustom) return;
    const g = netOrError();
    if (g === null) return;
    const food = pickedCustom.food;
    const name = foodLabel(food);
    setSaving(true);
    try {
      if (weighed) {
        await addWeighedLogEntry(p.date, p.meal, { customFoodId: food.id }, name,
          weighed.grossG, weighed.vesselIds, { origin, cuisine });
      } else {
        await addLogEntry(p.date, p.meal, { customFoodId: food.id }, name, g, { origin, cuisine });
      }
      setPickedCustom(null); setQuery(""); setHits([]); setWeighed(null);
      setOrigin(null); setCuisine(null); setRecalled(false);
      // The screen stays mounted after a log, and the list it is about to show
      // again has just changed underneath it — this very entry may be what
      // puts the food into the window in the first place.
      loadQuick();
      p.onLogged();
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }

  async function commitSupplement() {
    if (!pickedSupplement) return;
    const u = Number(doseUnits);
    if (!doseUnits.trim() || !Number.isFinite(u) || u <= 0) {
      setError("Enter how many you took.");
      return;
    }
    setSaving(true);
    try {
      await addSupplementLogEntry(
        p.date,
        p.meal,
        pickedSupplement.id,
        supplementLabel(pickedSupplement),
        u,
      );
      setPickedSupplement(null);
      p.onLogged();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function commitWater() {
    if (!pickedBottle) return;
    const g = Number(currentG);
    if (!currentG.trim() || !Number.isFinite(g) || g < 0) {
      setError("Enter what the bottle reads now — zero if it is empty.");
      return;
    }
    if (g >= pickedBottle.full_g) {
      setError(
        `${pickedBottle.name} reads ${Math.round(g)} g, which is not less than its full ` +
          `weight of ${Math.round(pickedBottle.full_g)} g — nothing to log.`,
      );
      return;
    }
    setSaving(true);
    try {
      await logWater(p.date, pickedBottle.id, g);
      setPickedBottle(null);
      setCurrentG("0");
      p.onLogged();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function commit() {
    if (!picked) return;
    const g = netOrError();
    if (g === null) return;
    setSaving(true);
    try {
      // The gross weight goes over as-is; the backend does the subtraction from the
      // stored vessel weights, so the log can never disagree with the library.
      if (weighed) {
        await addWeighedLogEntry(p.date, p.meal, { fdcId: picked.fdc_id }, picked.description,
          weighed.grossG, weighed.vesselIds, { origin, cuisine });
      } else {
        await addLogEntry(p.date, p.meal, { fdcId: picked.fdc_id }, picked.description, g,
          { origin, cuisine });
      }
      setPicked(null); setQuery(""); setHits([]); setWeighed(null);
      setOrigin(null); setCuisine(null); setRecalled(false);
      loadQuick();
      p.onLogged();
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }

  const unmeasured = picked
    ? picked.nutrients.filter((n) => n.value.kind === "absent" || n.value.kind === "zero_unknown").length
    : 0;

  const ownHits = hits.filter((h) => h.kind === "custom");
  const refHits = hits.filter((h) => h.kind === "reference");
  /** The two groups in the order they are drawn — what ↑/↓ walk. */
  const flatHits = [...ownHits, ...refHits];

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (flatHits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveHit((i) => (i + 1) % flatHits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveHit((i) => (i - 1 + flatHits.length) % flatHits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = flatHits[activeHit];
      if (h) pick(h);
    }
  }

  return (
    <div className="screen">
      {/* Centred while this screen is one narrow column, left-aligned once the
          workbench splits — see `.foodtabs`. A pill row floating in the middle
          of a 1,100px canvas with a left-aligned search field beneath it makes
          the eye start in the wrong place. Alignment is a breakpoint decision,
          so it lives in CSS rather than in an inline style. */}
      <div className="chips foodtabs">
        {/* A tap on the tab already showing does nothing. It is the switch that
            unmounts the weight field; clearing `weighed` without it would leave the
            field visibly subtracting vessels while the parent logged the net as an
            untared number, with no tare recorded and no vessel touched. */}
        {/* First, and selected by default when there is a pot open: the food
            already in the kitchen is the likeliest thing being eaten, and it
            is the only tab whose contents were actually weighed. Hidden
            entirely when nothing is open rather than shown empty. */}
        {cooks.length > 0 && (
          <button className="chip" aria-pressed={tab === "available"}
            onClick={() => {
              if (tab === "available") return;
              setTab("available");
              setPicked(null); setPickedCustom(null); setPickedRecipe(null); setWeighed(null);
            }}>Available</button>
        )}
        <button className="chip" aria-pressed={tab === "foods"}
          onClick={() => { if (tab === "foods") return; setTab("foods"); setPickedRecipe(null); setPickedCook(null); setWeighed(null); }}>Foods</button>
        <button className="chip" aria-pressed={tab === "recipes"}
          onClick={() => { if (tab === "recipes") return; setTab("recipes"); setPicked(null); setPickedCustom(null); setPickedCook(null); setWeighed(null); }}>My recipes</button>
        <button className="chip" aria-pressed={tab === "supplements"}
          onClick={() => {
            if (tab === "supplements") return;
            setTab("supplements");
            setPicked(null); setPickedCustom(null); setPickedRecipe(null); setPickedCook(null);
            setWeighed(null);
          }}>Supplements</button>
        <button className="chip" aria-pressed={tab === "water"}
          onClick={() => {
            if (tab === "water") return;
            setTab("water");
            setPicked(null); setPickedCustom(null); setPickedRecipe(null); setPickedCook(null);
            setWeighed(null);
          }}>Water</button>
      </div>

      {/* Above the tab split: a failed save on the recipe side used to have nowhere to appear. */}
      {error && <p className="alert" role="alert">{error}</p>}

      {tab === "available" ? (
        pickedCook ? (
          <section className="card">
            <div className="card__head">
              <h2 className="picked__title">{pickedCook.name}</h2>
              <button className="link card__note"
                onClick={() => { setPickedCook(null); setWeighed(null); }}>change</button>
            </div>
            <p className="rangenote">
              {potLine(pickedCook)}
              {pickedCook.weighed_yield_g === null && (
                <>
                  {" "}This pot was never weighed, so portions are divided by what its
                  ingredients add up to — an estimate. Weighing it makes every portion since
                  then no better, but every one after it exact.
                </>
              )}
            </p>

            <div className="group__name" style={{ marginTop: "var(--s4)" }}>Meal</div>
            <div className="chips">
              {MEALS.map((m) => (
                <button key={m} className="chip" aria-pressed={m === p.meal}
                  onClick={() => p.onMealChange(m)} style={{ textTransform: "capitalize" }}>{m}</button>
              ))}
            </div>

            <div className="group__name" style={{ marginTop: "var(--s5)" }}>How much</div>
            <div className="chips">
              {/* Everything left, for the last helping. The only portion this
                  screen can offer without inventing one — it is the pot's own
                  measurement minus what has already been logged. */}
              {pickedCook.remaining_g > 0 && (
                <button className="chip"
                  aria-pressed={!weighed && Number(grams) === Math.round(pickedCook.remaining_g)}
                  onClick={() => setNet(String(Math.round(pickedCook.remaining_g)))}>
                  All that's left · {Math.round(pickedCook.remaining_g)} g
                </button>
              )}
            </div>

            <WeightField
              key={wfKey}
              grams={grams}
              onChange={(g, w) => { setGrams(g); setWeighed(w); }}
              vessels={vessels}
              onManageVessels={p.onManageVessels}
              onSubmit={commitCook}
            />

            <TagPicker
              origin={origin}
              cuisine={cuisine}
              onChange={(o, c) => { setOrigin(o); setCuisine(c); setRecalled(false); }}
              recalledNote={recalled ? "From the last time you ate from this pot — change it if this helping was different." : null}
            />

            <div className="commit">
              <button className="btn" style={{ marginLeft: "auto" }} onClick={commitCook} disabled={saving}>
                {saving ? "Adding…" : `Add to ${p.meal}`}
              </button>
            </div>
          </section>
        ) : cooks.length === 0 ? (
          <div className="empty">
            <h3>Nothing cooked yet</h3>
            <p>
              Cook a recipe and the pot lands here with what is left in it, so a helping on
              Thursday still draws down Monday's dal.
            </p>
          </div>
        ) : (
          <section className="card">
            <div className="rows">
              {cooks.map((c) => (
                <div className="row" key={c.id} style={{ gridTemplateColumns: "1fr auto auto" }}>
                  <button className="row__main" style={{ textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer" }}
                    onClick={async () => {
                      setPickedCook(c);
                      // Half of what is left, rounded — a helping, not the pot.
                      // Nothing here knows how much you eat, so it is a figure
                      // to correct rather than one to trust.
                      setNet(String(Math.max(1, Math.round(c.remaining_g / 2))));
                      await recall({ cookId: c.id });
                      // A pot never eaten from falls back to what the cook
                      // sheet carried over from the recipe — the user's own
                      // statement, not a guess from the dish's name.
                      setOrigin((o) => o ?? c.default_origin);
                      setCuisine((x) => x ?? c.default_cuisine);
                    }}>
                    <span className="row__title">{c.name}</span>
                    <span className="row__sub">{potLine(c)}</span>
                  </button>
                  <button className="btn btn--quiet vrow__btn" onClick={() => p.onEditCook(c.id)}>
                    Adjust
                  </button>
                  <button className="btn btn--quiet vrow__btn" onClick={() => closePot(c)}>
                    Finished
                  </button>
                </div>
              ))}
            </div>
            <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
              A pot stays here until you say it is finished. What is left is the yield minus what
              you have logged from it, so deleting an entry puts the food back.
            </p>
          </section>
        )
      ) : tab === "supplements" ? (
        pickedSupplement ? (
          <section className="card">
            <div className="card__head">
              <h2 className="picked__title">{supplementLabel(pickedSupplement)}</h2>
              <button className="link card__note" onClick={() => setPickedSupplement(null)}>change</button>
            </div>
            <p className="rangenote">
              Its panel lists {plural(pickedSupplement.nutrients.length, "nutrient")}, per{" "}
              {pickedSupplement.serving_label ??
                `${pickedSupplement.serving_units} ${pickedSupplement.unit_noun}${pickedSupplement.serving_units === 1 ? "" : "s"}`}.
              {pickedSupplement.panel_complete
                ? " You marked the panel as listing everything, so what it leaves out counts as none."
                : " What it leaves out stays unknown rather than counting as none."}
            </p>

            <div className="group__name" style={{ marginTop: "var(--s4)" }}>Meal</div>
            <div className="chips">
              {MEALS.map((m) => (
                <button key={m} className="chip" aria-pressed={m === p.meal}
                  onClick={() => p.onMealChange(m)} style={{ textTransform: "capitalize" }}>{m}</button>
              ))}
            </div>

            {/* Counted, never weighed. No weight field and no vessels: a tablet
                does not go on a scale, and the tare machinery would be
                meaningless here. */}
            <div className="group__name" style={{ marginTop: "var(--s5)" }}>
              How many {pickedSupplement.unit_noun}s
            </div>
            <div className="dose">
              <input
                className="field tnum dose__n"
                inputMode="decimal"
                value={doseUnits}
                onChange={(e) => setDoseUnits(e.target.value)}
                aria-label={`How many ${pickedSupplement.unit_noun}s`}
              />
              <span className="dose__unit">
                {pickedSupplement.unit_noun}
                {Number(doseUnits) === 1 ? "" : "s"}
              </span>
              {pickedSupplement.serving_units !== 1 && (
                <span className="dose__note">
                  the panel is per {pickedSupplement.serving_units}
                </span>
              )}
            </div>

            <div className="commit">
              <button className="btn" style={{ marginLeft: "auto" }} onClick={commitSupplement}
                disabled={saving}>
                {saving ? "Adding…" : `Add to ${p.meal}`}
              </button>
            </div>
          </section>
        ) : supplements.length === 0 ? (
          <div className="empty">
            <h3>No supplements yet</h3>
            <p>
              A multivitamin can carry more of a day's iodine or B12 than everything else you
              eat put together. Transcribe one and those nutrients stop reading as gaps when
              they are not.
            </p>
            <button className="btn" onClick={p.onManageSupplements}>Add a supplement</button>
          </div>
        ) : (
          <section className="card">
            <div className="rows">
              {supplements.map((sup) => (
                <button className="row" key={sup.id} style={{ gridTemplateColumns: "1fr auto" }}
                  onClick={() => {
                    setPickedSupplement(sup);
                    setDoseUnits(String(sup.default_units ?? sup.serving_units));
                  }}>
                  <span className="row__main">
                    <span className="row__title">{supplementLabel(sup)}</span>
                    <span className="row__sub">
                      {plural(sup.nutrients.length, "line")} off the panel ·{" "}
                      {sup.serving_label ??
                        `${sup.serving_units} ${sup.unit_noun}${sup.serving_units === 1 ? "" : "s"}`}
                    </span>
                  </span>
                  <span className="row__chev">›</span>
                </button>
              ))}
            </div>
            <div className="card__foot">
              <button className="link" onClick={p.onManageSupplements}>Manage your supplements</button>
            </div>
          </section>
        )
      ) : tab === "water" ? (
        pickedBottle ? (
          <section className="card">
            <div className="card__head">
              <h2 className="picked__title">{pickedBottle.name}</h2>
              <button className="link card__note"
                onClick={() => { setPickedBottle(null); setCurrentG("0"); }}>change</button>
            </div>
            <p className="rangenote">
              Registered full at {Math.round(pickedBottle.full_g)} g. What it reads now,
              subtracted from that, is what gets logged as water.
            </p>

            {/* No meal picker, and this is the one tab that has none.
                A bottle is refilled and drunk from across a whole day, so
                there is no sitting it was part of — asking which one would
                collect an answer the clock had guessed and store it as the
                user's. The backend refuses a meal for water outright.

                Weighed, like food, never counted — no dose field and no
                vessels: the bottle's own registered full weight is the only
                tare this needs. */}
            <div className="group__name" style={{ marginTop: "var(--s5)" }}>
              What it reads now
            </div>
            <div className="dose">
              <input
                className="field tnum dose__n"
                inputMode="decimal"
                value={currentG}
                onChange={(e) => setCurrentG(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commitWater()}
                aria-label="What the bottle reads now, in grams"
              />
              <span className="dose__unit">g</span>
              {currentG.trim() !== "" &&
                Number.isFinite(Number(currentG)) &&
                Number(currentG) >= 0 &&
                Number(currentG) < pickedBottle.full_g && (
                  <span className="dose__note">
                    {/*
                      The scale gives grams and the bottle turns them into the
                      volume its label puts them in. Grams go in because that
                      is what a scale says; litres come out because that is
                      what a person drank.
                    */}
                    ≈{" "}
                    {describeVolume(
                      volumeOfDrink(pickedBottle, pickedBottle.full_g - Number(currentG)),
                    )}{" "}
                    of water
                  </span>
                )}
            </div>

            {/* "Add to the day", not "Add to breakfast": there is no sitting
                to add it to. */}
            <div className="commit">
              <button className="btn" style={{ marginLeft: "auto" }} onClick={commitWater}
                disabled={saving}>
                {saving ? "Adding…" : "Add to the day"}
              </button>
            </div>
          </section>
        ) : bottles.length === 0 ? (
          <div className="empty">
            <h3>No bottles yet</h3>
            <p>
              Weigh a bottle full once. After that, logging water is just reading it again —
              full minus what is left is what you drank.
            </p>
            <button className="btn" onClick={p.onManageBottles}>Add a bottle</button>
          </div>
        ) : (
          <section className="card">
            <div className="rows">
              {bottles.map((b) => (
                <button className="row" key={b.id} style={{ gridTemplateColumns: "1fr auto" }}
                  onClick={() => { setPickedBottle(b); setCurrentG("0"); }}>
                  <span className="row__main">
                    <span className="row__title">{b.name}</span>
                    <span className="row__sub">full at {Math.round(b.full_g)} g</span>
                  </span>
                  <span className="row__chev">›</span>
                </button>
              ))}
            </div>
            <div className="card__foot">
              <button className="link" onClick={p.onManageBottles}>Manage your bottles</button>
            </div>
          </section>
        )
      ) : tab === "recipes" ? (
        pickedRecipe ? (
          <section className="card">
            <div className="card__head">
              <h2 className="picked__title">{pickedRecipe.name}</h2>
              <button className="link card__note" onClick={() => { setPickedRecipe(null); setWeighed(null); }}>change</button>
            </div>
            <p className="rangenote">
              Written for {Math.round(pickedRecipe.yield_g).toLocaleString()} g, from{" "}
              {plural(pickedRecipe.ingredients.length, "ingredient")}. Logging here portions
              that written batch — if today's pot was a different size, cook it instead so the
              weights are the ones that went in.
            </p>

            <div className="group__name" style={{ marginTop: "var(--s4)" }}>Meal</div>
            <div className="chips">
              {MEALS.map((m) => (
                <button key={m} className="chip" aria-pressed={m === p.meal}
                  onClick={() => p.onMealChange(m)} style={{ textTransform: "capitalize" }}>{m}</button>
              ))}
            </div>

            <div className="group__name" style={{ marginTop: "var(--s5)" }}>How much</div>
            {/* Only the portions the user named. There was once a derived
                "1 serving" chip here, at yield ÷ servings — it went with the
                servings count, because it was a weight nobody had measured
                dressed up as one they had. */}
            <div className="chips">
              {pickedRecipe.serving_options.map((so) => (
                <button key={so.id || so.label} className="chip"
                  aria-pressed={!weighed && Number(grams) === Math.round(so.grams)}
                  onClick={() => setNet(String(Math.round(so.grams)))}>
                  {so.label} · {Math.round(so.grams)} g
                </button>
              ))}
            </div>

            <WeightField
              key={wfKey}
              grams={grams}
              onChange={(g, w) => { setGrams(g); setWeighed(w); }}
              vessels={vessels}
              onManageVessels={p.onManageVessels}
              onSubmit={commitRecipe}
            />

            <TagPicker
              origin={origin}
              cuisine={cuisine}
              onChange={(o, c) => { setOrigin(o); setCuisine(c); setRecalled(false); }}
              recalledNote={recalled ? "From the last time you logged this — change it if today was different." : null}
            />

            <div className="commit">
              <button className="btn" style={{ marginLeft: "auto" }} onClick={commitRecipe} disabled={saving}>
                {saving ? "Adding…" : `Add to ${p.meal}`}
              </button>
            </div>
          </section>
        ) : recipes.length === 0 ? (
          <div className="empty">
            <h3>No recipes saved yet</h3>
            <p>Build one on the Recipes screen and it becomes loggable here in one tap.</p>
          </div>
        ) : (
          <section className="card">
            <div className="rows">
              {recipes.map((r) => (
                <button className="row" key={r.id} style={{ gridTemplateColumns: "1fr auto" }}
                  onClick={async () => {
                    setPickedRecipe(r);
                    setNet(String(defaultPortion(r)));
                    await recall({ recipeId: r.id });
                    // A recipe the user has never logged falls back to what they
                    // said in the builder — their own statement, not a guess.
                    setOrigin((o) => o ?? r.default_origin);
                    setCuisine((c) => c ?? r.default_cuisine);
                  }}>
                  <span className="row__main">
                    <span className="row__title">{r.name}</span>
                    <span className="row__sub">
                      {plural(r.ingredients.length, "ingredient")} · written for{" "}
                      {Math.round(r.yield_g).toLocaleString()} g
                    </span>
                  </span>
                  <span className="row__chev">›</span>
                </button>
              ))}
            </div>
          </section>
        )
      ) : (
      <>
      {/* Master and detail, side by side above 1080px and one at a time
          below it — see `.workbench` in styles.css. The list keeps its scroll
          and its query while a food is picked beside it, which is what makes a
          mispick a glance rather than a trip back through a search. */}
      <div className="workbench" data-picked={picked !== null || pickedCustom !== null}>
        <div className="workbench__list">
        <div className="search-hero">
          <input
            ref={searchRef}
            className="field"
            placeholder="Search your foods and 13,694 more — try “urad dal”, “ghee”, “broccoli”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            autoFocus
            aria-label="Search foods"
            role="combobox"
            aria-expanded={flatHits.length > 0}
            aria-controls="food-hits"
          />
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginTop: "var(--s2)" }}>
            {flatHits.length > 0 && (
              <span className="hits__hint">
                <kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> to move,{" "}
                <kbd className="kbd">↵</kbd> to pick
              </span>
            )}
            <button className="link" style={{ marginLeft: "auto" }} onClick={p.onManageCustomFoods}>
              Your own foods
            </button>
          </div>
        </div>

        {query.trim().length < 2 ? (
        <>
        {/* A shortcut, and it has to read as one. There is no count on a row,
            no rank number, no "your favourites" and no heading that praises
            the person for having habits — a tally beside a food name is a
            leaderboard of your own eating, which is a streak wearing different
            clothes. The ordering's basis is stated ONCE, in the quiet note
            beside the heading, and never per row. What each row prints instead
            is the one fact that actually helps you choose: what you weighed
            out last time. That is a fact about the food.

            Only while the search is empty. Once two characters are typed the
            results are the answer, and a fixed list pinned above them would
            push real matches below the fold. Two rows long is a perfectly good
            list and gets no apology; nothing pads it, and with nothing in the
            window this branch renders exactly what it rendered before the
            section existed. */}
        {quick.length > 0 && (
          <section className="card">
            <div className="card__head">
              <h2>Quick add</h2>
              <span className="card__note">most days these past three months</span>
            </div>
            <ul className="hits" style={{ marginTop: "var(--s2)" }}>
              {quick.map((f) => (
                <li key={f.key}>
                  <button className="row hit" onClick={() => pickFrequent(f)}>
                    <span className="row__main">
                      <span className="row__title">{f.description}</span>
                      {f.brand && <span className="row__sub">{f.brand}</span>}
                    </span>
                    <span className="hit__src">{f.last_amount_label} last time</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="card__foot">
              A tap opens the amount, filled in with what you weighed last time — nothing is
              logged until you add it.
            </div>
          </section>
        )}
        <div className="empty">
          <h3>What did you eat?</h3>
          <p>
            Indian names work — <em>urad dal</em>, <em>besan</em>, <em>rava</em>, <em>haldi</em> —
            even where USDA files the food under a different name.
          </p>
          <p>
            Anything with a pack on it is better transcribed from the label than matched to a
            generic entry. Your own foods come first in these results.
          </p>
        </div>
        </>
      ) : busy && hits.length === 0 ? (
        <div className="card">
          {[0, 1, 2, 3, 4].map((i) => (
            <div className="skel skel--row" key={i} style={{ width: `${92 - i * 9}%` }} />
          ))}
        </div>
      ) : hits.length === 0 ? (
        <div className="empty">
          <h3>No matches for “{query.trim()}”</h3>
          <p>Try a simpler word, or the ingredient rather than the dish.</p>
          <p>
            If it is something with a nutrition panel on the back, transcribe that instead —
            what the pack says beats any generic entry for the thing you are actually eating.
          </p>
          <button className="btn" onClick={p.onCreateCustomFood}>Add it yourself</button>
        </div>
      ) : (
        <section className="card">
          {ownHits.length > 0 && (
            <>
              <div className="card__head">
                <h2>Your foods</h2>
                <span className="card__note">what the pack says</span>
              </div>
              <ul className="hits" id="food-hits" style={{ marginTop: "var(--s2)" }}>
                {ownHits.map((h, i) => (
                  <li key={`c-${h.custom_food_id}`}>
                    <button
                      className="row hit"
                      data-active={i === activeHit}
                      onMouseMove={() => setActiveHit(i)}
                      onClick={() => pick(h)}
                    >
                      <span className="row__main">
                        <span className="row__title">{h.description}</span>
                        {h.brand && <span className="row__sub">{h.brand}</span>}
                        {h.note && <span className="hit__note">{h.note}</span>}
                      </span>
                      <span className="hit__src">Yours</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {refHits.length > 0 && (
            <div style={{ marginTop: ownHits.length > 0 ? "var(--s5)" : 0 }}>
              <div className="card__head">
                <h2>Reference data</h2>
                <span className="card__note">USDA, per 100 g</span>
              </div>
              <ul className="hits" style={{ marginTop: "var(--s2)" }}>
                {refHits.map((h, i) => (
                  <li key={`r-${h.fdc_id}`}>
                    <button
                      className="row hit"
                      data-active={ownHits.length + i === activeHit}
                      onMouseMove={() => setActiveHit(ownHits.length + i)}
                      onClick={() => pick(h)}
                    >
                      <span className="row__main">
                        <span className="row__title">{h.description}</span>
                        {h.note && <span className="hit__note">{h.note}</span>}
                      </span>
                      <span className="hit__src">{SOURCE_LABEL[h.data_type] ?? h.data_type}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card__foot">
            Not the thing in your hand?{" "}
            <button className="link" onClick={p.onCreateCustomFood}>Add it from its label</button>
          </div>
        </section>
        )}
        </div>

        <div className="workbench__detail">
          {pickedCustom ? (
            <CustomPicked
          detail={pickedCustom}
          meal={p.meal}
          grams={grams}
          weighed={weighed}
          saving={saving}
          vessels={vessels}
          wfKey={wfKey}
          showPanel={showPanel}
          onTogglePanel={() => setShowPanel((s) => !s)}
          onMealChange={p.onMealChange}
          onNet={setNet}
          onWeight={(g, w) => { setGrams(g); setWeighed(w); }}
          onManageVessels={p.onManageVessels}
          onChangeFood={() => { setPickedCustom(null); setWeighed(null); }}
          onCommit={commitCustom}
          origin={origin}
          cuisine={cuisine}
          onTags={(o, cu) => { setOrigin(o); setCuisine(cu); setRecalled(false); }}
          recalledNote={recalled ? "From the last time you logged this — change it if today was different." : null}
        />
      ) : picked ? (
        <section className="card">
          <div className="card__head">
            <h2 className="picked__title">{picked.description}</h2>
            <button className="link card__note" onClick={() => { setPicked(null); setWeighed(null); }}>change</button>
          </div>

          <div className="group__name" style={{ marginTop: "var(--s4)" }}>Meal</div>
          <div className="chips">
            {MEALS.map((m) => (
              <button
                key={m}
                className="chip"
                aria-pressed={m === p.meal}
                onClick={() => p.onMealChange(m)}
                style={{ textTransform: "capitalize" }}
              >
                {m}
              </button>
            ))}
          </div>

          {picked.portions.length > 0 && (
            <>
              <div className="group__name" style={{ marginTop: "var(--s5)" }}>Serving</div>
              <div className="chips">
                {picked.portions.slice(0, 8).map((pt, i) => (
                  <button
                    key={i}
                    className="chip"
                    aria-pressed={!weighed && Number(grams) === round(pt.gram_weight)}
                    onClick={() => setNet(String(round(pt.gram_weight)))}
                  >
                    {portionLabel(pt)}
                  </button>
                ))}
              </div>
            </>
          )}

          <WeightField
            key={wfKey}
            grams={grams}
            onChange={(g, w) => { setGrams(g); setWeighed(w); }}
            vessels={vessels}
            onManageVessels={p.onManageVessels}
            onSubmit={commit}
          />

          <TagPicker
            origin={origin}
            cuisine={cuisine}
            onChange={(o, c) => { setOrigin(o); setCuisine(c); setRecalled(false); }}
            recalledNote={recalled ? "From the last time you logged this — change it if today was different." : null}
          />

          <div className="commit">
            <button className="btn" style={{ marginLeft: "auto" }} onClick={commit} disabled={saving}>
              {saving ? "Adding…" : `Add to ${p.meal}`}
            </button>
          </div>

          {unmeasured > 0 && (
            <div className="card__foot">
              {unmeasured} of {picked.nutrients.length} nutrients have no measured value for this
              food. They will count as unmeasured for the day rather than as zero.
            </div>
          )}
        </section>
          ) : (
            /* Desktop only (`.rest` is display:none below 1080px, where the
               list occupies the whole screen on its own). A blank half-window
               reads as a rendering fault; this says what the pane is for. */
            <div className="rest">
              <h3>Nothing picked yet</h3>
              <p>
                Choose something on the left and its serving sizes, weight and
                what it is measured for appear here.
              </p>
            </div>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
}

interface CustomPickedProps {
  detail: CustomFoodDetail;
  meal: Meal;
  grams: string;
  weighed: Weighed | null;
  saving: boolean;
  vessels: Vessel[];
  wfKey: number;
  showPanel: boolean;
  onTogglePanel: () => void;
  onMealChange: (m: Meal) => void;
  onNet: (g: string) => void;
  onWeight: (g: string, w: Weighed | null) => void;
  onManageVessels: () => void;
  onChangeFood: () => void;
  onCommit: () => void;
  origin: Origin | null;
  cuisine: string | null;
  onTags: (o: Origin | null, c: string | null) => void;
  recalledNote: string | null;
}

/**
 * One of the user's own foods, ready to log.
 *
 * The counts are stated before the weight field rather than after the fact: a
 * pack prints about fifteen numbers and this panel has forty-seven lines, so
 * most of what is about to be logged came from somewhere other than the pack,
 * and which somewhere is the difference between a borrowed figure and a gap.
 */
function CustomPicked(c: CustomPickedProps) {
  const { food, nutrients, base_description, from_label, from_base, unknown } = c.detail;
  const servingChip = food.serving_label ?? "1 serving";

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="picked__title">{foodLabel(food)}</h2>
        <button className="link card__note" onClick={c.onChangeFood}>change</button>
      </div>

      <p className="rangenote">
        {from_label} of {nutrients.length} values came off the pack.{" "}
        {base_description
          ? `${from_base} are borrowed from “${base_description}”, the generic entry this replaces, and ${unknown} are unmeasured.`
          : `The other ${unknown} are unmeasured — nothing here fills them in, and they count as gaps rather than as zero.`}
      </p>

      <div className="group__name" style={{ marginTop: "var(--s4)" }}>Meal</div>
      <div className="chips">
        {MEALS.map((m) => (
          <button key={m} className="chip" aria-pressed={m === c.meal}
            onClick={() => c.onMealChange(m)} style={{ textTransform: "capitalize" }}>{m}</button>
        ))}
      </div>

      {/* The pack's own serving, in the pack's own words. Its gram weight is what
          every transcribed figure on this food is per. */}
      <div className="group__name" style={{ marginTop: "var(--s5)" }}>Serving</div>
      <div className="chips">
        <button className="chip"
          aria-pressed={!c.weighed && Number(c.grams) === round(food.serving_g)}
          onClick={() => c.onNet(String(round(food.serving_g)))}>
          {servingChip} · {round(food.serving_g)} g
        </button>
      </div>

      <WeightField
        key={c.wfKey}
        grams={c.grams}
        onChange={c.onWeight}
        vessels={c.vessels}
        onManageVessels={c.onManageVessels}
        onSubmit={c.onCommit}
      />

      <TagPicker
        origin={c.origin}
        cuisine={c.cuisine}
        onChange={c.onTags}
        recalledNote={c.recalledNote}
      />

      <div className="commit">
        <button className="btn" style={{ marginLeft: "auto" }} onClick={c.onCommit} disabled={c.saving}>
          {c.saving ? "Adding…" : `Add to ${c.meal}`}
        </button>
      </div>

      {/* Below the commit rather than above it: forty-seven lines between the
          weight and the button would push the button off a phone screen. */}
      <div className="card__foot">
        <button className="link" onClick={c.onTogglePanel} aria-expanded={c.showPanel}>
          {c.showPanel ? "Hide all values" : `Show all ${nutrients.length} values`}
        </button>
      </div>

      {c.showPanel && (
        <div style={{ marginTop: "var(--s3)" }}>
          <p className="rangenote">
            Per 100 g, which is the basis everything else in the app is on. The pack's own
            figures are per {round(food.serving_g)} g and were scaled to match.
          </p>
          <div className="rows" style={{ marginTop: "var(--s3)" }}>
            {nutrients.map((n) => (
              <PanelRow key={n.id} n={n} base={base_description} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** One line of a custom food's panel, per 100 g, with where its value came from. */
function PanelRow({ n, base }: { n: CustomNutrientRow; base: string | null }) {
  const said =
    n.provenance === "label"
      ? "off the pack"
      : n.provenance === "inherited"
        ? base ? `from ${base}` : "from the generic entry"
        : "not measured";

  return (
    <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
      <span className="row__main">
        <span className="row__title" style={{ color: n.provenance === "unknown" ? "var(--ink-3)" : undefined }}>
          {n.name}
        </span>
        <span className="row__sub">{said}</span>
      </span>
      <span className="num" style={{ color: n.provenance === "unknown" ? "var(--ink-3)" : "var(--ink-2)" }}>
        {valueText(n.value, n.magnitude)}
      </span>
    </div>
  );
}

/**
 * One value as text. A bound reads as a bound and an unknown reads as a dash:
 * the only way a bare 0 appears here is if something actually measured one.
 */
function valueText(v: NutrientValue, unit: string): string {
  switch (v.kind) {
    case "measured":
      return fmtAmount(v.amount, unit);
    case "measured_zero":
    case "assumed_zero":
      return fmtAmount(0, unit);
    case "label_zero":
    case "below_loq":
    case "trace":
      return `< ${fmtAmount(v.upper, unit)}`;
    // A zero with nothing to bound it above — worth less than a bound, and it
    // must not be shown as though it were one.
    case "zero_unknown":
      return "0, unbounded";
    case "absent":
      return "—";
  }
}

/**
 * What a custom food is called in the log. The brand leads unless the name
 * already carries it, so a bar the user named "Hershey's Milk Chocolate" does
 * not become "Hershey's Hershey's Milk Chocolate" in every day it appears in.
 */
function foodLabel(f: CustomFood): string {
  if (!f.brand) return f.name;
  return f.name.toLowerCase().startsWith(f.brand.toLowerCase()) ? f.name : `${f.brand} ${f.name}`;
}

/**
 * One portion means `gram_weight` grams. The amount and unit are shown together
 * so the label can never name a quantity different from the value it encodes —
 * SR Legacy splits these ("10" + "crackers"), and collapsing them into a
 * per-unit weight would under-count an 11-cracker serving elevenfold.
 */
/**
 * What to put in the weight field when a recipe is picked.
 *
 * The smallest portion the user named, because a named portion is a weight
 * they actually decided on. With none named it falls back to 100 g — an
 * obvious placeholder to correct, rather than a figure derived from a batch
 * size that says nothing about what ends up on a plate.
 */
function defaultPortion(r: Recipe): number {
  const named = r.serving_options.map((so) => so.grams).filter((g) => g > 0);
  return Math.round(named.length > 0 ? Math.min(...named) : 100);
}

/**
 * What a pot has left, and where its yield came from.
 *
 * The provenance travels with the number, because "weighed" and "from the
 * ingredients" are different kinds of claim and every portion taken out of this
 * pot inherits whichever one it was.
 */
function potLine(c: Cook): string {
  const when = humanDate(c.cooked_on).toLowerCase();
  const basis = c.weighed_yield_g === null ? "from the ingredients" : "weighed";
  const left = `${Math.round(c.remaining_g).toLocaleString()} g left`;
  const of = `of ${Math.round(c.yield_g).toLocaleString()} g ${basis}`;
  return `${left} ${of} · cooked ${when}`;
}

function portionLabel(pt: Portion): string {
  const qty = pt.amount === 1 ? "" : `${trim(pt.amount)} `;
  const unit = pt.unit ?? pt.description ?? "portion";
  return `${qty}${unit} · ${round(pt.gram_weight)} g`;
}

/** What a supplement is called in the log — brand first unless the name has it. */
function supplementLabel(s: Supplement): string {
  if (!s.brand) return s.name;
  return s.name.toLowerCase().startsWith(s.brand.toLowerCase()) ? s.name : `${s.brand} ${s.name}`;
}

const round = (n: number) => Math.round(n * 10) / 10;
const trim = (n: number) => (Number.isInteger(n) ? String(n) : String(round(n)));

/**
 * What a weighed amount out of one bottle comes to in millilitres.
 *
 * Mirrors `trackit_core::water::volume_of`, which is the definition — this is
 * the same arithmetic ahead of the round trip, so the preview and the saved
 * entry cannot disagree. A bottle with no empty weight or no stated volume has
 * no scale factor of its own and falls back to the density of water.
 */
function volumeOfDrink(b: Bottle, grams: number): number {
  if (b.empty_g !== null && b.volume_ml !== null) {
    const capacity = b.full_g - b.empty_g;
    if (capacity > 0) return (grams * b.volume_ml) / capacity;
  }
  return grams / 0.9982;
}
