/**
 * Setting an amount as a scale reads one. Runs in a bare Node process, like
 * the other tests here:
 *
 *     node src/lib/amount.test.ts
 *
 * What it guards: the keys write only numbers a scale shows, a starting
 * figure is typed over rather than added to, a bowl comes off the reading and
 * never leaves less than nothing, and a portion's energy is its hundred grams
 * scaled with the coverage left where it was.
 */
import { DOTS, KEYS, atGrams, digitsOf, netOf, pasted, press, readingOf, ticking, weighing } from "./amount.ts";
import type { Key, Readout } from "./amount.ts";
import type { DailyTotal, Vessel } from "../types.ts";

let failed = 0;
let held = 0;
function check(claim: string, ok: boolean, detail?: string): void {
  if (ok) {
    held += 1;
    console.log(`  ok   ${claim}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${claim}${detail ? `\n         ${detail}` : ""}`);
  }
}
const is = (claim: string, got: unknown, want: unknown) =>
  check(claim, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const typing = (r: Readout, keys: string) => [...keys].reduce((x, k) => press(x, (k === "<" ? "del" : k) as Key), r);
const typed = (digits: string): Readout => ({ digits, from: "typed" });
const guess: Readout = { digits: "270", from: "guess" };

is("keys add up to the reading", typing(typed(""), "474").digits, "474");
is("a guess is typed over, not added to", typing(guess, "18").digits, "18");
is("a serving is typed over too", typing({ digits: "185", from: "serving" }, "2").digits, "2");
is("delete on a guess clears it", typing(guess, "<").digits, "");
is("delete takes the last digit of a reading", typing(typed("474"), "<").digits, "47");
is("what is typed is a reading", typing(guess, "1").from, "typed");
is("no leading zeros", typing(typed(""), "05").digits, "5");
is("a point on nothing is a nought and a point", typing(typed(""), ".5").digits, "0.5");
is("one point only", typing(typed("12.5"), ".").digits, "12.5");
is("to a tenth of a gram, no finer", typing(typed(""), "12.55").digits, "12.5");
is("no further than 9999 g", typing(typed(""), "123456").digits, "1234");
const kept = ticking(typed("474"));
is("a reading typed before the bowl is ticked stays", kept.digits, "474");
is("and the next key starts a new reading", typing(kept, "2").digits, "2");
is("ticking a second vessel keeps it still", ticking(kept).digits, "474");
is("a guess is no reading for a bowl to come off", ticking(guess).digits, "");
is("nor is a serving", ticking({ digits: "185", from: "serving" }).digits, "");
is("nothing typed stays nothing", ticking(typed("")).from, "typed");
check("the keypad holds every digit, the point and delete once each",
  new Set(KEYS).size === 12 && KEYS.includes("del") && KEYS.includes("."));

is("a paste of grams", pasted(" 180 g "), "180");
is("a comma is a decimal point", pasted("12,5"), "12.5");
is("a paste is held to a tenth", pasted("12.55"), "12.5");
is("words are not an amount", pasted("about 180"), null);
is("nor is a paste longer than the window", pasted("12345"), null);

is("whole grams start whole", digitsOf(270), "270");
is("a tenth is kept", digitsOf(12.5), "12.5");
is("finer is rounded to a tenth", digitsOf(33.333), "33.3");

is("nothing typed reads nothing", readingOf(""), null);
is("a lone point reads nothing", readingOf("0."), null);
is("zero is no portion", readingOf("0"), null);
is("a reading reads", readingOf("474"), 474);

is("nothing under the food: the reading is the food", netOf(474, 0), 474);
is("the bowl comes off the reading", netOf(474, 294), 180);
is("two vessels come off together", netOf(740, 412 + 68), 260);
is("a bowl that is the whole reading leaves nothing to log", netOf(294, 294), null);
is("a reading less than the bowl leaves nothing either", netOf(47, 294), null);
is("no reading, nothing to subtract from", netOf(null, 294), null);
is("the subtraction does not leave a float's tail", netOf(302.3, 294.1), 8.2);

const katori: Vessel = { id: "k", name: "Steel katori", grams: 68, last_used_at: null };
const thali: Vessel = { id: "t", name: "Dinner thali", grams: 412, last_used_at: null };
const both = weighing(typed("740"), ["k", "t"], [katori, thali]);
is("a katori on a thali comes off as both", both.net, 260);
is("and both are named to the backend", both.vesselIds.join(","), "k,t");
const gone = weighing(typed("740"), ["k", "t"], [katori]);
is("a vessel deleted from the library drops out of the tare", gone.tareG, 68);
is("and is not sent", gone.vesselIds.join(","), "k");
is("nothing ticked, the reading is the food", weighing(typed("185"), [], [katori]).net, 185);

const partial: DailyTotal = {
  lower: 132, upper: null, coverage: 0.8, items_total: 5, items_covered: 4, from_supplements: null,
};
const whole: DailyTotal = {
  lower: 352, upper: 352, coverage: 1, items_total: 1, items_covered: 1, from_supplements: null,
};
is("a portion's floor is its hundred grams scaled", atGrams(partial, 250).lower, 330);
is("an unbounded total stays unbounded", atGrams(partial, 250).upper, null);
is("the coverage does not move with the grams", atGrams(partial, 250).coverage, 0.8);
is("a measured total's ceiling scales with it", atGrams(whole, 50).upper, 176);
is("the count of what was measured does not move either", atGrams(partial, 40).items_covered, 4);

check("every digit and the point have a pattern seven dots high",
  [..."0123456789."].every((c) => DOTS[c]?.length === 7));
check("every digit is five dots wide",
  [..."0123456789"].every((c) => DOTS[c].every((row) => row.length === 5)));

console.log(failed === 0 ? `\nall ${held} claims held` : `\n${failed} of ${held + failed} claims FAILED`);
if (failed > 0) throw new Error(`${failed} claim(s) failed`);
