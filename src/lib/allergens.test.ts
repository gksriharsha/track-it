/**
 * Allergens in an ingredient list, and what to be aware of across reaction days.
 * Runs in a bare Node process:
 *
 *     node src/lib/allergens.test.ts
 */
import { describe, findAllergens, ingredientItems, readReactions, resolve, type IngredientDay } from "./allergens.ts";

let failures = 0;
function same(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failures++;
  console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}
const flags = (text: string, names: string[]) =>
  findAllergens(text, names).map((h) => `${h.allergen}:${h.word}${h.sure ? "" : "?"}`);

same("common names resolve to their chip", [resolve("Peanuts").id, resolve("tree nuts").id, resolve("Mango").label], ["peanut", "tree-nuts", "Mango"]);
same("synonyms find the allergen, as printed",
  flags("Wheat flour (Atta), groundnut oil, Whey powder, til seeds", ["gluten", "peanut", "milk", "sesame"]),
  ["Gluten:Wheat", "Gluten:Atta", "Peanut:groundnut", "Milk:Whey", "Sesame:til"]);
same("a phrase that is not the allergen is not it",
  flags("cocoa butter, coconut milk, cream of tartar, buckwheat, maltodextrin, nutmeg, water chestnut, milk thistle", ["milk", "wheat", "gluten", "tree-nuts"]),
  []);
same("peanut butter is still peanut, and not milk", flags("peanut butter", ["peanut", "milk"]), ["Peanut:peanut"]);
same("free of it is not it", flags("gluten-free oats, free from milk, no peanuts", ["gluten", "milk", "peanut"]), []);
same("lactose-free milk is still milk", flags("lactose-free milk", ["milk"]), ["Milk:milk"]);
same("may contain is not sure", flags("Rice. May contain traces of sesame and peanut.", ["sesame", "peanut"]), ["Sesame:sesame?", "Peanut:peanut?"]);
same("a word of your own is matched as a word", flags("Mango pulp, mangosteen", ["Mango"]), ["Mango:Mango"]);
same("sulphite codes", flags("Preservative (INS 223)", ["sulphites"]), ["Sulphites:INS 223"]);
same("describe names each allergen once, with its printed words",
  describe(findAllergens("groundnut, peanut, whey, milk", ["peanut", "milk"])), "Peanut (groundnut), Milk (whey)");

same("a list splits into what it names",
  ingredientItems("INGREDIENTS: Wheat flour (atta) (62%), edible vegetable oil (palm), salt. Contains: Wheat"),
  ["wheat flour", "atta", "edible vegetable oil", "palm", "salt", "wheat"]);

const day = (date: string, reaction: boolean, names: string[], lists: string[] = []): IngredientDay => ({ date, reaction, names, lists });
const days = [
  day("2026-10-01", true, ["Peanuts, raw"]),
  day("2026-10-02", true, ["Kiwi pack"], ["Kiwi, sugar, salt"]),
  day("2026-10-03", true, ["Fruit bar — 0 of 47 values off the pack, 47 unmeasured"], ["Kiwi, oats, salt"]),
  day("2026-10-04", false, ["Rice, white"], ["salt"]),
  day("2026-10-05", false, ["Oats, raw"], ["sugar"]),
  day("2026-10-06", false, ["Peanuts, roasted"]),
];
const view = readReactions(days, ["peanut"]);
same("a reaction day with an allergen is explained by it",
  view.reactions, [{ date: "2026-10-01", allergens: ["Peanut"] }, { date: "2026-10-02", allergens: [] }, { date: "2026-10-03", allergens: [] }]);
same("each allergen eaten is tracked", view.eaten, [{ allergen: "Peanut", days: 2, last: "2026-10-06" }]);
same("aware lists what was on unexplained reaction days more than on others, most often first",
  view.aware.map((a) => `${a.item} ${a.onReaction}/${a.onOther}`),
  ["kiwi 2/0", "salt 2/1", "fruit bar 1/0", "kiwi pack 1/0", "oats 1/1", "sugar 1/1"]);
same("nothing to be aware of without a reaction", readReactions(days.filter((d) => !d.reaction), ["peanut"]).aware, []);

// Thrown rather than process.exit: these tests are typechecked with the app,
// which has no Node typings (see node.d.ts).
if (failures > 0) throw new Error(`${failures} allergen claim(s) failed`);
console.log("allergens: ok");
