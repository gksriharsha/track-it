import { useCallback, useEffect, useMemo, useState } from "react";
import { getRange, humanDate, shiftIso, todayIso } from "../api";
import type { NutrientTotal, RangeView, TagBreakdown, TargetBasis } from "../types";
import { BASIS_LABEL, describeVolume } from "../types";
import { fmtAmount, perDay, plural, read } from "../lib/nutrient";
import ScreenHead from "../components/ScreenHead";
import Spread from "../components/Spread";
import ActivityTrends from "../components/ActivityTrends";

interface Props {
  onBack?: () => void;
  /** About you, from the activity section's comparison with its level. */
  onOpenProfile?: () => void;
  /** Add food, from the first-run invitation to log a few days. */
  onAddFood: () => void;
}

/** How far back to look. Kept short — three answers, not a date picker. */
const SPANS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

/** Nutrient 1008, energy. Named because two places need to agree about it. */
const ENERGY = 1008;

/**
 * How you have been eating, over weeks rather than today.
 *
 * The premise: one day tells you almost nothing. Intake is noisy — a festival,
 * a travel day, an ordinary Tuesday — and the trustworthy figure is where the
 * middle of that noise sits and how wide it is. So everything here is built on
 * spread rather than score: a middle day, the range most days fall in, and the
 * reference figure as a mark you can see yourself against.
 *
 * Deliberately not a scoreboard. No streak, no run of days, no badge, and no
 * percentage as the headline — this records what happened and leaves the
 * reading of it to the person who ate it.
 */
export default function Statistics(p: Props) {
  const [span, setSpan] = useState<number>(30);
  const [data, setData] = useState<RangeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const to = todayIso();
  const from = shiftIso(to, -(span - 1));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getRange(from, to));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const logged = data?.days_logged ?? 0;

  /** Days that had food, with the figure this strip plots. */
  const kcalDays = useMemo(
    () => (data?.days ?? []).filter((d) => d.food_items > 0 && d.kcal !== null).map((d) => d.kcal as number),
    [data],
  );
  const gramDays = useMemo(
    () => (data?.days ?? []).filter((d) => d.food_items > 0 && d.grams > 0).map((d) => d.grams),
    [data],
  );
  /*
    Days a bottle was actually logged on. A day with no bottle is filtered out
    rather than counted as zero: nobody drinks nothing, so a zero there would be
    a claim about the person instead of about the record.
  */
  const waterDays = useMemo(
    () => (data?.days ?? []).map((d) => d.water_ml).filter((ml): ml is number => ml !== null && ml > 0),
    [data],
  );

  const averages = useMemo(
    () => (data && logged > 0 ? data.totals.map((t) => perDay(t, logged)) : []),
    [data, logged],
  );

  const energyTarget = useMemo(
    () => averages.find((t) => t.id === ENERGY)?.target ?? null,
    [averages],
  );

  return (
    <div className="screen">
      <ScreenHead
        /* "Statistics" named the method; this names the question. Beside a
           row called "Days" in the same bar, a person could not tell which of
           the two held the last month — one sounded like a spreadsheet and the
           other like a list. */
        title="Trends"
        onBack={p.onBack}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      <div className="chips stats__spans">
        {SPANS.map((s) => (
          <button
            key={s.days}
            className="chip"
            aria-pressed={span === s.days}
            onClick={() => setSpan(s.days)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/*
        What the record actually covers, before anything is read off it. A
        companion is straight about this: every figure below describes the days
        that were logged, and saying which days those were is the difference
        between an average and a guess.
      */}
      {loading ? (
        <p className="stats__basis">Reading the period…</p>
      ) : logged === 0 ? (
        <div className="empty">
          <h3>Nothing to average yet</h3>
          <p>
            Log a few days and this fills in: how much you usually eat, how much that varies
            from day to day, and where your food has been coming from.
          </p>
          <button className="btn" onClick={p.onAddFood}>
            Add your first food
          </button>
        </div>
      ) : (
        <p className="stats__basis">
          You logged food on {logged} of the last {span} days, from {humanDate(from)}.
          Everything here describes those {logged}.
        </p>
      )}

      {logged > 0 && (
        <>
          <Spread
            label="Energy"
            values={kcalDays}
            unit="kcal"
            /*
              Named for what it is, not claimed as yours. A published estimate
              labelled "your target" turns a description of how you eat into a
              scatter around a goal — on the one screen in the app that was
              already doing what this redesign is for.
            */
            reference={energyTarget === null ? null : { value: energyTarget, label: "for reference" }}
          />

          <Spread
            label="Food weighed"
            values={gramDays}
            unit="g"
            reference={null}
          />

          {/*
            Water, in the unit it is drunk in.

            The log holds what came off the scale in grams; each bottle turns
            that into the volume its label puts it in. Counted only on days a
            bottle was logged — and kept apart from the nutrient called Water
            further down, which includes the water in food and is a different
            fact about a different thing.
          */}
          <Spread
            label="Water drunk"
            values={waterDays}
            unit="ml"
            reference={null}
            format={describeVolume}
          />

          <section className="stats__block">
            <h2 className="stats__h">A day on average</h2>
            <p className="stats__note">
              The period’s totals divided by the {plural(logged, "day")} you logged — not by
              all {span}, which would divide your intake by days you never recorded. Reference
              figures are printed beside each amount rather than as a score. Energy is above
              instead, where it can be shown as a spread.
            </p>
            <dl className="stats__list">
              {averages
                .filter((t) => t.tier === "core" && t.id !== ENERGY)
                .map((t) => <Average key={t.id} total={t} />)}
            </dl>
          </section>

          {data && (
            <section className="stats__block">
              <h2 className="stats__h">Where your food came from</h2>
              <Tags rows={data.origins} />
              <h3 className="stats__h3">What kind of food</h3>
              <Tags rows={data.cuisines} />
              <p className="stats__note">
                Counted by dish. Supplements are not dishes and are left out. “Not recorded” is
                shown rather than hidden — how much you have not said is part of the picture.
              </p>
            </section>
          )}
        </>
      )}

      {/* Outside the food gate: a period with no food logged in it can still
          have had walks in it, and the empty state above says nothing about
          them. Last, because this screen is about eating first (D26). */}
      {!loading && <ActivityTrends from={from} to={to} onOpenProfile={p.onOpenProfile} />}
    </div>
  );
}

/** One nutrient's daily average, with its reference figure beside it. */
function Average({ total }: { total: NutrientTotal }) {
  const r = read(total);
  return (
    <div className="stats__row">
      <dt className="stats__name">{total.name}</dt>
      <dd className={r.over ? "stats__amt stats__amt--over num" : "stats__amt num"}>{r.amount}</dd>
      <dd className="stats__ref">
        {total.target === null
          ? ""
          : `${total.is_limit ? "limit" : basisWord(r.basis)} ${fmtAmount(total.target, total.magnitude)}`}
      </dd>
    </div>
  );
}

/**
 * What a reference figure is, in the fewest words that stay true.
 *
 * An RDA and an Adequate Intake support very different conclusions from the
 * same shortfall, so they are never blurred into "target" — the same reason
 * the figure travels with its basis everywhere else in the app.
 *
 * Reads `BASIS_LABEL` rather than keeping its own list. The list it used to
 * keep had two cases — "user" and "dv" — that are not members of `TargetBasis`
 * at all, so a figure the user set themselves and an FDA Daily Value both fell
 * through to the word "reference": the one distinction this app exists to
 * preserve, quietly dropped on the screen that shows it most often.
 */
function basisWord(basis: TargetBasis | null): string {
  return basis === null ? "reference" : BASIS_LABEL[basis];
}

function Tags({ rows }: { rows: TagBreakdown[] }) {
  const total = rows.reduce((n, r) => n + r.entries, 0);
  if (total === 0) return <p className="stats__note">No dishes tagged in this period.</p>;
  return (
    <dl className="stats__list">
      {rows.map((r) => (
        <div className="stats__row" key={r.key ?? "untagged"}>
          <dt className="stats__name">{r.label ?? "Not recorded"}</dt>
          <dd className="stats__amt num">{r.entries}</dd>
          <dd className="stats__ref">
            {Math.round((r.entries / total) * 100)}% of dishes
          </dd>
        </div>
      ))}
    </dl>
  );
}
