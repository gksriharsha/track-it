import { useCallback, useEffect, useMemo, useState } from "react";
import { getGoals, setNutrientTarget } from "../api";
import type { GoalRow, GoalsView } from "../types";
import { BASIS_LABEL, BASIS_NOTE } from "../types";
import { displayUnit, fmtAmount } from "../lib/nutrient";
import ScreenHead from "../components/ScreenHead";

interface Props {
  onBack: () => void;
  onOpenProfile: () => void;
  /** Every screen reads days against these figures, so they reload when one moves. */
  onChanged: () => void;
}

type Filter = "all" | "mine" | "limits";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "limits", label: "Limits" },
];

/**
 * Targets and goals — what every number on the dashboard is a percentage of.
 *
 * The screen's real job is to make the denominator visible. A percentage with
 * an unnamed denominator is not a fact about anything, and this app carries
 * four different kinds of them: a figure the user set, an RDA, an Adequate
 * Intake, and the FDA Daily Value. Each row says which it is using and what it
 * would fall back to, so overriding one is an informed act rather than a leap.
 */
export default function Settings(p: Props) {
  const [view, setView] = useState<GoalsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      setView(await getGoals());
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

  const rows = view?.rows ?? [];

  const shown = useMemo(() => {
    if (filter === "mine") return rows.filter((r) => r.user_amount !== null);
    if (filter === "limits") return rows.filter((r) => r.is_limit);
    return rows;
  }, [rows, filter]);

  const mine = rows.filter((r) => r.user_amount !== null).length;

  function open(r: GoalRow) {
    setEditing(r.id);
    setDraft(r.user_amount === null ? "" : String(r.user_amount));
    setNote(r.user_note ?? "");
  }

  async function commit(r: GoalRow) {
    setError(null);
    const t = draft.trim();
    // An empty box means "use the published figure", which is a clear
    // instruction and not a mistake.
    const amount = t === "" ? null : Number(t);
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
      setError("A target has to be a positive number. Clear the box to go back to the published figure.");
      return;
    }
    try {
      await setNutrientTarget(r.id, amount, note.trim() === "" ? null : note.trim());
      setEditing(null);
      await load();
      p.onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  if (loading) {
    return (
      <div className="screen">
        <div className="card">
          {Array.from({ length: 8 }, (_, i) => (
            <div className="skel skel--row" key={i} style={{ width: `${94 - i * 6}%` }} />
          ))}
        </div>
      </div>
    );
  }

  const placed = view?.group_label ?? null;
  const energy = view?.energy_target ?? null;

  return (
    <div className="screen">
      <ScreenHead
        title="Targets and goals"
        sub="what every percentage is measured against"
        onBack={p.onBack}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      {/* Where the numbers come from, before any of them are shown. */}
      <section className="card">
        <div className="card__head">
          <h2>Where your targets come from</h2>
          <button className="link card__note" onClick={p.onOpenProfile}>Edit profile</button>
        </div>
        <div className="rows">
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="row__main">
              <span className="row__title">Reference tables</span>
              <span className="row__sub">
                {placed ?? "No profile — falling back to FDA Daily Values"}
              </span>
            </span>
            <span className={`pill${placed ? " is-on" : ""}`}>
              {placed ? "DRI" : "Daily Value"}
            </span>
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="row__main">
              <span className="row__title">Energy</span>
              <span className="row__sub">
                {energy === null
                  ? "No target — the day shows what you ate with no progress bar"
                  : energy.basis === "user_set"
                    ? `${Math.round(energy.kcal).toLocaleString()} kcal, set by you`
                    : `about ${Math.round(energy.kcal).toLocaleString()} kcal, estimated`}
              </span>
            </span>
            <span className={`pill${energy ? " is-on" : ""}`}>
              {energy === null ? "none" : energy.basis === "user_set" ? "yours" : "estimated"}
            </span>
          </div>
          {(view?.macro_ranges.length ?? 0) > 0 && (
            <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span className="row__main">
                <span className="row__title">Macronutrients</span>
                <span className="row__sub">
                  Acceptable ranges, as a share of that energy — not single targets.
                </span>
              </span>
              <span className="pill is-on">ranges</span>
            </div>
          )}
        </div>

        {!placed && (
          <div className="card__foot">
            A Daily Value is one adult column off a food label. It says 18 mg of iron for everybody,
            where the actual recommendation is 8 mg for an adult man and 18 mg for a woman under 50.{" "}
            <button className="link" onClick={p.onOpenProfile}>Add your age and sex</button> and every
            row below switches to the figure for you.
          </div>
        )}
      </section>

      {(view?.macro_ranges.length ?? 0) > 0 && (
        <section className="card">
          <div className="card__head">
            <h2>Macronutrient ranges</h2>
            <span className="card__note">share of energy</span>
          </div>
          <div className="rows">
            {view!.macro_ranges.map((m) => {
              const meta = rows.find((r) => r.id === m.nutrient_id);
              return (
                <div className="row" key={m.nutrient_id} style={{ gridTemplateColumns: "1fr auto" }}>
                  <span className="row__main">
                    <span className="row__title">{meta?.name ?? m.nutrient_id}</span>
                    <span className="row__sub">
                      {m.low_pct}–{m.high_pct}% of energy
                    </span>
                  </span>
                  <span className="num" style={{ color: "var(--ink-2)" }}>
                    {Math.round(m.low_g)}–{Math.round(m.high_g)} g
                  </span>
                </div>
              );
            })}
          </div>
          <div className="card__foot">
            A range, because there is no single right amount of fat or carbohydrate. The dashboard
            says whether the day landed inside it rather than scoring it against a midpoint nobody
            published.
          </div>
        </section>
      )}

      <section className="card">
        <div className="card__head">
          <h2>Every nutrient</h2>
          <span className="card__note">
            {mine > 0 ? `${mine} set by you` : "none set by you"}
          </span>
        </div>

        <div className="chips" style={{ marginBottom: "var(--s3)" }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className="chip"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="rows">
          {shown.map((r) => {
            const isOpen = editing === r.id;
            return (
              <div key={r.id}>
                <button className="row goalrow" onClick={() => (isOpen ? setEditing(null) : open(r))}>
                  <span className="row__main">
                    <span className="row__title">
                      {r.name}
                      {r.is_limit && <span className="goalrow__limit"> limit</span>}
                    </span>
                    <span className="row__sub">
                      {r.basis ? BASIS_LABEL[r.basis] : "no reference figure published"}
                    </span>
                  </span>
                  <span className="nval">
                    <span className="nval__amt tnum">
                      {r.amount === null ? "—" : fmtAmount(r.amount, r.magnitude)}
                    </span>
                  </span>
                </button>

                {isOpen && (
                  <div className="breakdown">
                    <p className="breakdown__note" style={{ marginTop: 0 }}>
                      {r.basis ? BASIS_NOTE[r.basis] : "No reference system publishes a figure for this one, so it has no target and no percentage."}
                    </p>

                    <div className="formgrid" style={{ marginTop: "var(--s3)" }}>
                      <label>
                        <span className="group__name">
                          Your {r.is_limit ? "limit" : "target"} ({displayUnit(r.magnitude)})
                        </span>
                        <input
                          className="field tnum"
                          inputMode="decimal"
                          autoFocus
                          value={draft}
                          placeholder={
                            r.published_amount === null ? "" : String(round(r.published_amount))
                          }
                          onChange={(e) => setDraft(e.target.value)}
                        />
                      </label>
                      <label>
                        <span className="group__name">Why (optional)</span>
                        <input
                          className="field"
                          value={note}
                          placeholder="what my doctor said"
                          onChange={(e) => setNote(e.target.value)}
                        />
                      </label>
                    </div>

                    <p className="breakdown__note">
                      {r.published_amount === null ? (
                        <>Clearing this leaves the nutrient with no target at all.</>
                      ) : (
                        <>
                          Clear the box to go back to{" "}
                          <strong>{fmtAmount(r.published_amount, r.magnitude)}</strong>
                          {r.published_basis && <> — the {BASIS_LABEL[r.published_basis]}</>}.
                        </>
                      )}
                    </p>

                    <div className="commit">
                      <button className="btn btn--quiet" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                      <button className="btn" style={{ marginLeft: "auto" }} onClick={() => commit(r)}>
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {shown.length === 0 && (
            <p style={{ color: "var(--ink-3)", fontSize: 14, margin: "var(--s3) 0" }}>
              {filter === "mine"
                ? "You have not set any targets of your own yet. Open any nutrient to set one."
                : "Nothing in this filter."}
            </p>
          )}
        </div>

        <div className="card__foot">
          A figure you set beats both reference tables. Nothing here changes a day you already
          logged — a target is a lens on what you ate, never part of it.
        </div>
      </section>
    </div>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
