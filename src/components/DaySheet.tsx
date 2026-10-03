import type { DayView, TargetBasis } from "../types";
import { BASIS_NOTE } from "../types";
import { read, unassessable } from "../lib/nutrient";
import { rangeFor, rangeShares, referenceFor, sharedCoverage } from "../lib/reference";
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
 * The grouping, the notes and the words for each reference are the Nutrients
 * screen's own (`groupBy`, `basisNote`, `LIMITED_DATA`, `lib/reference.ts`),
 * so the sheet and the desktop's screen are the same list, read the same way.
 *
 * What most rows share is said once, at the head. When one pack with nothing
 * on it is a twentieth of the day's food, every nutrient the rest of the food
 * measured is "95% measured" — the same fact eighteen times down the sheet.
 * The head says it, and a row says its own only where it differs.
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
  const shared = sharedCoverage(totals, (t) => read(t).state === "measured");
  const saidAbove = shared === null ? null : `${shared}% measured`;
  const shares = rangeShares(ranges);

  return (
    <Sheet open={p.open} onClose={p.onClose} title={`Nutrients for ${p.label === "Today" || p.label === "Yesterday" ? p.label.toLowerCase() : p.label}`}>
      <div className="daysheet">
        <div className="daysheet__cover">
          <span className="tnum">
            {covered} of {totals.length} measured
            {shared !== null && <>, {shared}% of the food by weight</>}
          </span>
          <Info title="How the day's nutrients are read">
            <p>
              {covered} of the {totals.length} nutrients this app tracks had data in this day's
              items.
              {unknown > 0 && (
                <> The other {unknown} are not zero — nothing logged that day carried a figure
                  for them.</>
              )}
            </p>
            {shared !== null && (
              <p>
                Most of the figures are read over {shared}% of the day's food, by weight: the rest
                of it had no figure for them. That is said once, at the top, rather than on every
                row; a row read over a different share says its own.
              </p>
            )}
            <p>
              A figure reads “≥” — at least this much — when less than four-fifths of what was
              eaten, by weight, had a figure for that nutrient, or when a supplement does not list
              it. Above that it reads as a figure. “—” means no data, not zero.
            </p>
            <p>{basisNote(totals)}</p>
            {bases.map((b) => <p key={b}>{BASIS_NOTE[b]}</p>)}
            {shares && (
              <p>
                The acceptable ranges beside protein, carbohydrate and fat are the shares of
                energy the DRIs give — {shares} — worked out in grams at the energy figure the day
                is read against.
              </p>
            )}
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
                <NutrientRow key={t.id} t={t} verdict={false} saidAbove={saidAbove}
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
                <NutrientRow key={t.id} t={t} verdict={false} saidAbove={saidAbove}
                  reference={referenceFor(t, energy)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
