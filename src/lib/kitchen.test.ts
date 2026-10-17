/**
 * The kitchen puts things where they live and greys back what has not been
 * used. Runs in a bare Node process:
 *
 *     node src/lib/kitchen.test.ts
 */
import { atHome, countIn, counts, faded, guess, shelvesOf, usedLine, usual } from "./kitchen.ts";
import type { KitchenFood } from "../types.ts";

let failures = 0;
function same(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failures++;
  console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}

const TODAY = "2026-10-17";
const food = (description: string, last_used: string | null, more: Partial<KitchenFood> = {}): KitchenFood => ({
  fdc_id: null, custom_food_id: description, description, name: null, last_used, put_on: null, out_on: null, place: null, ...more,
});

same("peanut butter is a jar on a pantry shelf, not butter", guess("Peanut butter, smooth"), { place: "pantry", shelf: "Everything else", art: "jar" });
same("butter goes in the fridge", guess("Butter, salted").place, "fridge");
same("rice flour is flour, before rice", guess("Rice flour").art, "bag2");
same("frozen peas go in the freezer", guess("Peas, green, frozen").place, "freezer");
same("dried peas are beans and lentils", guess("Peas, split, mature seeds, raw").shelf, "Beans and lentils");
same("eggplant is not eggs", guess("Eggplant, raw").shelf, "Vegetable drawer");
same("bell pepper is a vegetable, black pepper a spice", [guess("Peppers, bell, red").place, guess("Black pepper").shelf], ["fridge", "Oils and spices"]);
same("anything unknown sits on the last pantry shelf", guess("Kirkland trail mix"), { place: "pantry", shelf: "Everything else", art: "jar" });

const milk = food("Milk", "2026-10-15", { out_on: "2026-10-16" });
same("finished after it was last used: gone", atHome(milk), false);
same("used again after finishing: back", atHome({ ...milk, last_used: "2026-10-17" }), true);
same("finished on the day it was put away: gone", atHome(food("Eggs", null, { put_on: "2026-10-10", out_on: "2026-10-10" })), false);

same("the fridge keeps fresh things a week", faded(food("Spinach", "2026-10-10"), TODAY), false);
same("and greys them back after", faded(food("Spinach", "2026-10-09"), TODAY), true);
same("the pantry keeps them three months", faded(food("Toor dal", "2026-07-20"), TODAY), false);
same("a moved thing fades by where it is now", faded(food("Spinach", "2026-10-01", { place: "freezer" }), TODAY), false);

const foods = [
  food("Toor dal", "2026-10-12"),
  food("Basmati rice", "2026-10-15"),
  food("Peanut butter", "2026-06-01"),
  food("Cumin seeds", "2026-10-12"),
  food("Salt", "2026-10-16", { place: "fridge" }),
  food("Rolled oats", "2026-10-17"),
  food("Chickpeas", "2026-10-01", { out_on: "2026-10-05" }),
];
same(
  "pantry shelves in order, fresh things first, a moved thing elsewhere, a finished one gone",
  shelvesOf(foods, "pantry", TODAY).map((s) => [s.shelf, s.items.map((f) => f.description)]),
  [["Grains and flour", ["Rolled oats", "Basmati rice"]], ["Beans and lentils", ["Toor dal"]], ["Oils and spices", ["Cumin seeds"]], ["Everything else", ["Peanut butter"]]],
);
same("salt moved to the fridge sits on its shelves", shelvesOf(foods, "fridge", TODAY).map((s) => s.shelf), ["Shelves"]);
same("a count leaves out what has greyed back", countIn(foods, "pantry", TODAY), 4);
same(
  "a shop offers what ran out or greyed back first",
  usual(foods, TODAY, 3).map((f) => f.description),
  ["Chickpeas", "Peanut butter", "Rolled oats"],
);
same(
  "pots count in the fridge, and salt in a jar counts once, as the jar",
  counts(foods, TODAY, 2, [{ fdc_id: null, custom_food_id: "Toor dal" }]),
  { pantry: 4, fridge: 3, freezer: 0 },
);
same("put away today says so", usedLine(food("Milk", null, { put_on: TODAY }), TODAY), "Put away today");
same("used today says so", usedLine(food("Milk", TODAY, { put_on: TODAY }), TODAY), "Used today");

// Thrown rather than process.exit: these tests are typechecked with the app,
// which has no Node typings (see node.d.ts).
if (failures > 0) throw new Error(`${failures} kitchen claim(s) failed`);
console.log("kitchen: all checks passed");
