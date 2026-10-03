import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  scanBarcode,
  humanDate,
  listSupplements,
  listVessels,
  logWater,
  recallTags,
  searchFoods,
  per100g,
} from "../api";
import type { WeighedSource } from "../api";
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
  Per100g,
  Portion,
  Cook,
  Recipe,
  Vessel,
} from "../types";
import { MEALS, describeVolume, parsePick } from "../types";
import { fmtAmount } from "../lib/nutrient";
import { rowFigure } from "../lib/energy";
import { digitsOf, weighing } from "../lib/amount";
import type { Readout } from "../lib/amount";
import Amount, { AmountTitle, Dose } from "../components/Amount";
import type { Serving } from "../components/Amount";
import { useQuickLog } from "../components/QuickLog";
import CameraCapture from "../components/CameraCapture";
import ActivityPane from "./Activity";
import ScreenHead from "../components/ScreenHead";
import Glyph from "../components/Glyph";
import Sheet from "../components/Sheet";
import { PlusGlyph } from "../components/DayWater";
import { initials } from "../lib/entryText";
import { isAndroid, useMedia } from "../lib/desktop";
import { useHashSheet } from "../lib/hashSheet";
import { bare, canStream, readBarcodeFromFile, useCameraRoute } from "../lib/camera";
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
  /**
   * A food handed over by an Android home-screen widget, as the raw token from
   * the hash — `"food:167763"`, `"custom:<uuid>"`, or the literal `"water"`.
   *
   * A string rather than the parsed object on purpose. The effect below is
   * keyed on this prop, and a freshly-allocated object would be a new value on
   * every one of App's re-renders: the effect would re-run, `setNet` would fire
   * again, and a plate already weighed with two katoris tared would snap back
   * to the default portion. `seed` is a string for the same reason.
   *
   * The widget never logs anything and cannot: all it carries is which food.
   * The weight is still typed or weighed here, like any other.
   */
  preselect?: string | null;
  onMealChange: (m: Meal) => void;
  /**
   * Something was logged, and the day it went into is shown. `fromSheet` when
   * it was logged from the amount sheet, whose place in history the day then
   * takes: Back from it comes here, not to a sheet over nothing.
   */
  onLogged: (fromSheet?: boolean) => void;
  /**
   * The day changed while this screen stayed up — a one-tap log, or the Undo
   * of one. Re-reads it in place, without the trip to Today `onLogged` takes.
   */
  onChanged: () => void;
  /** Through to the vessel library, from the bowl line under the amount. */
  onManageVessels: () => void;
  /** Re-open the cook sheet on a pot, to correct what went into it. */
  onEditCook: (cookId: string) => void;
  /** The list of the user's own foods. */
  onManageCustomFoods: () => void;
  /**
   * The custom-food editor, on a food that does not exist yet.
   *
   * Takes the digits when the user got here by scanning a pack nothing matched,
   * so the one thing they have already done for this food is not thrown away
   * and asked for again.
   */
  onCreateCustomFood: (barcode?: string) => void;
  /** The supplement editor, on a supplement that does not exist yet. */
  onCreateSupplement: () => void;
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
  /* One tap writes the food at the weight printed on its button, and the way
     back out sits over the screen for eight seconds. `p.onLogged` is
     deliberately NOT called: that navigates to Today, and a person logging
     three staples in a row should stay in the list they are working down.
     The day behind this screen is re-read in place instead. It used to be
     left for "when they leave", which nothing did: Today then showed the day
     as it was before the tap, and an Undo pressed there took away a row that
     had never been drawn. */
  const qlog = useQuickLog(p.date, p.meal, p.onChanged);

  /* ── reading a pack ───────────────────────────────────────────────────────
     The lens is held open by the hash, not by state, so the Android back
     gesture closes it instead of navigating this screen out from under it —
     which matters more here than anywhere else, because `Foods` stays MOUNTED
     behind its asides (`hidden`, not unmounted), so a backed-out-of camera
     would keep a live stream and the indicator light running behind a hidden
     div. See `useCameraRoute`. */
  const barCam = useCameraRoute("barcode");
  /** The digits last read, so the no-match state knows a scan is why it is showing. */
  const [scanCode, setScanCode] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const barFile = useRef<HTMLInputElement>(null);
  const barSeq = useRef(0);
  /** Refocused when the sheet closes, so the keyboard is not left at the page top. */
  const barBtn = useRef<HTMLButtonElement>(null);

  /**
   * What a frame or a photo came to.
   *
   * `trusted` is the whole gate. An untrusted read is a guess at digits, and a
   * guess searched silently would put the wrong food in front of someone about
   * to log it — so it is reported rather than used.
   */
  async function readBarcode(b64: string) {
    const mine = ++barSeq.current;
    setScanBusy(true);
    setScanNote(null);
    try {
      const r = await scanBarcode(bare(b64));
      if (mine !== barSeq.current) return;
      if (r.payload !== null && r.trusted) {
        setScanCode(r.payload);
        setScanNote(null);
        // Straight into the search this screen already has: in TrackIt a
        // barcode IS a search — over the foods you transcribed yourself — and
        // it deliberately does not pick anything. A silent auto-pick would be a
        // write the back gesture could not undo, and it would teach a
        // scan-and-it-is-logged gesture the app cannot honour.
        setQuery(r.payload);
      } else if (r.payload !== null) {
        setScanNote(
          r.trouble ??
            "Those digits did not check out, so they were not searched. Try again square on, or type them in.",
        );
      } else {
        setScanNote(
          r.trouble ??
            "No barcode was found. Fill the frame with the code, hold steady, and try again.",
        );
      }
    } catch (e) {
      if (mine === barSeq.current) setScanNote(sentence(String(e)));
    } finally {
      if (mine === barSeq.current) setScanBusy(false);
    }
  }

  /**
   * The way in when there is no lens — a permission denied, a desktop, a
   * WebView built without the capability.
   *
   * This works and always would have: `scan_barcode` takes the same gate a
   * stored photo does and never cared where the bytes came from. Only the
   * interface insisted on a camera.
   */
  async function readBarcodeFile(f: File) {
    setScanBusy(true);
    setScanNote(null);
    const mine = ++barSeq.current;
    try {
      const r = await readBarcodeFromFile(f);
      if (mine !== barSeq.current) return;
      if (r.payload !== null && r.trusted) {
        setScanCode(r.payload);
        setQuery(r.payload);
      } else {
        setScanNote(
          r.trouble ?? "No barcode could be read from that photo. A closer, square-on shot works best.",
        );
      }
    } catch (e) {
      if (mine === barSeq.current) setScanNote(sentence(String(e)));
    } finally {
      if (mine === barSeq.current) setScanBusy(false);
    }
  }

  /** Lens if there is one, photo picker if there is not. */
  function startBarcode() {
    setScanNote(null);
    if (canStream()) barCam.openCam();
    else barFile.current?.click();
  }
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<FoodDetail | null>(null);
  /** The user's own food, picked. Never set at the same time as `picked`. */
  const [pickedCustom, setPickedCustom] = useState<CustomFoodDetail | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /*
    Opened on what it was sent for. The preselect effect below would get there
    too, but only after the first paint, so an activity would flash the food
    search on its way in.
  */
  const [tab, setTab] = useState<"foods" | "water" | "activity">(
    () => {
      const t = parsePick(p.preselect ?? null);
      if (t?.kind === "activity" || t?.kind === "strength") return "activity";
      return t?.kind === "water" ? "water" : "foods";
    },
  );
  /** A session opened from Today, to carry on with or correct (D26). */
  const [activityId, setActivityId] = useState<string | null>(() => {
    const t = parsePick(p.preselect ?? null);
    return t?.kind === "activity" ? t.id : null;
  });
  /** Arrived from the + sheet to start strength like last time. */
  const [likeLast, setLikeLast] = useState(() => parsePick(p.preselect ?? null)?.kind === "strength");
  /* Which sitting the food goes into: the screen's title, and a sheet to change it. */
  const mealSheet = useHashSheet("sheet", "meal");
  /*
    Where the amount is set: beside the list where the window is wide enough
    for both (the workbench), and otherwise in a sheet over it, held open by
    the hash so Back closes it. The keypad is drawn where there is no keyboard.
  */
  const amountSheet = useHashSheet("sheet", "amount");
  const wide = useMedia("(min-width: 1080px)");
  const keys = !useMedia("(hover: hover) and (pointer: fine)");
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [pickedRecipe, setPickedRecipe] = useState<Recipe | null>(null);
  /** Pots with food still in them, and the one being logged from. */
  const [cooks, setCooks] = useState<Cook[]>([]);
  const [pickedCook, setPickedCook] = useState<Cook | null>(null);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  /**
   * How much: the scale's window and the vessels ticked under the food (see
   * `components/Amount.tsx`). Held here rather than in the panel, because a
   * trip to the vessel library unmounts the sheet the panel is drawn in, and
   * a reading typed before it must still be there after.
   */
  const [readout, setReadout] = useState<Readout>({ digits: "100", from: "guess" });
  const [ticked, setTicked] = useState<string[]>([]);
  /*
    What is logged, from those two, every render: the food's own grams, and
    the scale reading behind them when vessels came off it. The backend takes
    the reading and the vessels' ids and subtracts from its own library, so the
    log cannot disagree with it.
  */
  const now = weighing(readout, ticked, vessels);
  const grams = now.net === null ? "" : String(now.net);
  const weighed: Weighed | null =
    now.vesselIds.length > 0 && now.reading !== null && now.net !== null
      ? { grossG: now.reading, vesselIds: now.vesselIds }
      : null;
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
      .then(setCooks)
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
  /*
    What is usually had at THIS sitting, for the chips under "Usually at
    dinner" — read again when the meal changes, since breakfast's usual foods
    are not dinner's.
  */
  const loadQuick = useCallback(() => {
    frequentFoods(4, p.meal)
      .then(setQuick)
      .catch(() => setQuick([]));
  }, [p.meal]);

  useEffect(() => { loadQuick(); }, [loadQuick]);

  /*
    Recipes and supplements sit among the person's own things now rather than
    behind tabs of their own, so they are read with the screen. A failure is
    swallowed, as the usual foods' is: nothing here was asked for, and an alert
    over the search because a list could not be read would be noise.
  */
  const loadKitchen = useCallback(() => {
    listRecipes().then(setRecipes).catch(() => setRecipes([]));
    listSupplements().then(setSupplements).catch(() => setSupplements([]));
  }, []);

  useEffect(() => { loadKitchen(); }, [loadKitchen]);

  useEffect(() => {
    if (tab === "water") listBottles().then(setBottles).catch((e) => setError(String(e)));
  }, [tab]);

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
    setPickedCook(null); setPickedSupplement(null); setTicked([]);
    runSearch(q);
    searchRef.current?.focus();
  }, [p.seed, runSearch]);

  /**
   * A food handed over by a home-screen widget.
   *
   * Sets the TAB as well as the pick, which is the whole trick: this screen
   * renders one branch of a `tab === …` chain and stays mounted across
   * navigation, so a user whose last visit ended on the Water tab would
   * otherwise land on the bottle list with a food invisibly picked behind it.
   * The `seed` effect above sets the tab for exactly the same reason.
   *
   * Keyed on the token, so a second tap on a different food while the screen is
   * already open replaces the pick rather than being ignored — and so an
   * ordinary re-render of App does not reset a weight already entered.
   */
  useEffect(() => {
    const target = parsePick(p.preselect ?? null);
    if (target === null) return;
    let live = true;
    setError(null);
    setPickedRecipe(null); setPickedCook(null); setPickedSupplement(null); setTicked([]);

    if (target.kind === "water") {
      // Water is logged from this screen's own water tab. The bottle library is
      // an inventory screen — it is where a jug's full weight is recorded, not
      // where a drink is — so a widget button pointed there would have looked
      // like it worked and logged nothing.
      setPicked(null); setPickedCustom(null);
      setTab("water");
      return;
    }
    if (target.kind === "activity" || target.kind === "strength") {
      setPicked(null); setPickedCustom(null);
      setActivityId(target.id);
      setLikeLast(target.kind === "strength");
      setTab("activity");
      return;
    }

    setTab("foods");
    (async () => {
      try {
        if (target.kind === "custom") {
          const d = await getCustomFoodDetail(target.id as string);
          if (!live) return;
          setPicked(null);
          setPickedCustom(d);
          setShowPanel(false);
          setNet(String(round(d.food.serving_g)));
          openAmount();
          await recall({ customFoodId: target.id as string });
        } else {
          const fdc = Number(target.id);
          const d = await getFoodDetail(fdc);
          if (!live) return;
          setPickedCustom(null);
          setPicked(d);
          setNet(d.portions[0] ? String(round(d.portions[0].gram_weight)) : "100");
          openAmount();
          await recall({ fdcId: fdc });
        }
      } catch {
        // A widget is a snapshot, and a food thrown away since it was written is
        // the one case where the row outlives the thing. Say so and leave a
        // blank search field rather than showing the backend's plumbing: the
        // user tapped a name, and what they need to know is that it has gone.
        if (!live) return;
        setPicked(null); setPickedCustom(null);
        setError("That food is no longer in your list, so it could not be opened.");
      }
    })();
    return () => { live = false; };
    // `recall` is stable and `setNet` is a plain function on this component;
    // re-running this for either would defeat the point of keying on the token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.preselect]);

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
    loadKitchen();
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
    clearPicks();
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
        openAmount();
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
        openAmount();
        await recall({ fdcId: hit.fdc_id });
      }
    } catch (e) { setError(String(e)); }
  }

  /** Only one thing is ever picked: each card beside the list commits its own. */
  function clearPicks() {
    setError(null);
    setPicked(null); setPickedCustom(null); setPickedRecipe(null); setPickedCook(null);
    setPickedSupplement(null); setTicked([]);
  }

  /*
    Opening a pot, a recipe or a supplement: what the rows of their old tabs
    did, unchanged, now that they sit in one list with everything else.
  */
  async function openCook(c: Cook) {
    clearPicks();
    setPickedCook(c);
    // Half of what is left, rounded — a helping, not the pot. Nothing here
    // knows how much you eat, so it is a figure to correct rather than one to
    // trust.
    setNet(String(Math.max(1, Math.round(c.remaining_g / 2))));
    openAmount();
    await recall({ cookId: c.id });
    // A pot never eaten from falls back to what the cook sheet carried over
    // from the recipe — the user's own statement, not a guess from the name.
    setOrigin((o) => o ?? c.default_origin);
    setCuisine((x) => x ?? c.default_cuisine);
  }

  async function openRecipe(r: Recipe) {
    clearPicks();
    setPickedRecipe(r);
    setNet(String(defaultPortion(r)));
    openAmount();
    await recall({ recipeId: r.id });
    // A recipe never logged falls back to what was said in the builder.
    setOrigin((o) => o ?? r.default_origin);
    setCuisine((c) => c ?? r.default_cuisine);
  }

  function openSupplement(sup: Supplement) {
    clearPicks();
    setPickedSupplement(sup);
    setDoseUnits(String(sup.default_units ?? sup.serving_units));
    openAmount();
  }

  /**
   * Open the window on a newly picked food's starting figure: the app's own
   * guess, drawn faint, to be typed over. That drops any scale reading — it
   * was taken for one plate of one dish and must not follow the user to the
   * next.
   */
  function setNet(g: string) {
    setReadout({ digits: digitsOf(Number(g)), from: "guess" });
    setTicked([]);
  }

  /** On a phone, the amount rises over the list. */
  function openAmount() {
    if (!wide) amountSheet.show();
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
      setPickedCook(null); setTicked([]);
      setOrigin(null); setCuisine(null); setRecalled(false);
      // Re-read before the parent refreshes: what is left has just changed.
      loadCooks();
      p.onLogged(amountSheet.open);
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }

  async function closePot(c: Cook) {
    if (!window.confirm(`Finished with ${c.name}? Days that ate from it keep their entries.`)) return;
    try {
      await finishCook(c.id, true);
      if (pickedCook?.id === c.id) {
        setPickedCook(null);
        amountSheet.hide();
      }
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
      setPickedRecipe(null); setQuery(""); setTicked([]);
      setOrigin(null); setCuisine(null); setRecalled(false);
      p.onLogged(amountSheet.open);
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
      setPickedCustom(null); setQuery(""); setHits([]); setTicked([]);
      setOrigin(null); setCuisine(null); setRecalled(false);
      // The screen stays mounted after a log, and the list it is about to show
      // again has just changed underneath it — this very entry may be what
      // puts the food into the window in the first place.
      loadQuick();
      p.onLogged(amountSheet.open);
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
      p.onLogged(amountSheet.open);
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
      setPicked(null); setQuery(""); setHits([]); setTicked([]);
      setOrigin(null); setCuisine(null); setRecalled(false);
      loadQuick();
      p.onLogged(amountSheet.open);
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }

  const unmeasured = picked
    ? picked.nutrients.filter((n) => n.value.kind === "absent" || n.value.kind === "zero_unknown").length
    : 0;

  const ownHits = hits.filter((h) => h.kind === "custom");
  const refHits = hits.filter((h) => h.kind === "reference");
  /*
    Your own pots, recipes and supplements answer a search too, matched on
    their names here: they are few, and already read for the list.
  */
  const q2 = query.trim().toLowerCase();
  const typed = q2.length >= 2;
  const potHits = typed ? cooks.filter((c) => c.name.toLowerCase().includes(q2)) : [];
  const recipeHits = typed ? recipes.filter((r) => r.name.toLowerCase().includes(q2)) : [];
  const suppHits = typed ? supplements.filter((x) => supplementLabel(x).toLowerCase().includes(q2)) : [];
  const yoursCount = potHits.length + recipeHits.length + suppHits.length + ownHits.length;
  /** Every result in the order drawn — what ↑, ↓ and Enter walk. */
  const choices: { key: string; open: () => void }[] = [
    ...potHits.map((c) => ({ key: `pot-${c.id}`, open: () => void openCook(c) })),
    ...recipeHits.map((r) => ({ key: `rec-${r.id}`, open: () => void openRecipe(r) })),
    ...suppHits.map((x) => ({ key: `sup-${x.id}`, open: () => openSupplement(x) })),
    ...ownHits.map((h) => ({ key: `c-${h.custom_food_id}`, open: () => void pick(h) })),
    ...refHits.map((h) => ({ key: `r-${h.fdc_id}`, open: () => void pick(h) })),
  ];

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (choices.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveHit((i) => (i + 1) % choices.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveHit((i) => (i - 1 + choices.length) % choices.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choices[activeHit]?.open();
    }
  }

  const anyPicked = picked !== null || pickedCustom !== null || pickedRecipe !== null
    || pickedCook !== null || pickedSupplement !== null;

  /*
    The sheet shut by Back, its scrim or its ×: the food is put down, as the
    old card's "change" did. Not while another screen is in front — a trip to
    the vessel library takes the sheet's param off the hash too, and the
    reading must be there on the way back.
  */
  useEffect(() => {
    if (wide || !p.active || amountSheet.open) return;
    if (anyPicked) clearPicks();
    // Keyed on the sheet alone: a food being picked has not opened it yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountSheet.open]);

  /*
    Adjusting a pot is a trip to the cook sheet and back, and what is left in
    it, and so the figures it is valued by, may have changed: the picked pot
    follows the list as it is read again.
  */
  useEffect(() => {
    setPickedCook((c) => (c === null ? c : cooks.find((x) => x.id === c.id) ?? c));
  }, [cooks]);

  /**
   * Each food's energy per 100 g, by `valueKey`: undefined until read, null
   * for one that cannot be valued. For the column beside the results and the
   * line under the amount. Pots and recipes are read again whenever they are,
   * since adjusting either moves its figure, and so are your own foods, which
   * can be edited; a reference food's never moves and is read once.
   */
  const [per100, setPer100] = useState<Record<string, Per100g | null>>({});
  const per100Now = useRef(per100);
  per100Now.current = per100;
  const value = useCallback((srcs: WeighedSource[]) => {
    if (srcs.length === 0) return;
    per100g(srcs)
      .then((got) => setPer100((m) => {
        const next = { ...m };
        srcs.forEach((s, i) => { next[valueKey(s)] = got[i] ?? null; });
        return next;
      }))
      // A figure beside a result was not asked for: a failure leaves it blank.
      .catch(() => undefined);
  }, []);
  useEffect(() => { value(cooks.map((c) => ({ cookId: c.id }))); }, [cooks, value]);
  useEffect(() => { value(recipes.map((r) => ({ recipeId: r.id }))); }, [recipes, value]);
  useEffect(() => {
    value(hits.flatMap((h): WeighedSource[] => {
      if (h.kind === "custom") return h.custom_food_id === null ? [] : [{ customFoodId: h.custom_food_id }];
      return h.fdc_id === null || `food:${h.fdc_id}` in per100Now.current ? [] : [{ fdcId: h.fdc_id }];
    }));
  }, [hits, value]);
  const pickedSrc: WeighedSource | null = pickedCook ? { cookId: pickedCook.id }
    : pickedRecipe ? { recipeId: pickedRecipe.id }
    : pickedCustom ? { customFoodId: pickedCustom.food.id }
    : picked ? { fdcId: picked.fdc_id } : null;
  const pickedKey = pickedSrc === null ? null : valueKey(pickedSrc);
  useEffect(() => {
    // Picked from a widget, or before its row's figure arrived.
    if (pickedSrc !== null && pickedKey !== null && !(pickedKey in per100Now.current)) value([pickedSrc]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey]);

  /*
    Results rise from the field. On a phone the search sits at the foot of the
    screen, so the space above it is held open and the results stand at the
    bottom of it: the best of them, your own, nearest your thumb.

    Measured from where the field actually is, because the keyboard moves it.
    The window is edge to edge and is not resized when the keyboard opens:
    MainActivity reports the keyboard's height as --sys-ime on the root
    element instead, and the field is lifted by that (`.food__dock`). Setting
    it fires no resize, so the root's style is watched. On a wider window the
    field heads the list and none of this applies.
  */
  const bodyRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const dock = dockRef.current;
    if (!body || !dock) return;
    const docked = () => getComputedStyle(dock).position === "fixed";
    const settle = () => {
      if (!docked()) { body.style.removeProperty("--food-fill"); return; }
      // From the top of the results, as they stand unscrolled, to just above the field.
      const fill = dock.getBoundingClientRect().top - (body.getBoundingClientRect().top + window.scrollY) - 16;
      body.style.setProperty("--food-fill", `${Math.max(0, Math.round(fill))}px`);
      // Only when the results outgrow the space: short ones already stand at
      // its foot, and scrolling then would push the meal's title off the top.
      // To where the last of them sits just above the field, and not to the
      // end of the page: the page's own padding clears a bottom bar this
      // screen does not have, and left a band of empty page between the
      // results and the field.
      if (typed && body.scrollHeight > Math.max(0, fill) + 1) {
        const past = body.getBoundingClientRect().bottom - (dock.getBoundingClientRect().top - 16);
        window.scrollTo({ top: window.scrollY + past });
      } else if (typed) {
        // Narrowed to a few, which fit: back to the top, where the title is
        // and where the space they stand at the foot of begins.
        window.scrollTo({ top: 0 });
      }
    };
    settle();
    const keyboard = new MutationObserver(settle);
    keyboard.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", settle);
    return () => {
      keyboard.disconnect();
      window.removeEventListener("resize", settle);
    };
  }, [typed, hits, anyPicked, tab]);

  /** A row of the list: what leads it, what it is, and what is on its right. */
  const row = (key: string, i: number | null, lead: React.ReactNode, title: string,
    sub: React.ReactNode, right: React.ReactNode, open: () => void) => (
    <button key={key} className="tile food__row" data-active={i !== null && i === activeHit}
      onMouseMove={i === null ? undefined : () => setActiveHit(i)} onClick={open}>
      {lead}
      <span className="row__main">
        <span className="row__title">{title}</span>
        {sub && <span className="row__sub">{sub}</span>}
      </span>
      {right}
    </button>
  );
  const potLead = <span className="lead lead--cook" aria-hidden><Glyph name="pot" size={20} /></span>;
  const recipeLead = <span className="lead lead--bought" aria-hidden><Glyph name="book" size={20} /></span>;
  const doseLead = <span className="lead lead--dose" aria-hidden><Glyph name="tablet" size={20} /></span>;
  const chev = <span className="food__chev" aria-hidden><Chevron /></span>;
  /** A result's energy per 100 g, under the unit its section heads with; blank until read. */
  const k100 = (key: string) => {
    const v = per100[key];
    return <span className="food__k tnum">{v ? rowFigure(v.energy) : ""}</span>;
  };

  /* ── how much ─────────────────────────────────────────────────────────
     One panel for whatever is picked: by weight in the scale's window, or,
     for a supplement, by count. What differs between the kinds is only what
     leads it, what it starts on and what is said at its foot. */
  const recalledNote = recalled ? "From the last time you logged this — change it if today was different." : null;
  const weigh = (lead: React.ReactNode, name: string, sub: React.ReactNode, servings: Serving[],
    onCommit: () => void, foot: React.ReactNode, note: string | null = recalledNote) => ({
    title: <AmountTitle lead={lead} name={name} sub={sub} />,
    body: (
      <Amount key={pickedKey ?? "none"} lead={lead} name={name} sub={sub} head={wide}
        onClose={wide ? clearPicks : undefined}
        readout={readout} setReadout={setReadout} ticked={ticked} setTicked={setTicked}
        servings={servings} per100={pickedKey === null ? undefined : per100[pickedKey]}
        vessels={vessels} onManageVessels={p.onManageVessels}
        meal={p.meal} saving={saving} onCommit={onCommit}
        origin={origin} cuisine={cuisine}
        onTags={(o, c) => { setOrigin(o); setCuisine(c); setRecalled(false); }}
        recalledNote={note} foot={foot} keypad={keys} autoFocus={wide && !keys} />
    ),
  });
  let panel: { title: React.ReactNode; body: React.ReactNode } | null = null;
  if (pickedCook) {
    const c = pickedCook;
    panel = weigh(potLead, c.name, `${potWhen(c)}, ${potLeft(c)}`,
      // Everything left, for the last helping: the one amount this can offer
      // without inventing one — the pot's own measurement less what is logged.
      c.remaining_g > 0
        ? [{ label: `All that's left · ${Math.round(c.remaining_g)} g`, grams: Math.round(c.remaining_g) }]
        : [],
      commitCook,
      <>
        {c.weighed_yield_g === null && (
          <p className="amount__note">
            Not weighed after cooking, so a helping is valued by what the recipe says the dish
            comes out at.
          </p>
        )}
        <div className="amount__links">
          <button className="link" onClick={() => p.onEditCook(c.id)}>Adjust this pot</button>
          <button className="link" onClick={() => void closePot(c)}>Finished with it</button>
        </div>
      </>,
      recalled ? "From the last time you ate from this pot — change it if this helping was different." : null);
  } else if (pickedRecipe) {
    const r = pickedRecipe;
    // Only the portions the user named: a derived "1 serving" was a weight
    // nobody had measured dressed up as one they had.
    panel = weigh(recipeLead, r.name, `Your recipe, ${Math.round(r.yield_g).toLocaleString()} g as written`,
      r.serving_options.map((so) => ({ label: `${so.label} · ${Math.round(so.grams)} g`, grams: Math.round(so.grams) })),
      commitRecipe,
      <p className="amount__note">
        Valued as the recipe is written. A pot cooked from it and weighed is valued as it came out.
      </p>);
  } else if (pickedCustom) {
    const { food, nutrients, base_description, from_label, from_base, unknown } = pickedCustom;
    const name = foodLabel(food);
    // The pack's own serving, in the pack's own words: what every figure it
    // printed is per.
    panel = weigh(<span className="lead lead--own" aria-hidden>{initials(name)}</span>, name, "Your food",
      [{ label: `${food.serving_label ?? "1 serving"} · ${round(food.serving_g)} g`, grams: round(food.serving_g) }],
      commitCustom,
      <>
        <p className="amount__note">
          {from_label} of {nutrients.length} values came off the pack
          {base_description ? `, ${from_base} are from “${base_description}”,` : ""} and {unknown} are
          unmeasured.
        </p>
        <button className="link" onClick={() => setShowPanel((s) => !s)} aria-expanded={showPanel}>
          {showPanel ? "Hide the values" : `All ${nutrients.length} values, per 100 g`}
        </button>
        {showPanel && (
          <div className="rows amount__panel">
            {nutrients.map((n) => <PanelRow key={n.id} n={n} base={base_description} />)}
          </div>
        )}
      </>);
  } else if (picked) {
    panel = weigh(<span className="lead lead--ref" aria-hidden>{initials(picked.description)}</span>,
      picked.description, "From the USDA",
      picked.portions.slice(0, 8).map((pt) => ({ label: portionLabel(pt), grams: round(pt.gram_weight) })),
      commit,
      unmeasured > 0 ? (
        <p className="amount__note">
          {unmeasured} of {picked.nutrients.length} nutrients have no measured value for this food,
          and count as unmeasured rather than as zero.
        </p>
      ) : null);
  } else if (pickedSupplement) {
    const s = pickedSupplement;
    const title = <AmountTitle lead={doseLead} name={supplementLabel(s)} sub="Your supplement" />;
    panel = {
      title,
      body: (
        <Dose units={doseUnits} onUnits={setDoseUnits} noun={s.unit_noun} perUnits={s.serving_units}
          meal={p.meal} saving={saving} onCommit={commitSupplement}
          head={wide ? (
            <header className="amount__bar">
              {title}
              <button type="button" className="sheet__close" aria-label="Close" onClick={clearPicks}>×</button>
            </header>
          ) : undefined} />
      ),
    };
  }

  /*
    An activity, or water to weigh: chosen before arriving — in the + sheet, on
    Today, in the water sheet — so each is a screen of its own, named for what
    it is. The row of tabs used to stay on top of both, offering food, water
    and activity again to someone who had just picked one of them. It is
    food's alone now: where the food comes from.
  */
  const chosen = tab === "activity" ? "Activity" : tab === "water" ? "Water" : null;

  return (
    <div className="screen">
      {chosen === "Activity" ? (
        /* Over the column it names: the activity pane keeps to a reading
           measure in the middle of a wide window. */
        <div className="activity__head"><ScreenHead title={chosen} /></div>
      ) : chosen ? (
        <ScreenHead title={chosen} />
      ) : (
        /* The meal is the title: which sitting this goes into is the one thing
           to know before anything is logged, and changing it is a tap on it. */
        <header className="head fhead">
          <button className="fhead__meal" onClick={mealSheet.show} aria-haspopup="dialog"
            aria-label={`Logging into ${p.meal}. Change the meal`}>
            <span className="head__title">{mealName(p.meal)}</span>
            <span className="fhead__chev" aria-hidden><Chevron down /></span>
          </button>
          <p className="fhead__day">{dayLine(p.date)}</p>
        </header>
      )}

      {error && <p className="alert" role="alert">{error}</p>}

      {tab === "activity" ? (
        /* Its own screen in its own file, drawn here so every way into it — the
           + sheet, Today, a home-screen widget — keeps the address it has always
           had (`foods?pick=activity`). */
        <ActivityPane date={p.date} sessionId={activityId} likeLast={likeLast} onDone={p.onLogged} />
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
      ) : (
        /* The list and the card for what is picked: side by side above 1080px
           and one at a time below it — see `.workbench` in styles.css. */
        <div className="workbench food" data-picked={wide && anyPicked}>
          <div className="workbench__list food__list">
            <div ref={bodyRef} className={`food__body${typed ? " is-results" : ""}`}>
              {!typed ? (
                <>
                  {/* What is already cooked comes first: the food in the
                      kitchen is the likeliest thing being eaten. */}
                  {cooks.length > 0 && (
                    <section className="food__sec" aria-label="On the stove">
                      <h2 className="food__h">On the stove</h2>
                      <div className="tiles">
                        {cooks.map((c) => row(`pot-${c.id}`, null, potLead, c.name, potWhen(c),
                          <span className="food__left tnum">{potLeft(c)}</span>, () => void openCook(c)))}
                      </div>
                    </section>
                  )}

                  {/* One tap each, at last time's amount, into this meal, with
                      Undo — the same entry the long way round would write (see
                      QuickLog.tsx). Its amount is changed from the entry. */}
                  {quick.length > 0 && (
                    <section className="food__sec" aria-label={`Usually at ${p.meal}`}>
                      <h2 className="food__h">Usually at {p.meal}</h2>
                      <div className="usual__chips">
                        {quick.map((f) => (
                          <button
                            key={f.key}
                            className="usual__chip"
                            onClick={() => void qlog.log(f)}
                            disabled={qlog.pending !== null}
                            aria-busy={qlog.pending === f.key}
                            aria-label={`Log ${f.description}, ${f.last_amount_label}, to ${p.meal}`}
                          >
                            <PlusGlyph />
                            <span className="usual__name">{f.description}</span>
                            <span className="usual__amt tnum">{f.last_amount_label}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}

                  {(recipes.length > 0 || supplements.length > 0) && (
                    <section className="food__sec" aria-label="Also yours">
                      <h2 className="food__h">Also yours</h2>
                      <div className="tiles">
                        {recipes.map((r) => row(`rec-${r.id}`, null, recipeLead, r.name, "Your recipe",
                          chev, () => void openRecipe(r)))}
                        {supplements.map((x) => row(`sup-${x.id}`, null, doseLead, supplementLabel(x),
                          doseText(x), chev, () => openSupplement(x)))}
                      </div>
                    </section>
                  )}

                  {cooks.length === 0 && quick.length === 0 && recipes.length === 0 && supplements.length === 0 && (
                    <div className="empty">
                      <h3>What did you eat?</h3>
                      <p>
                        Search below. Indian names work: <em>urad dal</em>, <em>besan</em>,{" "}
                        <em>rava</em>. Anything in a pack is better added from its label, with the
                        camera in the search field.
                      </p>
                    </div>
                  )}
                </>
              ) : busy && hits.length === 0 && yoursCount === 0 ? (
                <div className="card">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div className="skel skel--row" key={i} style={{ width: `${92 - i * 9}%` }} />
                  ))}
                </div>
              ) : choices.length === 0 ? (
                /*
                  Two different dead ends, and they need different words.

                  After a SCAN, the honest thing to say is the thing the app has
                  never said out loud: the digits were read on this phone and
                  looked up nowhere, because there is no product database here and
                  nothing left the device.
                */
                <div className="empty">
                  {scanCode !== null && query.trim() === scanCode ? (
                    <>
                      <h3>No food of yours has that barcode</h3>
                      <p>
                        The digits came off the pack fine. TrackIt reads them on this phone and
                        looks them up nowhere, so nothing was sent anywhere. Add the food from
                        its pack once and this barcode finds it every time after that.
                      </p>
                      <button className="btn" onClick={() => p.onCreateCustomFood(scanCode)}>
                        Add it from its pack
                      </button>
                    </>
                  ) : (
                    <>
                      <h3>No matches for “{query.trim()}”</h3>
                      <p>
                        Try a simpler word, or the ingredient rather than the dish. Anything with
                        a nutrition panel is better taken from the pack.
                      </p>
                      <div className="empty__acts">
                        <button className="btn" onClick={() => p.onCreateCustomFood()}>
                          Add it from its pack
                        </button>
                        <button className="btn btn--quiet" onClick={p.onCreateSupplement}>
                          Add a supplement from its bottle
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                /* Yours, then the reference data, in that order in the page.
                   On a phone they stand in reverse above the field, so your own
                   are the nearest to it (`.food__results`). */
                <div className="food__results" id="food-hits">
                  {yoursCount > 0 && (
                    <section className="food__sec" aria-label="Yours">
                      <h2 className="food__h">
                        Yours
                        {/* A supplement is counted, and has no figure per 100 g. */}
                        {yoursCount > suppHits.length && <span className="food__unit">kcal per 100 g</span>}
                      </h2>
                      <div className="tiles">
                        {potHits.map((c, i) => row(`pot-${c.id}`, i, potLead, c.name,
                          `${potWhen(c)}, ${potLeft(c)}`, k100(`cook:${c.id}`), () => void openCook(c)))}
                        {recipeHits.map((r, i) => row(`rec-${r.id}`, potHits.length + i, recipeLead, r.name,
                          "Your recipe", k100(`recipe:${r.id}`), () => void openRecipe(r)))}
                        {suppHits.map((x, i) => row(`sup-${x.id}`, potHits.length + recipeHits.length + i,
                          doseLead, supplementLabel(x), doseText(x), <span />, () => openSupplement(x)))}
                        {ownHits.map((h, i) => row(`c-${h.custom_food_id}`,
                          potHits.length + recipeHits.length + suppHits.length + i,
                          <span className="lead lead--own" aria-hidden>{initials(h.description)}</span>,
                          h.description, h.note ?? h.brand, k100(`custom:${h.custom_food_id}`), () => void pick(h)))}
                      </div>
                    </section>
                  )}
                  {refHits.length > 0 && (
                    <section className="food__sec" aria-label="From the USDA">
                      <h2 className="food__h">
                        From the USDA <span className="food__unit">kcal per 100 g</span>
                      </h2>
                      <div className="tiles">
                        {refHits.map((h, i) => row(`r-${h.fdc_id}`, yoursCount + i,
                          <span className="lead lead--ref" aria-hidden>{initials(h.description)}</span>,
                          h.description, h.note, k100(`food:${h.fdc_id}`), () => void pick(h)))}
                      </div>
                    </section>
                  )}
                  <p className="food__foot">
                    Not the thing in your hand?{" "}
                    <button className="link" onClick={() => p.onCreateCustomFood()}>Add it from its pack</button>
                  </p>
                </div>
              )}
            </div>

            {/* The field where the thumb is. Pinned to the foot of a phone's
                screen, and so above the keyboard when it is up; at the top of
                the list on a wider window, where the keyboard is a real one.
                The barcode and the pack camera are two icons in it: things
                done now and then, not two cards with a paragraph each. */}
            <div ref={dockRef} className="food__dock">
              {scanNote !== null && (
                <p className="food__scan">
                  {scanNote}{" "}
                  <button className="link" onClick={startBarcode}>Try again</button>
                </p>
              )}
              <div className="food__field">
                <svg className="food__glass" width="20" height="20" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
                  <circle cx="11" cy="11" r="6.5" />
                  <path d="M16 16l4.5 4.5" />
                </svg>
                <input
                  ref={searchRef}
                  className="food__input"
                  placeholder="Search foods"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKey}
                  /* A keyboard sprung on arrival would cover what is to hand,
                     which is the point of the screen on a phone. */
                  autoFocus={!isAndroid()}
                  enterKeyHint="search"
                  aria-label="Search foods"
                  role="combobox"
                  aria-expanded={choices.length > 0}
                  aria-controls="food-hits"
                />
                {query !== "" && (
                  <button className="food__icon" aria-label="Clear the search"
                    onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" aria-hidden>
                      <path d="M7 7l10 10M17 7L7 17" />
                    </svg>
                  </button>
                )}
                {/* Always offered, camera or not — see `startBarcode`. */}
                <button className="food__icon" onClick={startBarcode} ref={barBtn} disabled={scanBusy}
                  aria-label={scanBusy ? "Reading the barcode" : "Find it by its barcode"}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.9" strokeLinecap="round" aria-hidden>
                    <path d="M3.5 7.5V5.6A1.6 1.6 0 0 1 5.1 4H7" />
                    <path d="M17 4h1.9A1.6 1.6 0 0 1 20.5 5.6v1.9" />
                    <path d="M20.5 16.5v1.9a1.6 1.6 0 0 1-1.6 1.6H17" />
                    <path d="M7 20H5.1a1.6 1.6 0 0 1-1.6-1.6v-1.9" />
                    <path d="M7.5 8.5v7M10.5 8.5v7M13.5 8.5v7M16.5 8.5v7" />
                  </svg>
                </button>
                <button className="food__icon" onClick={() => p.onCreateCustomFood()}
                  aria-label="Add a food from its pack">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.9" strokeLinejoin="round" aria-hidden>
                    <path d="M4 8.5h3l1.4-2h7.2L17 8.5h3a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z" />
                    <circle cx="12" cy="13.5" r="3.2" />
                  </svg>
                </button>
              </div>
              {/* The way in with no lens: a photo of the pack already on the
                  phone. Rendered always, because it is also what
                  `startBarcode` falls back to when the permission is refused. */}
              <input
                ref={barFile}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void readBarcodeFile(f);
                }}
              />
            </div>
          </div>

          <div className="workbench__detail">
            {wide && (panel ? <section className="card amount-card">{panel.body}</section> : (
              /* A blank half-window reads as a rendering fault; this says
                 what the pane is for. */
              <div className="rest">
                <h3>Nothing picked yet</h3>
                <p>Choose something on the left to set how much of it you had.</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Which meal the food goes into. A sheet rather than four chips under
          the title, since it is set by the clock and changed now and then. */}
      <Sheet open={mealSheet.open} onClose={mealSheet.hide} title="Which meal?">
        <div className="tiles mealpick">
          {MEALS.map((m) => (
            <button key={m} className="tile mealpick__row" aria-pressed={m === p.meal}
              onClick={() => { p.onMealChange(m); mealSheet.hide(); }}>
              <span className="lead lead--ref" aria-hidden><Glyph name={m} size={20} /></span>
              <span className="row__title">{mealName(m)}</span>
              {m === p.meal && (
                <svg className="mealpick__tick" width="20" height="20" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </Sheet>

      {/* How much, over the list, wherever the panel does not fit beside it. */}
      {!wide && (
        <Sheet open={amountSheet.open && panel !== null} onClose={amountSheet.hide}
          title={panel?.title ?? null} className="amount-sheet"
          /* With a keyboard, the window takes it: the grams are typed there. */
          initialFocus={keys ? undefined
            : () => document.querySelector<HTMLElement>(".amount-sheet .readout__input")}>
          {panel?.body}
        </Sheet>
      )}

      {/* The lens. Open only while the hash says so, so the Android back
          gesture closes it rather than navigating this screen away underneath
          it — see `useCameraRoute`. */}
      {barCam.open && (
        <CameraCapture
          scanKind="barcode"
          onCapture={(b64) => { barCam.closeCam(); void readBarcode(b64); barBtn.current?.focus(); }}
          onCancel={() => { barCam.closeCam(); barBtn.current?.focus(); }}
          /* A denied permission is not a dead end here: `scan_barcode` reads a
             stored photo exactly as it reads a frame. */
          onPickInstead={() => { barCam.closeCam(); barFile.current?.click(); }}
        />
      )}

      {/* What the green button on a "Had it before" row just wrote is said in
          the app's one bar, with its way back (see UndoBar.tsx); only a log
          that failed is said here. */}
      {qlog.error && <p className="alert" role="alert">{qlog.error}</p>}
    </div>
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
 * What a serving chip says.
 *
 * `unit` is whatever the source dataset carries there, and FNDDS carries
 * numeric modifier CODES — so this printed “52000 · 9.8 g”, offering a
 * five-digit database key as though it were a portion somebody might
 * recognise. A code is not a name. Anything with no letter in it is dropped
 * and the chip falls back to the one thing that is always true and always
 * useful: what it weighs.
 */
function portionLabel(pt: Portion): string {
  const named = [pt.description, pt.unit].find(
    (v): v is string => typeof v === "string" && /\p{L}/u.test(v),
  );
  // A portion of so many grams is said once: "100 g", not "100 g · 100 g".
  if (named === undefined || /^g(rams?)?$/i.test(named.trim())) return `${round(pt.gram_weight)} g`;
  const qty = pt.amount === 1 ? "" : `${trim(pt.amount)} `;
  return `${qty}${named.trim()} · ${round(pt.gram_weight)} g`;
}

/** The key a food's figure per 100 g is kept under. */
function valueKey(s: WeighedSource): string {
  if ("fdcId" in s) return `food:${s.fdcId}`;
  if ("customFoodId" in s) return `custom:${s.customFoodId}`;
  if ("recipeId" in s) return `recipe:${s.recipeId}`;
  return `cook:${s.cookId}`;
}

/** A sitting's name as a title: "Dinner". */
function mealName(m: Meal): string {
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** The day being logged into, as Today writes it under its title. */
function dayLine(iso: string): string {
  const dt = new Date(`${iso}T00:00:00`);
  const thisYear = iso.slice(0, 4) === new Date().toISOString().slice(0, 4);
  return dt.toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long",
    ...(thisYear ? {} : { year: "numeric" as const }),
  });
}

/** When a pot was cooked: "Cooked today", "Cooked Sun, Sep 27". */
function potWhen(c: Cook): string {
  const d = humanDate(c.cooked_on);
  return `Cooked ${d === "Today" || d === "Yesterday" ? d.toLowerCase() : d}`;
}

/**
 * What a pot has left, roughly: the yield is one measurement of a pot that has
 * been stirred and served since — and for a pot never weighed, the recipe's
 * expectation — so the figure is said as about.
 */
function potLeft(c: Cook): string {
  return c.remaining_g > 0 ? `about ${Math.round(c.remaining_g).toLocaleString()} g left` : "none left";
}

/** A supplement's usual dose: "1 tablet", "2 capsules". */
function doseText(sup: Supplement): string {
  const n = sup.default_units ?? sup.serving_units;
  return `${n} ${sup.unit_noun}${n === 1 ? "" : "s"}`;
}

/** The chevron the list's rows end on, and the title's, pointing down. */
function Chevron({ down = false }: { down?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden
      style={down ? { transform: "rotate(90deg)" } : undefined}>
      <path d="M10 7l5 5-5 5" />
    </svg>
  );
}

/** What a supplement is called in the log — brand first unless the name has it. */
function supplementLabel(s: Supplement): string {
  if (!s.brand) return s.name;
  return s.name.toLowerCase().startsWith(s.brand.toLowerCase()) ? s.name : `${s.brand} ${s.name}`;
}

/** An error string, given a capital and a full stop so it reads as a sentence. */
function sentence(s: string): string {
  const t = s.replace(/^Error:\s*/, "").trim();
  if (t === "") return "That did not work.";
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".");
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
