import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  convertLabelFigure,
  getSupplement,
  listNutrients,
  saveSupplement,
  scanBarcode,
  scanIngredientsPhoto,
  scanSupplementPhoto,
} from "../api";
import CameraCapture from "../components/CameraCapture";
import Glyph from "../components/Glyph";
import PhotoSlot from "../components/PhotoSlot";
import { useCameraRoute } from "../lib/camera";
import { inPrintedOrder } from "../lib/printedOrder";
import type {
  BarcodeScan,
  IngredientsScan,
  LabelForm,
  LabelUnit,
  NutrientMeta,
  Supplement,
  SupplementNutrient,
  SupplementScan,
} from "../types";
import { formsFor } from "../types";
import Info from "../components/Info";
import ScreenHead from "../components/ScreenHead";

interface Props {
  /** The supplement being edited, or null to create one. */
  id: string | null;
  onDone: () => void;
  onCancel: () => void;
}

const UNITS: LabelUnit[] = ["mg", "ug", "IU", "g", "kcal"];

const UNIT_LABEL: Record<LabelUnit, string> = {
  g: "g",
  mg: "mg",
  ug: "mcg",
  IU: "IU",
  kcal: "kcal",
};

/**
 * Whether this device can hand a live stream to the page. Same test the photo
 * slot makes: a Scan button that can only apologise is worse than no button,
 * and the digits printed under the bars can always be typed instead.
 */
const CAN_STREAM =
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/** One line being transcribed, before it is put on the app's basis. */
interface Line {
  nutrientId: number;
  amount: string;
  unit: LabelUnit;
  form: LabelForm;
  /** What the backend made of it: the converted row, or a refusal. */
  resolved: SupplementNutrient | null;
  error: string | null;
  /** Read off the photo and not yet confirmed: tinted until "Looks right" or an edit. */
  read?: boolean;
}

/**
 * One row a photograph of the panel yielded, in the panel's own words.
 *
 * Taken off the scan's own type rather than named again here, so this screen
 * cannot drift from what the command actually returns.
 */
type PanelReading = SupplementScan["readings"][number];

/**
 * Transcribe a Supplement Facts panel.
 *
 * Three things make this different from transcribing a nutrition panel, and the
 * screen exists to hold all three:
 *
 * 1. **A panel is not a fixed form.** A Nutrition Facts panel always prints the
 *    same fifteen lines; a supplement declares whatever is in it. So lines are
 *    added rather than filled in, in the order the pack prints them.
 * 2. **International Units convert only when the compound is named.** 400 IU of
 *    vitamin E is 268 mg if it is natural and 180 mg if it is synthetic — the
 *    single letter between "d-" and "dl-" is a 1.49x difference. Rather than
 *    pick one, a line whose form is unsaid is stored exactly as printed and
 *    counted as unknown, with the reason on the row.
 * 3. **What the panel does NOT say means different things in different
 *    markets**, which is why the regime is asked once at the top.
 *
 * The camera shortens the typing and nothing else. Everything it reads — a
 * figure, a form, a serving, a barcode, the other-ingredients line — is held
 * apart from the form and enters it only when the user takes that row. Two
 * things it never offers at all: **the regime and "this panel lists
 * everything"**. Nothing on a bottle says which market printed it, and no
 * photograph can assert that a panel lists everything in the product. Both are
 * the user's own claim, both decide what the panel's silence is worth, and a
 * scan that quietly set either would turn that claim into a machine's guess on
 * every day this supplement is taken.
 */
export default function SupplementEditor(p: Props) {
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [unitNoun, setUnitNoun] = useState("tablet");
  /**
   * Whether the serving boxes say something the user put there. A new bottle
   * opens on "1 tablet", which nobody typed, so a serving read off the panel may
   * stand in those boxes, tinted; once any of them is edited, or for a bottle
   * already saved, the panel's serving is only offered under them.
   */
  const [servingEdited, setServingEdited] = useState(p.id !== null);
  const [servingUnits, setServingUnits] = useState("1");
  const [servingLabel, setServingLabel] = useState("");
  const [defaultUnits, setDefaultUnits] = useState("1");
  const [regime, setRegime] = useState<"us" | "other">("other");
  const [panelComplete, setPanelComplete] = useState(false);
  const [otherIngredients, setOtherIngredients] = useState("");
  const [barcode, setBarcode] = useState("");
  const [photoPanel, setPhotoPanel] = useState<string | null>(null);
  const [photoIngredients, setPhotoIngredients] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  const [nutrients, setNutrients] = useState<NutrientMeta[]>([]);
  const [loading, setLoading] = useState(p.id !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");

  /* ── what the camera thinks, held apart from the form ───────────────────
     None of this is a value. A figure off a photo is not something the user
     has asserted, and a supplement is taken every day — one misread digit is
     wrong again on each of them. So every reading below has exactly one way
     into the form: the user pressing the button on its own row. */
  const [scanning, setScanning] = useState(false);
  const [readings, setReadings] = useState<PanelReading[] | null>(null);
  const [panelNote, setPanelNote] = useState<PanelNote | null>(null);
  const [servingHint, setServingHint] = useState<ServingHint | null>(null);

  const [ingScanning, setIngScanning] = useState(false);
  const [ingHint, setIngHint] = useState<IngredientsScan | null>(null);
  const [ingNote, setIngNote] = useState<string | null>(null);

  /*
    The barcode lens, held in the hash rather than in state. Held in state it
    was invisible to the Android back gesture, which went straight past it and
    closed the editor with a half-typed bottle on it. As a history entry, Back
    shuts the lens and leaves the form where it was. The key is its own rather
    than Add food's "barcode": `Foods` stays mounted behind this aside, and a
    shared key would open its hidden camera alongside this one.
  */
  const barCam = useCameraRoute("supplement-barcode");
  const [barcodeBusy, setBarcodeBusy] = useState(false);
  const [barcodeHint, setBarcodeHint] = useState<BarcodeScan | null>(null);
  const [barcodeFail, setBarcodeFail] = useState<string | null>(null);

  /** Which scan is the current one, so a second photo's result cannot land after it. */
  const panelSeq = useRef(0);
  const ingSeq = useRef(0);

  useEffect(() => {
    listNutrients().then(setNutrients).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (p.id === null) return;
    setLoading(true);
    getSupplement(p.id)
      .then((s) => {
        setName(s.name);
        setBrand(s.brand ?? "");
        setUnitNoun(s.unit_noun);
        setServingUnits(String(s.serving_units));
        setServingLabel(s.serving_label ?? "");
        setDefaultUnits(s.default_units === null ? "" : String(s.default_units));
        setRegime(s.regime);
        setPanelComplete(s.panel_complete);
        setOtherIngredients(s.other_ingredients ?? "");
        setBarcode(s.barcode ?? "");
        setPhotoPanel(s.photo_panel);
        setPhotoIngredients(s.photo_ingredients);
        setLines(
          s.nutrients.map((n) => ({
            nutrientId: n.nutrient_id,
            amount: String(n.label_amount),
            unit: n.label_unit,
            form: n.label_form,
            resolved: n,
            error: null,
          })),
        );
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [p.id]);

  // A reading belongs to the bottle it was taken off. The router pointing this
  // screen at a different supplement does not remount it, so everything the
  // camera produced is dropped here — otherwise the next bottle would open
  // holding the last one's figures.
  useEffect(() => {
    panelSeq.current++;
    ingSeq.current++;
    setReadings(null);
    setPanelNote(null);
    setServingHint(null);
    setScanning(false);
    setIngHint(null);
    setIngNote(null);
    setIngScanning(false);
    setBarcodeHint(null);
    setBarcodeFail(null);
  }, [p.id]);

  const metaOf = useCallback(
    (id: number) => nutrients.find((n) => n.id === id),
    [nutrients],
  );

  const nameOf = useCallback(
    (id: number) => metaOf(id)?.short_name ?? `Nutrient ${id}`,
    [metaOf],
  );

  /**
   * Ask the backend what a line counts as. The conversion lives there, beside
   * the regulation it comes from, so this screen and the day's totals can never
   * disagree about the same pack.
   */
  const resolve = useCallback(async (line: Line): Promise<Line> => {
    const amount = Number(line.amount);
    if (line.amount.trim() === "" || !Number.isFinite(amount) || amount < 0) {
      return { ...line, resolved: null, error: null };
    }
    try {
      const row = await convertLabelFigure(line.nutrientId, amount, line.unit, line.form);
      return { ...line, resolved: row, error: null };
    } catch (e) {
      return { ...line, resolved: null, error: String(e) };
    }
  }, []);

  /**
   * The lines as they stand right now, for `update` to read.
   *
   * `update` cannot read `lines` from its closure: two keystrokes in quick
   * succession would both start from the value before the first, and the second
   * would drop the first. The ref is written synchronously alongside the state
   * so each edit builds on the previous one.
   */
  const linesRef = useRef<Line[]>([]);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  /** Newest in-flight conversion per line, so a slow one cannot win a race. */
  const pending = useRef<Record<number, number>>({});

  /** Put a line on the app's basis, and land the answer only if it is still the newest. */
  const settle = useCallback(
    async (i: number, line: Line) => {
      const token = (pending.current[i] ?? 0) + 1;
      pending.current[i] = token;
      const resolved = await resolve(line);
      // A newer keystroke has superseded this one. Writing now would show a
      // conversion of a figure that is no longer in the box.
      if (pending.current[i] !== token) return;
      setLines((ls) =>
        ls.map((l, j) =>
          // Only the conversion is merged back, never the whole line: the
          // amount and unit in `l` may already be newer than the ones this
          // request was built from.
          j === i ? { ...l, resolved: resolved.resolved, error: resolved.error } : l,
        ),
      );
    },
    [resolve],
  );

  const update = useCallback(
    async (i: number, patch: Partial<Line>) => {
      const base = linesRef.current[i];
      if (!base) return;
      // Changing a read line makes it the user's.
      const merged = { ...base, ...patch, read: false };
      // Write what was typed immediately — the field must not lag the keyboard
      // while a conversion is in flight.
      linesRef.current = linesRef.current.map((l, j) => (j === i ? merged : l));
      setLines(linesRef.current);
      await settle(i, merged);
    },
    [settle],
  );

  const addLine = (nutrientId: number) => {
    setLines((ls) => [
      ...ls,
      {
        nutrientId,
        amount: "",
        // A nutrient whose IU factor depends on the compound starts unspecified
        // rather than on a guess, so the refusal is what the user sees first.
        unit: (metaOf(nutrientId)?.magnitude as LabelUnit) ?? "mg",
        form: "unspecified",
        resolved: null,
        error: null,
      },
    ]);
    setAdding(false);
    setSearch("");
  };

  const unconverted = lines.filter((l) => l.resolved?.kind === "not_converted").length;
  const converted = lines.filter((l) => l.resolved?.kind === "measured").length;

  const available = useMemo(() => {
    const taken = new Set(lines.map((l) => l.nutrientId));
    const q = search.trim().toLowerCase();
    return nutrients
      .filter((n) => !taken.has(n.id))
      .filter((n) => q === "" || n.short_name.toLowerCase().includes(q));
  }, [nutrients, lines, search]);

  /* ── reading the bottle ─────────────────────────────────────────────── */

  function forgetPanelScan() {
    panelSeq.current++;
    setReadings(null);
    setPanelNote(null);
    setServingHint(null);
    setScanning(false);
  }

  function forgetIngScan() {
    ingSeq.current++;
    setIngHint(null);
    setIngNote(null);
    setIngScanning(false);
  }

  /**
   * Read the panel in the photo just stored. Runs after the photo is on disk
   * and beside the form rather than in front of it: every branch below leaves
   * the fields exactly as usable as they were, because typing the bottle in by
   * hand is the path that always works and this only ever saves keystrokes.
   */
  async function runPanelScan(photoName: string) {
    // The other-ingredients line usually sits right under the panel, in the
    // same shot. Without a photo of it, read this one for it too.
    if (photoIngredients === null) void runIngScan(photoName, true);
    const mine = ++panelSeq.current;
    setReadings(null);
    setPanelNote(null);
    setServingHint(null);
    setScanning(true);
    try {
      const s = await scanSupplementPhoto(photoName);
      if (mine !== panelSeq.current) return;
      placeReadings(s.readings);
      // What was read waits in its lines; only a photo that gave nothing says so.
      const note = noteOf(s);
      setPanelNote(note.kind === "read" ? null : note);
      setServingHint(
        s.serving_units !== null || s.unit_noun !== null || s.serving_label !== null
          ? { units: s.serving_units, noun: s.unit_noun, label: s.serving_label }
          : null,
      );
    } catch (e) {
      if (mine !== panelSeq.current) return;
      setPanelNote({ kind: "failed", text: sentence(String(e)) });
    } finally {
      if (mine === panelSeq.current) setScanning(false);
    }
  }

  /**
   * Read the other-ingredients line off its own photo — or, `quiet`, off the
   * panel photo, where a line found is offered and anything else says nothing.
   */
  async function runIngScan(photoName: string, quiet = false) {
    const mine = ++ingSeq.current;
    setIngHint(null);
    setIngNote(null);
    if (!quiet) setIngScanning(true);
    try {
      const s = await scanIngredientsPhoto(photoName);
      if (mine !== ingSeq.current) return;
      if (quiet) {
        if (s.text.trim() !== "") setIngHint(s);
        return;
      }
      if (s.text.trim() !== "" || s.contains) {
        setIngHint(s);
        // A CONTAINS statement without the list above it is half an answer.
        // Offering it alone under "Read off the photo" reads as a finished
        // capture, so the sentence saying the list itself was not in the frame
        // is shown beside it rather than instead of it.
        if (s.text.trim() === "" && s.trouble) setIngNote(s.trouble);
      } else if (s.trouble) {
        setIngNote(s.trouble);
      } else {
        setIngNote(
          s.lines > 0
            ? `Found ${s.lines} lines of text on this photo but no ingredient list among them. Type it in below.`
            : "Nothing legible came off this photo. Type the list in below.",
        );
      }
    } catch (e) {
      if (mine !== ingSeq.current || quiet) return;
      setIngNote(`Reading the photo failed — ${sentence(String(e))} Type the list in below.`);
    } finally {
      if (mine === ingSeq.current) setIngScanning(false);
    }
  }

  /**
   * Read a barcode off a live frame. Nothing is stored: once the digits are
   * read a photograph of a barcode is worth nothing, and keeping it would
   * clutter the photo store for no benefit.
   */
  async function readBarcode(frame: string) {
    barCam.closeCam();
    setBarcodeBusy(true);
    setBarcodeHint(null);
    setBarcodeFail(null);
    try {
      // The camera hands over bare base64; a data URL would only be a prefix
      // the backend has to reject, so strip one if it ever appears.
      const b64 = frame.startsWith("data:") ? frame.slice(frame.indexOf(",") + 1) : frame;
      setBarcodeHint(await scanBarcode(b64));
    } catch (e) {
      setBarcodeFail(sentence(String(e)));
    } finally {
      setBarcodeBusy(false);
    }
  }

  /** A reading whose figure this app has somewhere to put. */
  const takeableUnit = (r: PanelReading) => unitOf(r.label_unit);

  /**
   * One reading confirmed. This is the ONLY way a reading becomes a line.
   *
   * The verbatim unit text is not stored — "400 mcg DFE" is kept as mcg on the
   * line, because that is the shape a stored row has — so the suggestion shows
   * the pack's full wording while it is still on screen to be checked against
   * the photo.
   */
  const takeReading = useCallback(
    async (r: PanelReading) => {
      const unit = unitOf(r.label_unit);
      if (unit === null) return;
      const line: Line = {
        nutrientId: r.nutrient_id,
        amount: printed(r.label_amount),
        unit,
        form: formFor(r.nutrient_id, unit, r.label_form),
        resolved: null,
        error: null,
      };
      const cur = linesRef.current;
      const at = cur.findIndex((l) => l.nutrientId === r.nutrient_id);
      const next = at >= 0 ? cur.map((l, j) => (j === at ? line : l)) : [...cur, line];
      const i = at >= 0 ? at : next.length - 1;
      // Written synchronously, exactly as `update` does, so taking several
      // readings in one press each builds on the one before it.
      linesRef.current = next;
      setLines(next);
      setReadings((rs) => {
        const left = (rs ?? []).filter((x) => x.nutrient_id !== r.nutrient_id);
        return left.length > 0 ? left : null;
      });
      await settle(i, line);
    },
    [settle],
  );

  /**
   * Put what the photo read into the lines, tinted, in the order the panel
   * prints them, so the form reads down like the bottle. A line already typed
   * keeps its figure: the photo's sits under it, to take or to leave. A unit
   * this app has nowhere to put is said under the lines and goes nowhere.
   */
  function placeReadings(rs: PanelReading[]) {
    const next = [...linesRef.current];
    const left: PanelReading[] = [];
    for (const r of rs) {
      const unit = unitOf(r.label_unit);
      if (unit === null) {
        left.push(r);
        continue;
      }
      const amount = printed(r.label_amount);
      const at = next.findIndex((l) => l.nutrientId === r.nutrient_id);
      if (at >= 0 && next[at].amount.trim() !== "") {
        // The same figure is no question; a different one is offered under it.
        if (next[at].amount.trim() !== amount || next[at].unit !== unit) left.push(r);
        continue;
      }
      const line: Line = {
        nutrientId: r.nutrient_id,
        amount,
        unit,
        form: formFor(r.nutrient_id, unit, r.label_form),
        resolved: null,
        error: null,
        read: true,
      };
      if (at >= 0) next[at] = line;
      else next.push(line);
    }
    const ordered = inPrintedOrder(next, (l) => l.nutrientId, rs.map((r) => r.nutrient_id));
    linesRef.current = ordered;
    setLines(ordered);
    setReadings(left.length > 0 ? left : null);
    // Every line, not only the read ones: moving a line moves its index, and a
    // conversion still in flight for the old index must not land on another.
    ordered.forEach((l, i) => void settle(i, l));
  }

  function takeServing() {
    if (!servingHint) return;
    setServingEdited(true);
    if (servingHint.units !== null) setServingUnits(String(servingHint.units));
    if (servingHint.noun) setUnitNoun(servingHint.noun);
    if (servingHint.label) setServingLabel(servingHint.label);
    setServingHint(null);
  }

  function takeBarcode() {
    if (!barcodeHint?.payload || !barcodeHint.trusted) return;
    setBarcode(barcodeHint.payload);
    setBarcodeHint(null);
  }

  /** The list as read, with a CONTAINS statement kept on its own line. */
  const ingText = (s: IngredientsScan) =>
    [s.text.trim(), s.contains ? `Contains: ${s.contains}` : ""].filter(Boolean).join("\n");

  function takeIngredients() {
    if (!ingHint) return;
    setOtherIngredients(ingText(ingHint));
    forgetIngScan();
  }

  function appendIngredients() {
    if (!ingHint) return;
    setOtherIngredients((cur) => `${cur.trimEnd()}\n${ingText(ingHint)}`);
    forgetIngScan();
  }

  /* What was read off the photos and still waits for a yes. */
  const servingTint = servingHint !== null && !servingEdited;
  const servingOffer = servingHint !== null && servingEdited &&
    (servingHint.units !== null || !!servingHint.noun || !!servingHint.label);
  const ingTint = ingHint !== null && otherIngredients.trim() === "" && ingText(ingHint) !== "";
  const ingOffer = ingHint !== null && !ingTint && otherIngredients.trim() !== ingText(ingHint).trim();
  const lineOffers = (readings ?? []).filter((r) => takeableUnit(r) !== null);
  const tintedCount = lines.filter((l) => l.read).length + (servingTint ? 1 : 0) + (ingTint ? 1 : 0);
  const waiting = tintedCount + lineOffers.length + (servingOffer ? 1 : 0) + (ingOffer ? 1 : 0);

  /**
   * "Looks right": everything tinted goes in as it reads. A figure typed before
   * the photo was read stays as typed.
   */
  function confirmReads() {
    linesRef.current = linesRef.current.map((l) => (l.read ? { ...l, read: false } : l));
    setLines(linesRef.current);
    if (servingTint) takeServing();
    setServingHint(null);
    if (ingTint) takeIngredients();
    else forgetIngScan();
    setReadings(null);
  }

  async function save() {
    setError(null);
    if (tintedCount > 0) {
      return setError("Check the tinted lines against the bottle, then tap Looks right.");
    }
    const su = Number(servingUnits);
    if (!name.trim()) return setError("Give it a name — whatever is on the bottle.");
    if (!unitNoun.trim()) return setError("Say what one of these is called: a tablet, a capsule, a gummy.");
    if (!Number.isFinite(su) || su <= 0) {
      return setError("The serving must be a positive number of units — what the panel's figures are per.");
    }
    // A line whose figure never resolved would be dropped on save. Say so
    // rather than losing a transcription the user thinks they entered.
    const unresolved = lines.filter((l) => l.resolved === null);
    if (unresolved.length > 0) {
      const names = unresolved
        .map((l) => metaOf(l.nutrientId)?.short_name ?? String(l.nutrientId))
        .join(", ");
      return setError(
        `These lines have nothing this app can store yet — give each an amount, or remove it: ${names}.`,
      );
    }
    const rows = lines.map((l, i) => ({ ...l.resolved!, position: i }));
    if (rows.length === 0) {
      return setError("Transcribe at least one line from the panel.");
    }
    const du = defaultUnits.trim() === "" ? null : Number(defaultUnits);
    if (du !== null && (!Number.isFinite(du) || du <= 0)) {
      return setError("The usual dose must be a positive number of units, or blank.");
    }

    const sup: Supplement = {
      id: p.id ?? "",
      name: name.trim(),
      brand: brand.trim() || null,
      unit_noun: unitNoun.trim(),
      serving_units: su,
      serving_label: servingLabel.trim() || null,
      default_units: du,
      // Both of these are the user's own answers above and are never touched by
      // a scan. See the note on this component.
      regime,
      panel_complete: panelComplete,
      other_ingredients: otherIngredients.trim() || null,
      barcode: barcode.trim() || null,
      photo_panel: photoPanel,
      photo_ingredients: photoIngredients,
      nutrients: rows,
    };
    setSaving(true);
    try {
      await saveSupplement(sup, p.id);
      // Still "Saving…" after it has saved: the screen closes by going back a
      // step, which lands a moment later, and a Save live again in that moment
      // could write the same thing twice.
      p.onDone();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="screen">
        <div className="card">
          {[0, 1, 2, 3].map((i) => (
            <div className="skel skel--row" key={i} style={{ width: `${90 - i * 10}%` }} />
          ))}
        </div>
      </div>
    );
  }


  return (
    <div className="screen" style={waiting > 0 ? { paddingBottom: "var(--s8)" } : undefined}>
      <ScreenHead
        title={p.id ? "Edit supplement" : "Add a supplement"}
        action={<button className="btn btn--quiet" onClick={p.onCancel}>Cancel</button>}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="card">
        <div className="card__head">
          <h2>What it is</h2>
        </div>
        <div className="formgrid">
          <label>
            <span className="group__name">Name</span>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Multivitamin" />
          </label>
          <label>
            <span className="group__name">Brand</span>
            <input className="field" value={brand} onChange={(e) => setBrand(e.target.value)} />
          </label>
          <label>
            <span className="group__name">One of these is a…</span>
            <input className={`field${servingTint && servingHint?.noun ? " is-read" : ""}`}
              value={servingTint && servingHint?.noun ? servingHint.noun : unitNoun}
              onChange={(e) => { setServingEdited(true); setUnitNoun(e.target.value); }}
              placeholder="tablet" />
          </label>
          <label>
            <span className="group__name">Serving is how many</span>
            <input className={`field tnum${servingTint && servingHint?.units != null ? " is-read" : ""}`}
              type="number" min="0" step="0.5"
              value={servingTint && servingHint?.units != null ? printed(servingHint.units) : servingUnits}
              onChange={(e) => { setServingEdited(true); setServingUnits(e.target.value); }} />
          </label>
          <label>
            <span className="group__name">Serving, as printed</span>
            <input className={`field${servingTint && servingHint?.label ? " is-read" : ""}`}
              value={servingTint && servingHint?.label ? servingHint.label : servingLabel}
              onChange={(e) => { setServingEdited(true); setServingLabel(e.target.value); }}
              placeholder="2 tablets daily" />
          </label>
          <label>
            <span className="group__name">What you usually take</span>
            <input className="field tnum" type="number" min="0" step="0.5" value={defaultUnits}
              onChange={(e) => setDefaultUnits(e.target.value)} />
          </label>

          {/* Not a <label>: the Scan button sits inside the row, and a button
              inside a label steals its own click for the field beside it. */}
          <div className="sup-barcode">
            <label className="group__name" htmlFor="sup-barcode">Barcode</label>
            <div className="sup-barcode__row">
              <input
                id="sup-barcode"
                className="field tnum"
                inputMode="numeric"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder="0 3 3 9 8 4 0 0 1 2 5 3"
              />
              {CAN_STREAM && (
                <button
                  className="btn btn--quiet sup-barcode__btn"
                  onClick={() => { setBarcodeHint(null); setBarcodeFail(null); barCam.openCam(); }}
                  disabled={barcodeBusy}
                >
                  {barcodeBusy ? "Reading…" : "Scan"}
                </button>
              )}
            </div>
          </div>
        </div>

        {barcodeFail && (
          <Say onDismiss={() => setBarcodeFail(null)}>
            Reading the frame failed — {barcodeFail} Type the digits printed under the bars.
          </Say>
        )}

        {barcodeHint && (
          barcodeHint.payload && barcodeHint.trusted ? (
            <Say
              onDismiss={() => setBarcodeHint(null)}
              act={<button className="btn vrow__btn" onClick={takeBarcode}>Use it</button>}
            >
              The bars read <strong className="num">{barcodeHint.payload}</strong>
              {/* Already the spelling a person reads: the backend turned the
                  recogniser's own constant into it before sending it. */}
              {barcodeHint.symbology && <> — {barcodeHint.symbology}</>}
              {/* `trusted` is not the same claim. A Code 128 or a QR is trusted
                  only because it carries no check digit for anything to test,
                  and saying one computed would be this screen inventing an
                  assurance the recogniser explicitly refused to give. */}
              {barcodeHint.check_digit_verified ? (
                <>, and its check digit computes.</>
              ) : (
                <>
                  , which carries no check digit — nothing about these characters could be
                  verified, so read them against the bottle before you take them.
                </>
              )}
              {barcode.trim() !== "" && barcode.trim() !== barcodeHint.payload && (
                <> The box says <span className="num">{barcode.trim()}</span>; taking this replaces it.</>
              )}
            </Say>
          ) : barcodeHint.payload ? (
            /* A code whose check digit does not compute is a misread, not a
               code. It is shown so the user can see what came off the bars,
               and deliberately has no button that would enter it. */
            <Say
              onDismiss={() => setBarcodeHint(null)}
              act={CAN_STREAM ? (
                <button className="btn btn--quiet vrow__btn"
                  onClick={() => { setBarcodeHint(null); barCam.openCam(); }}>
                  Try again
                </button>
              ) : null}
            >
              {barcodeHint.trouble ??
                `“${barcodeHint.payload}” came off the bars, but its check digit does not compute.`}{" "}
              That is a misread rather than a code, so it is not offered here. Take it again, or
              type the digits printed under the bars.
            </Say>
          ) : (
            <Say
              onDismiss={() => setBarcodeHint(null)}
              act={CAN_STREAM ? (
                <button className="btn btn--quiet vrow__btn"
                  onClick={() => { setBarcodeHint(null); barCam.openCam(); }}>
                  Try again
                </button>
              ) : null}
            >
              {barcodeHint.trouble ?? "No barcode in that frame."} Fill the box with the bars, or
              type the digits printed under them.
            </Say>
          )
        )}

        {/* The boxes say what the user put there; the panel's serving sits
            under them, to take or to leave. */}
        {servingOffer && servingHint && (
          <Say onDismiss={() => setServingHint(null)}
            act={<button className="btn vrow__btn" onClick={takeServing}>Use it</button>}>
            The panel reads {servingWords(servingHint)}.
          </Say>
        )}

        <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
          Figures below are per <strong>{servingUnits || "?"} {unitNoun || "unit"}
          {Number(servingUnits) === 1 ? "" : "s"}</strong>.
        </p>
      </section>

      {/* The regime decides what the panel's SILENCE is worth, which is why it
          is asked rather than guessed at — and why no photograph is allowed to
          answer it. */}
      <section className="card">
        <div className="card__head">
          <h2>Which panel is on it</h2>
        </div>
        <div className="chips">
          <button className="chip" aria-pressed={regime === "us"} onClick={() => setRegime("us")}>
            US “Supplement Facts”
          </button>
          <button className="chip" aria-pressed={regime === "other"} onClick={() => setRegime("other")}>
            Indian or other
          </button>
        </div>
        <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
          {regime === "us" ? (
            <>
              A US panel must declare fifteen nutrients whenever they are present above a
              threshold — and must <em>not</em> declare them below it. So leaving one of those
              fifteen out is the pack saying “less than that threshold”, and this app counts it
              as a bound. Everything else on the panel is voluntary: its absence says nothing.
            </>
          ) : (
            <>
              FSSAI has no mandatory list of vitamins and minerals and no declare-as-zero
              threshold, so a nutrient missing from an Indian panel tells us nothing about
              whether the product contains it. Those nutrients stay unknown rather than being
              counted as zero.
            </>
          )}
        </p>
        <label className="checkline">
          <input type="checkbox" checked={panelComplete}
            onChange={(e) => setPanelComplete(e.target.checked)} />
          <span>
            <strong>This panel lists everything in the product.</strong>
            <span className="checkline__sub">
              Your own judgement, not the regulation's — a nutrient can be present from an
              undeclared route, like a botanical extract or an algae base. Ticking this counts
              every nutrient the panel omits as a real zero instead of an unknown, which is what
              stops one bottle making a well-measured day read as uncertain.
            </span>
          </span>
        </label>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Photos of the bottle</h2>
          <Info title="What a photo reads">
            <p>
              Nothing a photo reads is stored on its own: every figure it finds is offered for you
              to check against the bottle first.
            </p>
            <p>
              Neither photo answers which panel is on it, or whether the panel lists everything —
              no picture can say that.
            </p>
            <p>
              Each figure is shown in the panel's own words, down to the suffix. A misread digit is
              wrong again on every day you take this, so check it against the photo. A form the
              bottle names only matters for a figure printed in IU.
            </p>
          </Info>
          <span className="card__note">deleted when you save</span>
        </div>
        <div className="idrow">
          <PhotoSlot
            scanKind="supplement"
            label="Supplement Facts panel"
            hint="Read for you, then deleted when you save."
            name={photoPanel}
            /* A reading belongs to one photo. Drop the panel photo and the
               figures taken off it go with it, rather than lingering over a
               form that no longer has anything to check them against. */
            onChange={(n) => {
              setPhotoPanel(n);
              if (n === null) {
                forgetPanelScan();
                // So does a line read off it, when no photo of the line stands in.
                if (photoIngredients === null) forgetIngScan();
              }
            }}
            onScan={runPanelScan}
          />
          <PhotoSlot
            scanKind="ingredients"
            label="Other ingredients"
            hint="Optional if it is in the panel photo."
            name={photoIngredients}
            onChange={(n) => { setPhotoIngredients(n); if (n === null) forgetIngScan(); }}
            onScan={runIngScan}
          />
        </div>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>What the panel declares</h2>
          <span className="card__note">
            {converted} converted{unconverted > 0 ? `, ${unconverted} not` : ""}
          </span>
        </div>

        {scanning && (
          <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
            Reading the panel in the photo… you can start typing, nothing here will be
            overwritten.
          </p>
        )}

        {panelNote && <PanelSays note={panelNote} onDismiss={() => setPanelNote(null)} />}

        {lines.length === 0 && (
          <p className="t-sm" style={{ color: "var(--ink-3)", margin: "var(--s3) 0" }}>
            Nothing yet. Add the lines the pack prints, in the order it prints them.
          </p>
        )}

        <div className="rows">
          {lines.map((l, i) => {
            const meta = metaOf(l.nutrientId);
            const forms = formsFor(l.nutrientId, l.unit);
            const refused = l.resolved?.kind === "not_converted";
            /* A figure typed before the photo was read, and a different one read off it. */
            const offer = lineOffers.find((r) => r.nutrient_id === l.nutrientId);
            return (
              <div className={`supline${l.read ? " is-read" : ""}`} key={`${l.nutrientId}-${i}`}>
                <div className="supline__top">
                  <span className="supline__name">
                    {l.read && <span className="supline__cam"><Glyph name="camera" size={15} /></span>}
                    {meta?.short_name ?? l.nutrientId}
                  </span>
                  <input
                    className={`field tnum supline__amt${l.read ? " is-read" : ""}`}
                    inputMode="decimal"
                    value={l.amount}
                    placeholder="0"
                    aria-label={(l.read ? "Read from the photo, not yet confirmed: " : "") +
                      `${meta?.short_name ?? "line"} amount`}
                    onChange={(e) => update(i, { amount: e.target.value })}
                  />
                  <select
                    className="field supline__unit"
                    value={l.unit}
                    onChange={(e) => update(i, { unit: e.target.value as LabelUnit })}
                  >
                    {UNITS.map((u) => (
                      <option key={u} value={u}>{UNIT_LABEL[u]}</option>
                    ))}
                  </select>
                  <button
                    className="iconbtn"
                    aria-label={`Remove ${meta?.short_name ?? "line"}`}
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>

                {/*
                  Only where the answer changes the arithmetic. In IU it asks
                  which compound is in the product; in mg or mcg it asks what
                  the typed number measures, because a compliant panel already
                  prints RAE and DFE whatever the product contains.
                */}
                {forms && (
                  <div className="chips supline__forms">
                    {forms.map((f) => (
                      <button
                        key={f.id}
                        className="chip chip--sm"
                        aria-pressed={l.form === f.id}
                        onClick={() => update(i, { form: f.id })}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                )}

                {offer && (
                  <span className="lrow__photo">
                    <span>The photo reads <strong className="num">{printed(offer.label_amount)} {offer.label_unit}</strong></span>
                    <button className="chip chip--sm lrow__use" type="button" onClick={() => void takeReading(offer)}>
                      Use it
                    </button>
                  </span>
                )}

                {refused ? (
                  <p className="supline__refused">{l.resolved?.convert_note}</p>
                ) : l.error ? (
                  <p className="supline__refused">{l.error}</p>
                ) : l.resolved?.kind === "measured" && meta ? (
                  <p className="supline__ok">
                    counts as {round(l.resolved.amount ?? 0)} {meta.magnitude === "ug" ? "mcg" : meta.magnitude}
                    {l.unit !== (meta.magnitude as LabelUnit) && " on this app's basis"}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        {(readings ?? []).filter((r) => takeableUnit(r) === null).map((r) => (
          <p className="supline__refused" key={`unit-${r.nutrient_id}`}>
            The photo also read {nameOf(r.nutrient_id)} {printed(r.label_amount)} {r.label_unit}, in a
            unit this app cannot store.
          </p>
        ))}

        {adding ? (
          <div style={{ marginTop: "var(--s4)" }}>
            <input
              className="field"
              autoFocus
              data-results-below
              placeholder="Which nutrient? — vitamin D, magnesium, B12…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="chips" style={{ marginTop: "var(--s3)" }}>
              {available.slice(0, 24).map((n) => (
                <button key={n.id} className="chip chip--sm" onClick={() => addLine(n.id)}>
                  {n.short_name}
                </button>
              ))}
              {available.length === 0 && (
                <span className="t-sm" style={{ color: "var(--ink-3)" }}>
                  Nothing left that matches.
                </span>
              )}
            </div>
            <button className="link" style={{ marginTop: "var(--s3)" }} onClick={() => setAdding(false)}>
              cancel
            </button>
          </div>
        ) : (
          <button className="btn btn--quiet" style={{ marginTop: "var(--s4)" }}
            onClick={() => setAdding(true)}>
            Add a line
          </button>
        )}
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Other ingredients</h2>
          <span className="card__note">as printed</span>
        </div>
        <span className="lrow__box">
          <textarea
            className={`field${ingTint ? " is-read" : ""}`}
            rows={3}
            value={ingTint && ingHint ? ingText(ingHint) : otherIngredients}
            onChange={(e) => {
              setOtherIngredients(e.target.value);
              // Typed over: the line is the user's now.
              if (ingTint) forgetIngScan();
            }}
            aria-label={(ingTint ? "Read from the photo, not yet confirmed: " : "") + "Other ingredients as printed"}
            placeholder="Microcrystalline cellulose, magnesium stearate…"
            style={{ width: "100%" }}
          />
          {ingTint && <span className="ing__tag"><Glyph name="camera" size={14} />From the photo</span>}
        </span>

        {ingScanning && (
          <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
            Reading the photo…
          </p>
        )}

        {ingNote && <Say onDismiss={() => setIngNote(null)}>{ingNote}</Say>}

        {ingOffer && ingHint && (
          <div className="ing__photo" role="group" aria-label="Read from the ingredients photo">
            <span>The photo reads a different list</span>
            <p className="ing__read">{ingText(ingHint)}</p>
            <span className="ing__acts">
              <button className="chip chip--sm lrow__use" type="button" onClick={takeIngredients}>
                Use the photo's
              </button>
              <button className="chip chip--sm" type="button" onClick={appendIngredients}>
                Add it underneath
              </button>
            </span>
          </div>
        )}

        <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
          For reference only — add a line above for anything to count.
        </p>
      </section>

      {/* One confirm for everything read off the photos, at the foot of the screen. */}
      {waiting > 0 && (
        <div className="readbar readbar--auto" role="region" aria-label="Read from the photo">
          <span className="readbar__glyph"><Glyph name="camera" size={20} /></span>
          <span className="readbar__t">
            <strong>Read from the photo</strong>
            <span>{tintedCount > 0 ? "Check the tinted lines against it" : "Keep what you typed, or use the photo's"}</span>
          </span>
          <button className="btn readbar__ok" type="button" onClick={confirmReads}>
            {tintedCount > 0 ? "Looks right" : "Keep mine"}
          </button>
        </div>
      )}

      <div className="commit">
        <button className="btn btn--quiet" onClick={p.onCancel}>Cancel</button>
        <button className="btn" style={{ marginLeft: "auto" }} onClick={save} disabled={saving}>
          {saving ? "Saving…" : p.id ? "Save changes" : "Save supplement"}
        </button>
      </div>

      {barCam.open && (
        <CameraCapture
          scanKind="barcode"
          onCapture={readBarcode}
          onCancel={barCam.closeCam}
        />
      )}
    </div>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * A figure the pack printed, back as text.
 *
 * NOT rounded. `round` above is for a converted figure, where two decimals is
 * all the arithmetic is worth; a printed one has to survive intact — 0.055 mg
 * of selenium rounded to 0.06 is a ten-percent error introduced by this screen,
 * on a row whose whole purpose is to be checked against the photo word for
 * word. The toFixed only sheds a float's tail: 25.000000000000004 is the
 * recogniser's arithmetic, not something the bottle says.
 */
const printed = (n: number) => String(Number(n.toFixed(6)));

/* ── what a scan came to ───────────────────────────────────────────────── */

/** The serving a panel printed, in the three pieces this screen has boxes for. */
interface ServingHint {
  units: number | null;
  noun: string | null;
  label: string | null;
}

/**
 * What one scan of the panel came to, in the terms the user needs rather than
 * the parser's.
 *
 * The distinction that matters is between "this photo is not a panel" and "this
 * is a panel whose rows I could not lay out": the first is answered by moving
 * the camera, the second by typing, and "0 values" would send the user to the
 * wrong one.
 */
type PanelNote =
  | { kind: "read"; read: number; unmatched: number }
  | { kind: "no-rows"; lines: number; unmatched: number }
  | { kind: "trouble"; text: string }
  | { kind: "failed"; text: string };

function noteOf(s: SupplementScan): PanelNote {
  if (s.trouble) return { kind: "trouble", text: s.trouble };
  if (s.readings.length === 0) {
    return { kind: "no-rows", lines: s.lines, unmatched: s.unmatched_rows };
  }
  return { kind: "read", read: s.readings.length, unmatched: s.unmatched_rows };
}

function PanelSays({ note, onDismiss }: { note: PanelNote; onDismiss: () => void }) {
  return (
    <Say onDismiss={onDismiss}>
      {note.kind === "read" && (
        <>
          Read <strong className="num">{note.read}</strong>{" "}
          {note.read === 1 ? "line" : "lines"} off the photo.
          {note.unmatched > 0 && (
            <>
              {" "}
              <span className="num">{note.unmatched}</span> more{" "}
              {note.unmatched === 1 ? "row was" : "rows were"} laid out but named nothing this app
              tracks — a botanical or a blend, most likely. Nothing was dropped silently: they are
              simply not lines you can add here.
            </>
          )}
        </>
      )}
      {note.kind === "no-rows" && (
        note.lines > 0 ? (
          <>
            Found <strong className="num">{note.lines}</strong> lines of text but could not read a
            nutrient off any of them. The bottle was legible; the panel's layout was not
            understood. Type it in below.
          </>
        ) : (
          <>Nothing legible came off this photo. Type the panel in below.</>
        )
      )}
      {note.kind === "trouble" && note.text}
      {note.kind === "failed" && (
        <>Reading the photo failed — {note.text} Type the panel in below.</>
      )}
    </Say>
  );
}

/**
 * A sentence about a scan, with its own way out.
 *
 * Dashed and sunken, so it reads as something the app is proposing rather than
 * as a field. Deliberately not `--over`, which this app spends only on a
 * nutrient over its limit — a scan that read nothing is not an error the user
 * made, and a camera that could not focus is not one either.
 */
function Say(
  { children, onDismiss, act }: { children: ReactNode; onDismiss: () => void; act?: ReactNode },
) {
  return (
    <div className="scanbox" role="status">
      <div className="scanbox__row">
        <span className="scanbox__say">{children}</span>
        <span className="scanbox__btns">
          {act}
          <button className="btn btn--quiet vrow__btn" onClick={onDismiss}>Dismiss</button>
        </span>
      </div>
    </div>
  );
}

/** The serving as the panel worded it, for the suggestion's own sentence. */
function servingWords(h: ServingHint): string {
  if (h.label) return `“${h.label}”`;
  if (h.units !== null) return `${printed(h.units)} ${h.noun ?? "unit"}${h.units === 1 ? "" : "s"}`;
  return h.noun ? `a serving counted in ${h.noun}s` : "a serving";
}

/* ── a printed unit and a printed form, onto what a line can hold ──────── */

/**
 * The printed unit text put on one of the five magnitudes a line can carry.
 *
 * Only the LEADING token decides: "400 mcg DFE" is mcg and "15 mg NE" is mg.
 * The suffix is not thrown away — the suggestion shows the pack's full wording
 * while it is on screen, which is what the figure has to be checked against.
 * Null where the pack printed something this app has no basis for; that
 * reading is then shown as read and offered as nothing.
 */
function unitOf(asRead: string): LabelUnit | null {
  const head = asRead.trim().split(/[\s(]/)[0].toLowerCase().replace(/[.,;:]+$/, "");
  switch (head) {
    case "g":
      return "g";
    case "mg":
      return "mg";
    // Both micro-sign codepoints, because packs and recognisers use both.
    case "mcg":
    case "ug":
    case "µg":
    case "μg":
      return "ug";
    case "iu":
      return "IU";
    case "kcal":
      return "kcal";
    default:
      return null;
  }
}

/**
 * Which form a suggested line takes — which is NOT always the form the bottle
 * names.
 *
 * A named form is only allowed to move the arithmetic where the arithmetic
 * depends on it: an IU figure, whose mass is a property of the compound. On a
 * mass figure it must not. 21 CFR 101.36 makes a compliant panel print vitamin
 * A as mcg RAE and folate as mcg DFE whatever the product contains, so applying
 * "(as folic acid)" to a printed 400 mcg would multiply by 1.7 a figure that
 * has already had it applied — a 70% overcount, every day, off a parenthetical.
 * "As printed" is the right answer for a panel line, and the form the bottle
 * named is still shown beside the suggestion as what the bottle says.
 */
// `asRead` is the scan's own word and may be `""` (the bottle named no form),
// which matches nothing in `offered` and so falls through to `unspecified`.
function formFor(nutrientId: number, unit: LabelUnit, asRead: LabelForm | ""): LabelForm {
  if (unit !== "IU") return "unspecified";
  const offered = formsFor(nutrientId, unit);
  const found = offered?.find((f) => f.id === asRead);
  return found ? found.id : "unspecified";
}

/** A backend error is a fragment; it is quoted mid-sentence, so it needs an end. */
function sentence(s: string): string {
  const t = s.trim();
  return t === "" || /[.!?]$/.test(t) ? t : `${t}.`;
}
