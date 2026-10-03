/*
  A pack that counts its serving — "2 figs (57 g)", "2 biscuits (20 g)" — can be
  logged by the piece. These are the words a count is said in, one set of them
  for every screen that says one, following the same rules as `pieces_label`
  and `plural_noun` in src-tauri/src/store.rs, which write the repeat list's
  labels for the home-screen widget.
*/

/**
 * A piece's name made plural by the plain English rules, on its last word:
 * "fig" → "figs", "candy" → "candies", "glass" → "glasses", "fig bar" →
 * "fig bars". Irregular nouns are rare among what a pack counts, and the
 * editor shows the plural as it is typed, so a wrong one is seen.
 */
export function pluralNoun(noun: string): string {
  const n = noun.trim();
  const lower = n.toLowerCase();
  if (lower.length > 1 && lower.endsWith("y") && !"aeiou".includes(lower[lower.length - 2])) {
    return `${n.slice(0, -1)}ies`;
  }
  if (["s", "x", "z", "ch", "sh"].some((e) => lower.endsWith(e))) return `${n}es`;
  return `${n}s`;
}

/** The name for so many of them: "fig" for one, "figs" for any other count. */
export function nounFor(count: number, noun: string): string {
  return count === 1 ? noun.trim() : pluralNoun(noun);
}

/** So many pieces, as a person says them: "1 fig", "3 figs", "1.5 biscuits". */
export function pieceText(count: number, noun: string): string {
  const said = Number.isInteger(count) ? String(count) : String(Math.round(count * 100) / 100);
  return `${said} ${nounFor(count, noun)}`;
}
