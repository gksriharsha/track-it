import type { NutrientTotal } from "../types";
import { fmtAmount, read } from "../lib/nutrient";
import { BASIS_LABEL } from "../types";

/**
 * One nutrient line. Shared by the day's sheet, the full panel and Days so the
 * three-state rendering can never drift between them.
 */
export default function NutrientRow({
  t, reference, aside, verdict = true,
}: {
  t: NutrientTotal;
  /**
   * The figure this line is read against, already named — "RDA 18 mg",
   * "set by you 2,240 kcal". Left out, the line prints the bare figure (and
   * "limit" before a ceiling's), as the full panel always has.
   */
  reference?: string | null;
  /** A second reference that is not a single figure — a macronutrient's range. */
  aside?: string | null;
  /**
   * Whether a ceiling that has been passed is drawn as passed. False on the
   * day's sheet: one day over a limit is not a finding, and the sheet reads a
   * single day. A period is where a ceiling means something.
   */
  verdict?: boolean;
}) {
  const r = read(t);
  const stateClass =
    r.state === "measured" ? (r.over && verdict ? "is-over" : "") : `is-${r.state}`;
  // A reference that names its own system has no need of the line under the
  // name saying which system it is.
  const named = reference !== undefined;

  return (
    <div className={`row nrow ${stateClass}`}>
      <span className="row__main">
        <span className="row__title" title={t.full_name}>
          {t.name}
        </span>
        {r.note && <span className="row__sub">{r.note}</span>}
        {aside && <span className="row__sub tnum">{aside}</span>}
        {/*
          Which system the percentage is against. A shortfall against an
          Adequate Intake and a shortfall against an RDA are different findings,
          and a bare "62%" cannot tell them apart. Shown only where it is not
          the app-wide default, so the panel does not repeat "Daily Value"
          forty-seven times.
        */}
        {!named && r.basis && r.basis !== "daily_value" && r.pct !== null && (
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

      {/*
        The amount, and what it can be read against — not a bar and not a
        percentage.

        Both of those were scores. A bar fills toward a target and a percentage
        is one number to push to 100, and there were forty-seven of them: a
        surface of gaps to close, refreshed every day. The pair says the same
        thing without proposing that anything be optimised — 412 mg beside an
        RDA of 1,000 mg is a fact a person can read, and no arrangement of it
        counts as a win.
      */}
      <span className="nval">
        <span className="nval__amt tnum">{r.amount}</span>
        {named ? (
          reference && <span className="nval__ref tnum">{reference}</span>
        ) : (
          t.target !== null && (
            <span className="nval__ref tnum">
              {t.is_limit ? "limit " : ""}
              {fmtAmount(t.target, t.magnitude)}
            </span>
          )
        )}
      </span>
    </div>
  );
}
