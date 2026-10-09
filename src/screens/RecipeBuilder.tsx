import { useEffect, useRef, useState } from "react";
import { saveRecipe, searchFoods } from "../api";
import TagPicker from "../components/TagPicker";
import { pct } from "../lib/nutrient";
import { displayName, familyOf, formName, formsLine, ingredientOf, rawFirst } from "../lib/foodForms";
import type { Origin } from "../types";
import type { FoodFamily, FoodForm, FoodHit, RecipeIngredient, RecipeServing } from "../types";
import { SOURCE_LABEL } from "../types";
import ScreenHead from "../components/ScreenHead";
import FormChips from "../components/FormChips";
import Info from "../components/Info";
import { initials } from "../lib/entryText";

interface Draft {
  key: string;
  /** A reference food. Null when this line is one of the user's own instead. */
  fdcId: number | null;
  /** One of the user's own foods. Never set alongside `fdcId`. */
  ownId: string | null;
  /** The full USDA description, or the food's own name: what is saved. */
  description: string;
  /**
   * What the tile says — "Mungo beans, raw" for one form of a food that comes
   * in several. Absent on a draft saved before it existed, which shows the
   * description instead.
   */
  name?: string;
  /** Weighed before it goes in. The only weight a line has — see below. */
  raw: string;
  source: string;
  /** Whether the dish survives without this line. See `RecipeIngredient`. */
  optional: boolean;
  /**
   * Added by feel: salt, oil, ghee. The weight is then what you would write,
   * and each pot gets it times what your pantry shows. Absent on a draft
   * saved before this existed, which reads as false.
   */
  toTaste?: boolean;
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
 * Every ingredient is weighed once, raw, because that is the only state in
 * which a single ingredient can be put on a scale. Once it is cooked it is part
 * of one mixed dish, and nobody can lift the rajma back out of a finished curry
 * to weigh it apart from the onions.
 *
 * The raw-to-cooked change is still real and still large — dry rajma roughly
 * triples, and a katori of cooked beans read as if it were dry overstates its
 * nutrients about threefold, the single largest avoidable error in tracking
 * Indian food. It is handled by asking for ONE cooked weight for the whole
 * dish, which is one weighing of one pot, and dividing by that. Nutrient mass
 * is conserved through cooking; concentration is not. See D22.
 */
/**
 * A half-built recipe is real work. The builder is a history entry of its own
 * (`builder=new`, held by `Recipes`), so the Android back gesture closes it
 * and lands on the recipe list — and an accidental swipe unmounts it just the
 * same, which would lose an ingredient list someone just typed. The draft is
 * mirrored to sessionStorage and restored on return, which is kinder than a
 * confirmation dialog on every exit. Only Discard draft, which asks first, and a
 * successful save throw it away.
 *
 * The key is versioned. A draft written before ingredients could be optional
 * has rows of the wrong shape, and restoring one would put `undefined` where a
 * boolean belongs; a new key lets the old draft expire untouched rather than
 * being half-read.
 */
const DRAFT_KEY = "trackit.recipe-draft.v3";

type Persisted = {
  name: string;
  rows: Draft[];
  /** What the dish comes out at, cooked. Carried so a reload keeps it. */
  yieldG?: string;
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
  /**
   * What the whole dish weighs once it is cooked — the one cooked measurement
   * a recipe asks for, and the figure every portion is divided by.
   */
  const [yieldG, setYieldG] = useState(restored?.yieldG ?? "");
  const [servingOpts, setServingOpts] = useState<RecipeServing[]>(restored?.servingOpts ?? []);
  const [wasRestored] = useState(() => !!restored && (restored.name !== "" || restored.rows.length > 0));
  const [soLabel, setSoLabel] = useState("");
  const [soGrams, setSoGrams] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FoodHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The one ingredient showing its flags and Remove. */
  const [openKey, setOpenKey] = useState<string | null>(null);
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
    const draft: Persisted = { name, rows, yieldG, servingOpts, defaultOrigin, defaultCuisine };
    try {
      if (name || rows.length) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Private mode or blocked storage: the draft simply is not kept.
    }
  }, [name, rows, yieldG, servingOpts, defaultOrigin, defaultCuisine]);

  function clearDraft() {
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clean up */ }
  }

  // An ingredient may be a reference food OR one of the user's own. Search
  // already ranks their own first, and they are the better answer for anything
  // that came out of a packet — the generic entry is a stranger's version of it.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      // Eight foods, each one row however many forms it comes in, those
      // with a form to weigh raw ahead of those only ever cooked.
      searchFoods(q, 8)
        .then((r) => {
          if (mine !== seq.current) return;
          setHits(rawFirst(r));
        })
        .catch((e) => setError(String(e)));
    }, 160);
    return () => clearTimeout(t);
  }, [query]);

  /** What goes in, added up. Not the yield — these are raw weights. */
  const rawInG = rows.reduce((a, r) => a + (Number(r.raw) || 0), 0);
  const yieldNum = Number(yieldG);
  const haveYield = yieldG.trim() !== "" && Number.isFinite(yieldNum) && yieldNum > 0;
  /**
   * A line's share of the ingredients, which is the proportion the recipe is
   * really made of. Computed from the raw weights, because those are the
   * weights the recipe is written in — and returned as null rather than 0 while
   * the list is still empty, since a share of "0%" would read as a claim about
   * the ingredient.
   */
  const shareOf = (r: Draft): number | null =>
    rawInG > 0 ? (Number(r.raw) || 0) / rawInG : null;

  function addHit(h: FoodHit) {
    // One or the other. A hit always carries exactly one of the two, and a hit
    // carrying neither is not a food anything could be stored for. A food in
    // several forms goes in as its uncooked one, unless the words typed named
    // another: every line here is weighed raw. Its tile, opened, offers the
    // others.
    const { fdcId, ownId, description, name } = ingredientOf(h, query);
    if (fdcId === null && ownId === null) return;
    setRows((rs) => [
      ...rs,
      {
        key: `${fdcId ?? ownId}-${rs.length}-${description.length}`,
        fdcId,
        ownId,
        description,
        name,
        raw: "100",
        // Said plainly rather than as a data-type code: "yours" is the fact
        // that matters about this line, and it is the reason its panel has
        // holes in it where a reference food's would not.
        source: ownId !== null
          ? h.brand ? `yours · ${h.brand}` : "yours"
          : SOURCE_LABEL[h.data_type] ?? h.data_type,
        // Required until the user says otherwise. Nothing may guess that a
        // small line is skippable — "optional" is a claim about the dish.
        optional: false,
      },
    ]);
    setQuery(""); setHits([]);
  }

  function addUntracked() {
    const label = query.trim();
    if (!label) return;
    setRows((rs) => [
      ...rs,
      {
        key: `x-${rs.length}-${label}`, fdcId: null, ownId: null, description: label,
        raw: "10", source: "no nutrition data", optional: false,
      },
    ]);
    setQuery(""); setHits([]);
  }

  function patch(key: string, value: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, raw: value } : r)));
  }

  function toggleOptional(key: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, optional: !r.optional } : r)));
  }

  function toggleTaste(key: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, toTaste: !r.toTaste } : r)));
  }

  /**
   * Another form of the same food, for a line that was not raw after all.
   * The weight stays: it is what went on the scale, and the form only says
   * what that was.
   */
  function switchForm(key: string, family: FoodFamily, f: FoodForm) {
    setRows((rs) => rs.map((r) => (r.key === key
      ? { ...r, fdcId: f.fdc_id, description: f.description, name: formName(family, f) }
      : r)));
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
    const bad = rows.find((r) => !(Number(r.raw) > 0));
    if (bad) return setError(`“${bad.name ?? bad.description}” needs a weight above zero.`);
    // The one cooked figure the recipe asks for, and the divisor for every
    // portion ever logged from it. Without it a helping cannot be valued at all.
    if (!haveYield) {
      return setError("Add the cooked weight. Every helping is divided by it.");
    }

    const ingredients: RecipeIngredient[] = rows.map((r, i) => ({
      id: "", position: i, fdc_id: r.fdcId, custom_food_id: r.ownId,
      description: r.description, raw_g: Number(r.raw), optional: r.optional,
      to_taste: r.toTaste === true,
    }));

    setSaving(true);
    try {
      await saveRecipe(name.trim(), yieldNum, ingredients, servingOpts, null, {
        origin: defaultOrigin,
        cuisine: defaultCuisine,
      });
      clearDraft();
      // Still "Saving…" after it has saved. Recipes closes the builder by
      // going back a step, which lands a moment later rather than at once,
      // and a Save live again in that moment could save the same recipe twice.
      onDone();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  // The page keeps the fields and their state; why each one is asked for is
  // method, and sits one tap away behind an (i) beside its heading. Printed
  // under every field it made this the wordiest screen in the app.
  return (
    <div className="screen">
      <ScreenHead
        title="New recipe"
        // Back keeps the draft, as the Android gesture does. Throwing it away
        // is the quiet link at the foot, which asks first.
        onBack={onCancel}
        action={
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        }
      />

      {wasRestored && <p className="rb__note">Your unsaved draft is back.</p>}

      {error && <p className="alert" role="alert">{error}</p>}

      <input
        className="field rb__name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name, like Rajma chawal"
        aria-label="Recipe name"
        // Not over a draft that already has its name: the keyboard would
        // cover the ingredients someone came back to finish.
        autoFocus={!restored?.name}
      />

      <section className="rb" aria-label="Ingredients">
        <div className="rb__head">
          <h2 className="rb__h">Ingredients</h2>
          <Info title="How ingredients are weighed">
            <p>
              Weigh each ingredient raw: it is the one state each of them can go on a scale in.
            </p>
            <p>
              The weights only set the proportions. You scale the whole batch, and change any
              line, when you cook it.
            </p>
            <p>
              Your own foods come first in the search. A pack that is not in it can be added
              under More › Foods you added, from a photo of its label.
            </p>
            <p>
              An ingredient with no nutrition data stays in the dish. Days you eat it show those
              nutrients as unmeasured, never as zero.
            </p>
          </Info>
          {rawInG > 0 && (
            <span className="rb__fig tnum">{Math.round(rawInG).toLocaleString()} g raw</span>
          )}
        </div>

        {rows.length > 0 && (
          <div className="tiles">
            {rows.map((r) => {
              const share = shareOf(r);
              const untracked = r.fdcId === null && r.ownId === null;
              const open = openKey === r.key;
              const shown = r.name ?? r.description;
              const sub = [
                share !== null ? pct(share) : null,
                r.optional ? "optional" : null,
                r.toTaste ? "to taste" : null,
              ].filter(Boolean).join(", ");
              return (
                <div className="tile rb-ing" key={r.key}>
                  <button
                    className="rb-ing__tap"
                    aria-expanded={open}
                    onClick={() => setOpenKey(open ? null : r.key)}
                  >
                    <span className={`lead ${r.ownId !== null ? "lead--own" : "lead--ref"}`} aria-hidden>
                      {initials(shown)}
                    </span>
                    <span className="row__main">
                      <span className="row__title">{shown}</span>
                      {(sub || untracked) && (
                        <span className="row__sub">
                          {sub}
                          {untracked && <span className="rb-ing__nodata">{sub ? ", " : ""}no nutrition data</span>}
                        </span>
                      )}
                    </span>
                  </button>
                  <label className="rb-ing__w">
                    <input className="field tnum" type="number" min="1" inputMode="decimal" value={r.raw}
                      onChange={(e) => patch(r.key, e.target.value)}
                      aria-label={`Raw grams of ${shown}`} />
                    <span className="rb-ing__u" aria-hidden>g</span>
                  </label>
                  {/* Its forms, read when the tile is first opened. */}
                  {open && r.fdcId !== null && (
                    <FormChips fdcId={r.fdcId} small className="rb-ing__forms"
                      onForm={(f, family) => switchForm(r.key, family, f)} />
                  )}
                  {open && (
                    <div className="rb-ing__more">
                      <button className="chip chip--sm" aria-pressed={r.optional}
                        onClick={() => toggleOptional(r.key)}>
                        Optional
                      </button>
                      <button className="chip chip--sm" aria-pressed={r.toTaste === true}
                        onClick={() => toggleTaste(r.key)}>
                        To taste
                      </button>
                      <button className="link rb-ing__rm"
                        onClick={() => { setRows((rs) => rs.filter((x) => x.key !== r.key)); setOpenKey(null); }}>
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <input
          className="field"
          data-results-below
          placeholder="Add an ingredient"
          aria-label="Search for an ingredient"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {hits.length > 0 && (
          <div className="tiles">
            {hits.map((h) => {
              // A food in several forms is one row, as on the Food screen.
              const fam = familyOf(h);
              const sub = h.note ?? (fam ? formsLine(fam.forms) : h.brand);
              return (
                <button className="tile food__row" key={h.fdc_id ?? h.custom_food_id ?? h.description}
                  onClick={() => addHit(h)}>
                  <span className={`lead ${h.custom_food_id !== null ? "lead--own" : "lead--ref"}${fam ? " lead--stack" : ""}`}
                    aria-hidden>
                    {initials(displayName(h))}
                  </span>
                  <span className="row__main">
                    <span className="row__title">{displayName(h)}</span>
                    {sub && <span className="row__sub">{sub}</span>}
                  </span>
                  <span className="row__chev" aria-hidden>+</span>
                </button>
              );
            })}
          </div>
        )}
        {query.trim().length >= 2 && (
          <button className="link rb__untracked" onClick={addUntracked}>
            Add “{query.trim()}” without nutrition data
          </button>
        )}
      </section>

      <section className="rb" aria-label="Cooked weight">
        <div className="rb__head">
          <h2 className="rb__h">Cooked weight</h2>
          <Info title="Why the cooked weight matters">
            <p>
              Weigh the whole pot once, the next time you make this. Every helping is divided by
              it.
            </p>
            <p>
              Dry beans roughly triple as they cook, so a bowl read as if it were still dry would
              count about three times over.
            </p>
            <p>
              A dish that neither soaks up water nor cooks down, like a chutney, a salad or a
              raita, weighs the same as what went in.
            </p>
          </Info>
        </div>
        <div className="rb__line">
          <input
            className="field grams tnum"
            type="number"
            min="1"
            inputMode="decimal"
            placeholder="900"
            value={yieldG}
            onChange={(e) => setYieldG(e.target.value)}
            aria-label="What the whole dish weighs once cooked"
          />
          <span className="rb__u">g</span>
          {rawInG > 0 && Math.round(rawInG) !== Math.round(yieldNum) && (
            <button className="link" onClick={() => setYieldG(String(Math.round(rawInG)))}>
              Same as raw
            </button>
          )}
        </div>
      </section>

      <section className="rb" aria-label="Portions">
        <div className="rb__head">
          <h2 className="rb__h">Portions</h2>
          <Info title="What a portion is for">
            <p>
              Name a helping, like 1 bowl or 1 slice, and log it later without weighing.
            </p>
          </Info>
        </div>
        {servingOpts.length > 0 && (
          <div className="tiles">
            {servingOpts.map((s, i) => (
              <div className="tile rb-por" key={i}>
                <span className="row__title">{s.label}</span>
                <span className="tnum">{s.grams} g</span>
                <button className="iconbtn" onClick={() => setServingOpts((x) => x.filter((_, j) => j !== i))}
                  aria-label={`Remove ${s.label}`}>×</button>
              </div>
            ))}
          </div>
        )}
        <div className="rb__line">
          <input className="field rb__plabel" placeholder="1 bowl"
            value={soLabel} onChange={(e) => setSoLabel(e.target.value)} aria-label="Portion name" />
          <input className="field grams tnum" type="number" min="1" inputMode="decimal" placeholder="150"
            value={soGrams} onChange={(e) => setSoGrams(e.target.value)} aria-label="Portion grams" />
          <span className="rb__u">g</span>
          <button className="btn btn--quiet" onClick={addServingOption}>Add</button>
        </div>
      </section>

      <section className="rb" aria-label="Tags">
        <div className="rb__head">
          <h2 className="rb__h">Tags</h2>
          <Info title="What the tags do">
            <p>
              They fill in the tags the first time you log this dish. On a day you made it
              differently, change them then.
            </p>
            <p>Editing them here later never changes a day you already logged.</p>
          </Info>
        </div>
        <TagPicker
          origin={defaultOrigin}
          cuisine={defaultCuisine}
          // A recipe is made at home, so only its cuisine is asked.
          origins={[]}
          onChange={(o, c) => { setDefaultOrigin(o); setDefaultCuisine(c); }}
        />
      </section>

      {(name || rows.length > 0) && (
        <button
          className="link rb__discard"
          onClick={() => {
            if (!window.confirm("Discard this recipe? The ingredients you added will be lost.")) return;
            clearDraft();
            onCancel();
          }}
        >
          Discard draft
        </button>
      )}
    </div>
  );
}
