import type { DayView, EnergyTarget, MacroRange, NutrientTotal, TargetBasis } from "../types";
import { BASIS_NOTE } from "../types";
import { fmtAmount, read, unassessable } from "../lib/nutrient";
import { LIMITED_DATA, basisNote, groupBy } from "../screens/Nutrients";
import Info from "./Info";
import NutrientRow from "./NutrientRow";
import Sheet from "./Sheet";

/**
 * Every nutrient in one day, opened from the day's energy line on Today.
 *
 * It replaces three things Today used to print on its surface: a switch to a
 * second screen holding this same list, a card saying how much of the day
 * could be measured, and the day's energy and macronutrients set against
 * their reference figures. All three were readings of one day, and together
 * they put the day's log below the fold. They are one tap away now, in one
 * place, and nothing in them was dropped: the coverage heads the sheet, and
 * the reference figures sit beside the amounts they are for, named.
 *
 * Named, and never as a verdict. Nothing here is coloured as over and nothing
 * as outside a range, because this is ONE day: a day's sodium past its Daily
 * Value or its carbohydrate under a range is a noisy sample, not a finding.
 * Trends is where a period can say something about a limit.
 *
 * The grouping and the notes are the Nutrients screen's own (`groupBy`,
 * `basisNote`, `LIMITED_DATA`), so the sheet and the desktop's screen are the
 * same list, read the same way.
 */
export default function DaySheet(p: {
  day: DayView | null;
  label: string;
  open: boolean;
  onClose: () => void;
  onOpenProfile: () => void;
}) {
  const totals = p.day?.totals ?? [];
  const energy = p.day?.energy_target ?? null;
  const ranges = p.day?.macro_ranges ?? [];
  const covered = totals.filter((t) => read(t).state === "measured").length;
  const unknown = unassessable(totals).length;
  const core = groupBy(totals.filter((t) => t.tier === "core"));
  const extended = totals.filter((t) => t.tier === "extended");
  const bases = [...new Set(totals.map((t) => t.target_basis))].filter(
    (b): b is Exclude<TargetBasis, "user_set"> => b !== null && b !== "user_set",
  );

  return (
    <Sheet open={p.open} onClose={p.onClose} title={`Nutrients · ${p.label}`}>
      <div className="daysheet">
        <div className="daysheet__cover">
          <span className="tnum">{covered} of {totals.length} measured</span>
          <Info title="How the day's nutrients are read">
            <p>
              {covered} of the {totals.length} nutrients this app tracks had data in this day's
              items.
              {unknown > 0 && (
                <> The other {unknown} are not zero — nothing logged that day carried a figure
                  for them.</>
              )}
            </p>
            <p>
              “≥” means part of what was eaten had no figure for that nutrient, so the amount is at
              least this much. “—” means no data, not zero.
            </p>
            <p>{basisNote(totals)}</p>
            {bases.map((b) => <p key={b}>{BASIS_NOTE[b]}</p>)}
            <p>
              A single day is never marked as over or under any of these. Whether a figure has run
              high or low is a question about weeks, and Trends is where it is asked.
            </p>
          </Info>
        </div>

        {energy === null && (
          <p className="daysheet__note">
            No energy figure to read the day against yet.{" "}
            <button className="link" onClick={p.onOpenProfile}>Tell the app about you</button>{" "}
            and it can estimate one.
          </p>
        )}

        {core.map(([group, rows]) => (
          <div className="group" key={group}>
            {/* "Energy" over a single row called Energy is the heading saying
                its one line twice. */}
            {!(rows.length === 1 && rows[0].name === group) && <div className="group__name">{group}</div>}
            <div className="rows">
              {rows.map((t) => (
                <NutrientRow key={t.id} t={t} verdict={false}
                  reference={referenceFor(t, energy)} aside={rangeFor(t, ranges)} />
              ))}
            </div>
          </div>
        ))}

        {extended.length > 0 && (
          <div className="tier">
            <h3>
              Limited data
              <Info title="Why these are mostly blank">
                <p>{LIMITED_DATA}</p>
              </Info>
            </h3>
            <div className="rows">
              {extended.map((t) => (
                <NutrientRow key={t.id} t={t} verdict={false} reference={referenceFor(t, energy)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/**
 * The figure a nutrient is read against, with the name of the system it comes
 * from — never "your target", which turned a published figure the user never
 * set into a commitment, and never a bare number with no name at all.
 *
 * Energy reads the day's own figure — the one set in About you, or estimated
 * from it — rather than the generic one the panel would otherwise carry.
 */
function referenceFor(t: NutrientTotal, energy: EnergyTarget | null): string | null {
  if (t.id === ENERGY && energy !== null) {
    const kcal = Math.round(energy.kcal).toLocaleString();
    return energy.basis === "estimated" ? `estimated need ${kcal} kcal` : `set by you ${kcal} kcal`;
  }
  if (t.target === null || t.target_basis === null) return null;
  const amount = fmtAmount(t.target, t.magnitude);
  const limit = t.is_limit ? ", a limit" : "";
  switch (t.target_basis) {
    case "rda": return `RDA ${amount}${limit}`;
    case "ai": return `adequate intake ${amount}${limit}`;
    case "daily_value": return `Daily Value ${amount}${limit}`;
    case "user_set": return `set by you ${amount}${limit}`;
  }
}

/**
 * A macronutrient's acceptable share of energy, as grams for this person and
 * as the share it is. A range and not a point: there is no single right
 * amount of fat, and the midpoint of 20–35% is not a figure to reach.
 */
function rangeFor(t: NutrientTotal, ranges: MacroRange[]): string | null {
  const r = ranges.find((m) => m.nutrient_id === t.id);
  if (!r) return null;
  return `acceptable range ${Math.round(r.low_g)}–${Math.round(r.high_g)} g (${r.low_pct}–${r.high_pct}% of energy)`;
}

const ENERGY = 1008;
