import type { EntryBreakdown, LogEntry, Origin } from "../types";
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
 */
export function portionText(e: LogEntry, b: EntryBreakdown | undefined, servings = false): string {
  const q = quantityText(e);
  if (!b?.recipe_yield_g || e.grams === null) return q;
  const of = e.source_kind === "cook" ? "pot" : "batch";
  const count = servings && b.recipe_servings !== null ? ` (${b.recipe_servings} servings)` : "";
  return `${q} of a ${Math.round(b.recipe_yield_g).toLocaleString()} g ${of}${count}`;
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
 * How a water entry's amount was arrived at, when it was not off the scale.
 * The bottle's own note, and only that one: a weighed bottle's note is empty,
 * and a corrected one's is null.
 */
export function waterNote(e: LogEntry): string | null {
  return e.tare_note === WHOLE_BOTTLE_NOTE ? WHOLE_BOTTLE_NOTE : null;
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
 * The quiet second line of an entry's row: how much, then what is missing,
 * then what it was weighed in, then where it came from. In that order because
 * a narrow phone cuts the line from the end, and a gap in the data matters
 * more than a cuisine.
 */
export function rowSub(e: LogEntry, b: EntryBreakdown | undefined): string {
  return [portionText(e, b), gapText(e, b), waterNote(e), vesselText(e), tagText(e)]
    .filter((s) => s !== null && s !== "")
    .join(" · ");
}
