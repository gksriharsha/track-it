import type { EntryBreakdown, LogEntry, Origin, SnapshotBasis } from "../types";
import { ORIGIN_LABEL, WHOLE_BOTTLE_NOTE, describeVolume } from "../types";

/*
  The words a logged entry is described in, shared by its row on Today and by
  the sheet it opens. One set of them, so the row and the sheet cannot say the
  same entry two ways.
*/

/**
 * How much of it, in the unit the thing is actually measured in.
 *
 * A supplement has no mass this app knows, so it is never given one — "0 g" on
 * a tablet is the same class of lie as a nutrient rendered as 0.
 */
export function quantityText(e: LogEntry): string {
  if (e.source_kind === "supplement") {
    const n = e.units ?? 0;
    const rounded = Math.round(n * 100) / 100;
    return `${rounded} ${rounded === 1 ? "dose" : "doses"}`;
  }
  // Water is drunk by volume and weighed by mass. The scale gave grams; the
  // bottle says what that comes to, and that is the number to show — nobody
  // thinks about their day in grams of water.
  if (e.water) return describeVolume(e.water.ml);
  return e.grams === null ? "weight not recorded" : `${Math.round(e.grams)} g`;
}

/**
 * The portion and what it was a portion of: "210 g of a 1,680 g pot".
 *
 * The yield is what makes a portion legible — it is the number the breakdown
 * was divided by. A pot's is what it weighed, or what its recipe says it comes
 * out at; a recipe's is what it makes as written. The servings count is a
 * separate, optional clause, for the sheet only: a recipe need not carry one,
 * and requiring it would have dropped the whole phrase from every entry logged
 * without.
 *
 * A pot's size is printed on its row only when it is known which of the two
 * it was (see `potNote`, which says when it was the estimate). For an older
 * portion where that was never recorded, the row gives the portion alone —
 * "of a 1,680 g pot" would claim a weighing — and the sheet, which has room
 * for the clause, gives the size with the doubt beside it.
 */
export function portionText(e: LogEntry, b: EntryBreakdown | undefined, sheet = false): string {
  const q = quantityText(e);
  if (!b?.recipe_yield_g || e.grams === null) return q;
  const pot = e.source_kind === "cook";
  const size = Math.round(b.recipe_yield_g).toLocaleString();
  if (pot && b.recipe_yield_weighed === null && !sheet) return q;
  // The sheet has room to say what the figure is, rather than print it as a
  // weighing and take it back two words later ("of a 1,140 g pot, pot not
  // weighed").
  if (pot && b.recipe_yield_weighed === false && sheet) {
    return `${q} of a pot expected to come to ${size} g, which was never weighed`;
  }
  const count = sheet && b.recipe_servings !== null ? ` (${b.recipe_servings} servings)` : "";
  return `${q} of a ${size} g ${pot ? "pot" : "batch"}${count}`;
}

/**
 * Whether the pot a portion was divided by was weighed, on the row — said
 * only when it was not, or (on the sheet) when nobody recorded which. A
 * portion of a pot that never went on the scale was divided by its recipe's
 * estimate, and every figure in it leans on that estimate, so it is a state of
 * the entry and sits on its line. The sheet says the first in `portionText`.
 */
export function potNote(e: LogEntry, b: EntryBreakdown | undefined, sheet = false): string | null {
  if (e.source_kind !== "cook" || !b?.recipe_yield_g || e.grams === null) return null;
  if (b.recipe_yield_weighed === false && !sheet) return "pot not weighed";
  if (b.recipe_yield_weighed === null && sheet) return "whether the pot was weighed was not recorded";
  return null;
}

/**
 * What is not known about it, as a marker, or null when nothing is missing.
 *
 * In the words of where the gap is: a pack with nothing transcribed off it, a
 * panel that does not list something, or an ingredient with no data. Never a
 * count — "0 ingredients" sat on seven of twelve rows and said nothing.
 */
export function gapText(e: LogEntry, b: EntryBreakdown | undefined): string | null {
  if (!(b?.components ?? []).some((c) => !c.has_data)) return null;
  if (e.source_kind === "custom") return "nothing off the pack";
  if (e.source_kind === "supplement") return "nothing off the panel";
  return "some unmeasured";
}

/**
 * How an entry's values came to be, as a marker, when it was not simply as it
 * was logged. "Corrected" is the user's own change, dated on the sheet;
 * "filled in later" is an entry logged before values were frozen, valued
 * afterwards from the best data then available rather than the data of the
 * day it was eaten. Both are facts about the figure on the right of the row.
 */
export function basisMarker(b: EntryBreakdown | undefined): string | null {
  if (b?.basis === "corrected") return "corrected";
  if (b?.basis === "backfilled") return "filled in later";
  return null;
}

/**
 * The same, as the sentence the entry's sheet and its correction form print.
 * Dated, because when a value was fixed is half of what makes a correction a
 * correction rather than an edit nobody can see.
 */
export function provenanceText(s: { basis: SnapshotBasis; frozen_at: string; corrected_at: string | null }): string {
  const when = (iso: string) => iso.slice(0, 10);
  if (s.basis === "corrected") {
    return `You corrected this on ${when(s.corrected_at ?? s.frozen_at)}. It was first recorded on ${when(s.frozen_at)}.`;
  }
  if (s.basis === "backfilled") {
    return `Filled in on ${when(s.frozen_at)}, after this entry was logged. What it was worth at the time was never recorded, so these are the best figures available rather than the original ones.`;
  }
  return `Recorded on ${when(s.frozen_at)}, when you logged it. Changing the food since then has not moved these.`;
}

/**
 * How a water entry's amount was arrived at, when it was not off the scale.
 * The bottle's own note, and only that one: a weighed bottle's note is empty,
 * and a corrected one's is null.
 */
export function waterNote(e: LogEntry): string | null {
  return e.tare_note === WHOLE_BOTTLE_NOTE ? WHOLE_BOTTLE_NOTE : null;
}

/**
 * For the sheet: a volume read at the density of water, from a bottle never
 * weighed empty, rather than off the bottle's own scale. Right to about two
 * parts in a thousand — finer than the row's figure is printed to, which is
 * why the row does not carry it — but it is a conversion and not a reading,
 * and the sheet is where the amount is spelled out.
 */
export function densityNote(e: LogEntry): string | null {
  return e.water?.kind === "assumed" ? "at the density of water" : null;
}

/**
 * What it was weighed in, for food: the vessel names, joined, as they were
 * when it was logged. Water keeps its own note (above), and an entry put
 * straight on the scale has none.
 */
export function vesselText(e: LogEntry): string | null {
  if (e.source_kind === "water" || e.gross_g === null) return null;
  return e.tare_note && e.tare_note.trim() !== "" ? e.tare_note : null;
}

/** The tags, when the user has given them. Silence stays silent. */
export function tagText(
  e: { origin: Origin | null; cuisine: string | null },
  join = ", ",
  lower = true,
): string {
  const origin = e.origin ? ORIGIN_LABEL[e.origin] : null;
  const bits = [origin && lower ? origin.toLowerCase() : origin, e.cuisine].filter(Boolean);
  return bits.join(join);
}

/**
 * The quiet second line of an entry's row: how much, then what the figure
 * leans on or lacks, then what it was weighed in. In that order because a
 * narrow phone cuts the line from the end, and a gap in the data — an
 * unweighed pot, an unmeasured line, a corrected value — is what must survive.
 *
 * Where it came from (home, ordered in, the cuisine) is not on the row. It is
 * a fact about the meal, not about the figure beside it; it sits on its own
 * line in the entry's sheet, with Change; and on a phone it was the part that
 * pushed "some unmeasured" off the end of the line.
 */
export function rowSub(e: LogEntry, b: EntryBreakdown | undefined): string {
  return [portionText(e, b), potNote(e, b), gapText(e, b), basisMarker(b), waterNote(e), vesselText(e)]
    .filter((s) => s !== null && s !== "")
    .join(" · ");
}
