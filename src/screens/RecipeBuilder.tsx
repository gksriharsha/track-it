import { useEffect, useRef, useState } from "react";
import { saveRecipe, searchFoods } from "../api";
import TagPicker from "../components/TagPicker";
import { pct } from "../lib/nutrient";
import type { Origin } from "../types";
import type { FoodHit, RecipeIngredient, RecipeServing } from "../types";
import { SOURCE_LABEL } from "../types";
import ScreenHead from "../components/ScreenHead";

interface Draft {
  key: string;
  fdcId: number | null;
  description: string;
  raw: string;
  cooked: string;
  source: string;
  /** Whether the dish survives without this line. See `RecipeIngredient`. */
  optional: boolean;
}

/**
 * Build a recipe: ingredients in proportion to one another.
 *
 * A recipe here is an intention, not a measurement. It records what the dish
 * is meant to be — which ingredients, in what ratio, and which of them may be
 * skipped. How much you actually make, and what you actually put in on the
 * day, belongs to a cook.
 *
 * That is why there is no servings field. The same dal feeds two on a weeknight
 * and six when there are guests, so a count demanded here would be a number the
 * recipe cannot honestly carry.
 *
 * Raw and cooked weight are separate fields on purpose. Dry rajma roughly
 * triples on cooking, so a katori of cooked beans logged against the raw weight
 * overstates its nutrients about threefold — the single largest avoidable error
 * in tracking Indian food.
 */
/**
 * A half-built recipe is real work. The Android back gesture drives WebView
 * history, so an accidental swipe unmounts this screen — losing an ingredient
 * list someone just typed. The draft is mirrored to sessionStorage and restored
 * on return, which is kinder than a confirmation dialog on every exit.
 *
 * The key is versioned. A draft written before ingredients could be optional
 * has rows of the wrong shape, and restoring one would put `undefined` where a
 * boolean belongs; a new key lets the old draft expire untouched rather than
 * being half-read.
 */
const DRAFT_KEY = "trackit.recipe-draft.v2";

type Persisted = {
  name: string;
  rows: Draft[];
  servingOpts: RecipeServing[];
  /** Carried in the draft too, or a reload silently forgets what was answered. */
  defaultOrigin?: Origin | null;
  defaultCuisine?: string | null;
};

function loadDraft(): Persisted | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

export default function RecipeBuilder({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const restored = loadDraft();
  const [name, setName] = useState(restored?.name ?? "");
  const [rows, setRows] = useState<Draft[]>(restored?.rows ?? []);
  const [servingOpts, setServingOpts] = useState<RecipeServing[]>(restored?.servingOpts ?? []);
  const [wasRestored] = useState(() => !!restored && (restored.name !== "" || restored.rows.length > 0));
  const [soLabel, setSoLabel] = useState("");
  const [soGrams, setSoGrams] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FoodHit[]>([]);
  /** How many of the user's own foods this query matched and this list cannot show. */
  const [hiddenOwn, setHiddenOwn] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * What this dish usually is. A DEFAULT for the picker only — it pre-fills the
   * tags the first time the recipe is logged and is never written into an entry
   * that already exists. Asking here is the user's own statement about their own
   * construct, which is why reference foods get no equivalent.
   */
  const [defaultOrigin, setDefaultOrigin] = useState<Origin | null>(restored?.defaultOrigin ?? null);
  const [defaultCuisine, setDefaultCuisine] = useState<string | null>(restored?.defaultCuisine ?? null);
  const seq = useRef(0);

  useEffect(() => {
    const draft: Persisted = { name, rows, servingOpts, defaultOrigin, defaultCuisine };
    try {
      if (name || rows.length) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Private mode or blocked storage: the draft simply is not kept.
    }
  }, [name, rows, servingOpts, defaultOrigin, defaultCuisine]);

  function clearDraft() {
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clean up */ }
  }

  // An ingredient has to be a reference food: `recipe_ingredients` references an
  // fdc_id, so a custom food has nothing to store here. Search ranks the user's
  // own foods first, so asking for eight results and filtering afterwards could
  // leave none at all — hence the wider ask and the slice after the filter.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); setHiddenOwn(0); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchFoods(q, 24)
        .then((r) => {
          if (mine !== seq.current) return;
          const refs = r.filter((h) => h.kind === "reference");
          setHits(refs.slice(0, 8));
          setHiddenOwn(r.length - refs.length);
        })
        .catch((e) => setError(String(e)));
    }, 160);
    return () => clearTimeout(t);
  }, [query]);

  const yieldG = rows.reduce((a, r) => a + (Number(r.cooked) || 0), 0);
  const missing = rows.filter((r) => r.fdcId === null).length;
  /**
   * A line's share of the batch, which is the proportion the recipe is really
   * made of. Computed from the cooked weights because that is what portioning
   * divides by, and returned as null rather than 0 while the batch is still
   * empty — a share of "0%" would read as a claim about the ingredient.
   */
  const shareOf = (r: Draft): number | null =>
    yieldG > 0 ? (Number(r.cooked) || 0) / yieldG : null;
  const optionalCount = rows.filter((r) => r.optional).length;

  function addHit(h: FoodHit) {
    // Only reference hits reach this list, and a reference hit always carries its
    // fdc_id. Nothing sensible could be stored for one that did not.
    if (h.fdc_id === null) return;
    const fdcId = h.fdc_id;
    setRows((rs) => [
      ...rs,
      {
        key: `${fdcId}-${rs.length}-${h.description.length}`,
        fdcId,
        description: h.description,
        raw: "100",
        cooked: "100",
        source: SOURCE_LABEL[h.data_type] ?? h.data_type,
        // Required until the user says otherwise. Nothing may guess that a
        // small line is skippable — "optional" is a claim about the dish.
        optional: false,
      },
    ]);
    setQuery(""); setHits([]); setHiddenOwn(0);
  }

  function addUntracked() {
    const label = query.trim();
    if (!label) return;
    setRows((rs) => [
      ...rs,
      {
        key: `x-${rs.length}-${label}`, fdcId: null, description: label,
        raw: "10", cooked: "10", source: "no composition data", optional: false,
      },
    ]);
    setQuery(""); setHits([]); setHiddenOwn(0);
  }

  function patch(key: string, field: "raw" | "cooked", value: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function toggleOptional(key: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, optional: !r.optional } : r)));
  }

  function addServingOption() {
    const g = Number(soGrams);
    if (!soLabel.trim() || !Number.isFinite(g) || g <= 0) return;
    setServingOpts((s) => [...s, { id: "", label: soLabel.trim(), grams: g }]);
    setSoLabel(""); setSoGrams("");
  }

  async function save() {
    setError(null);
    if (!name.trim()) return setError("Give the recipe a name.");
    if (rows.length === 0) return setError("Add at least one ingredient.");
    // Zero belongs on a cook, not here. A recipe line at zero is not an
    // ingredient left out — it is a recipe that does not call for it.
    const bad = rows.find((r) => !(Number(r.raw) > 0) || !(Number(r.cooked) > 0));
    if (bad) return setError(`“${bad.description}” needs a raw and cooked weight above zero.`);

    const ingredients: RecipeIngredient[] = rows.map((r, i) => ({
      id: "", position: i, fdc_id: r.fdcId, description: r.description,
      raw_g: Number(r.raw), cooked_g: Number(r.cooked), optional: r.optional,
    }));

    setSaving(true);
    try {
      await saveRecipe(name.trim(), yieldG, ingredients, servingOpts, null, {
        origin: defaultOrigin,
        cuisine: defaultCuisine,
      });
      clearDraft();
      onDone();
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }

  return (
    <div className="screen">
      <ScreenHead
        title="New recipe"
        sub="the proportions, not one batch of it"
        action={
          <>
            <button
              className="btn btn--quiet"
              onClick={() => {
                if (
                  (name || rows.length) &&
                  !window.confirm("Discard this recipe? The ingredients you added will be lost.")
                ) return;
                clearDraft();
                onCancel();
              }}
            >
              Cancel
            </button>
            <button className="btn" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save recipe"}
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

      <section className="card">
        <div className="group__name">Name</div>
        <input
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rajma chawal"
          autoFocus
        />

        {/* Nothing here is a field. Both figures are derived from the
            ingredients, and there is deliberately no servings box: how many
            people a batch feeds is a fact about an evening, not about a dish. */}
        <div className="yieldrow">
          <div className="yieldrow__stat">
            <span className="group__name">Written for</span>
            <span className="yieldrow__v tnum">
              {yieldG > 0 ? Math.round(yieldG).toLocaleString() : "—"}
              {yieldG > 0 && <span className="yieldrow__u"> g</span>}
            </span>
          </div>
          <div className="yieldrow__stat">
            <span className="group__name">Ingredients</span>
            <span className="yieldrow__v tnum">
              {rows.length > 0 ? rows.length : "—"}
              {optionalCount > 0 && (
                <span className="yieldrow__u"> · {optionalCount} optional</span>
              )}
            </span>
          </div>
        </div>
        <p className="rangenote" style={{ marginTop: "var(--s2)" }}>
          A recipe is the proportions, not the batch. These weights are only the size they happen
          to be written at — you scale the whole thing, and adjust any line, when you actually cook
          it. The total is the sum of the cooked weights below, so it can never disagree with the
          ingredients.
        </p>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Ingredients</h2>
          <span className="card__note">{rows.length} added</span>
        </div>

        {rows.length > 0 && (
          <>
            <div className="ing-row ing-head ing-head--wide">
              <span>Ingredient</span>
              <span style={{ textAlign: "right" }}>Raw g</span>
              <span style={{ textAlign: "right" }}>Cooked g</span>
              <span>Skippable</span>
              <span />
            </div>
            {rows.map((r) => {
              const share = shareOf(r);
              return (
              <div className="ing-row" key={r.key}>
                <span className="row__main ing-name">
                  <span className="row__title">
                    {r.description}
                    {/* The share is the proportion this recipe actually is.
                        Shown beside the name rather than in a column of its
                        own: at 390px a fourth column costs more than it says. */}
                    {share !== null && (
                      <span className="ing-share tnum"> · {pct(share)}</span>
                    )}
                  </span>
                  <span className="row__sub" style={{ color: r.fdcId === null ? "var(--over)" : undefined }}>
                    {r.source}
                    {r.optional && " · optional"}
                  </span>
                </span>
                {/* Both weights stay reachable at every width. Hiding the cooked
                    field on a phone would remove the only control that sets the
                    yield — and the raw-to-cooked change is the point. */}
                <label className="ing-w">
                  <span className="ing-w__k">raw</span>
                  <input className="field tnum" type="number" min="1" value={r.raw}
                    onChange={(e) => patch(r.key, "raw", e.target.value)}
                    aria-label={`Raw grams of ${r.description}`} />
                </label>
                <label className="ing-w">
                  <span className="ing-w__k">cooked</span>
                  <input className="field tnum" type="number" min="1" value={r.cooked}
                    onChange={(e) => patch(r.key, "cooked", e.target.value)}
                    aria-label={`Cooked grams of ${r.description}`} />
                </label>
                {/* Optional says the dish is still the dish without this line.
                    It moves no weight here — it is what the cook sheet reads
                    to offer "leave this out" at the stove. */}
                <button
                  className="chip ing-opt"
                  aria-pressed={r.optional}
                  onClick={() => toggleOptional(r.key)}
                  title={
                    r.optional
                      ? `${r.description} can be left out`
                      : `Mark ${r.description} as one you can skip`
                  }
                >
                  optional
                </button>
                <button className="iconbtn ing-x" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  aria-label={`Remove ${r.description}`}>×</button>
              </div>
              );
            })}
          </>
        )}

        <div style={{ marginTop: "var(--s4)" }}>
          <input
            className="field"
            placeholder="Search an ingredient — “urad dal”, “atta”, “ghee”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {hits.length > 0 && (
            <ul className="hits">
              {hits.map((h) => (
                <li key={h.fdc_id ?? h.description}>
                  <button className="row hit" onClick={() => addHit(h)}>
                    <span className="row__main">
                      <span className="row__title">{h.description}</span>
                      {h.note && <span className="hit__note">{h.note}</span>}
                    </span>
                    <span className="hit__src">{SOURCE_LABEL[h.data_type] ?? h.data_type}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* Said out loud rather than silently dropped: the food is there, it
              matched, and it is not in this list. */}
          {hiddenOwn > 0 && (
            <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
              {hiddenOwn === 1
                ? "One of your own foods matched and is not listed here."
                : `${hiddenOwn} of your own foods matched and are not listed here.`}{" "}
              A recipe is stored as
              reference ingredients over a yield, so a food transcribed from a pack is logged on
              its own rather than built into a dish.
            </p>
          )}

          {query.trim().length >= 2 && (
            <button className="link" style={{ marginTop: "var(--s3)" }} onClick={addUntracked}>
              Add “{query.trim()}” with no composition data
            </button>
          )}
        </div>

        {missing > 0 && (
          <div className="card__foot">
            {missing} ingredient{missing > 1 ? "s have" : " has"} no composition data. They stay in
            the recipe and keep counting against coverage, so days using this dish report those
            nutrients as unmeasured rather than as zero.
          </div>
        )}
      </section>

      <section className="card">
        <div className="card__head">
          <h2>What this dish usually is</h2>
          <span className="card__note">optional</span>
        </div>
        <p className="rangenote">
          Only a starting point. It fills in the tags the first time you log this dish, and any
          day you made it differently records what you say then — changing this later never
          rewrites a day you already logged.
        </p>
        <TagPicker
          origin={defaultOrigin}
          cuisine={defaultCuisine}
          onChange={(o, c) => { setDefaultOrigin(o); setDefaultCuisine(c); }}
        />
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Named portions</h2>
          <span className="card__note">optional</span>
        </div>
        <p className="rangenote">
          So you can log “1 katori” instead of weighing. A katori is conventionally taken as 150 g.
        </p>
        {servingOpts.length > 0 && (
          <div className="rows" style={{ marginTop: "var(--s3)" }}>
            {servingOpts.map((s, i) => (
              <div className="row" key={i} style={{ gridTemplateColumns: "1fr auto auto" }}>
                <span className="row__title">{s.label}</span>
                <span className="tnum">{s.grams} g</span>
                <button className="iconbtn" onClick={() => setServingOpts((x) => x.filter((_, j) => j !== i))}
                  aria-label={`Remove ${s.label}`}>×</button>
              </div>
            ))}
          </div>
        )}
        <div className="commit">
          <input className="field" style={{ maxWidth: 220 }} placeholder="1 katori"
            value={soLabel} onChange={(e) => setSoLabel(e.target.value)} aria-label="Serving label" />
          <input className="field grams tnum" type="number" min="1" placeholder="150"
            value={soGrams} onChange={(e) => setSoGrams(e.target.value)} aria-label="Serving grams" />
          <button className="btn btn--quiet" onClick={addServingOption}>Add</button>
        </div>
      </section>
    </div>
  );
}
