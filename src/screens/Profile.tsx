import { useCallback, useEffect, useState } from "react";
import { getGoals, saveProfile } from "../api";
import type { Activity, GoalsView, LifeStage, Profile as ProfileT, Sex } from "../types";
import { ACTIVITIES, LIFE_STAGES } from "../types";
import ScreenHead from "../components/ScreenHead";

interface Props {
  onBack: () => void;
  onOpenSettings: () => void;
  /** The day view is read against these figures, so it reloads when they move. */
  onChanged: () => void;
}

/**
 * Who the targets are for.
 *
 * Everything here is optional, and the screen's job is to be honest about what
 * each answer buys rather than to demand the lot up front. Two thresholds
 * matter and are stated as you cross them:
 *
 * - **Age and sex** place you in the DRI tables, which is what replaces the
 *   Daily Values — one adult column that says 18 mg of iron for everybody,
 *   against an adult man's 8 mg and a woman's 18 mg that falls back to 8 mg
 *   after 50.
 * - **Height, weight and activity** are what an energy estimate needs. Without
 *   all three there is no estimate, because filling in the missing one with a
 *   guess would produce a fiction with a plausible number attached.
 *
 * Nothing here is required to use the app. With an empty profile every target
 * falls back to the Daily Value and the app says so on every screen.
 */
export default function Profile(p: Props) {
  const [view, setView] = useState<GoalsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [sex, setSex] = useState<Sex | null>(null);
  const [birthYear, setBirthYear] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [activity, setActivity] = useState<Activity | null>(null);
  const [lifeStage, setLifeStage] = useState<LifeStage>("standard");
  const [energyKcal, setEnergyKcal] = useState("");

  const load = useCallback(async () => {
    try {
      const v = await getGoals();
      setView(v);
      const f = v.profile;
      setSex(f.sex);
      setBirthYear(f.birth_year === null ? "" : String(f.birth_year));
      setHeightCm(f.height_cm === null ? "" : String(f.height_cm));
      setWeightKg(f.weight_kg === null ? "" : String(f.weight_kg));
      setActivity(f.activity);
      setLifeStage(f.life_stage);
      setEnergyKcal(f.energy_kcal === null ? "" : String(f.energy_kcal));
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

  /** A blank box means "I would rather not say", which is a real answer. */
  const num = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };

  async function save() {
    setError(null);
    const by = num(birthYear);
    const h = num(heightCm);
    const w = num(weightKg);
    const e = num(energyKcal);
    for (const [label, v] of [
      ["birth year", by],
      ["height", h],
      ["weight", w],
      ["energy target", e],
    ] as const) {
      if (v !== null && Number.isNaN(v)) {
        return setError(`That ${label} is not a number. Leave it blank if you would rather not say.`);
      }
    }

    const next: ProfileT = {
      sex,
      birth_year: by,
      height_cm: h,
      weight_kg: w,
      activity,
      life_stage: lifeStage,
      energy_kcal: e,
    };
    setSaving(true);
    try {
      await saveProfile(next);
      await load();
      p.onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="screen">
        <div className="card">
          {[0, 1, 2].map((i) => (
            <div className="skel skel--row" key={i} style={{ width: `${88 - i * 14}%` }} />
          ))}
        </div>
      </div>
    );
  }

  const placed = view?.group_label ?? null;
  const estimate = view?.estimated_kcal ?? null;
  const inForce = view?.energy_target ?? null;

  return (
    <div className="screen">
      <ScreenHead
        title="Profile"
        sub="who the targets are for"
        onBack={p.onBack}
        action={
          <button className="btn btn--quiet" onClick={p.onOpenSettings}>Targets and goals</button>
        }
      />

      {error && <p className="alert" role="alert">{error}</p>}

      {/* What the profile currently buys, stated before any of the questions. */}
      <section className="card">
        <div className="card__head">
          <h2>What this changes</h2>
        </div>
        <div className="rows">
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="row__main">
              <span className="row__title">Nutrient targets</span>
              <span className="row__sub">
                {placed
                  ? `Read against the DRIs for ${placed.toLowerCase()}.`
                  : "Falling back to FDA Daily Values — one adult column, the figure on a food label."}
              </span>
            </span>
            <span className={`pill${placed ? " is-on" : ""}`}>
              {placed ? "personalised" : "generic"}
            </span>
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="row__main">
              <span className="row__title">Energy target</span>
              <span className="row__sub">
                {inForce === null
                  ? "No target. The day shows what you ate and draws no progress bar."
                  : inForce.basis === "user_set"
                    ? `${Math.round(inForce.kcal).toLocaleString()} kcal, the figure you set.`
                    : `About ${Math.round(inForce.kcal).toLocaleString()} kcal, estimated from your body.`}
              </span>
            </span>
            <span className={`pill${inForce ? " is-on" : ""}`}>
              {inForce === null ? "none" : inForce.basis === "user_set" ? "yours" : "estimated"}
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Age and sex</h2>
          <span className="card__note">places you in the DRI tables</span>
        </div>
        <p className="rangenote">
          These two do the most work. Without them every target is the FDA Daily Value, which is a
          single adult column: it puts iron at 18 mg for everyone, where the actual recommendation
          is 8 mg for an adult man, 18 mg for a woman under 50, and 8 mg again after that.
        </p>

        <div className="formgrid" style={{ marginTop: "var(--s4)" }}>
          <label>
            <span className="group__name">Birth year</span>
            <input
              className="field tnum"
              inputMode="numeric"
              placeholder="1990"
              value={birthYear}
              onChange={(e) => setBirthYear(e.target.value)}
            />
          </label>
          <div>
            <span className="group__name">Reference column</span>
            <div className="chips" style={{ marginTop: "var(--s1)" }}>
              {(["female", "male"] as Sex[]).map((s) => (
                <button
                  key={s}
                  className="chip"
                  aria-pressed={sex === s}
                  // Tapping the selected one clears it: "would rather not say"
                  // has to stay reachable.
                  onClick={() => setSex(sex === s ? null : s)}
                  style={{ textTransform: "capitalize" }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="tags__note">
          The DRI tables have exactly two columns, so this is a lookup key rather than a description
          of you. Leaving it blank is fine — the app falls back to the Daily Values and says so.
        </p>

        <div className="group__name" style={{ marginTop: "var(--s5)" }}>
          Pregnant or breastfeeding
        </div>
        <div className="chips">
          {LIFE_STAGES.map((l) => (
            <button
              key={l.id}
              className="chip"
              aria-pressed={lifeStage === l.id}
              onClick={() => setLifeStage(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <p className="tags__note">
          Not a small adjustment: folate goes from 400 to 600 µg, iron from 18 to 27 mg and iodine
          from 150 to 220 µg. The published tables stop at 50, so beyond that this app has no column
          to read.
        </p>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Body and activity</h2>
          <span className="card__note">what an energy estimate needs</span>
        </div>
        <p className="rangenote">
          All three, or none. An estimate built on a guessed weight is a fiction with a plausible
          number attached, so the app would rather show no energy target than one it made up.
        </p>

        <div className="formgrid" style={{ marginTop: "var(--s4)" }}>
          <label>
            <span className="group__name">Height (cm)</span>
            <input
              className="field tnum"
              inputMode="decimal"
              placeholder="170"
              value={heightCm}
              onChange={(e) => setHeightCm(e.target.value)}
            />
          </label>
          <label>
            <span className="group__name">Weight (kg)</span>
            <input
              className="field tnum"
              inputMode="decimal"
              placeholder="65"
              value={weightKg}
              onChange={(e) => setWeightKg(e.target.value)}
            />
          </label>
        </div>

        <div className="group__name" style={{ marginTop: "var(--s4)" }}>How active a day is</div>
        <div className="rows">
          {ACTIVITIES.map((a) => (
            <button
              key={a.id}
              className="row activityrow"
              aria-pressed={activity === a.id}
              onClick={() => setActivity(activity === a.id ? null : a.id)}
            >
              <span className="row__main">
                <span className="row__title">{a.label}</span>
                <span className="row__sub">{a.note}</span>
              </span>
              <span className="activityrow__mark" aria-hidden>
                {activity === a.id ? "✓" : ""}
              </span>
            </button>
          ))}
        </div>

        {estimate !== null && (
          <p className="rangenote" style={{ marginTop: "var(--s4)" }}>
            That works out to about <strong>{Math.round(estimate).toLocaleString()} kcal</strong> a
            day
            {view?.estimated_resting != null && (
              <> — {Math.round(view.estimated_resting).toLocaleString()} kcal at rest, times the
              activity multiplier</>
            )}
            . It uses the Mifflin–St Jeor equation, which predicts resting expenditure to roughly
            ±10% at best, and an activity factor that is a round number standing in for something
            that genuinely varies day to day. Treat it as a starting point, not a measurement of you.
          </p>
        )}
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Your own energy target</h2>
          <span className="card__note">optional</span>
        </div>
        <p className="rangenote">
          If you have been given a figure, or you have one you trust, put it here and it wins over
          the estimate above. Leave it blank to use the estimate.
        </p>
        <div className="formgrid" style={{ marginTop: "var(--s4)" }}>
          <label>
            <span className="group__name">Energy (kcal a day)</span>
            <input
              className="field tnum"
              inputMode="numeric"
              placeholder={estimate !== null ? String(Math.round(estimate)) : "2000"}
              value={energyKcal}
              onChange={(e) => setEnergyKcal(e.target.value)}
            />
          </label>
        </div>
      </section>

      <div className="commit">
        <button className="btn btn--quiet" onClick={p.onBack}>Back</button>
        <button className="btn" style={{ marginLeft: "auto" }} onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>

      <p className="rangenote" style={{ textAlign: "center" }}>
        Everything here stays on this device, in the same file as your food log.
      </p>
    </div>
  );
}
