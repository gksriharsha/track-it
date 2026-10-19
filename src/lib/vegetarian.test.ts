/**
 * Flagging what is not vegetarian in an ingredient list. Runs in a bare Node process:
 *
 *     node src/lib/vegetarian.test.ts
 */
import { nonVegetarian } from "./vegetarian.ts";

let failures = 0;
function same(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failures++;
  console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}
const words = (t: string) => nonVegetarian(t).map((f) => (f.sure ? f.word : `${f.word}?`));

same("a vegetarian list with dairy, egg and honey flags nothing",
  words("Wheat flour, sugar, butter (milk), whole egg powder, honey, ghee, paneer, whey, shellac, beeswax"), []);
same("flesh, fish and gelatin are flagged as printed",
  words("Sugar, Gelatine, glucose syrup, Chicken Fat, anchovies"), ["Gelatine", "Chicken", "anchovies"]);
same("a word is flagged once", words("fish sauce, fish oil, FISH"), ["fish"]);
same("a phrase is read before the word inside it",
  words("Cheese (milk, salt, animal rennet), bone char sugar"), ["animal rennet", "bone char"]);
same("rennet and enzymes may be from an animal",
  words("Cheese (milk, cultures, salt, enzymes), rennet"), ["enzymes?", "rennet?"]);
same("the word before can say it is not the animal",
  words("microbial rennet, vegetable mono- and diglycerides, agar (vegetable gelatin), no meat, free from gelatin, veg sausage"),
  []);
same("so can the word after", words("gelatin-free capsule, meat free"), []);
same("free range is still chicken", words("free range chicken"), ["chicken"]);
same("false friends are not animals",
  words("coconut meat, cream of tartar, oyster mushrooms, goat's milk, butter beans, eggplant, chickpeas, gooseberry, turkey berry, sweetmeat, graham flour. Product of Turkey"),
  []);
same("a may-contain line is cross-contact, not an ingredient",
  words("Wheat, sugar. May contain traces of fish, crustaceans and molluscs."),
  ["fish?", "crustaceans?", "molluscs?"]);
same("a sure sighting outranks a may-contain one",
  words("Fish sauce. May contain fish."), ["Fish"]);
same("additive numbers are named, prefixed or inside an additive's brackets",
  words("Colour (INS 120), E441, emulsifiers (471, 322), sugar 120 g"),
  ["INS 120 (carmine)", "E441 (gelatin)", "471 (mono- and diglycerides)?"]);
same("glycerides are read whole",
  words("Emulsifier: mono and diglycerides of fatty acids"), ["mono and diglycerides?"]);
same("an empty list flags nothing", words(""), []);

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("vegetarian: ok");
