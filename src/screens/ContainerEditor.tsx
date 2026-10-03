import { useEffect, useRef, useState } from "react";
import { deleteContainer, getContainer, saveContainer, searchFoods, suggestDensity } from "../api";
import ScreenHead from "../components/ScreenHead";
import type { ContainerUnit, Density, FoodHit, FoodRef, ReadBy } from "../types";

interface Props {
  /** The container being changed, or null to add one. */
  id: string | null;
  onDone: (id: string) => void;
  onCancel: () => void;
  /** After a delete: back to the pantry. */
  onDeleted: () => void;
}

const POUR_UNITS: { id: ContainerUnit; label: string }[] = [
  { id: "g", label: "g" },
  { id: "kg", label: "kg" },
  { id: "ml", label: "ml" },
  { id: "l", label: "L" },
];

/**
 * Add a container, or change one, on one screen: what it is, what is in it,
 * how it is read, and the first pack poured in.
 *
 * The food's weight per ml is shown with where it came from — the pack, or
 * USDA's household measures — because an ml reading only counts in grams
 * through it. Weighing a cupful replaces either.
 */
export default function ContainerEditor(p: Props) {
  const [loading, setLoading] = useState(p.id !== null);
  const [name, setName] = useState("");
  const [food, setFood] = useState<FoodRef | null>(null);
  const [foodName, setFoodName] = useState("");
  const [readBy, setReadBy] = useState<ReadBy>("scale");
  const [cupMl, setCupMl] = useState(240);
  const [capacity, setCapacity] = useState("");
  const [emptyG, setEmptyG] = useState("");
  const [density, setDensity] = useState<Density | null>(null);
  const [weighing, setWeighing] = useState(false);
  const [cupG, setCupG] = useState("");
  const [pour, setPour] = useState("");
  const [pourUnit, setPourUnit] = useState<ContainerUnit>("g");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FoodHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const seq = useRef(0);

  // An existing container opens as it is.
  useEffect(() => {
    if (p.id === null) return;
    let live = true;
    getContainer(p.id)
      .then((c) => {
        if (!live) return;
        setName(c.name);
        setFood(c.food);
        setFoodName(c.description);
        setReadBy(c.read_by);
        setCupMl(c.cup_ml);
        setCapacity(c.capacity_ml === null ? "" : String(c.capacity_ml));
        setEmptyG(c.empty_g === null ? "" : String(c.empty_g));
        setDensity(c.density);
        if (c.density?.source === "weighed") {
          setWeighing(true);
          setCupG(String(Math.round(c.density.g_per_ml * c.cup_ml)));
        }
        setLoading(false);
      })
      .catch((e) => { if (live) { setError(String(e)); setLoading(false); } });
    return () => { live = false; };
  }, [p.id]);

  // Your own foods come first, as in every other place a food is picked.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchFoods(q, 12)
        .then((r) => { if (mine === seq.current) setHits(r.slice(0, 8)); })
        .catch((e) => setError(String(e)));
    }, 160);
    return () => clearTimeout(t);
  }, [query]);

  // A new food brings its own weight per ml, unless one was weighed.
  useEffect(() => {
    if (!food || p.id !== null) return;
    let live = true;
    suggestDensity(food)
      .then((d) => { if (live) setDensity(d); })
      .catch(() => { if (live) setDensity(null); });
    return () => { live = false; };
  }, [food, p.id]);

  // A pack poured into a container read by its marks is usually labelled by
  // volume, and one on the scale by weight; nothing typed is overruled.
  function chooseReadBy(r: ReadBy) {
    setReadBy(r);
    if (pour.trim() === "") setPourUnit(r === "marks" ? "ml" : "g");
  }

  function pick(h: FoodHit) {
    if (h.fdc_id === null && h.custom_food_id === null) return;
    setFood({ fdc_id: h.fdc_id, custom_food_id: h.custom_food_id });
    setFoodName(h.description);
    setQuery("");
    setHits([]);
  }

  const pourInMl = pourUnit === "ml" || pourUnit === "l";
  const needsDensity = readBy === "marks" || (p.id === null && pour.trim() !== "" && pourInMl);
  const weighedCup = Number(cupG);
  const weighedOk = weighing && cupG.trim() !== "" && Number.isFinite(weighedCup) && weighedCup > 0;

  async function save() {
    setError(null);
    if (!name.trim()) return setError("Give it a name, like Salt jar.");
    if (!food) return setError("Pick what's in it.");
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    const cap = readBy === "marks" ? num(capacity) : null;
    const empty = num(emptyG);
    const poured = p.id === null ? num(pour) : null;
    for (const [v, what] of [[cap, "What it holds"], [empty, "The empty weight"], [poured, "The amount poured in"]] as const) {
      if (v !== null && !(Number.isFinite(v) && v > 0)) return setError(`${what} must be a number above zero.`);
    }
    if (weighing && !weighedOk) return setError("Type what a full cup weighs, or turn weighing off.");
    setSaving(true);
    try {
      const id = await saveContainer(
        {
          name: name.trim(),
          food,
          description: foodName,
          read_by: readBy,
          empty_g: empty,
          capacity_ml: cap,
          cup_ml: cupMl,
        },
        { weighedCupG: weighedOk ? weighedCup : null, pouredIn: poured, pouredUnit: poured !== null ? pourUnit : null },
        p.id,
      );
      p.onDone(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!p.id) return;
    try {
      await deleteContainer(p.id);
      p.onDeleted();
    } catch (e) {
      setError(String(e));
    }
  }

  if (loading) {
    return (
      <div className="screen screen--form">
        <ScreenHead title="Container" onBack={p.onCancel} />
        <div className="card"><div className="skel skel--row" /></div>
      </div>
    );
  }

  return (
    <div className="screen screen--form">
      <ScreenHead title={p.id ? "Edit container" : "New container"} onBack={p.onCancel} />

      <section className="card cform">
        <label className="cform__field">
          <span className="cform__l">Name</span>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Salt jar" />
        </label>

        <div className="cform__field">
          <span className="cform__l">What's in it</span>
          {food ? (
            <div className="cform__food">
              <span className="cform__tag">{foodName}</span>
              <button className="link" onClick={() => { setFood(null); setFoodName(""); setDensity(null); }}>change</button>
            </div>
          ) : (
            <>
              <input className="field" value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Salt, sunflower oil, ghee…" aria-label="Search for what's in it" />
              {hits.length > 0 && (
                <ul className="hits">
                  {hits.map((h) => (
                    <li key={h.custom_food_id ?? h.fdc_id ?? h.description}>
                      <button className="row hit" onClick={() => pick(h)}>
                        <span className="row__main"><span className="row__title">{h.description}</span></span>
                        <span className="hit__src">{h.custom_food_id !== null ? "yours" : ""}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="cform__field">
          <span className="cform__l">How you read it</span>
          <div className="chips" role="group" aria-label="How you read it">
            <button type="button" className="chip" aria-pressed={readBy === "scale"} onClick={() => chooseReadBy("scale")}>On the scale</button>
            <button type="button" className="chip" aria-pressed={readBy === "marks"} onClick={() => chooseReadBy("marks")}>By its marks</button>
          </div>
        </div>

        {readBy === "marks" ? (
          <>
            <div className="cform__field">
              <span className="cform__l">A cup is</span>
              <div className="chips">
                {[240, 250].map((ml) => (
                  <button key={ml} className="chip" aria-pressed={cupMl === ml} onClick={() => setCupMl(ml)}>{ml} ml</button>
                ))}
              </div>
            </div>
            <label className="cform__field">
              <span className="cform__l">Holds when full <em>optional</em></span>
              <span className="cform__unit">
                <input className="field tnum" inputMode="decimal" value={capacity}
                  onChange={(e) => setCapacity(e.target.value)} placeholder="1000" />
                <span>ml</span>
              </span>
            </label>
          </>
        ) : (
          <label className="cform__field">
            <span className="cform__l">Weighed empty <em>optional</em></span>
            <span className="cform__unit">
              <input className="field tnum" inputMode="decimal" value={emptyG}
                onChange={(e) => setEmptyG(e.target.value)} placeholder="when you can" />
              <span>g</span>
            </span>
          </label>
        )}

        {food && (needsDensity || weighing) && (
          <div className="cform__dens">
            {weighing ? (
              <>
                <label className="cform__unit">
                  <span className="cform__l">A full {cupMl} ml cup weighs</span>
                  <input className="field tnum" inputMode="decimal" value={cupG}
                    onChange={(e) => setCupG(e.target.value)} placeholder="218" autoFocus />
                  <span>g</span>
                </label>
                {weighedOk && <p className="cform__dv">{(weighedCup / cupMl).toFixed(2)} g per ml</p>}
                {density && density.source !== "weighed" && (
                  <button className="link" onClick={() => { setWeighing(false); setCupG(""); }}>
                    Use {density.note.split(":")[0] === "USDA" ? "USDA's figure" : "the pack's figure"} instead
                  </button>
                )}
              </>
            ) : density ? (
              <>
                <p className="cform__dv">{density.g_per_ml.toFixed(2)} g per ml</p>
                <p className="cform__ds">{density.note}</p>
                <button className="link" onClick={() => setWeighing(true)}>Weigh a cupful instead</button>
              </>
            ) : (
              <>
                <p className="cform__ds">No weight per ml known for {foodName.toLowerCase()} yet.</p>
                <button className="link" onClick={() => setWeighing(true)}>Weigh a cupful</button>
              </>
            )}
          </div>
        )}

        {p.id === null && (
          <div className="cform__field">
            <span className="cform__l">Poured in now <em>optional</em></span>
            <span className="cform__unit">
              <input className="field tnum" inputMode="decimal" value={pour}
                onChange={(e) => setPour(e.target.value)} placeholder="from the label" />
            </span>
            <div className="chips" role="group" aria-label="Unit of the pack">
              {POUR_UNITS.map((u) => (
                <button key={u.id} type="button" className="chip" aria-pressed={pourUnit === u.id} onClick={() => setPourUnit(u.id)}>{u.label}</button>
              ))}
            </div>
          </div>
        )}

        {error && <p className="alert" role="alert">{error}</p>}

        <button className="btn cform__save" onClick={save} disabled={saving}>
          {saving ? "Saving…" : p.id ? "Save" : "Add to pantry"}
        </button>
      </section>

      {p.id && (
        <section className="card">
          {confirmDelete ? (
            <div className="cform__del">
              <p>Delete {name}? Its readings stop counting. Meals already logged keep their amounts.</p>
              <span className="prow__confirm">
                <button className="btn btn--danger" onClick={remove}>Delete</button>
                <button className="btn btn--quiet" onClick={() => setConfirmDelete(false)}>Keep</button>
              </span>
            </div>
          ) : (
            <button className="btn btn--danger" onClick={() => setConfirmDelete(true)}>Delete container</button>
          )}
        </section>
      )}
    </div>
  );
}
