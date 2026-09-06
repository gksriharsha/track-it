import { useCallback, useEffect, useState } from "react";
import { deleteBottle, humanDate, listBottles, saveBottle, todayIso } from "../api";
import type { Bottle } from "../types";
import ScreenHead from "../components/ScreenHead";

interface Props {
  /**
   * Reached from both the bottle picker in Add food and from Library, so
   * the label stays neutral rather than naming one destination that would be
   * wrong from the other. Falls back to the hash the router reads.
   */
  onBack?: () => void;
}

/**
 * The bottle library: every bottle and jug with a known full weight.
 *
 * A row is one physical object, not a type of object. Two bottles of the same
 * model off the same shelf can differ by a few grams, so a weight keyed by
 * "1L steel bottle" would put back the error the full weight exists to remove.
 */
export default function Bottles(p: Props) {
  const [bottles, setBottles] = useState<Bottle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [fullG, setFullG] = useState("");
  /** Set while re-weighing or renaming an existing row: the same two fields serve both. */
  const [editing, setEditing] = useState<Bottle | null>(null);
  const [saving, setSaving] = useState(false);

  const back = p.onBack ?? (() => { window.location.hash = "/foods"; });

  const load = useCallback(async () => {
    try {
      setBottles(await listBottles());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function edit(b: Bottle) {
    setEditing(b);
    setName(b.name);
    setFullG(String(b.full_g));
    setError(null);
  }

  function cancelEdit() {
    setEditing(null);
    setName("");
    setFullG("");
    setError(null);
  }

  async function save() {
    setError(null);
    if (!name.trim()) return setError("Give the bottle a name.");
    const g = Number(fullG);
    if (!fullG.trim() || !Number.isFinite(g) || g <= 0) {
      return setError("Enter its full weight in grams, greater than zero.");
    }
    setSaving(true);
    try {
      await saveBottle(name.trim(), g, editing?.id ?? null);
      cancelEdit();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(b: Bottle) {
    if (
      !window.confirm(
        `Delete “${b.name}”? Days that already used it keep the amount they were logged with.`,
      )
    ) return;
    try {
      await deleteBottle(b.id);
      if (editing?.id === b.id) cancelEdit();
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="screen">
      <ScreenHead
        title="Bottles"
        sub={bottles.length > 0 ? `${bottles.length} weighed` : "so a bottle can be read at a glance"}
        onBack={back}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="card">
        <div className="card__head">
          <h2>{editing ? `Re-weigh ${editing.name}` : "Add a bottle"}</h2>
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
              placeholder="1L steel bottle"
              aria-label="Bottle name"
            />
          </label>
          <label className="vform__cell vform__cell--g">
            <span className="group__name">Full weight</span>
            <input
              className="field tnum"
              type="number"
              min="1"
              inputMode="decimal"
              value={fullG}
              onChange={(e) => setFullG(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="1050"
              aria-label="Full weight in grams"
            />
          </label>
          <button className="btn vform__go" onClick={save} disabled={saving}>
            {saving ? "Saving…" : editing ? "Update" : "Save bottle"}
          </button>
        </div>
        <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
          Weigh it once, filled with water the way you normally would. Logging water later just
          asks what it reads now — full minus that is what you drank.
        </p>
      </section>

      {loading ? (
        <div className="card">
          {[0, 1, 2].map((i) => (
            <div className="skel skel--row" key={i} style={{ width: `${80 - i * 12}%` }} />
          ))}
        </div>
      ) : bottles.length === 0 ? (
        <div className="empty">
          <h3>Nothing weighed yet</h3>
          <p>
            Fill it, weigh it, save what the scale says. After that, logging water is just
            reading the bottle again — full minus what is left is what you drank.
          </p>
        </div>
      ) : (
        <section className="card">
          <div className="card__head">
            <h2>Weighed</h2>
            <span className="card__note">most recently used first</span>
          </div>
          <div className="rows">
            {bottles.map((b) => (
              <div className="row vrow" key={b.id}>
                <span className="row__main">
                  <span className="row__title">{b.name}</span>
                  <span className="row__sub">
                    {b.last_used_at
                      ? `last used ${humanDate(localDay(b.last_used_at)).toLowerCase()}`
                      : "not used yet"}
                  </span>
                </span>
                <span className="vrow__g num">
                  {fmt(b.full_g)}
                  <span className="vrow__u"> g</span>
                </span>
                <span className="vrow__acts">
                  <button className="btn btn--quiet vrow__btn" onClick={() => edit(b)}>
                    Re-weigh
                  </button>
                  <button className="btn btn--danger vrow__btn" onClick={() => remove(b)}>
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="rangenote">
        A bottle's full weight can drift a little — a new cap, a scratched label — so re-weigh it
        here if a reading ever looks off, rather than trusting an old number forever.
      </p>
    </div>
  );
}

/** One decimal at most. A scale that reads tenths is worth keeping; two are noise. */
const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString();

/**
 * `last_used_at` is a UTC instant, and `humanDate` compares against the local
 * calendar day — so the string cannot simply be sliced. West of UTC an evening
 * refill is already tomorrow in UTC, and the row would read "thu, sep 4" for a
 * bottle used minutes ago.
 */
const localDay = (instant: string) => todayIso(new Date(instant));
