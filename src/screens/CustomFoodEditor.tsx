import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  getCustomFood,
  getDay,
  getFoodDetail,
  readFoodPhoto,
  saveCustomFood,
  scanBarcode,
  scanIngredientsPhoto,
  scanLabelPhoto,
  searchFoods,
  todayIso,
} from "../api";
import CameraCapture from "../components/CameraCapture";
import LabelForm from "../components/LabelForm";
import PhotoSlot from "../components/PhotoSlot";
import type {
  BarcodeScan,
  CustomFood,
  CustomNutrient,
  FoodHit,
  IngredientsScan,
  NutrientRow,
  Scan,
} from "../types";
import { LABEL_NUTRIENTS } from "../types";
import ScreenHead from "../components/ScreenHead";

interface Props {
  /**
   * The food being edited, or null to create one. The router reads it out of the
   * hash, so a reload and the Android back gesture both land on the same food.
   */
  id: string | null;
  /**
   * Digits already read off this pack, when the user got here by scanning one
   * that matched nothing. Only ever seeds a NEW food: an existing food has a
   * barcode of its own and a route param must not overwrite it.
   */
  barcode?: string | null;
  /** Saved — back to the list. */
  onDone: () => void;
  /** Left without saving. The draft is cleared first. */
  onCancel: () => void;
}

/**
 * Create or edit one of the user's own foods, from the pack in front of them.
 *
 * The screen exists because a nutrition panel prints about fifteen values and
 * this app displays forty-seven. The other thirty-odd are either borrowed from
 * the generic entry this food replaces or genuinely unknown, and the running
 * summary at the top says which — before saving, while the choice of base can
 * still be changed.
 */
export default function CustomFoodEditor(p: Props) {
  const first = useState(() => loadDraft(p.id))[0];

  const [name, setName] = useState(first?.name ?? "");
  const [brand, setBrand] = useState(first?.brand ?? "");
  /* `p.barcode` only where there is no saved food to take one from. A scanned
     code is a starting point for a food being created, never a correction to
     one already stored. */
  const [barcode, setBarcode] = useState(first?.barcode ?? (p.id === null ? (p.barcode ?? "") : ""));
  const [overridesFdcId, setOverridesFdcId] = useState<number | null>(first?.overridesFdcId ?? null);
  const [servingG, setServingG] = useState(first?.servingG ?? "");
  const [servingLabel, setServingLabel] = useState(first?.servingLabel ?? "");
  const [ingredients, setIngredients] = useState(first?.ingredients ?? "");
  const [photoLabel, setPhotoLabel] = useState<string | null>(first?.photoLabel ?? null);
  const [photoIngredients, setPhotoIngredients] = useState<string | null>(first?.photoIngredients ?? null);
  const [nutrients, setNutrients] = useState<CustomNutrient[]>(first?.nutrients ?? []);

  const [wasRestored, setWasRestored] = useState(!!first);
  const [loading, setLoading] = useState(p.id !== null && !first);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * The form exactly as it was loaded, as JSON. The draft is written only once
   * the form differs from this, so opening a food to look at it does not leave
   * behind something that later claims to be unsaved work. Null means "already
   * dirty" — which is what a restored draft is by definition.
   */
  const [baseline, setBaseline] = useState<string | null>(null);

  /** The overridden entry's name and its own 47 values, for the live summary. */
  const [baseName, setBaseName] = useState<string | null>(null);
  const [baseRows, setBaseRows] = useState<NutrientRow[] | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FoodHit[]>([]);
  const [hidCustom, setHidCustom] = useState(false);
  const seq = useRef(0);

  const [viewing, setViewing] = useState(false);
  const wide = useWide();

  /**
   * What the camera thinks the panel says, held APART from `nutrients` and never
   * written to the draft.
   *
   * Text recognition misreads "1.5" as "15" often enough that a figure off a
   * camera is not something the user has asserted, and a wrong figure here is
   * wrong again on every day this food is logged. So a reading has exactly one
   * way into the form — the user accepting that row — and nothing restores it: a
   * draft picked up tomorrow contains the user's work, not a guess made about a
   * photo they may never have looked at.
   */
  const [suggestions, setSuggestions] = useState<CustomNutrient[] | null>(null);
  const [scanNote, setScanNote] = useState<ScanNote | null>(null);
  const [scanning, setScanning] = useState(false);
  /** The serving the panel printed. Offered, never typed in on the user's behalf. */
  const [servingHint, setServingHint] = useState<{ g: number | null; label: string | null } | null>(null);

  /** Which scan is the current one, so a second photo's result cannot land after it. */
  const scanSeq = useRef(0);

  function forgetScan() {
    scanSeq.current++;
    setSuggestions(null);
    setScanNote(null);
    setServingHint(null);
    setScanning(false);
  }

  /**
   * Read the panel in the photo just stored. Runs after the photo is on disk and
   * beside the form rather than in front of it: every branch below ends with the
   * fields exactly as usable as they were, because typing the pack in by hand is
   * the path that always works and this only ever saves keystrokes.
   */
  async function runScan(photoName: string) {
    const mine = ++scanSeq.current;
    setSuggestions(null);
    setScanNote(null);
    setServingHint(null);
    setScanning(true);
    try {
      const s = await scanLabelPhoto(photoName);
      if (mine !== scanSeq.current) return;
      setSuggestions(s.readings.length > 0 ? s.readings : null);
      setScanNote(noteOf(s));
      setServingHint(s.serving_g !== null || s.serving_label !== null
        ? { g: s.serving_g, label: s.serving_label }
        : null);
    } catch (e) {
      if (mine !== scanSeq.current) return;
      setScanNote({ kind: "failed", text: sentence(String(e)) });
    } finally {
      if (mine === scanSeq.current) setScanning(false);
    }
  }

  /**
   * One reading confirmed. This is the ONLY way a reading becomes a value.
   *
   * The label form holds suggestions in their own prop and never writes one into
   * its lines itself, so the merge belongs here, where `nutrients` lives. It
   * comes back down as an ordinary outside edit and the form reseeds from it.
   */
  function acceptSuggestion(n: CustomNutrient) {
    setNutrients((cur) => merge(cur, [n]));
    // Functional: the form confirms several readings in one go when only some of
    // them clashed, and each of those calls lands in the same batch.
    setSuggestions((cur) => {
      const left = (cur ?? []).filter((c) => c.nutrient_id !== n.nutrient_id);
      return left.length > 0 ? left : null;
    });
  }

  /** Every reading taken at once — the form fires this only when none was held back. */
  function acceptAll() {
    const all = suggestions ?? [];
    if (all.length === 0) return;
    setNutrients((cur) => merge(cur, all));
    setSuggestions(null);
  }

  function acceptServing() {
    if (!servingHint) return;
    if (servingHint.g !== null) setServingG(String(servingHint.g));
    if (servingHint.label !== null && !servingLabel.trim()) setServingLabel(servingHint.label);
    setServingHint(null);
  }

  /**
   * What the camera made of the ingredient list, held APART from `ingredients`
   * and never written to the draft.
   *
   * Prose rather than figures, but the rule does not change with the shape of
   * what was read: a recogniser that turns "Rye" into "Rve" or drops the word
   * "not" out of a warning has proposed a reading of the pack, not written the
   * pack down. It goes in when the user has looked at it and said so.
   */
  const [ingRead, setIngRead] = useState<{ text: string; contains: string | null } | null>(null);
  const [ingNote, setIngNote] = useState<IngNote | null>(null);
  const [ingScanning, setIngScanning] = useState(false);

  /** Which ingredient scan is the current one, so a replaced photo wins. */
  const ingSeq = useRef(0);

  function forgetIngredientScan() {
    ingSeq.current++;
    setIngRead(null);
    setIngNote(null);
    setIngScanning(false);
  }

  /**
   * Read the ingredient list off the photo just stored. Same footing as the
   * panel scan: it runs after the photo is on disk, it says what it found beside
   * the box rather than in it, and every branch leaves typing the list out by
   * hand exactly as available as it was.
   */
  async function runIngredientScan(photoName: string) {
    const mine = ++ingSeq.current;
    setIngRead(null);
    setIngNote(null);
    setIngScanning(true);
    try {
      const s: IngredientsScan = await scanIngredientsPhoto(photoName);
      if (mine !== ingSeq.current) return;
      const text = s.text.trim();
      const contains = s.contains?.trim() || null;
      if (text || contains) {
        setIngRead({ text, contains });
        // A frame cropped to the bottom of a pack catches the allergen line
        // without the list above it. The statement is worth offering, but on
        // its own it is not the list, and a box holding only "Contains: WHEAT"
        // under the heading "Read from the photo" reads as a finished capture.
        // The backend measures its trouble against the LIST for exactly this;
        // showing the two together is what keeps that sentence reachable.
        if (!text && s.trouble) setIngNote({ kind: "trouble", text: s.trouble });
      } else if (s.trouble) {
        setIngNote({ kind: "trouble", text: s.trouble });
      } else {
        setIngNote({ kind: "none", lines: s.lines });
      }
    } catch (e) {
      if (mine !== ingSeq.current) return;
      setIngNote({ kind: "failed", text: sentence(String(e)) });
    } finally {
      if (mine === ingSeq.current) setIngScanning(false);
    }
  }

  /**
   * The reading as one block of text: the list, then the allergen statement on a
   * line of its own.
   *
   * "CONTAINS: WHEAT" is an assertion ABOUT the list rather than a part of it,
   * and folding it into the commas would leave the box claiming wheat is an
   * ingredient of a food that merely shares a line with it.
   */
  const ingText = useMemo(() => {
    if (!ingRead) return "";
    const parts: string[] = [];
    if (ingRead.text) parts.push(ingRead.text);
    if (ingRead.contains) parts.push(`Contains: ${ingRead.contains}`);
    return parts.join("\n");
  }, [ingRead]);

  /** The reading and the box already say the same thing — nothing to put anywhere. */
  const ingSame = ingText !== "" && ingredients.trim() === ingText.trim();

  /**
   * The reading into the box. The only way it gets there, and never over typed
   * text without the user picking which of the two they meant — `append` keeps
   * both, `replace` is the choice they made with the old text in front of them.
   */
  function acceptIngredients(how: "replace" | "append") {
    if (!ingText) return;
    setIngredients((cur) =>
      how === "replace" || cur.trim() === "" ? ingText : `${cur.replace(/\s+$/, "")}\n${ingText}`,
    );
    forgetIngredientScan();
  }

  /**
   * The barcode read off a live frame. Nothing is stored: a photograph of a
   * barcode is worth nothing once the digits are read, so the frame goes to the
   * recogniser and no further.
   */
  const [barcodeCam, setBarcodeCam] = useState(false);
  const [barcodeReading, setBarcodeReading] = useState(false);
  const [barcodeShot, setBarcodeShot] = useState<BarcodeScan | null>(null);
  const [barcodeNote, setBarcodeNote] = useState<string | null>(null);
  const barSeq = useRef(0);

  function forgetBarcodeScan() {
    barSeq.current++;
    setBarcodeShot(null);
    setBarcodeNote(null);
    setBarcodeReading(false);
  }

  async function readBarcodeFrame(dataBase64: string) {
    setBarcodeCam(false);
    const mine = ++barSeq.current;
    setBarcodeShot(null);
    setBarcodeNote(null);
    setBarcodeReading(true);
    try {
      const b = await scanBarcode(bare(dataBase64));
      if (mine !== barSeq.current) return;
      if (b.payload === null) {
        setBarcodeNote(
          b.trouble ??
            "No barcode was found in that frame. Fill the frame with the code, hold steady, and try again.",
        );
      } else {
        setBarcodeShot(b);
      }
    } catch (e) {
      if (mine !== barSeq.current) return;
      setBarcodeNote(`Reading that frame failed — ${sentence(String(e))} Type the digits in instead.`);
    } finally {
      if (mine === barSeq.current) setBarcodeReading(false);
    }
  }

  /**
   * The digits into the field. Guarded on `trusted` as well as on the payload:
   * a code whose check digit does not compute is a misread, and this is the one
   * place it could quietly become the number the food is found by.
   */
  function acceptBarcode() {
    if (!barcodeShot?.payload || !barcodeShot.trusted) return;
    setBarcode(barcodeShot.payload);
    forgetBarcodeScan();
  }

  /**
   * What the code's own arithmetic settled, in a sentence.
   *
   * Only the GS1 numeric family carries a check digit. A Code 128 or a QR code
   * carries none, so there is nothing to have added up, and saying otherwise
   * would be this screen inventing an assurance nobody gave it. Which happened
   * is `check_digit_verified`, computed where the checksum was: deriving it
   * here from the symbology's name meant one spelling drifting from another and
   * every verified code being reported as unverifiable. The recogniser's own
   * note is preferred where it sent one.
   */
  const barcodeAssurance =
    barcodeShot?.trouble ??
    (barcodeShot?.check_digit_verified
      ? "The check digit adds up."
      : "It carries no check digit, so nothing about these characters could be verified — read them against the pack.");

  const apply = useCallback((d: Persisted) => {
    setName(d.name);
    setBrand(d.brand);
    setBarcode(d.barcode);
    setOverridesFdcId(d.overridesFdcId);
    setServingG(d.servingG);
    setServingLabel(d.servingLabel);
    setIngredients(d.ingredients);
    setPhotoLabel(d.photoLabel);
    setPhotoIngredients(d.photoIngredients);
    setNutrients(d.nutrients);
  }, []);

  // One place decides what the form starts as: an unsaved draft for this exact
  // food, the stored food, or a blank sheet. Keyed on the id so the screen
  // survives the router pointing it at a different food without a remount.
  useEffect(() => {
    const draft = loadDraft(p.id);
    if (draft) {
      apply(draft);
      setBaseline(null);
      setWasRestored(true);
      setLoading(false);
      return;
    }
    setWasRestored(false);
    if (p.id === null) {
      const blank = blankDraft(null);
      apply(blank);
      setBaseline(JSON.stringify(blank));
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    getCustomFood(p.id)
      .then((f) => {
        if (!live) return;
        const stored = draftOf(f);
        apply(stored);
        setBaseline(JSON.stringify(stored));
        setLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setError(String(e));
        setLoading(false);
      });
    return () => { live = false; };
  }, [p.id, apply]);

  // A reading belongs to the food it was taken for. The router pointing this
  // screen at a different food does not remount it, so the set is dropped here —
  // otherwise the next food would open holding the last one's suggestions, and a
  // fig bar's sugars would be sitting on a jar of ghee.
  useEffect(() => {
    scanSeq.current++;
    setSuggestions(null);
    setScanNote(null);
    setServingHint(null);
    setScanning(false);
    // The ingredient list and the barcode belong to that same pack, and a
    // barcode left on offer would be the fastest thing on this screen to
    // accept without looking.
    ingSeq.current++;
    setIngRead(null);
    setIngNote(null);
    setIngScanning(false);
    barSeq.current++;
    setBarcodeShot(null);
    setBarcodeNote(null);
    setBarcodeReading(false);
    setBarcodeCam(false);
  }, [p.id]);

  const snapshot = useMemo(
    () =>
      JSON.stringify({
        forId: p.id, name, brand, barcode, overridesFdcId, servingG, servingLabel,
        ingredients, photoLabel, photoIngredients, nutrients: settled(nutrients),
      } satisfies Persisted),
    [p.id, name, brand, barcode, overridesFdcId, servingG, servingLabel, ingredients,
      photoLabel, photoIngredients, nutrients],
  );

  const dirty = baseline === null || snapshot !== baseline;

  /**
   * A half-transcribed pack is a lot of typing, and Android's back gesture
   * unmounts the screen outright. The draft is mirrored to sessionStorage and
   * offered back on return.
   *
   * One key PER FOOD. With a single shared key this effect wrote or cleared
   * whatever draft happened to be stored whenever the form it is in matched its
   * own baseline — so opening any other food, or starting a new one, threw away
   * a half-transcribed pack without a word. The key names the food so that
   * cannot happen: this screen only ever touches its own.
   *
   * Nothing is written before this form knows what it started as. Until the
   * baseline arrives `dirty` is true only because there is nothing to compare
   * to yet, and a blank snapshot written on that basis would overwrite the very
   * draft the next render is about to restore.
   */
  useEffect(() => {
    if (loading) return;
    if (baseline === null && !wasRestored) return;
    try {
      if (dirty) sessionStorage.setItem(draftKey(p.id), snapshot);
      else sessionStorage.removeItem(draftKey(p.id));
    } catch {
      // Private mode or blocked storage: the draft simply is not kept.
    }
  }, [p.id, snapshot, dirty, loading, baseline, wasRestored]);

  function clearDraft() {
    try { sessionStorage.removeItem(draftKey(p.id)); } catch { /* nothing to clean up */ }
  }

  // The base food's own panel. Fetched rather than persisted with the draft:
  // it is derived from the fdc id, and a stale copy would make the summary
  // disagree with what is actually stored.
  useEffect(() => {
    if (overridesFdcId === null) { setBaseName(null); setBaseRows(null); return; }
    let live = true;
    getFoodDetail(overridesFdcId)
      .then((d) => { if (!live) return; setBaseName(d.description); setBaseRows(d.nutrients); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [overridesFdcId]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); setHidCustom(false); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      // Overridden entries included: this is the picker that hides them from
      // ordinary search, and an entry already replaced must still be choosable —
      // otherwise a food that removes its own base could never take it back.
      searchFoods(q, 8, true)
        .then((r) => {
          if (mine !== seq.current) return;
          // A base has to be a bundled entry: `overrides_fdc_id` is an fdc id, and
          // a food of your own has none. Saying so beats a list that quietly
          // omits the food the user just searched for.
          setHits(r.filter((h) => h.kind === "reference" && h.fdc_id !== null));
          setHidCustom(r.some((h) => h.kind === "custom"));
        })
        .catch((e) => setError(String(e)));
    }, 160);
    return () => clearTimeout(t);
  }, [query]);

  const panelSize = usePanelSize();

  /**
   * What the saved food will actually know, split three ways. The counts are
   * taken from the PANEL rather than from the typed rows, so they always add up
   * to its length: a value is off the label, or borrowed from the base, or
   * nothing measured it.
   *
   * A base value that is itself absent counts as unmeasured, not as inherited —
   * inheriting a gap inherits the gap, and calling that "borrowed from the
   * generic entry" would dress up an absence as knowledge.
   */
  const summary = useMemo(() => {
    const typed = new Set(nutrients.map((n) => n.nutrient_id));
    if (baseRows) {
      const fromLabel = baseRows.filter((r) => typed.has(r.id)).length;
      const inherited = baseRows.filter((r) => !typed.has(r.id) && r.value.kind !== "absent").length;
      return {
        total: baseRows.length,
        fromLabel,
        inherited,
        unknown: baseRows.length - fromLabel - inherited,
      };
    }
    if (panelSize === null) return null;
    const fromLabel = Math.min(typed.size, panelSize);
    return { total: panelSize, fromLabel, inherited: 0, unknown: panelSize - fromLabel };
  }, [nutrients, baseRows, panelSize]);

  async function save() {
    setError(null);
    if (!name.trim()) return setError("Give the food a name — what the pack calls it.");
    const g = Number(servingG);
    if (!servingG.trim() || !Number.isFinite(g) || g <= 0) {
      return setError("Enter the serving size in grams, greater than zero. Every label figure is per this weight.");
    }
    const ids = nutrients.map((n) => n.nutrient_id);
    if (new Set(ids).size !== ids.length) {
      return setError("The same nutrient is filled in twice.");
    }
    for (const n of nutrients) {
      const problem = nutrientProblem(n);
      if (problem) return setError(problem);
    }

    const food: CustomFood = {
      id: p.id ?? "",
      name: name.trim(),
      brand: nz(brand),
      overrides_fdc_id: overridesFdcId,
      serving_g: g,
      serving_label: nz(servingLabel),
      ingredients: nz(ingredients),
      barcode: nz(barcode),
      photo_label: photoLabel,
      photo_ingredients: photoIngredients,
      nutrients,
    };

    setSaving(true);
    try {
      await saveCustomFood(food, p.id);
      clearDraft();
      p.onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    if (dirty && !window.confirm("Discard this food? What you have typed will be lost.")) return;
    clearDraft();
    p.onCancel();
  }

  /* The photo you transcribe from. The nutrition panel is what the label form
     asks for, so it wins; the ingredient list is worth keeping in view when it
     is the only photo taken. */
  const asideName = photoLabel ?? photoIngredients;
  const asideTitle = photoLabel ? "Nutrition panel" : "Ingredient list";
  const aside = usePhoto(asideName);
  const showAside = wide && aside.url !== null;
  const showStrip = !wide && aside.url !== null;

  if (loading) {
    return (
      <div className="screen">
        <ScreenHead title={p.id ? "Edit food" : "New food"} />
        <section className="card">
          {[0, 1, 2, 3].map((i) => (
            <div className="skel skel--row" key={i} style={{ width: `${90 - i * 12}%` }} />
          ))}
        </section>
      </div>
    );
  }

  const form = (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s6)", minWidth: 0 }}>
      <section className="card">
        <div className="card__head"><h2>What it is</h2></div>
        <div className="group__name">Name</div>
        <input
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Milk chocolate bar"
          autoFocus={p.id === null}
          aria-label="Food name"
        />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--s3)", marginTop: "var(--s4)" }}>
          <label className="vform__cell">
            <span className="group__name">Brand</span>
            <input
              className="field"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="Hershey’s"
              aria-label="Brand"
            />
          </label>
          {/* Not a <label> around the input: the Scan button sits in this cell,
              and a button inside a label is a click that also lands on the box. */}
          <div className="vform__cell">
            <span className="group__name">Barcode</span>
            <input
              className="field tnum"
              inputMode="numeric"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="034000002405"
              aria-label="Barcode"
            />
            {CAN_STREAM && (
              <div className="pslot__acts" style={{ marginTop: "var(--s1)" }}>
                <button
                  className="btn btn--quiet vrow__btn"
                  type="button"
                  onClick={() => { forgetBarcodeScan(); setBarcodeCam(true); }}
                  disabled={barcodeReading}
                  aria-label="Read the barcode with the camera"
                >
                  {barcodeReading ? "Reading…" : "Scan it"}
                </button>
                <span className="pslot__hint">Nothing is stored — only the digits are read.</span>
              </div>
            )}
          </div>
        </div>

        {barcodeNote && (
          <div style={SUGGESTED} role="status">
            <span style={SAY}>{barcodeNote}</span>
            {CAN_STREAM && (
              <button
                className="btn btn--quiet vrow__btn"
                type="button"
                onClick={() => { forgetBarcodeScan(); setBarcodeCam(true); }}
              >
                Try again
              </button>
            )}
            <button className="btn btn--quiet vrow__btn" type="button" onClick={forgetBarcodeScan}>
              Dismiss
            </button>
          </div>
        )}

        {barcodeShot?.payload && (
          <div style={SUGGESTED} role="status">
            <span style={SAY}>
              {!barcodeShot.trusted ? (
                <>
                  The camera read <span className="num">{barcodeShot.payload}</span>, and it did not
                  verify. {barcodeShot.trouble ?? "Its check digit does not add up."} A code that
                  fails its own arithmetic is a misread of something, so it is not offered here —
                  take it again straight on, or type the digits off the pack.
                </>
              ) : barcode.trim() === "" ? (
                <>
                  The camera reads <strong className="num">{barcodeShot.payload}</strong>
                  {barcodeShot.symbology && <> ({barcodeShot.symbology})</>}.{" "}
                  {barcodeAssurance} It is not in the field until you put it there.
                </>
              ) : barcode.trim() === barcodeShot.payload ? (
                <>
                  The camera reads <strong className="num">{barcodeShot.payload}</strong> too — the
                  same code you already have.
                </>
              ) : (
                <>
                  You have <span className="num">{barcode.trim()}</span>. The camera reads{" "}
                  <strong className="num">{barcodeShot.payload}</strong>
                  {barcodeShot.symbology && <> ({barcodeShot.symbology})</>}.{" "}
                  {barcodeAssurance} Yours stays until you choose.
                </>
              )}
            </span>
            {barcodeShot.trusted && barcode.trim() !== barcodeShot.payload && (
              <button className="btn vrow__btn" type="button" onClick={acceptBarcode}>
                {barcode.trim() === "" ? "Use it" : "Use the camera’s"}
              </button>
            )}
            {CAN_STREAM && !barcodeShot.trusted && (
              <button
                className="btn btn--quiet vrow__btn"
                type="button"
                onClick={() => { forgetBarcodeScan(); setBarcodeCam(true); }}
              >
                Take it again
              </button>
            )}
            <button className="btn btn--quiet vrow__btn" type="button" onClick={forgetBarcodeScan}>
              {barcodeShot.trusted && barcode.trim() !== "" && barcode.trim() !== barcodeShot.payload
                ? "Keep mine"
                : "Dismiss"}
            </button>
          </div>
        )}

        <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
          Brand and barcode are optional, and both are searchable — the barcode is the fastest way
          back to a food you have already transcribed.
        </p>
      </section>

      {/*
        Second, not fifth.

        The two cameras that read this pack used to sit below three cards of
        form fields, which put them off the bottom of a phone screen on a
        screen whose whole point is that you photograph the pack instead of
        typing it. They do not go FIRST either: the serving weight above is
        what every figure on this food is per, and burying that would make
        every transcribed number wrong by the same factor.
      */}
      <section className="card">
        <div className="card__head">
          <h2>Photos of the pack</h2>
          <span className="card__note">so you only hold it once</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "var(--s4)" }}>
          <PhotoSlot
            scanKind="nutrition"
            label="Nutrition panel"
            hint="The numbers you are about to type. It stays beside the form while you transcribe, and the app has a go at reading it."
            name={photoLabel}
            /* A reading belongs to one photo. Drop the panel photo and the
               suggestions taken off it go with it, rather than lingering over a
               form that no longer has anything to check them against. */
            onChange={(n) => { setPhotoLabel(n); if (n === null) forgetScan(); }}
            onScan={runScan}
          />
          <PhotoSlot
            scanKind="ingredients"
            label="Ingredient list"
            hint="Kept as it was printed, and the app has a go at reading it out for you."
            name={photoIngredients}
            /* As with the panel: the reading belongs to this photo, so dropping
               the photo drops what was read off it rather than leaving the text
               on offer with nothing left to check it against. */
            onChange={(n) => { setPhotoIngredients(n); if (n === null) forgetIngredientScan(); }}
            onScan={runIngredientScan}
          />
        </div>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Does this replace a generic entry?</h2>
          <span className="card__note">optional</span>
        </div>

        {overridesFdcId !== null ? (
          <>
            <div className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <span className="row__main">
                <span className="row__title">{baseName ?? "Loading the entry…"}</span>
                <span className="row__sub tnum">fdc {overridesFdcId}</span>
              </span>
              <button
                className="btn btn--quiet vrow__btn"
                onClick={() => { setOverridesFdcId(null); setQuery(""); }}
              >
                Remove
              </button>
            </div>
            <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
              This food takes that entry’s place in search, and borrows its values for everything
              the pack does not print. Every borrowed value is marked as borrowed wherever it is
              shown.
            </p>
          </>
        ) : (
          <>
            <input
              className="field"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the generic entry this replaces — “chocolate, milk”"
              aria-label="Search a generic entry to replace"
            />
            {hits.length > 0 && (
              <ul className="hits">
                {hits.map((h) => (
                  <li key={h.fdc_id ?? h.description}>
                    <button
                      className="row hit"
                      onClick={() => { setOverridesFdcId(h.fdc_id); setQuery(""); setHits([]); }}
                    >
                      <span className="row__main">
                        <span className="row__title">{h.description}</span>
                        {h.note && <span className="hit__note">{h.note}</span>}
                      </span>
                      <span className="hit__src">{h.data_type}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {hidCustom && (
              <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
                Foods of your own matched too and are not listed: a food can only replace a
                bundled entry.
              </p>
            )}
            <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
              Leave this empty and anything the pack does not print stays unmeasured — never
              counted as zero, and it will drag the day’s coverage down where it matters.
            </p>
          </>
        )}
      </section>

      <section className="card">
        <div className="card__head"><h2>Serving</h2></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--s3)", marginTop: "var(--s4)" }}>
          <label className="vform__cell vform__cell--g">
            <span className="group__name">Grams</span>
            <input
              className="field tnum"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={servingG}
              onChange={(e) => setServingG(e.target.value)}
              placeholder="43"
              aria-label="Serving size in grams"
            />
          </label>
          <label className="vform__cell">
            <span className="group__name">As the pack words it</span>
            <input
              className="field"
              value={servingLabel}
              onChange={(e) => setServingLabel(e.target.value)}
              placeholder="1 bar (43 g)"
              aria-label="Serving as worded on the pack"
            />
          </label>
        </div>

        {/* Offered, not filled in. The box stays as the user left it until they
            press the button — a misread serving multiplies every figure on the
            panel by the wrong factor, so this is the last number to guess at. */}
        {servingHint && !servingG.trim() && (
          <div style={SUGGESTED}>
            <span style={{ minWidth: 0, flex: 1 }}>
              {servingHint.g !== null ? (
                <>
                  The photo reads <strong className="num">{servingHint.g}</strong> g per serving
                  {servingHint.label && <> — “{servingHint.label}”</>}.
                </>
              ) : (
                <>
                  The photo reads the serving as “{servingHint.label}” but no weight in grams.
                  Weigh one and type it in.
                </>
              )}
            </span>
            {servingHint.g !== null && (
              <button className="btn vrow__btn" onClick={acceptServing}>Use it</button>
            )}
            <button className="btn btn--quiet vrow__btn" onClick={() => setServingHint(null)}>
              Ignore
            </button>
          </div>
        )}

        <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
          Every figure in the label below is per this weight. The app stores food per 100 g and
          converts, so a serving size that is wrong makes every transcribed number wrong by the
          same factor — take it from the pack rather than from the scale.
        </p>
      </section>


      <section className="card">
        <div className="card__head">
          <h2>What the pack prints</h2>
          <span className="card__note">per serving</span>
        </div>
        {scanning && (
          <p className="rangenote" style={{ marginBottom: "var(--s4)" }}>
            Reading the panel in the photo… you can start typing, nothing here will be
            overwritten.
          </p>
        )}
        {scanNote && <ScanLine note={scanNote} onDismiss={forgetScan} />}

        {/* The base's name goes down with it: a line left blank means something
            different when a generic entry is standing behind it, and the row is
            where that difference has to be visible. */}
        <LabelForm
          servingG={servingG}
          nutrients={nutrients}
          onChange={setNutrients}
          baseName={baseName}
          suggestions={suggestions}
          onAcceptSuggestion={acceptSuggestion}
          onAcceptAll={acceptAll}
        />
        {summary && baseRows !== null && summary.unknown > 0 && (
          <div className="card__foot">
            {baseName ?? "The entry this replaces"} has no measurement for {summary.unknown} of
            these either, so those stay unmeasured rather than being borrowed. A gap inherited is
            still a gap.
          </div>
        )}
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Ingredients</h2>
          <span className="card__note">optional</span>
        </div>
        {ingScanning && (
          <p className="rangenote" style={{ marginBottom: "var(--s4)" }}>
            Reading the list in the photo… carry on typing, nothing here will be overwritten.
          </p>
        )}

        <textarea
          className="field"
          value={ingredients}
          onChange={(e) => setIngredients(e.target.value)}
          rows={4}
          placeholder="Sugar, milk, chocolate, cocoa butter, milk fat, soy lecithin, vanillin"
          aria-label="Ingredient list as printed"
          style={{ resize: "vertical", lineHeight: 1.5 }}
        />

        {/* What was read, in full and side by side with what is in the box — the
            two are shown together because only the user can tell which of them
            says what the pack says. Nothing here reaches the box on its own. */}
        {ingText && (
          <div style={SUGGESTED} role="group" aria-label="Read from the ingredient list photo">
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <p style={{ margin: 0 }}>
                {ingSame ? (
                  <>The photo reads the same as what is in the box.</>
                ) : ingredients.trim() === "" ? (
                  <>
                    Read from the photo. Check it against the pack before you take it — a
                    recogniser drops words as readily as it misreads them.
                  </>
                ) : (
                  <>
                    Read from the photo, and you have already typed something. Both are here:
                    take this instead, add it underneath, or keep what you wrote.
                  </>
                )}
              </p>
              {/* Pre-wrapped and verbatim: the commas, the brackets and the
                  capitals are what the pack printed, and the allergen line has
                  to stay a line of its own. */}
              <p style={READ_BACK}>{ingText}</p>
            </div>
            {!ingSame && (
              <button
                className="btn vrow__btn"
                type="button"
                onClick={() => acceptIngredients("replace")}
              >
                {ingredients.trim() === "" ? "Use it" : "Use this instead"}
              </button>
            )}
            {!ingSame && ingredients.trim() !== "" && (
              <button
                className="btn btn--quiet vrow__btn"
                type="button"
                onClick={() => acceptIngredients("append")}
              >
                Add underneath
              </button>
            )}
            <button className="btn btn--quiet vrow__btn" type="button" onClick={forgetIngredientScan}>
              {ingSame ? "Got it" : ingredients.trim() === "" ? "Ignore" : "Keep mine"}
            </button>
          </div>
        )}

        {/* Dismissed on its own: when it stands beside a suggestion, clearing
            the whole scan would take the statement away with the sentence. */}
        {ingNote && <IngLine note={ingNote} onDismiss={() => setIngNote(null)} />}

        <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
          Nothing is parsed out of this. It is here so you can check what is in a food without
          finding the pack again.
        </p>
      </section>
    </div>
  );

  return (
    <div className="screen" style={showStrip ? { paddingBottom: "var(--s8)" } : undefined}>
      <ScreenHead
        title={p.id ? "Edit food" : "New food"}
        sub="what the pack says, in your own record"
        action={
          <>
            <button className="btn btn--quiet" onClick={cancel}>Cancel</button>
            <button className="btn" onClick={save} disabled={saving}>
              {saving ? "Saving…" : p.id ? "Save changes" : "Save food"}
            </button>
          </>
        }
      />

      {wasRestored && (
        <p className="rangenote" style={{ marginTop: "calc(var(--s5) * -1)" }}>
          Picked up where you left off — this draft was still unsaved.
        </p>
      )}

      {error && <p className="alert" role="alert">{error}</p>}

      {summary && (
        <p className="rangenote">
          <strong className="num">{summary.fromLabel}</strong> from the pack
          {summary.inherited > 0 && (
            <>
              {" · "}
              <strong className="num">{summary.inherited}</strong> inherited from{" "}
              {baseName ?? "the entry it replaces"}
            </>
          )}
          {" · "}
          <strong className="num">{summary.unknown}</strong> unmeasured — of{" "}
          <span className="num">{summary.total}</span> nutrients this app displays.
        </p>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: showAside ? "minmax(0, 1fr) 300px" : "minmax(0, 1fr)",
          gap: "var(--s5)",
          alignItems: "start",
        }}
      >
        {form}

        {/* Desktop: the panel photo stays beside the fields, because transcribing
            means reading and typing at the same time. It sticks BELOW the
            topbar, which is sticky, opaque and above this in the stacking order
            — pinned any higher, the panel's heading and first rows scroll
            underneath it. */}
        {showAside && (
          <aside
            className="card"
            style={{
              position: "sticky",
              top: "calc(var(--topbar-h) + var(--s5))",
              padding: "var(--s3)",
            }}
          >
            <div className="group__name">{asideTitle}</div>
            <button
              onClick={() => setViewing(true)}
              style={{ display: "block", width: "100%" }}
              aria-label={`Open the ${asideTitle.toLowerCase()} photo full size`}
            >
              <img
                src={aside.url ?? undefined}
                alt={`${asideTitle} on the pack`}
                style={{ display: "block", width: "100%", borderRadius: "var(--r-md)" }}
              />
            </button>
            <p className="rangenote" style={{ marginTop: "var(--s2)" }}>
              Click it to read it full size.
            </p>
          </aside>
        )}
      </div>

      {/* Phone: there is no room beside the form, so the photo pins itself above
          the nav bar as a strip and opens full screen on a tap. */}
      {showStrip && (
        <div
          className="card"
          style={{
            position: "fixed",
            left: "var(--s4)",
            right: "var(--s4)",
            bottom: "calc(60px + var(--s2) + env(safe-area-inset-bottom, 0px))",
            zIndex: 25,
            display: "flex",
            alignItems: "center",
            gap: "var(--s3)",
            padding: "var(--s2) var(--s3)",
            boxShadow: "var(--lift-hi)",
          }}
        >
          <button
            onClick={() => setViewing(true)}
            style={{
              display: "flex", alignItems: "center", gap: "var(--s3)",
              flex: 1, minWidth: 0, minHeight: 44, textAlign: "left",
            }}
          >
            <img
              src={aside.url ?? undefined}
              alt=""
              style={{ width: 36, height: 36, objectFit: "cover", borderRadius: "var(--r-sm)" }}
            />
            <span style={{ minWidth: 0 }}>
              <span className="row__title">{asideTitle}</span>
              <span className="row__sub">Tap to read it full screen</span>
            </span>
          </button>
        </div>
      )}

      {/* The barcode camera. The same sheet the photo slots use, but its live
          readiness comes from the barcode reader rather than the panel-type
          gauge. Capture stays enabled, and the check digit is still what decides
          whether the digits are worth offering. */}
      {barcodeCam && (
        <CameraCapture
          scanKind="barcode"
          onCapture={(b64) => { void readBarcodeFrame(b64); }}
          onCancel={() => setBarcodeCam(false)}
        />
      )}

      {viewing && aside.url && (
        <Lightbox url={aside.url} title={asideTitle} onClose={() => setViewing(false)} />
      )}
    </div>
  );
}

/* ── reading the panel from the photo ──────────────────────────────────── */

/**
 * How a suggestion looks: dashed and sunken, so it reads as something proposed
 * rather than as a field. Deliberately not `--over`, which this app spends only
 * on a nutrient over its limit — a scan that read nothing is not an error the
 * user made.
 */
/**
 * The sentence inside a suggestion box, beside its buttons.
 *
 * A real flex-basis, not `flex: 1`: with a basis of 0 and no min-content floor
 * the span never forces the line to wrap, so the buttons take their full width
 * first and a 230-character refusal is left a ~75px column at 390px. This is
 * what `.scanbox__say` does for the supplement editor's equivalent boxes.
 */
const SAY: CSSProperties = { flex: "1 1 260px", minWidth: 0 };

const SUGGESTED: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--s3)",
  marginTop: "var(--s4)",
  padding: "var(--s3) var(--s4)",
  border: "1px dashed var(--line)",
  borderRadius: "var(--r-md)",
  background: "var(--sunken)",
  color: "var(--ink-2)",
  fontSize: 13,
};

/**
 * The list as it was read, shown back verbatim so it can be compared with the
 * pack word for word. Pre-wrapped, because the allergen statement is a line of
 * its own and a wrapped list has to break where the box breaks it.
 */
const READ_BACK: CSSProperties = {
  margin: "var(--s2) 0 0",
  padding: "var(--s2) var(--s3)",
  borderRadius: "var(--r-sm)",
  background: "var(--bg)",
  color: "var(--ink)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  lineHeight: 1.5,
};

/**
 * Whether this device can hand a live stream to the page at all — the same test
 * `PhotoSlot` makes before offering its camera. Without it the barcode Scan
 * button could only apologise, and the field is typeable either way.
 */
const CAN_STREAM =
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/** The camera hands over bare base64; a data URL is stripped in case it ever does not. */
const bare = (s: string) => (s.startsWith("data:") ? s.slice(s.indexOf(",") + 1) : s);

/**
 * What one ingredient scan came to when it came to nothing usable.
 *
 * A photo that held no text and a photo full of text with no ingredients row in
 * it are answered differently — move the camera, or turn the pack over — and
 * "nothing found" for both would send half of them the wrong way.
 */
type IngNote =
  | { kind: "none"; lines: number }
  | { kind: "trouble"; text: string }
  | { kind: "failed"; text: string };

function IngLine({ note, onDismiss }: { note: IngNote; onDismiss: () => void }) {
  return (
    <div style={SUGGESTED} role="status">
      <span style={{ minWidth: 0, flex: 1 }}>
        {note.kind === "none" && (
          note.lines > 0 ? (
            <>
              Found <strong className="num">{note.lines}</strong> lines of text in that photo, but
              none of them begins an ingredient list. It may be the wrong side of the pack. Type
              the list in above if it is easier.
            </>
          ) : (
            <>Nothing legible came off that photo. Type the list in above.</>
          )
        )}
        {note.kind === "trouble" && note.text}
        {note.kind === "failed" && (
          <>The photo is saved, but reading it failed — {note.text} Type the list in above.</>
        )}
      </span>
      <button className="btn btn--quiet vrow__btn" type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * What one scan came to, in the terms the user needs rather than the parser's.
 *
 * The distinction that matters is between "the photo is not a panel" and "the
 * photo is a panel I could not lay out": the first is answered by moving the
 * camera, the second by typing, and telling the user "0 values" would send them
 * to the wrong one.
 */
type ScanNote =
  | { kind: "read"; read: number; total: number }
  | { kind: "no-rows"; lines: number }
  | { kind: "trouble"; text: string }
  | { kind: "failed"; text: string };

/** A backend error is a fragment; it is quoted mid-sentence, so it needs an end. */
function sentence(s: string): string {
  const t = s.trim();
  return t === "" || /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Confirmed readings into the food's lines. One entry per nutrient: a reading the
 * user has just accepted replaces whatever stood on that line, and everything the
 * readings are silent about is left exactly as it was — a nutrient absent here
 * stays absent, which is not the same as zero.
 */
function merge(cur: CustomNutrient[], taken: CustomNutrient[]): CustomNutrient[] {
  const by = new Map(cur.map((n) => [n.nutrient_id, n]));
  for (const t of taken) by.set(t.nutrient_id, t);
  return [...by.values()];
}

function noteOf(s: Scan): ScanNote {
  if (s.trouble) return { kind: "trouble", text: s.trouble };
  if (s.readings.length === 0) return { kind: "no-rows", lines: s.lines };
  // Counted off what came back, not off a constant: the total is however many
  // lines this panel's spine has, and the two halves always add up to it.
  return { kind: "read", read: s.readings.length, total: s.readings.length + s.missing.length };
}

function ScanLine({ note, onDismiss }: { note: ScanNote; onDismiss: () => void }) {
  return (
    <div style={SUGGESTED} role="status">
      <span style={{ minWidth: 0, flex: 1 }}>
        {note.kind === "read" && (
          note.read === note.total ? (
            <>
              Read <strong className="num">{note.read}</strong> of{" "}
              <span className="num">{note.total}</span> values. Every one is a suggestion until
              you accept it — check each against the photo, because a misread digit would be
              wrong on every day you log this food.
            </>
          ) : (
            <>
              Read <strong className="num">{note.read}</strong> of{" "}
              <span className="num">{note.total}</span> — check the rest against the photo. The
              lines it missed are still blank, which is not the same as zero.
            </>
          )
        )}
        {note.kind === "no-rows" && (
          note.lines > 0 ? (
            <>
              Found <strong className="num">{note.lines}</strong> lines of text but could not lay
              any of them out as a panel row. The pack was legible; the layout was not understood.
              Type it in below.
            </>
          ) : (
            <>Nothing legible came off this photo. Type the panel in below.</>
          )
        )}
        {note.kind === "trouble" && note.text}
        {note.kind === "failed" && (
          <>The photo is saved, but reading it failed — {note.text} Type the panel in below.</>
        )}
      </span>
      <button className="btn btn--quiet vrow__btn" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

/* ── draft ─────────────────────────────────────────────────────────────── */

/**
 * One key per food, so a draft is only ever reachable — and only ever
 * overwritten or cleared — by the form it was typed in. Editing a second food
 * while a first is half-transcribed is ordinary use, not an edge case.
 */
const draftKey = (forId: string | null) => `trackit.custom-food-draft:${forId ?? "new"}`;

interface Persisted {
  /** Which food this draft belongs to — null for a new one. A draft is only ever
   *  offered back for the food it was typed against. */
  forId: string | null;
  name: string;
  brand: string;
  barcode: string;
  overridesFdcId: number | null;
  servingG: string;
  servingLabel: string;
  ingredients: string;
  /** Photos are already on disk by the time they reach the draft — only the names travel. */
  photoLabel: string | null;
  photoIngredients: string | null;
  nutrients: CustomNutrient[];
}

const blankDraft = (forId: string | null): Persisted => ({
  forId,
  name: "", brand: "", barcode: "",
  overridesFdcId: null,
  servingG: "", servingLabel: "", ingredients: "",
  photoLabel: null, photoIngredients: null,
  nutrients: [],
});

/**
 * Nutrient rows in a fixed order, with a fixed key order.
 *
 * The draft is compared to the form as it was loaded by comparing JSON, so
 * "has anything changed?" has to be a question about the data and not about the
 * order a row happened to be rebuilt in. Without this, a label form that
 * re-emits its rows would make an untouched food look edited and put a discard
 * prompt in front of someone who typed nothing.
 */
const settled = (ns: CustomNutrient[]): CustomNutrient[] =>
  [...ns]
    .sort((a, b) => a.nutrient_id - b.nutrient_id)
    .map((n) => ({ nutrient_id: n.nutrient_id, kind: n.kind, amount: n.amount, upper: n.upper }));

const draftOf = (f: CustomFood): Persisted => ({
  forId: f.id,
  name: f.name,
  brand: f.brand ?? "",
  barcode: f.barcode ?? "",
  overridesFdcId: f.overrides_fdc_id,
  servingG: String(f.serving_g),
  servingLabel: f.serving_label ?? "",
  ingredients: f.ingredients ?? "",
  photoLabel: f.photo_label,
  photoIngredients: f.photo_ingredients,
  nutrients: settled(f.nutrients),
});

function loadDraft(forId: string | null): Persisted | null {
  try {
    const raw = sessionStorage.getItem(draftKey(forId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Persisted;
    // Belt and braces over the key: a draft for another food is not this food's
    // unsaved work, and pouring one pack's numbers into another would be worse
    // than offering nothing.
    return d.forId === forId ? d : null;
  } catch {
    return null;
  }
}

/* ── validation ────────────────────────────────────────────────────────── */

const nz = (s: string) => (s.trim() ? s.trim() : null);

/**
 * Catch a half-typed row here rather than as a CHECK-constraint error from
 * SQLite. The database rejects the same shapes; this names the nutrient.
 */
function nutrientProblem(n: CustomNutrient): string | null {
  const label = LABEL_NUTRIENTS.find((l) => l.id === n.nutrient_id);
  const name = label ? label.name : `Nutrient ${n.nutrient_id}`;
  if (n.kind === "measured") {
    if (n.amount === null || !Number.isFinite(n.amount) || n.amount < 0) {
      return `“${name}” needs the number printed on the pack, or set it back to not printed.`;
    }
    return null;
  }
  if (n.upper === null || !Number.isFinite(n.upper) || n.upper <= 0) {
    return `“${name}” needs the figure it is below, greater than zero.`;
  }
  return null;
}

/* ── panel size ────────────────────────────────────────────────────────── */

/**
 * How many nutrients a panel carries — read, never assumed.
 *
 * Every panel in the app is the same spine out of the nutrients table, and a
 * day's totals are built from that spine, so one day read answers the question
 * without a constant that could drift from the database. Cached for the session
 * because the spine cannot change while the app is open.
 */
let cachedPanelSize: number | null = null;

function usePanelSize(): number | null {
  const [size, setSize] = useState<number | null>(cachedPanelSize);
  useEffect(() => {
    if (size !== null) return;
    let live = true;
    getDay(todayIso())
      .then((d) => {
        cachedPanelSize = d.totals.length;
        if (live) setSize(d.totals.length);
      })
      .catch(() => {
        // Without it the summary simply does not claim a total; the counts it
        // does show still come from the base food's own panel.
      });
    return () => { live = false; };
  }, [size]);
  return size;
}

/* ── photos ────────────────────────────────────────────────────────────── */

/**
 * The 720px breakpoint the stylesheet uses, read in JS because this screen's two
 * layouts differ in STRUCTURE and not only in their CSS: a sticky column beside
 * the form, or a strip pinned over it.
 */
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const m = window.matchMedia(WIDE);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}
const WIDE = "(min-width: 721px)";

/**
 * A stored photo, as a data URL.
 *
 * The type comes from the extension because the backend derived that extension
 * from the file's own magic bytes — it is the one statement about this file that
 * never passed through the browser.
 */
function usePhoto(name: string | null): { url: string | null; error: string | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!name) return;
    let live = true;
    readFoodPhoto(name)
      .then((b64) => { if (live) setUrl(`data:${mimeOf(name)};base64,${b64}`); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [name]);

  return { url, error };
}

function mimeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/**
 * The photo, full screen, while you type from it.
 *
 * Fit-to-screen is the default and actual size is one tap away: a panel
 * photographed at arm's length is legible fitted, and one photographed of a
 * whole pack is not.
 */
function Lightbox({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [actual, setActual] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title} photo`}
      style={{
        position: "fixed", inset: 0, zIndex: 60,
        background: "var(--bg)",
        display: "flex", flexDirection: "column",
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <div
        style={{
          display: "flex", alignItems: "center", gap: "var(--s3)",
          padding: "var(--s3) var(--s4)", borderBottom: "1px solid var(--line)",
        }}
      >
        <span className="group__name" style={{ marginBottom: 0 }}>{title}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: "var(--s2)" }}>
          <button className="btn btn--quiet vrow__btn" onClick={() => setActual((a) => !a)}>
            {actual ? "Fit to screen" : "Actual size"}
          </button>
          <button className="btn vrow__btn" onClick={onClose}>Close</button>
        </div>
      </div>

      <div
        style={{
          flex: 1, minHeight: 0, overflow: "auto",
          display: actual ? "block" : "grid",
          placeItems: "center", padding: "var(--s4)",
          background: "var(--sunken)",
        }}
      >
        <img
          src={url}
          alt={`${title} on the pack`}
          style={
            actual
              ? { display: "block", maxWidth: "none" }
              : { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "var(--r-md)" }
          }
        />
      </div>
    </div>
  );
}
