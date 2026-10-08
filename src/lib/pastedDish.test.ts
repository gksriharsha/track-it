/**
 * A dish pasted in as an assistant's JSON reply. Runs in a bare Node process,
 * like the other tests here:
 *
 *     node src/lib/pastedDish.test.ts
 *
 * What it guards: the reply is read through a code fence and prose around it,
 * in the key spellings assistants actually use, one dish or several; units are
 * converted only where they can be, a value that is not one number is left out
 * rather than guessed, and a blank figure is unknown rather than zero. Where a
 * dish came from and its cuisine are never taken from the reply (D15), and the
 * prompt's own template, pasted back unfilled, logs nothing.
 */
import { DISH_PROMPT, parsePastedDishes, type PastedDish } from "./pastedDish.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}`, detail ?? "");
}
function one(raw: string): PastedDish {
  const r = parsePastedDishes(raw);
  if (!r.ok) throw new Error(`expected a dish, got: ${r.error}`);
  return r.dishes[0];
}
const amt = (d: PastedDish, id: number) => d.nutrients.find((n) => n.nutrient_id === id)?.amount;

// The prompt's own shape, fenced, with a sentence in front.
{
  const d = one(`Here you go:
\`\`\`json
{"name": "Paneer butter masala", "cuisine": "North Indian", "grams": 350,
 "calories": 620, "protein_g": 22, "carbs_g": 30, "fat_g": 45, "sodium_mg": 1100}
\`\`\``);
  check("name", d.name === "Paneer butter masala", d.name);
  check("grams", d.grams === 350);
  check("energy", amt(d, 1008) === 620);
  check("protein", amt(d, 1003) === 22);
  check("carbs", amt(d, 1005) === 30);
  check("fat", amt(d, 1004) === 45);
  check("sodium in mg", amt(d, 1093) === 1100);
  check("nothing ignored, cuisine set aside quietly", d.ignored.length === 0, d.ignored);
}

// Other spellings: camelCase, parenthesised units, strings with units, nesting.
{
  const d = one(`{"dish": "Pad thai", "origin": "takeout",
    "nutrition": {"Calories (kcal)": "780", "saturatedFat": "6 g", "Sodium (g)": 1.8,
                  "dietary fiber": "4g", "sugar": "1,200", "vitamin_c_mg": 12}}`);
  check("dish key", d.name === "Pad thai");
  check("origin is never read off the reply", !("origin" in d) && !d.ignored.includes("origin"), d);
  check("nested energy", amt(d, 1008) === 780);
  check("camelCase sat fat", amt(d, 1258) === 6);
  check("sodium converted g→mg", amt(d, 1093) === 1800, amt(d, 1093));
  check("unit glued to number", amt(d, 1079) === 4);
  check("thousands separator", amt(d, 2000) === 1200);
  check("unknown nutrient reported", d.ignored.includes("vitamin_c_mg"), d.ignored);
}

// A figure that is not one number, or is blank, is left out — never a zero.
{
  const d = one(`{"name": "Biryani", "calories": 700, "protein_g": "20-25", "fat_g": null, "fiber_g": ""}`);
  check("range left out", amt(d, 1003) === undefined);
  check("range reported", d.ignored.includes("protein_g"));
  check("null not zero", amt(d, 1004) === undefined && !d.ignored.includes("fat_g"));
  check("blank not zero", amt(d, 1079) === undefined);
}

// A unit that cannot be converted is refused, not applied unconverted.
{
  const d = one(`{"name": "Soup", "energy_kj": 800, "kcal": 190}`);
  check("kJ refused", d.ignored.includes("energy_kj"), d.ignored);
  check("kcal key read", amt(d, 1008) === 190);
}

// Several dishes, bare or wrapped; a nameless one is still numbered.
{
  const r = parsePastedDishes(`{"items": [{"name": "Naan", "calories": 260}, {"calories": 90}]}`);
  check("two dishes", r.ok && r.dishes.length === 2);
  check("fallback name", r.ok && r.dishes[1].name === "Dish 2");
  const bare = parsePastedDishes(`[{"name": "Dal", "calories": 210}]`);
  check("bare list", bare.ok && bare.dishes[0].name === "Dal");
}

// The prompt's template, handed back unfilled or pasted by mistake, is nothing.
{
  const r = parsePastedDishes(DISH_PROMPT);
  check("prompt pasted back logs nothing", !r.ok, r);
  const template = JSON.parse(DISH_PROMPT.slice(DISH_PROMPT.indexOf("{"), DISH_PROMPT.lastIndexOf("}") + 1));
  check("template figures are null, never 0",
    Object.entries(template).every(([k, v]) => k === "name" || v === null), template);
  check("template asks for the restaurant", "restaurant" in template);
}

// Where it came from, as named to the assistant; none when none was named.
{
  check("restaurant read", one(`{"name": "Chicken biryani", "restaurant": "Paradise", "calories": 780}`).place === "Paradise");
  check("other spelling", one(`{"dish": "Dosa", "Restaurant Name": " Vidyarthi Bhavan ", "calories": 300}`).place === "Vidyarthi Bhavan");
  check("null is no place", one(`{"name": "Dal", "restaurant": null, "calories": 200}`).place === null);
  check("absent is no place", one(`{"name": "Dal", "calories": 200}`).place === null);
  check("not left out", !one(`{"name": "A", "restaurant": "B", "calories": 1}`).ignored.includes("restaurant"));
}

// A unit in the key and a different one by the number is refused, not chosen between.
{
  const d = one(`{"name": "Soup", "calories": 200, "protein_g": "500 mg", "Calories (kcal)": "800 kJ", "sodium_mg": "1.2 g", "fiber_g": "3 g"}`);
  check("g key, mg value refused", amt(d, 1003) === undefined && d.ignored.includes("protein_g"), d);
  check("mg key, g value refused", amt(d, 1093) === undefined && d.ignored.includes("sodium_mg"));
  check("agreeing units read", amt(d, 1079) === 3);
}

// A weight is grams; a serving or portion is grams only when it says so.
{
  check("bare weight is grams", one(`{"name": "A", "calories": 1, "weight": 350}`).grams === 350);
  const count = one(`{"name": "B", "calories": 1, "portion": 1, "serving_size": 2}`);
  check("bare portion is a count, not 1 g", count.grams === null && count.ignored.includes("portion"), count);
  check("serving in g is grams", one(`{"name": "C", "calories": 1, "serving_size_g": 280}`).grams === 280);
  check("portion with g is grams", one(`{"name": "D", "calories": 1, "portion": "300 g"}`).grams === 300);
}

// A "Total" row beside the dishes is the sum of them, so it is left out.
{
  const r = parsePastedDishes(`[{"name": "Naan", "calories": 260}, {"name": "Dal makhani", "calories": 410}, {"name": "Total", "calories": 670}]`);
  check("total row skipped", r.ok && r.dishes.length === 2 && r.skipped.join() === "Total", r);
  const lone = parsePastedDishes(`{"name": "Total", "calories": 670}`);
  check("a lone total is the meal", lone.ok && lone.dishes.length === 1);
}

// A dish that carries its own figures is the dish, whatever list it also holds.
{
  const r = parsePastedDishes(`{"name": "Chicken biryani", "calories": 800, "items": [{"name": "rice", "calories": 400}]}`);
  check("outer dish kept", r.ok && r.dishes.length === 1 && r.dishes[0].name === "Chicken biryani", r);
  const words = parsePastedDishes(`{"name": "Pad thai", "calories": 780, "items": ["noodles", "egg"]}`);
  check("a list of words is no list of dishes", words.ok && words.dishes[0].name === "Pad thai", words);
}

// The name is the best-named key, and a sitting is not a name.
{
  check("name outranks meal", one(`{"meal": "dinner", "description": "spicy", "name": "Biryani", "calories": 1}`).name === "Biryani");
  check("sitting is not a name", one(`{"meal": "lunch", "calories": 1}`).name === "Dish");
}

// One code block per dish: every block is read.
{
  const r = parsePastedDishes("Naan:\n```json\n{\"name\": \"Naan\", \"calories\": 260}\n```\nDal:\n```json\n{\"name\": \"Dal\", \"calories\": 410}\n```");
  check("two fenced blocks, two dishes", r.ok && r.dishes.map((d) => d.name).join() === "Naan,Dal", r);
}

// Nothing usable says so.
{
  check("empty is quiet", !parsePastedDishes("  ").ok);
  const noJson = parsePastedDishes("about 600 calories");
  check("no JSON", !noJson.ok && noJson.error !== "");
  const cut = parsePastedDishes(`{"name": "Dosa", "calories": 3`);
  check("cut off", !cut.ok);
  const noFigures = parsePastedDishes(`{"name": "Dosa"}`);
  check("no figures", !noFigures.ok);
}

// Thrown rather than process.exit: these tests are typechecked with the app,
// which has no Node typings (see node.d.ts).
if (failures > 0) throw new Error(`${failures} check(s) failed`);
console.log("pastedDish: all checks passed");
