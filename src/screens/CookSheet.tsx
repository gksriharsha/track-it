import { useCallback, useEffect, useRef, useState } from "react";
import { draftCook, getCook, listVessels, saveCook, searchFoods } from "../api";
import IngredientDial from "../components/IngredientDial";
import TagPicker from "../components/TagPicker";
import WeightField, { type Weighed } from "../components/WeightField";
import { useKeepAwake } from "../lib/awake";
import { pct, plural } from "../lib/nutrient";
import { SOURCE_LABEL } from "../types";
import type { Cook, CookIngredient, FoodHit, Origin, Vessel } from "../types";
import ScreenHead from "../components/ScreenHead";

/**
 * The cook sheet: what actually went in the pot.
 *
 * A recipe is what the dish should be. This is the one screen where an
 * ingredient amount is a *measurement* — scaled for how many are eating,
 * dialled up or down line by line, with what you skipped recorded as a skip and
 * what you swapped recorded as a swap.
 *
 * Every line is a RAW weight, because that is the one state an ingredient can
 * be put on a scale in — once it is cooked it is part of one mixed dish. The
 * cooked side of the arithmetic is a single number: what the pot weighs when it
 * comes off the heat.
 *
 * So the pot goes on the scale. What you weighed wins: a reading is the pot
 * itself, while the expected yield is only what the recipe says this dish comes
 * out at, scaled. Every portion logged afterwards is divided by whichever of
 * those the pot actually has — never by the lines, which are raw and add to a
 * quite different number.
 *
 * Editing here is safe at any time, including after the pot has been eaten
 * from. An entry's nutrition was frozen when it was written and no read path
 * reaches back through this screen.
 */
interface Props {
  /** An existing pot to re-open, or null when starting one from a recipe. */
  cookId: string | null;
  /** The recipe to open a fresh pot from. Ignored when `cookId` is set. */
  recipeId: string | null;
  onBack: () => void;
  onSaved: (cookId: string) => void;
  onManageVessels: () => void;
}

/** The batch multipliers worth one tap. Anything else is typed. */
const SCALES = [0.5, 1, 1.5, 2, 3];

/**
 * A pot half adjusted is real work, and losing it is worse than losing a
 * half-typed recipe: the amounts are a record of something that already
 * happened at the stove and cannot be re-read off the ingredients.
 *
 * The Android back gesture drives WebView history, and the vessel library is a
 * screen away — either unmounts this one. So the sheet is mirrored to
 * sessionStorage, keyed by which pot it is, and restored on return.
 */
const DRAFT_KEY = "trackit.cook-draft";

type Persisted = {
  key: string;
  rows: CookIngredient[];
  scale: number;
  origin: Origin | null;
  cuisine: string | null;
  notes: string;
  yieldG: string;
};

function loadDraft(key: string): Persisted | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Persisted;
    // Keyed, so a draft of one pot can never be restored onto another.
    return d.key === key ? d : null;
  } catch {
    return null;
  }
}

export default function CookSheet(p: Props) {
  const [cook, setCook] = useState<Cook | null>(null);
  const [rows, setRows] = useState<CookIngredient[]>([]);
  const [scale, setScale] = useState(1);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [cuisine, setCuisine] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  /** The pot's weight: a scale reading with vessels, or a figure typed in. */
  const [yieldG, setYieldG] = useState("");
  const [weighed, setWeighed] = useState<Weighed | null>(null);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which row's "swap" search is open, by ingredient id or position key. */
  const [swapping, setSwapping] = useState<number | null>(null);
  const [restored, setRestored] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FoodHit[]>([]);
  const seq = useRef(0);

  /** Which pot this sheet is on, for keying the draft. */
  const draftKey = p.cookId ?? `r:${p.recipeId ?? ""}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const c = p.cookId
        ? await getCook(p.cookId)
        : p.recipeId
          ? await draftCook(p.recipeId, 1)
          : null;
      if (!c) throw new Error("nothing to cook — open this from a recipe");
      setCook(c);
      setOrigin(c.default_origin);
      setCuisine(c.default_cuisine);

      // A draft is what the user last had on screen, so it wins over what the
      // backend says — the stored pot is either older than these edits or, for
      // a fresh cook, has never existed at all.
      const d = loadDraft(draftKey);
      if (d) {
        setRows(d.rows);
        setScale(d.scale);
        setOrigin(d.origin);
        setCuisine(d.cuisine);
        setNotes(d.notes);
        setYieldG(d.yieldG);
        setRestored(true);
      } else {
        setRows(c.ingredients);
        setScale(c.scale);
        setNotes(c.notes ?? "");
        // Only a weighed pot pre-fills the field. The expected yield must not
        // appear in a box labelled "what it weighed" — typing it back would
        // turn what the recipe says into a reading off a scale.
        setYieldG(c.weighed_yield_g === null ? "" : String(Math.round(c.weighed_yield_g)));
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [p.cookId, p.recipeId, draftKey]);

  useEffect(() => { load(); }, [load]);

  // The whole sheet holds the screen open, not only its weight field. The pot
  // is on the heat and the dialling happens in bursts across a long stretch —
  // a line skipped, a stir, a line swapped — with the phone propped up and
  // nobody's hands free. Above the early returns below, so a sheet that is
  // still loading or that failed to load holds nothing. Android only in
  // effect; see lib/awake.ts.
  useKeepAwake(!loading && cook !== null);

  // Mirrored on every change. Not while still loading, or the initial empty
  // state would overwrite the very draft being restored.
  useEffect(() => {
    if (loading || !cook) return;
    const draft: Persisted = {
      key: draftKey, rows, scale, origin, cuisine, notes, yieldG,
    };
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Private mode or blocked storage: the draft simply is not kept.
    }
  }, [loading, cook, draftKey, rows, scale, origin, cuisine, notes, yieldG]);

  function clearDraft() {
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clean up */ }
  }
  useEffect(() => { listVessels().then(setVessels).catch(() => { /* the picker simply stays empty */ }); }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchFoods(q, 24)
        .then((r) => {
          if (mine !== seq.current) return;
          setHits(r.filter((h) => h.kind === "reference").slice(0, 6));
        })
        .catch((e) => setError(String(e)));
    }, 160);
    return () => clearTimeout(t);
  }, [query]);

  /**
   * Re-scale every line to a new batch multiplier.
   *
   * Applied to the *planned* amounts, and the actual amounts follow only where
   * the user has not moved them. A line already dialled by hand is their
   * decision about this pot; silently rescaling it would discard that.
   */
  function rescale(next: number) {
    if (!cook || !(next > 0)) return;
    const factor = next / scale;
    setRows((rs) =>
      rs.map((r) => {
        const planned = r.planned_g * factor;
        // A line still sitting on its planned amount follows the batch. One
        // the user has moved — including one they left out — keeps what they
        // gave it: that is a decision about this pot, not a number to rescale.
        const untouched = Math.abs(r.raw_g - r.planned_g) < 0.05;
        if (!untouched) return { ...r, planned_g: planned };
        return { ...r, planned_g: planned, raw_g: roundHalf(planned) };
      }),
    );
    setScale(next);
  }

  /**
   * Set a line's amount: what went into the pot, weighed raw.
   *
   * One number, because there is only one. What the dish weighs afterwards is
   * asked once, below, about the whole pot.
   */
  function setRaw(i: number, rawG: number) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, raw_g: rawG } : r)));
  }

  function toggleOut(i: number) {
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        // Putting a line back restores what the recipe says, not whatever it
        // was dialled to before it was zeroed: that amount is not something
        // this pot ever had, and re-offering it would invent a measurement.
        if (r.raw_g === 0) return { ...r, raw_g: r.planned_g };
        return { ...r, raw_g: 0 };
      }),
    );
  }

  function swapIn(i: number, h: FoodHit) {
    if (h.fdc_id === null) return;
    setRows((rs) =>
      rs.map((r, j) =>
        j === i
          ? {
              ...r,
              fdc_id: h.fdc_id,
              description: h.description,
              // Keep the first thing this line ever was. Swapping twice must
              // still say what the dish was meant to have, not what the last
              // substitute was.
              substituted_for: r.substituted_for ?? r.description,
            }
          : r,
      ),
    );
    setSwapping(null); setQuery(""); setHits([]);
  }

  function addLine(h: FoodHit) {
    if (h.fdc_id === null) return;
    setRows((rs) => [
      ...rs,
      {
        id: "", position: rs.length, fdc_id: h.fdc_id, description: h.description,
        // The recipe never called for this, so there is nothing to be centred
        // on. The dial falls back to half-gram notches, which is right for a
        // line whose "as written" amount is genuinely zero.
        planned_g: 0, raw_g: 10, substituted_for: null,
      },
    ]);
    setSwapping(null); setQuery(""); setHits([]);
  }

  /** What went in, added up. A raw total: never a yield, and never a divisor. */
  const rawInG = rows.reduce((a, r) => a + r.raw_g, 0);
  /**
   * What the recipe says this dish comes out at, at this batch size. Scaled off
   * the figure the draft was opened with, so ×2 of a 900 g dish expects 1,800 g.
   */
  const expectedG = cook ? (cook.expected_yield_g / cook.scale) * scale : 0;
  const typedYield = Number(yieldG);
  const haveYield = weighed !== null || (yieldG.trim() !== "" && typedYield > 0);
  const effectiveYield = weighed
    ? weighed.grossG - vessels.filter((v) => weighed.vesselIds.includes(v.id)).reduce((a, v) => a + v.grams, 0)
    : haveYield
      ? typedYield
      : expectedG;
  const left = rows.filter((r) => r.raw_g === 0).length;
  const swapped = rows.filter((r) => r.substituted_for !== null).length;

  async function save() {
    if (!cook) return;
    setError(null);
    const live = rows.filter((r) => r.raw_g > 0);
    if (live.length === 0) {
      return setError("Every ingredient is left out — there is no pot to save.");
    }
    setSaving(true);
    try {
      const id = await saveCook(
        {
          recipeId: cook.recipe_id,
          name: cook.name,
          cookedOn: cook.cooked_on,
          scale,
          grossG: weighed?.grossG ?? null,
          vesselIds: weighed?.vesselIds ?? [],
          // A typed figure is only sent when there is no reading: a reading
          // carries its own provenance, and two sources for one number is how
          // they drift apart.
          weighedYieldG: weighed ? null : haveYield ? typedYield : null,
          // Carried even when the pot was weighed: it is what the recipe said
          // this batch would come out at, and re-opening the sheet must show
          // the same figure rather than re-deriving it from a rewritten recipe.
          expectedYieldG: expectedG,
          notes: notes.trim() || null,
          origin,
          cuisine,
          ingredients: rows,
        },
        p.cookId,
      );
      clearDraft();
      p.onSaved(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="screen">
        <div className="card">
          {[0, 1, 2].map((i) => (
            <div className="skel skel--row" key={i} style={{ width: `${80 - i * 12}%` }} />
          ))}
        </div>
      </div>
    );
  }

  if (!cook) {
    return (
      <div className="screen">
        {error && <p className="alert" role="alert">{error}</p>}
        <button className="btn btn--quiet" onClick={p.onBack}>Back</button>
      </div>
    );
  }

  return (
    <div className="screen">
      <ScreenHead
        title={cook.name}
        sub={p.cookId ? "cooked · adjust what went in" : "cooking · adjust as you go"}
        action={
          <>
            <button
              className="btn btn--quiet"
              onClick={() => {
                if (!window.confirm("Leave this pot? The amounts you adjusted will be lost.")) return;
                clearDraft();
                p.onBack();
              }}
            >
              Cancel
            </button>
            <button className="btn" onClick={save} disabled={saving}>
              {saving ? "Saving…" : p.cookId ? "Save changes" : "Save this pot"}
            </button>
          </>
        }
      />

      {restored && (
        <p className="rangenote" style={{ marginTop: "calc(var(--s5) * -1)" }}>
          Picked up where you left off — this pot was still unsaved.
        </p>
      )}

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="card">
        <div className="card__head">
          <h2>How much of it</h2>
          <span className="card__note">the whole recipe, scaled</span>
        </div>
        <div className="chips">
          {SCALES.map((s) => (
            <button key={s} className="chip" aria-pressed={Math.abs(scale - s) < 0.001}
              onClick={() => rescale(s)}>
              {s === 1 ? "As written" : `×${s}`}
            </button>
          ))}
        </div>
        <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
          Scaling moves every line at once. A line you have already dialled by hand keeps the
          amount you gave it — that is a decision about this pot, not something to overwrite.
        </p>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>What goes in</h2>
          <span className="card__note">
            {plural(rows.length, "ingredient")}
            {left > 0 && ` · ${left} left out`}
            {swapped > 0 && ` · ${swapped} swapped`}
          </span>
        </div>

        {rows.map((r, i) => {
          const out = r.raw_g === 0;
          return (
            <div className={`cook-row${out ? " cook-row--off" : ""}`} key={`${r.id}-${i}`}>
              <div className="cook-row__head">
                <span className="row__main">
                  <span className="row__title">
                    {r.description}
                    {r.planned_g > 0 && (
                      <span className="cook-row__planned tnum">
                        {" · "}{Math.round(r.planned_g)} g as written
                      </span>
                    )}
                  </span>
                  <span className="cook-row__sub">
                    {r.substituted_for !== null && <>instead of {r.substituted_for} · </>}
                    {r.fdc_id === null && "no composition data · "}
                    {!out && rawInG > 0
                      ? `${pct(r.raw_g / rawInG)} of what goes in`
                      : out
                        ? "left out"
                        : ""}
                  </span>
                </span>

                <input
                  className="field tnum cook-row__amt"
                  type="number"
                  min="0"
                  inputMode="decimal"
                  value={fmtG(r.raw_g)}
                  disabled={out}
                  onChange={(e) => setRaw(i, Math.max(0, Number(e.target.value) || 0))}
                  aria-label={`Raw grams of ${r.description}`}
                />

                <span className="cook-row__acts">
                  <button className="chip ing-opt" aria-pressed={out} onClick={() => toggleOut(i)}>
                    {out ? "put back" : "leave out"}
                  </button>
                  <button
                    className="chip ing-opt"
                    aria-pressed={swapping === i}
                    onClick={() => { setSwapping(swapping === i ? null : i); setQuery(""); setHits([]); }}
                  >
                    swap
                  </button>
                </span>
              </div>

              {!out && (
                <div className="cook-row__dial">
                  <IngredientDial
                    plannedG={r.planned_g > 0 ? r.planned_g : r.raw_g}
                    valueG={r.raw_g}
                    label={r.description}
                    onChange={(g) => setRaw(i, g)}
                  />
                </div>
              )}

              {swapping === i && (
                <div style={{ marginTop: "var(--s3)" }}>
                  <input
                    className="field"
                    autoFocus
                    placeholder={`Instead of ${r.description}…`}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {hits.length > 0 && (
                    <ul className="hits">
                      {hits.map((h) => (
                        <li key={h.fdc_id ?? h.description}>
                          <button className="row hit" onClick={() => swapIn(i, h)}>
                            <span className="row__main">
                              <span className="row__title">{h.description}</span>
                            </span>
                            <span className="hit__src">{SOURCE_LABEL[h.data_type] ?? h.data_type}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <div style={{ marginTop: "var(--s4)" }}>
          <button className="btn btn--quiet" onClick={() => { setSwapping(-1); setQuery(""); }}>
            Something else went in
          </button>
          {swapping === -1 && (
            <div style={{ marginTop: "var(--s3)" }}>
              <input className="field" autoFocus placeholder="Search an ingredient"
                value={query} onChange={(e) => setQuery(e.target.value)} />
              {hits.length > 0 && (
                <ul className="hits">
                  {hits.map((h) => (
                    <li key={h.fdc_id ?? h.description}>
                      <button className="row hit" onClick={() => addLine(h)}>
                        <span className="row__main">
                          <span className="row__title">{h.description}</span>
                        </span>
                        <span className="hit__src">{SOURCE_LABEL[h.data_type] ?? h.data_type}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>What came out</h2>
          <span className="card__note">what you weighed wins</span>
        </div>

        <WeightField
          grams={yieldG}
          onChange={(g, w) => { setYieldG(g); setWeighed(w); }}
          vessels={vessels}
          onManageVessels={p.onManageVessels}
          vesselNoun="pot"
        />

        <div className="yieldrow" style={{ marginTop: "var(--s4)" }}>
          <div className="yieldrow__stat">
            <span className="group__name">Yield</span>
            <span className="yieldrow__v tnum">
              {Math.round(effectiveYield).toLocaleString()}
              <span className="yieldrow__u"> g</span>
            </span>
          </div>
          <div className="yieldrow__stat">
            <span className="group__name">Went in, raw</span>
            <span className="yieldrow__v tnum">
              {Math.round(rawInG).toLocaleString()}
              <span className="yieldrow__u"> g</span>
            </span>
          </div>
        </div>

        <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
          {haveYield
            ? "Portions are divided by what the pot weighed. It will not match what went in, and should not — dry rajma roughly triples on the water it takes up, while a reduced dal comes out lighter. Nutrients stay where they are either way; only what they are dissolved in moves."
            : `No weight yet, so portions are divided by the ${Math.round(expectedG).toLocaleString()} g this dish is written to come out at. Weighing the pot replaces that with a measurement of this one.`}
        </p>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>What this pot is</h2>
          <span className="card__note">optional</span>
        </div>
        <TagPicker
          origin={origin}
          cuisine={cuisine}
          onChange={(o, c) => { setOrigin(o); setCuisine(c); }}
          recalledNote={
            cook.recipe_id !== null && !p.cookId
              ? "Carried over from the recipe — change it if today was different."
              : null
          }
        />
        <div className="group__name" style={{ marginTop: "var(--s5)" }}>Notes</div>
        <input
          className="field"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Reduced it further than usual"
        />
      </section>
    </div>
  );
}

/** Kitchen-scale resolution: nothing here is finer than half a gram. */
function roundHalf(g: number): number {
  return Math.round(g * 2) / 2;
}

function fmtG(g: number): string {
  const r = roundHalf(g);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
