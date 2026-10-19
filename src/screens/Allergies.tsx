import { useCallback, useEffect, useState } from "react";
import { humanDate, ingredientDays, listAllergens, setAllergens, shiftIso, todayIso } from "../api";
import Info from "../components/Info";
import ScreenHead from "../components/ScreenHead";
import { COMMON, readReactions, resolve, type ReactionView } from "../lib/allergens";

const ROW = { gridTemplateColumns: "1fr auto" } as const;
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/**
 * What the person is allergic to, how often it was eaten, and — on days they
 * marked a reaction that none of it explains — what else they ate more often
 * than usual. Six months of the log, read on the device.
 */
export default function Allergies(p: { onBack: () => void }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [view, setView] = useState<ReactionView | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async (list: string[]) => {
    const to = todayIso();
    setView(readReactions(await ingredientDays(shiftIso(to, -182), to), list));
  }, []);

  useEffect(() => {
    listAllergens()
      .then((list) => { setNames(list); return read(list); })
      .catch((e) => setError(String(e)));
  }, [read]);

  async function save(next: string[]) {
    setError(null);
    try {
      await setAllergens(next);
      setNames(next);
      await read(next);
    } catch (e) {
      setError(String(e));
    }
  }

  const ids = (names ?? []).map((n) => resolve(n).id);
  const own = (names ?? []).filter((n) => !COMMON.some((c) => c.id === resolve(n).id));
  const toggle = (id: string) =>
    save(ids.includes(id) ? (names ?? []).filter((n) => resolve(n).id !== id) : [...(names ?? []), id]);
  function add() {
    const t = typed.trim();
    const a = resolve(t);
    setTyped("");
    // "Peanuts" typed is the Peanut chip, kept by its id; anything else as typed.
    if (t && !ids.includes(a.id)) void save([...(names ?? []), COMMON.some((c) => c.id === a.id) ? a.id : t]);
  }

  const unexplained = view?.reactions.filter((r) => r.allergens.length === 0).length ?? 0;

  return (
    <div className="screen">
      <ScreenHead title="Allergies" onBack={p.onBack} />
      {error && <p className="alert" role="alert">{error}</p>}

      <section className="card">
        <div className="card__head">
          <h2>Your allergens</h2>
          <Info title="How they are found">
            <p>
              Each is looked for in the ingredient list of a packaged food or supplement, by its
              other names too: groundnut for peanut, atta and maida for wheat, whey and ghee for
              milk, til for sesame. A "may contain" line is shown as may contain.
            </p>
            <p>
              The check reads the words printed on the pack. A list with nothing flagged is not a
              guarantee, and foods without a printed list are not checked.
            </p>
          </Info>
          <span className="card__note">flagged on packs</span>
        </div>
        <div className="chips">
          {COMMON.map((c) => (
            <button key={c.id} className="chip" aria-pressed={ids.includes(c.id)} onClick={() => toggle(c.id)}>
              {c.label}
            </button>
          ))}
          {own.map((n) => (
            <button key={n} className="chip" aria-pressed onClick={() => toggle(resolve(n).id)} aria-label={`Remove ${n}`}>
              {n} ×
            </button>
          ))}
        </div>
        <form
          className="formgrid"
          style={{ marginTop: "var(--s4)", gridTemplateColumns: "1fr auto", alignItems: "end" }}
          onSubmit={(e) => { e.preventDefault(); add(); }}
        >
          <label>
            <span className="group__name">Something else</span>
            <input className="field" value={typed} maxLength={60} placeholder="Mango" onChange={(e) => setTyped(e.target.value)} />
          </label>
          <button className="btn btn--quiet" type="submit" disabled={!typed.trim()}>Add</button>
        </form>
      </section>

      {view && view.eaten.length > 0 && (
        <section className="card">
          <div className="card__head">
            <h2>Eaten in the last six months</h2>
          </div>
          <div className="rows">
            {view.eaten.map((e) => (
              <div key={e.allergen} className="row" style={ROW}>
                <span className="row__main">
                  <span className="row__title">{e.allergen}</span>
                  <span className="row__sub">Last: {humanDate(e.last)}</span>
                </span>
                <span className="tnum">{days(e.days)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {view && (
        <section className="card">
          <div className="card__head">
            <h2>Reaction days</h2>
            <span className="card__note">{view.reactions.length || "none yet"}</span>
          </div>
          {view.reactions.length === 0 ? (
            <p className="rangenote">Mark one with "Had a reaction", beside the day's note on Today.</p>
          ) : (
            <div className="rows">
              {[...view.reactions].reverse().map((r) => (
                <div key={r.date} className="row" style={ROW}>
                  <span className="row__title">{humanDate(r.date)}</span>
                  <span className="row__sub">{r.allergens.length ? r.allergens.join(", ") : "none of yours"}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {view && unexplained > 0 && (
        <section className="card">
          <div className="card__head">
            <h2>To be aware of</h2>
            <Info title="What this list is">
              <p>
                On the {days(unexplained)} you marked a reaction that none of your allergens
                explains, these were eaten more often than on the {days(view.otherDays)} without
                one.
              </p>
              <p>
                Eaten on the same day is not a cause. It is a list to keep an eye on, and an
                allergist can test what it cannot.
              </p>
            </Info>
          </div>
          {view.aware.length === 0 ? (
            <p className="rangenote">Nothing stands out yet.</p>
          ) : (
            <div className="rows">
              {view.aware.map((a) => (
                <div key={a.item} className="row" style={ROW}>
                  <span className="row__title">{a.item[0].toUpperCase() + a.item.slice(1)}</span>
                  <span className="row__sub tnum">
                    {a.onReaction} of {unexplained} reaction days · {a.onOther} of {view.otherDays} others
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
