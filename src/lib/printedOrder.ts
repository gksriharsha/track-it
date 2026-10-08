/**
 * Nutrient lines in the order the pack prints them.
 *
 * Checking a form against a pack is reading down both at once, so the form
 * follows the pack: what a photo read comes first, in the order it was read off
 * the panel, and every other line keeps the place it already had, after them.
 * An Indian pack printing energy, protein, carbohydrate, sugars, fat reads in
 * that order rather than being re-sorted into the US one.
 *
 * Stable, so lines the order says nothing about never trade places, and pure:
 * the order is decided when a food loads or a photo is read, never as a line is
 * typed into, so nothing moves under the finger.
 */
export function inPrintedOrder<T>(
  items: readonly T[],
  idOf: (item: T) => number,
  order: readonly number[] | null | undefined,
): T[] {
  if (!order || order.length === 0) return [...items];
  const rank = new Map<number, number>();
  order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  return items
    .map((item, i) => ({ item, i, r: rank.get(idOf(item)) }))
    .sort((a, b) => {
      if (a.r !== undefined && b.r !== undefined) return a.r - b.r;
      if (a.r !== undefined) return -1;
      if (b.r !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.item);
}
