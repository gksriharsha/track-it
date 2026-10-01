import { useMemo } from "react";
import { fmtAmount, plural } from "../lib/nutrient";

/**
 * Below this many logged days a spread is not a spread — it is a handful of
 * points, and drawing a band through them would claim a pattern that is not
 * there yet. The screen says how many are missing instead.
 */
const ENOUGH_FOR_SPREAD = 5;

/**
 * One measure, as a distribution rather than a figure.
 *
 * The band is the middle half of the logged days and the marks are the days
 * themselves, so the width of the thing is the answer: a narrow band means you
 * eat about the same every day, a wide one means you do not. A single average
 * hides exactly that, and a line chart over dates invites reading a trend into
 * what is mostly noise.
 */
export default function Spread(props: {
  label: string;
  values: number[];
  /**
   * What each value is one of. Days for food, weeks for activity — a walk
   * happens on some days and not others, and the honest unit is the week (D26).
   */
  per?: "day" | "week";
  /** Draws the band and the middle mark in the activity colour. */
  tone?: "act";
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
  const per = props.per ?? "day";
  const block = props.tone === "act" ? "stats__block stats__block--act" : "stats__block";
  const write = props.format ?? ((v: number) => fmtAmount(v, unit));
  const s = useMemo(() => summarise(values), [values]);

  if (s === null) {
    return (
      <section className={block}>
        <h2 className="stats__h">{label}</h2>
        <p className="stats__note">
          {values.length === 0
            ? `Nothing measured this in the ${per}s you logged.`
            : `${plural(values.length, per)} measured this. ` +
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
    <section className={block}>
      <h2 className="stats__h">{label}</h2>

      <p className="stats__figure">
        {/* `fmtAmount` already carries the unit — naming it again beside the
            figure printed "2,000 kcal kcal". */}
        <span className="stats__n num">{write(s.median)}</span>
        <span className="stats__when">{per === "day" ? "on a middle day" : "in a middle week"}</span>
      </p>

      <div className="spread" role="img"
        aria-label={
          `${label}: middle ${per} ${write(s.median)}, ` +
          `half of ${per}s between ${write(s.q1)} and ${write(s.q3)}, ` +
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
        Half your {per}s fell between{" "}
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
