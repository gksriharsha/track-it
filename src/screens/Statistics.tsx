import { useCallback, useEffect, useMemo, useState } from "react";
import { getRange, humanDate, shiftIso, todayIso } from "../api";
import type { NutrientTotal, RangeView, TagBreakdown, TargetBasis } from "../types";
import { BASIS_LABEL, describeVolume } from "../types";
import { fmtAmount, perDay, plural, read } from "../lib/nutrient";
import ScreenHead from "../components/ScreenHead";

interface Props {
  onBack?: () => void;
}

/** How far back to look. Kept short — three answers, not a date picker. */
const SPANS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

/**
 * Below this many logged days a spread is not a spread — it is a handful of
 * points, and drawing a band through them would claim a pattern that is not
 * there yet. The screen says how many are missing instead.
 */
const ENOUGH_FOR_SPREAD = 5;

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
        sub="how the last few weeks have gone"
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
          <button className="btn" onClick={() => { window.location.hash = "/foods?from=statistics"; }}>
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
    </div>
  );
}

/**
 * One measure, as a distribution rather than a figure.
 *
 * The band is the middle half of the logged days and the marks are the days
 * themselves, so the width of the thing is the answer: a narrow band means you
 * eat about the same every day, a wide one means you do not. A single average
 * hides exactly that, and a line chart over dates invites reading a trend into
 * what is mostly noise.
 */
function Spread(props: {
  label: string;
  values: number[];
  unit: string;
  reference: { value: number; label: string } | null;
  /**
   * How to write one of these figures, when a mass with a unit is not it.
   * Water is measured in grams and drunk in litres, and "1533 g" is not a
   * sentence anybody says about their day.
   */
  format?: (v: number) => string;
}) {
  const { label, values, unit, reference } = props;
  const write = props.format ?? ((v: number) => fmtAmount(v, unit));
  const s = useMemo(() => summarise(values), [values]);

  if (s === null) {
    return (
      <section className="stats__block">
        <h2 className="stats__h">{label}</h2>
        <p className="stats__note">
          {values.length === 0
            ? "Nothing measured this in the days you logged."
            : `${values.length} ${plural(values.length, "day")} measured this. ` +
              `${ENOUGH_FOR_SPREAD} would be enough to show how much it varies.`}
        </p>
      </section>
    );
  }

  // The axis is set by the DAYS, then widened to admit the reference only as
  // far as it can without squashing them. A target of 2,240 beside days from
  // 1,500 to 2,400 belongs on the same scale; one that sits nowhere near the
  // data would otherwise crush every mark into a smear at one end and destroy
  // the only thing the strip is for. Past that limit the mark is pinned to the
  // edge, which reads as "off this scale" rather than as a value.
  const span = s.max - s.min || 1;
  const lo = Math.max(s.min - span * 1.5, Math.min(s.min, reference?.value ?? s.min));
  const hi = Math.min(s.max + span * 1.5, Math.max(s.max, reference?.value ?? s.max));
  const pad = (hi - lo) * 0.08 || 1;
  const at = (v: number) =>
    Math.max(0, Math.min(100, ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * 100));

  return (
    <section className="stats__block">
      <h2 className="stats__h">{label}</h2>

      <p className="stats__figure">
        {/* `fmtAmount` already carries the unit — naming it again beside the
            figure printed "2,000 kcal kcal". */}
        <span className="stats__n num">{write(s.median)}</span>
        <span className="stats__when">on a middle day</span>
      </p>

      <div className="spread" role="img"
        aria-label={
          `${label}: middle day ${write(s.median)}, ` +
          `half of days between ${write(s.q1)} and ${write(s.q3)}, ` +
          `lowest ${write(s.min)}, highest ${write(s.max)}` +
          (reference ? `, ${reference.label} ${write(reference.value)}` : "")
        }
      >
        <div className="spread__axis" />
        <div
          className="spread__band"
          style={{ left: `${at(s.q1)}%`, width: `${at(s.q3) - at(s.q1)}%` }}
        />
        {values.map((v, i) => (
          <i className="spread__day" key={i} style={{ left: `${at(v)}%` }} />
        ))}
        <div className="spread__mid" style={{ left: `${at(s.median)}%` }} />
        {reference && (() => {
          // Past the midpoint the label has to sit on the other side of its own
          // hairline or it runs off the edge. Decided here, from the number,
          // rather than by matching on the serialised style string — "left: 5"
          // is a prefix of "left: 5.1%" as much as of "left: 51%", so the CSS
          // version flipped labels that were nowhere near the right-hand side.
          const x = at(reference.value)
          return (
            <div
              className={x > 55 ? "spread__ref spread__ref--flip" : "spread__ref"}
              style={{ left: `${x}%` }}
            >
              <span className="spread__reflabel">{reference.label}</span>
            </div>
          )
        })()}
      </div>

      <p className="stats__read">
        Half your days fell between{" "}
        <b className="num">{write(s.q1)}</b> and{" "}
        <b className="num">{write(s.q3)}</b>.
        {reference && (
          /* Capitalised as a sentence, not by matching a word. This read
             `.replace(/^y/, "Y")`, written when the label was "your target";
             once the label became "for reference" the hack matched nothing and
             the screen printed "…2,176 kcal. for reference is 2,240 kcal." */
          <> {sentence(reference.label)} is <b className="num">{write(reference.value)}</b>.</>
        )}
      </p>
    </section>
  );
}

/** A label that has to start a sentence, given its capital. */
function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

/**
 * The five figures the strip is drawn from.
 *
 * Quartiles by the median-of-halves method, which is stable on the small
 * samples a few weeks of logging produce. Returns null below the point where a
 * band would be describing noise rather than a habit.
 */
function summarise(values: number[]) {
  if (values.length < ENOUGH_FOR_SPREAD) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = (xs: number[]) => {
    const h = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[h] : (xs[h - 1] + xs[h]) / 2;
  };
  const h = Math.floor(v.length / 2);
  return {
    min: v[0],
    max: v[v.length - 1],
    median: mid(v),
    q1: mid(v.slice(0, h)),
    q3: mid(v.slice(v.length % 2 ? h + 1 : h)),
  };
}
