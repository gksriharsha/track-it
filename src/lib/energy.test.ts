/**
 * How a row of Today reads its energy, held to the three states. Runs in a
 * bare Node process, like the other tests here:
 *
 *     node src/lib/energy.test.ts
 *
 * What it guards: a measured row prints its figure, a partly measured one "≥"
 * and an unmeasured one "—", never 0; a tablet with no stated energy prints
 * nothing at all; a label that does print calories keeps them; and every one
 * of those answers is the one `read` gives the same total, so a row cannot
 * disagree with the nutrient panel about what is known. The day's own line
 * reads a day with no food on it as "—", not as the pills' few calories, and
 * a sitting's subtotal follows the day's rule rather than a row's.
 */
import { dayFigure, energyShares, mealFigure, rowFigure } from "./energy.ts";
import { read } from "./nutrient.ts";
import type { DailyTotal, NutrientTotal } from "../types.ts";

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
const is = (claim: string, got: string, want: string) => check(claim, got === want, `got "${got}", wanted "${want}"`);

function total(over: Partial<DailyTotal>): DailyTotal {
  return {
    lower: 228, upper: 228, coverage: 1, items_total: 1, items_covered: 1, from_supplements: null,
    ...over,
  };
}

/** The same total as the nutrient panel would hold it, to ask `read` about. */
function asNutrient(t: DailyTotal): NutrientTotal {
  return {
    id: 1008, name: "Energy", full_name: "Energy", magnitude: "kcal", tier: "core", group: "Energy",
    total: t, target: null, target_basis: null, is_limit: false,
  };
}

const measured = total({});
// The fixture's sambar: the drumstick pods have no data, half the dish by weight.
const partial = total({ lower: 208, upper: null, coverage: 0.485, items_total: 3, items_covered: 2 });
// The fixture's roasted chana: nothing off the pack.
const unknown = total({ lower: 0, upper: null, coverage: 0, items_total: 1, items_covered: 0 });
// Mostly measured: 12 g of ghee in 219 g of dal, which is still a figure.
const mostly = total({ lower: 376, upper: null, coverage: 0.945, items_total: 6, items_covered: 5 });
// A fish-oil softgel whose label prints 10 kcal: a dose, so no mass and no coverage.
const softgel = total({
  lower: 10, upper: 10, coverage: null,
  from_supplements: { lower: 10, upper: 10, doses_total: 1, doses_covered: 1 },
});
// A capsule whose panel was only partly transcribed.
const halfPanel = total({
  lower: 12, upper: null, coverage: null, items_total: 2, items_covered: 1,
  from_supplements: { lower: 12, upper: null, doses_total: 2, doses_covered: 1 },
});

console.log("an entry's energy, as its row prints it");
is("a measured entry prints its figure", rowFigure(measured), "228");
is("a partly measured entry prints at least what is accounted for", rowFigure(partial), "≥208");
is("an unmeasured entry prints a dash, never 0", rowFigure(unknown), "—");
is("a mostly measured entry is still a figure", rowFigure(mostly), "376");
is("a tablet with no stated energy prints nothing", rowFigure(null), "");
is("a softgel whose label prints calories keeps them", rowFigure(softgel), "10");
is("a dose whose panel is half there reads as partial", rowFigure(halfPanel), "≥12");
is("a partial reading of nothing is a dash, not \"≥0\"", rowFigure(total({ lower: 0.3, upper: null, coverage: 0.4 })), "—");
is("a meal of several hundred is grouped the way the app writes numbers",
  rowFigure(total({ lower: 2156.4, upper: 2156.4 })), (2156).toLocaleString());
is("a measured zero is a figure, not a dash", rowFigure(total({ lower: 0, upper: 0 })), "0");
is("an entry nothing was ever logged against is a dash", rowFigure(total({ lower: 0, items_total: 0, items_covered: 0 })), "—");

console.log("the same answer as the nutrient panel");
for (const [name, t] of Object.entries({ measured, partial, unknown, mostly, softgel, halfPanel })) {
  const state = read(asNutrient(t)).state;
  const fig = rowFigure(t);
  const shape = fig === "—" ? "unknown" : fig.startsWith("≥") ? "partial" : "measured";
  check(`${name}: the row reads "${fig}" where read() says ${state}`, shape === state);
}

console.log("the day's own line");
is("a day of food reads like a row", dayFigure(measured), "228");
is("a partly measured day says at least", dayFigure(partial), "≥208");
is("a day holding only a supplement is not the supplement's calories", dayFigure(softgel), "—");
is("a day with no figure at all is a dash", dayFigure(undefined), "—");
// What the backend sends for a day of nothing but water: the bottles carry no
// energy, so there is nothing to sum, which is not a measured nought.
is("a day of nothing but water is a dash, not 0", dayFigure(total({
  lower: 0, upper: 0, coverage: null, items_total: 0, items_covered: 0,
})), "—");

console.log("a sitting's subtotal, by the day's rule");
is("a meal of food reads like the day", String(mealFigure(measured)), "228");
is("a partly measured meal says at least", String(mealFigure(partial)), "≥208");
is("an unmeasured meal is a dash", String(mealFigure(unknown)), "—");
check("a meal of nothing but softgels has no subtotal, as the day has no figure",
  mealFigure(softgel) === null && dayFigure(softgel) === "—");
check("a sitting with nothing to total has no subtotal", mealFigure(null) === null && mealFigure(undefined) === null);
// Food and a softgel at one sitting: the food has a mass, so the meal is a
// meal, and the softgel's printed calories are in it — as they are in the day.
const withSoftgel = total({
  lower: 238, upper: 238, coverage: 1, items_total: 2, items_covered: 2,
  from_supplements: { lower: 10, upper: 10, doses_total: 1, doses_covered: 1 },
});
is("food with a softgel counts the softgel's calories", String(mealFigure(withSoftgel)), "238");

console.log("\nwhere the day's energy came from");
// 74 g protein, 262 g carbohydrate, 78 g fat: 296, 1,048 and 702 kcal of 2,046.
const shares = energyShares(total({ lower: 74, upper: 80 }), total({ lower: 262, upper: 262 }), total({ lower: 78, upper: 90 }));
check("the split is in whole percents that add up to 100",
  shares !== null && shares.protein + shares.carbs + shares.fat === 100, JSON.stringify(shares));
// 14.47, 51.22 and 34.31 per cent: the point left over goes to the largest
// remainder, protein's.
check("it weighs fat at 9 kcal a gram and the other two at 4",
  shares?.protein === 15 && shares?.carbs === 51 && shares?.fat === 34, JSON.stringify(shares));
check("it is read over what is accounted for, never the upper bound",
  JSON.stringify(energyShares(total({ lower: 10, upper: 90 }), total({ lower: 10, upper: 10 }), total({ lower: 0, upper: 0 }))) ===
    JSON.stringify({ protein: 50, carbs: 50, fat: 0 }));
check("with one of the three unmeasured there is no split, rather than a split of the other two",
  energyShares(total({ lower: 74 }), unknown, total({ lower: 78 })) === null);
check("a day with nothing of any of them has no split", energyShares(total({ lower: 0, upper: 0 }), total({ lower: 0, upper: 0 }), total({ lower: 0, upper: 0 })) === null);
check("nor does a day of nothing but a tablet", energyShares(softgel, softgel, softgel) === null);

console.log(failed === 0 ? `\nall ${held} claims held` : `\n${failed} of ${held + failed} claims FAILED`);
if (failed > 0) throw new Error(`${failed} claim(s) failed`);
