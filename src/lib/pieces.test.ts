/**
 * The words a count of pieces is said in. Runs in a bare Node process, like
 * the other tests here:
 *
 *     node src/lib/pieces.test.ts
 *
 * What it guards: a count reads the way a person says it, and the same way the
 * Rust side writes it for the home-screen widget (`pieces_label`), so a repeat
 * chip and the entry it writes cannot say one food two ways.
 */
import { nounFor, pieceText, pluralNoun } from "./pieces.ts";

let failed = 0;
let held = 0;
function is(claim: string, got: unknown, want: unknown): void {
  if (got === want) {
    held += 1;
    console.log(`  ok   ${claim}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${claim}\n         got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

is("one is said in the singular", pieceText(1, "fig"), "1 fig");
is("any other whole count in the plural", pieceText(3, "fig"), "3 figs");
is("a half is a count like any other", pieceText(1.5, "biscuit"), "1.5 biscuits");
is("a count keeps two decimals at most", pieceText(1 / 3, "slice"), "0.33 slices");
is("a consonant and a y take -ies", pluralNoun("candy"), "candies");
is("a vowel and a y keep the y", pluralNoun("day"), "days");
is("s, x, z, ch and sh take -es", [pluralNoun("glass"), pluralNoun("box"), pluralNoun("sandwich"), pluralNoun("dish")].join(" "),
  "glasses boxes sandwiches dishes");
is("the last word is the one counted", pluralNoun("fig bar"), "fig bars");
is("a name is trimmed of what was typed around it", nounFor(1, "  fig "), "fig");
is("and so is its plural", nounFor(2, " fig "), "figs");
is("a capital stays where it was typed", pluralNoun("Oreo"), "Oreos");

console.log(failed === 0 ? `\nall ${held} claims held` : `\n${failed} of ${held + failed} claims FAILED`);
if (failed > 0) throw new Error(`${failed} claim(s) failed`);
