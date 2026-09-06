import type { NutrientTotal } from "../types";
import { read } from "../lib/nutrient";
import { BASIS_LABEL } from "../types";

/**
 * One nutrient line. Shared by the day dashboard and the full panel so the
 * three-state rendering can never drift between them.
 */
export default function NutrientRow({ t }: { t: NutrientTotal }) {
  const r = read(t);
  const stateClass =
    r.state === "measured" ? (r.over ? "is-over" : "") : `is-${r.state}`;

  return (
    <div className={`row nrow ${stateClass}`}>
      <span className="row__main">
        <span className="row__title" title={t.full_name}>
          {t.name}
        </span>
        {r.note && <span className="row__sub">{r.note}</span>}
        {/*
          Which system the percentage is against. A shortfall against an
          Adequate Intake and a shortfall against an RDA are different findings,
          and a bare "62%" cannot tell them apart. Shown only where it is not
          the app-wide default, so the panel does not repeat "Daily Value"
          forty-seven times.
        */}
        {r.basis && r.basis !== "daily_value" && r.pct !== null && (
          <span className="nrow__basis">of {BASIS_LABEL[r.basis]}</span>
        )}
        {/*
          What came out of a bottle, said separately from what came off a plate.
          Not decoration: the upper limits for supplemental magnesium, folic
          acid, added niacin and vitamin E are stated over exactly this
          quantity and cannot be evaluated against the day's total, so the two
          have to stay distinguishable on screen as well as in the data.
        */}
        {r.fromSupplement && (
          <span className="nrow__sup">{r.fromSupplement} of it from a supplement</span>
        )}
      </span>

      {r.showTrack && r.pct !== null ? (
        <span className="track">
          <span
            className={`track__fill${r.over ? " track__fill--over" : ""}`}
            style={{ width: `${Math.min(r.pct, 100)}%` }}
          />
        </span>
      ) : (
        /* Deliberately invisible, not a zero-width bar: an empty track reads
           as "0% of target", which is precisely the lie to avoid. */
        <span className="track track--none" aria-hidden />
      )}

      <span className="nval">
        <span className="nval__amt tnum">{r.amount}</span>
        <span className="nval__pct tnum">{r.pct !== null ? `${Math.round(r.pct)}%` : ""}</span>
      </span>
    </div>
  );
}
