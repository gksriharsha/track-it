import { useCallback, useEffect, useState } from "react";
import { deleteVessel, humanDate, listVessels, saveVessel, todayIso } from "../api";
import type { Vessel } from "../types";
import ScreenHead from "../components/ScreenHead";

interface Props {
  /**
   * Reached from both the weight field in Add food and from Library, so
   * the label stays neutral rather than naming one destination that would be
   * wrong from the other. Falls back to the hash the router reads.
   */
  onBack?: () => void;
}

/**
 * The vessel library: every plate, bowl, katori and pot with a known empty weight.
 *
 * A row is one physical object, not a type of object. Two steel katoris off the same
 * shelf differ by three or four grams, so a weight keyed by "katori" would put back
 * the error the tare exists to remove.
 */
export default function Vessels(p: Props) {
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [grams, setGrams] = useState("");
  /** Set while re-weighing or renaming an existing row: the same two fields serve both. */
  const [editing, setEditing] = useState<Vessel | null>(null);
  const [saving, setSaving] = useState(false);

  const back = p.onBack ?? (() => { window.location.hash = "/foods"; });

  const load = useCallback(async () => {
    try {
      setVessels(await listVessels());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function edit(v: Vessel) {
    setEditing(v);
    setName(v.name);
    setGrams(String(v.grams));
    setError(null);
  }

  function cancelEdit() {
    setEditing(null);
    setName("");
    setGrams("");
    setError(null);
  }

  async function save() {
    setError(null);
    if (!name.trim()) return setError("Give the vessel a name.");
    const g = Number(grams);
    if (!grams.trim() || !Number.isFinite(g) || g <= 0) {
      return setError("Enter the empty weight in grams, greater than zero.");
    }
    setSaving(true);
    try {
      await saveVessel(name.trim(), g, editing?.id ?? null);
      cancelEdit();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(v: Vessel) {
    if (
      !window.confirm(
        `Delete “${v.name}”? Days that already used it keep the weight they were logged with.`,
      )
    ) return;
    try {
      await deleteVessel(v.id);
      if (editing?.id === v.id) cancelEdit();
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="screen">
      <ScreenHead
        title="Vessels"
        sub={vessels.length > 0 ? `${vessels.length} weighed` : "so the plate can go on the scale"}
        onBack={back}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="card">
        <div className="card__head">
          <h2>{editing ? `Re-weigh ${editing.name}` : "Add a vessel"}</h2>
          {editing && (
            <button className="link card__note" onClick={cancelEdit}>cancel</button>
          )}
        </div>
        <div className="vform">
          <label className="vform__cell">
            <span className="group__name">Name</span>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Steel katori, small"
              aria-label="Vessel name"
            />
          </label>
          <label className="vform__cell vform__cell--g">
            <span className="group__name">Empty weight</span>
            <input
              className="field tnum"
              type="number"
              min="1"
              inputMode="decimal"
              value={grams}
              onChange={(e) => setGrams(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="86"
              aria-label="Empty weight in grams"
            />
          </label>
          <button className="btn vform__go" onClick={save} disabled={saving}>
            {saving ? "Saving…" : editing ? "Update" : "Save vessel"}
          </button>
        </div>
        <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
          Each row here is one physical object, weighed empty once — not a kind of vessel. Two
          steel katoris off the same shelf differ by a few grams, and naming them apart
          (“katori, chipped rim”) is what keeps the subtraction honest.
        </p>
      </section>

      {loading ? (
        <div className="card">
          {[0, 1, 2].map((i) => (
            <div className="skel skel--row" key={i} style={{ width: `${80 - i * 12}%` }} />
          ))}
        </div>
      ) : vessels.length === 0 ? (
        <div className="empty">
          <h3>Nothing weighed yet</h3>
          <p>
            Two steps, once per vessel: put it on the scale empty, then save what the scale
            says. After that you never weigh it again — serve the food, put the whole plate
            on, and tick the vessels underneath.
          </p>
        </div>
      ) : (
        <section className="card">
          <div className="card__head">
            <h2>Weighed</h2>
            <span className="card__note">most recently used first</span>
          </div>
          <div className="rows">
            {vessels.map((v) => (
              <div className="row vrow" key={v.id}>
                <span className="row__main">
                  <span className="row__title">{v.name}</span>
                  <span className="row__sub">
                    {v.last_used_at
                      ? `last used ${humanDate(localDay(v.last_used_at)).toLowerCase()}`
                      : "not used yet"}
                  </span>
                </span>
                <span className="vrow__g num">
                  {fmt(v.grams)}
                  <span className="vrow__u"> g</span>
                </span>
                <span className="vrow__acts">
                  <button className="btn btn--quiet vrow__btn" onClick={() => edit(v)}>
                    Re-weigh
                  </button>
                  <button className="btn btn--danger vrow__btn" onClick={() => remove(v)}>
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="rangenote">
        Where your scale has a tare button, use it — zeroing the empty vessel is exact. This is
        for the plate that is already served, and for the day the katori is sitting on a thali
        and both of them have to come off.
      </p>
    </div>
  );
}

/** One decimal at most. A scale that reads tenths is worth keeping; two are noise. */
const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString();

/**
 * `last_used_at` is a UTC instant, and `humanDate` compares against the local
 * calendar day — so the string cannot simply be sliced. West of UTC an evening
 * meal is already tomorrow in UTC, and the row would read "thu, sep 4" for a
 * vessel used minutes ago.
 */
const localDay = (instant: string) => todayIso(new Date(instant));
