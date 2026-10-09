import { useCallback, useEffect, useState } from "react";
import { deleteSupplement, listSupplements } from "../api";
import type { Supplement } from "../types";
import { plural } from "../lib/nutrient";
import Info from "../components/Info";
import ScreenHead from "../components/ScreenHead";

interface Props {
  onBack: () => void;
  onEdit: (id: string | null) => void;
}

/**
 * The supplements you take, as their panels describe them.
 *
 * Kept apart from "your own foods" rather than folded in with them. A custom
 * food can borrow the thirty-odd nutrients its pack does not print from the
 * generic entry it replaces; a supplement has nothing to borrow from, because
 * there is no reference entry for "one multivitamin tablet" and crediting a
 * pill with values measured in a food would be inventing data. So it asserts
 * what its panel lists and nothing else — a different kind of record, on its
 * own shelf.
 */
export default function Supplements(p: Props) {
  const [list, setList] = useState<Supplement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await listSupplements());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(s: Supplement) {
    if (
      !window.confirm(
        `Delete “${s.name}”? Days you already took it keep exactly what they were logged with.`,
      )
    ) {
      return;
    }
    try {
      await deleteSupplement(s.id);
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="screen">
      {/* The header action is dropped while the empty state is showing: that
          state already carries "Add your first one", and two green buttons a
          few hundred pixels apart doing the identical thing is two calls to
          action competing for one intent. */}
      <ScreenHead
        title="Your supplements"
        onBack={p.onBack}
        action={
          list.length > 0 ? (
            <button className="btn" onClick={() => p.onEdit(null)}>Add a supplement</button>
          ) : null
        }
      />

      {error && <p className="alert" role="alert">{error}</p>}

      {loading ? (
        <div className="card">
          {[0, 1, 2].map((i) => (
            <div className="skel skel--row" key={i} style={{ width: `${88 - i * 12}%` }} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="empty">
          <h3>No supplements yet</h3>
          <p>Add one from a photo of its panel.</p>
          <button className="btn" onClick={() => p.onEdit(null)}>Add your first one</button>
        </div>
      ) : (
        <section className="card">
          {/* The count the title used to carry as a subtitle, now heading the
              list it counts. */}
          <div className="card__head">
            <h2>{plural(list.length, "supplement")}</h2>
            <Info title="How supplements count">
              <p>
                A supplement borrows nothing. What its panel does not list stays unknown unless you
                said the panel lists everything.
              </p>
            </Info>
          </div>
          <div className="rows">
            {list.map((s) => (
              <div className="row entryrow" key={s.id}>
                <button className="entryrow__main" onClick={() => p.onEdit(s.id)}>
                  <span className="row__title">
                    {s.brand ? `${s.brand} ${s.name}` : s.name}
                  </span>
                  <span className="row__sub">
                    {plural(s.nutrients.length, "line")} off the panel ·{" "}
                    {s.serving_label ??
                      `${s.serving_units} ${s.unit_noun}${s.serving_units === 1 ? "" : "s"}`}{" "}
                    a serving
                    {s.panel_complete && " · panel listed as complete"}
                  </span>
                </button>
                <span className="row__chev" aria-hidden>›</span>
                <button
                  className="iconbtn"
                  onClick={() => remove(s)}
                  aria-label={`Delete ${s.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
