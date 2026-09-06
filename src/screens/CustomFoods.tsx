import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteCustomFood, listCustomFoods } from "../api";
import { plural } from "../lib/nutrient";
import type { CustomFood } from "../types";
import ScreenHead from "../components/ScreenHead";

interface Props {
  /**
   * Open the editor. `null` starts a new food, an id edits that one. The router
   * carries the id in the hash, so this screen never holds it.
   */
  onEdit: (id: string | null) => void;
  /**
   * Reached from a search in Add food that came up short, and from
   * browsing Library — so the label stays neutral rather than naming one
   * destination that would be wrong from the other. Falls back to the hash
   * the router reads.
   */
  onBack?: () => void;
}

/**
 * The user's own foods: what the pack in front of them actually says.
 *
 * These rank above the bundled reference data in search, and one of them can
 * replace a generic entry outright — so this list is where a wrong override
 * gets found and corrected. Everything a pack does not print is either borrowed
 * from the entry it replaces or left unmeasured, and the row says which by
 * counting what came off the label.
 */
export default function CustomFoods(p: Props) {
  const [foods, setFoods] = useState<CustomFood[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const back = p.onBack ?? (() => { window.location.hash = "/foods"; });

  const load = useCallback(async () => {
    try {
      setFoods(await listCustomFoods());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return foods;
    return foods.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        (f.brand ?? "").toLowerCase().includes(q) ||
        (f.barcode ?? "").includes(q),
    );
  }, [foods, filter]);

  async function remove(f: CustomFood) {
    if (
      !window.confirm(
        `Delete “${f.name}”? Days that already used it keep the values they were ` +
          `logged with, and the generic entry it replaced comes back in search.`,
      )
    ) return;
    try {
      await deleteCustomFood(f.id);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="screen">
      <ScreenHead
        title="Your foods"
        sub={foods.length > 0 ? `${foods.length} saved` : "what the pack actually says"}
        onBack={back}
        action={
          foods.length > 0 ? (
            <button className="btn" onClick={() => p.onEdit(null)}>New food</button>
          ) : null
        }
      />

      {error && <p className="alert" role="alert">{error}</p>}

      {loading ? (
        <section className="card">
          {[0, 1, 2].map((i) => (
            <div className="skel skel--row" key={i} style={{ width: `${84 - i * 11}%` }} />
          ))}
        </section>
      ) : foods.length === 0 ? (
        <div className="empty">
          <h3>No foods of your own yet</h3>
          <p>
            A generic entry for milk chocolate is not the bar you are eating. Transcribe what the
            pack prints — from a photo of it, so you only have to hold the pack once — and this
            food ranks above the 13,694 bundled ones in search, or replaces the generic entry it
            was built from.
          </p>
          <button className="btn" onClick={() => p.onEdit(null)}>Add your first food</button>
        </div>
      ) : (
        <section className="card">
          {/* A filter rather than a search command: these are the user's own foods,
              a few hundred at most, and all of them are already in memory. */}
          {foods.length > 8 && (
            <input
              className="field"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, brand or barcode"
              aria-label="Filter my foods"
              style={{ marginBottom: "var(--s3)" }}
            />
          )}

          {shown.length === 0 ? (
            <p className="rangenote">Nothing here matches “{filter.trim()}”.</p>
          ) : (
            <div className="rows">
              {/* The same shape as a vessel row — a name, one figure, two actions —
                  including its mobile stacking, so both stay full-size targets. */}
              {shown.map((f) => (
                <div className="row vrow" key={f.id}>
                  <span className="row__main">
                    <span className="row__title">{f.name}</span>
                    <span className="row__sub">
                      {f.brand ? `${f.brand} · ` : ""}
                      {plural(f.nutrients.length, "value")} off the pack
                    </span>
                    {f.overrides_fdc_id !== null && (
                      <span className="hit__note">
                        Replaces a generic entry — open it to see which
                      </span>
                    )}
                  </span>
                  <span className="vrow__g num">
                    {fmt(f.serving_g)}
                    <span className="vrow__u"> g</span>
                    {f.serving_label && (
                      <span className="row__sub" style={{ textAlign: "right" }}>
                        {f.serving_label}
                      </span>
                    )}
                  </span>
                  <span className="vrow__acts">
                    <button className="btn btn--quiet vrow__btn" onClick={() => p.onEdit(f.id)}>
                      Edit
                    </button>
                    <button className="btn btn--danger vrow__btn" onClick={() => remove(f)}>
                      Delete
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {foods.length > 0 && (
        <p className="rangenote">
          A serving weight is what makes these usable: the pack prints its figures per serving and
          the rest of the app works per 100 g. Edit a food to see how many of its 47 nutrients came
          off the label, how many were borrowed, and how many nothing measured.
        </p>
      )}
    </div>
  );
}

/** One decimal at most — a serving weight printed to tenths is worth keeping, two are noise. */
const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString();
