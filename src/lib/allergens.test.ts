/**
 * Allergens in an ingredient list, and what to be aware of across reaction days.
 * Runs in a bare Node process:
 *
 *     node src/lib/allergens.test.ts
 */
import { findAllergens, group, ingredientItems, readReactions, resolve, type IngredientDay } from "./allergens.ts";

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
same("group names each allergen once, with its printed words, sure if any word was",
  group(findAllergens("groundnut, peanut, whey. May contain milk.", ["peanut", "milk"])),
  [{ allergen: "Peanut", sure: true, words: ["groundnut"] }, { allergen: "Milk", sure: true, words: ["whey"] }]);
same("an allergen only in a may-contain line is not sure",
  group(findAllergens("Rice. May contain sesame.", ["sesame"])), [{ allergen: "Sesame", sure: false, words: [] }]);

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
const aware = (date: string) => view.reactions.find((r) => r.date === date)!.aware.map((a) => `${a.item} ${a.onReaction}/${a.onOther}`);
same("reaction days come newest first, an explained one with its allergen",
  view.reactions.map((r) => `${r.date} ${r.allergens.join(",")}`), ["2026-10-03 ", "2026-10-02 ", "2026-10-01 Peanut"]);
same("each allergen eaten is tracked", view.eaten, [{ allergen: "Peanut", days: 2, last: "2026-10-06" }]);
same("an unexplained day lists what was on it more often than on other days, most often first",
  aware("2026-10-03"), ["kiwi 2/0", "salt 2/1", "fruit bar 1/0", "oats 1/1"]);
same("each unexplained day lists its own", aware("2026-10-02"), ["kiwi 2/0", "salt 2/1", "kiwi pack 1/0", "sugar 1/1"]);
same("an explained day lists nothing", aware("2026-10-01"), []);
same("no reaction days, nothing listed", readReactions(days.filter((d) => !d.reaction), ["peanut"]).reactions, []);

// Thrown rather than process.exit: these tests are typechecked with the app,
// which has no Node typings (see node.d.ts).
if (failures > 0) throw new Error(`${failures} allergen claim(s) failed`);
console.log("allergens: ok");
