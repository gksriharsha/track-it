/**
 * A food that comes in several forms, said once. Runs in a bare Node process,
 * like the other tests here:
 *
 *     node src/lib/foodForms.test.ts
 *
 * What it guards: a family's row names its forms in one short phrase that a
 * comma inside a label cannot misread, a chip says its form and never
 * nothing, an ingredient picker takes an uncooked form with its full USDA
 * description — whatever order the forms come in, the form the words typed
 * name, the form used last or the alias means where that is uncooked too —
 * a food only ever cooked is listed after one with a raw form, a family named
 * by one form's description is never titled by it over another, and a change
 * of form keeps the grams the person gave while a serving follows its own
 * name to the new form.
 */
import {
  displayName,
  familyOf,
  familyTitle,
  formLabel,
  formName,
  formsLine,
  ingredientOf,
  rawFirst,
  rawness,
  readoutOnSwitch,
} from "./foodForms.ts";
import type { NamedServing } from "./foodForms.ts";
import type { Readout } from "./amount.ts";
import type { FoodForm, FoodHit } from "../types.ts";

let failed = 0;
let held = 0;
function is(claim: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    held += 1;
    console.log(`  ok   ${claim}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${claim}\n         got ${a}, want ${b}`);
  }
}

const form = (fdc_id: number, label: string, description = `Food, ${label}`): FoodForm =>
  ({ fdc_id, label, description });
const raw = form(174259, "raw", "Mungo beans, mature seeds, raw");
const boiled = form(172427, "boiled", "Mungo beans, mature seeds, cooked, boiled, without salt");
const salted = form(175256, "boiled, salted", "Mungo beans, mature seeds, cooked, boiled, with salt");

is("two forms are one or the other", formsLine([raw, boiled]), "Raw or boiled");
is("three are listed, the last after 'or'",
  formsLine([raw, form(2, "stir-fried"), boiled]), "Raw, stir-fried or boiled");
is("more than three: two named and the rest counted",
  formsLine([raw, boiled, ...[3, 4, 5, 6, 7, 8].map((n) => form(n, `f${n}`))]), "Raw, boiled and 6 more");
is("only the first word takes a capital", formsLine([form(1, "dry"), form(2, "cooked")]), "Dry or cooked");
is("the last name may keep its own comma", formsLine([raw, boiled, salted]), "Raw, boiled or boiled, salted");
is("a comma inside a name before the last is said shorter",
  formsLine([raw, form(2, "canned, drained"), form(3, "frozen")]), "Raw and 2 more");
is("and so is one among the first two of a long list",
  formsLine([raw, form(2, "canned, drained"), form(3, "frozen"), form(4, "boiled")]), "Raw and 3 more");
is("a lone form is just its name", formsLine([raw]), "Raw");
is("no forms say nothing", formsLine([]), "");

is("a chip is its label with a capital", formLabel(salted), "Boiled, salted");
is("a form with no label of its own is its description", formLabel(form(9, "", "Tamarind")), "Tamarind");
is("and the line under the row says it too", formsLine([form(9, "", "Tamarind"), raw]), "Tamarind or raw");

const family: FoodHit = {
  kind: "reference", fdc_id: 172427, custom_food_id: null, description: boiled.description, brand: null,
  data_type: "sr_legacy_food", note: "USDA files urad dal under its botanical name, Mungo beans",
  matched_alias: true, name: "Mungo beans", forms: [raw, boiled],
};
const single: FoodHit = {
  kind: "reference", fdc_id: 168196, custom_food_id: null, description: "Tamarinds, raw", brand: null,
  data_type: "sr_legacy_food", note: null, matched_alias: false, name: "Tamarinds", forms: [],
};
const older: FoodHit = {
  kind: "reference", fdc_id: 170554, custom_food_id: null, description: "Spinach, raw", brand: null,
  data_type: "foundation_food", note: null, matched_alias: false,
};
const own: FoodHit = {
  kind: "custom", fdc_id: null, custom_food_id: "c1", description: "Roasted chana, salted", brand: "Haldiram's",
  data_type: "custom", note: null, matched_alias: false, name: null, forms: [],
};

is("a family is called by its name", displayName(family), "Mungo beans");
is("a hit with no name keeps its description", displayName(older), "Spinach, raw");
is("and so does one of your own foods", displayName(own), "Roasted chana, salted");
is("a family's forms come under its name", familyOf(family)?.name, "Mungo beans");
is("one food is no family", familyOf(single), null);
is("nor is a hit from before forms existed", familyOf(older), null);
is("a single form is no family either", familyOf({ ...family, forms: [raw] }), null);

is("an ingredient from a family is its uncooked form, stored by its full name",
  ingredientOf(family), { fdcId: 174259, ownId: null, description: raw.description, name: "Mungo beans, raw" });
is("however the Food screen would have opened it",
  ingredientOf({ ...family, fdc_id: boiled.fdc_id }).fdcId, 174259);
is("one food goes in as itself, shown by its short name",
  ingredientOf(single), { fdcId: 168196, ownId: null, description: "Tamarinds, raw", name: "Tamarinds" });
is("one of your own goes in by its own id",
  ingredientOf(own), { fdcId: null, ownId: "c1", description: "Roasted chana, salted", name: "Roasted chana, salted" });
const mungo = { name: "Mungo beans", forms: [raw, boiled] };
is("a form is named with its label", formName(mungo, boiled), "Mungo beans, boiled");
is("and a form with none by the family alone",
  formName({ name: "Tamarind", forms: [form(9, "", "Tamarind"), raw] }, form(9, "", "Tamarind")), "Tamarind");

// Named by one form's description, as the backend falls back to when two
// entries on screen would share a name: the name is that form's alone.
const tunaRaw = form(2706308, "raw", "Fish, tuna, raw");
const tunaCanned = form(2706311, "canned", "Fish, tuna, canned");
const tuna = { name: "Fish, tuna, raw", forms: [tunaRaw, tunaCanned] };
is("a family named by a form's description is titled by the form chosen",
  familyTitle(tuna, tunaCanned), "Fish, tuna, canned");
is("and by its shared name otherwise", familyTitle(mungo, boiled), "Mungo beans");
is("and each of its forms is called by its own description", formName(tuna, tunaCanned), "Fish, tuna, canned");

// Pods and seeds folded into one food: two labels read alike, so every chip
// fell back to its description, lower-cased. As the backend names the entry.
const podRaw = form(169222, "yardlong bean, raw", "Yardlong bean, raw");
const seedBoiled = form(174282, "yardlong beans, mature seeds, cooked, boiled, without salt",
  "Yardlong beans, mature seeds,  cooked, boiled, without salt");
const yardlong = { name: "Yardlong bean", forms: [podRaw, seedBoiled] };
is("a form whose chip is its description is called by that, not the name twice",
  [formName(yardlong, podRaw), formName(yardlong, seedBoiled)],
  ["Yardlong bean, raw", "Yardlong beans, mature seeds,  cooked, boiled, without salt"]);
is("and so is the ingredient picked from it",
  ingredientOf({ kind: "reference", fdc_id: 169222, custom_food_id: null, description: podRaw.description,
    name: "Yardlong bean", forms: [podRaw, seedBoiled] }).name, "Yardlong bean, raw");
is("a survey abbreviation keeps USDA's capitals", formLabel(form(2707414, "nfs")), "NFS");
is("in the line under the row too", formsLine([form(1, "cooked"), form(2, "nfs")]), "Cooked or NFS");

/* ── what an ingredient picker takes ─────────────────────────────────── */

is("raw, dry and unroasted are uncooked", [rawness("raw"), rawness("(garbanzo beans, bengal gram), dry"),
  rawness("unroasted"), rawness("frozen, chopped or leaf, unprepared")], [0, 0, 0, 0]);
is("canned, enriched, a plain row say nothing either way",
  [rawness("canned, drained"), rawness("enriched"), rawness(""), rawness("plain"), rawness("salted")], [1, 1, 1, 1, 1]);
is("boiled, roasted and a survey's dishes are cooked",
  [rawness("boiled"), rawness("dry roasted, with salt added"), rawness("oil-roasted"),
    rawness("from dried, no added fat"), rawness("nfs"), rawness("survey"), rawness("stir-fried")], [2, 2, 2, 2, 2, 2, 2]);

/** A family hit as the backend sends it, opened on `open`. */
const fam = (name: string, open: number, forms: FoodForm[], extra: Partial<FoodHit> = {}): FoodHit => ({
  kind: "reference", fdc_id: open, custom_food_id: null,
  description: forms.find((f) => f.fdc_id === open)?.description ?? "", brand: null,
  data_type: "sr_legacy_food", note: null, matched_alias: false, name, forms, ...extra,
});
const ref = (fdc_id: number, label: string, description: string): FoodForm => ({ fdc_id, label, description });

// From the real backend: a survey row with no label of its own sorted ahead
// of the SR raw one, which is what a recipe weighs.
const millet = fam("Millet", 2708377, [ref(2708377, "plain", "Millet"), ref(169702, "raw", "Millet, raw"),
  ref(169703, "cooked", "Millet, cooked")]);
is("an uncooked form is taken however the forms are ordered", ingredientOf(millet).fdcId, 169702);

const almonds = fam("Almonds", 2707487, [ref(2707487, "salted", "Almonds, salted"),
  ref(2707489, "unsalted", "Almonds, unsalted"), ref(2707486, "unroasted", "Almonds, unroasted"),
  ref(2707488, "lightly salted", "Almonds, lightly salted")]);
is("unroasted nuts over the salted ones the family leads with", ingredientOf(almonds).fdcId, 2707486);

// Survey nuts with no unroasted form: salted and unsalted say nothing about
// cooking, and the pot's salt is the pantry's to count.
const pistachios = fam("Pistachio nuts", 2707500, [ref(2707500, "salted", "Pistachio nuts, salted"),
  ref(2707501, "unsalted", "Pistachio nuts, unsalted"), ref(2707502, "lightly salted", "Pistachio nuts, lightly salted")]);
is("no salt added, where nothing else tells the forms apart", ingredientOf(pistachios).fdcId, 2707501);
is("unless the salted form is the one used last",
  ingredientOf({ ...pistachios, fdc_id: 2707502 }).fdcId, 2707502);
is("or the words typed ask for it", ingredientOf(pistachios, "pistachio salted").fdcId, 2707500);

const chickDry = ref(2644282, "(garbanzo beans, bengal gram), dry", "Chickpeas, (garbanzo beans, bengal gram), dry");
const chickRaw = ref(173756, "raw", "Chickpeas (garbanzo beans, bengal gram), raw");
const chickBoiled = ref(173757, "boiled", "Chickpeas (garbanzo beans, bengal gram), boiled");
const chickCanned = ref(173800, "canned, drained", "Chickpeas (garbanzo beans, bengal gram), canned, drained");
const chickLiquid = ref(175206, "canned, with liquid", "Chickpeas (garbanzo beans, bengal gram), canned, with liquid");
const chickpeas = fam("Chickpeas", 2644282, [chickDry, chickRaw, chickBoiled, chickCanned, chickLiquid]);
is("the first uncooked form when nothing says otherwise", ingredientOf(chickpeas).fdcId, 2644282);
is("the boiled form logged last at the Food screen is not what a pot is weighed in",
  ingredientOf({ ...chickpeas, fdc_id: chickBoiled.fdc_id }).fdcId, 2644282);
is("the raw form used last is, and is taken again without asking",
  ingredientOf({ ...chickpeas, fdc_id: chickRaw.fdc_id }).fdcId, 173756);
is("a form the words typed name is taken: canned chickpeas",
  ingredientOf(chickpeas, "chickpeas canned"), {
    fdcId: 173800, ownId: null, description: chickCanned.description, name: "Chickpeas, canned, drained",
  });
is("words every form carries name nothing", ingredientOf(chickpeas, "bengal gram").fdcId, 2644282);
is("and a cooked form named outright is taken too", ingredientOf(chickpeas, "chickpeas boil").fdcId, 173757);

const spinach = fam("Spinach", 168462, [ref(168462, "raw", "Spinach, raw"),
  ref(168463, "boiled", "Spinach, cooked, boiled, drained, without salt"),
  ref(169288, "frozen, chopped or leaf, boiled", "Spinach, frozen, chopped or leaf, cooked, boiled, drained, without salt"),
  ref(169287, "frozen, chopped or leaf", "Spinach, frozen, chopped or leaf, unprepared")]);
is("of the frozen forms named, the one as bought", ingredientOf(spinach, "spinach frozen").fdcId, 169287);

const urad = { ...family, fdc_id: boiled.fdc_id, matched_alias: true };
is("an Indian name that only reached the food names no form", ingredientOf(urad, "urad dal").fdcId, 174259);
is("one that says raw takes the raw form", ingredientOf(urad, "urad dal raw").fdcId, 174259);

const semolina = fam("Semolina", 168933, [ref(169715, "enriched", "Semolina, enriched"),
  ref(168933, "unenriched", "Semolina, unenriched")], {
  matched_alias: true, note: "Semolina, not Cream of Wheat — the latter is a fortified US cereal",
});
is("the form an alias means, with its note, where it is as near raw as any",
  ingredientOf(semolina, "rava").fdcId, 168933);

const surveyChickpeas = fam("Chickpeas, survey", 2707416, [
  ref(2707416, "from dried, no added fat", "Chickpeas, from dried, no added fat"),
  ref(2707415, "from dried, fat added", "Chickpeas, from dried, fat added"),
  ref(2707418, "from canned, no added fat", "Chickpeas, from canned, no added fat"),
  ref(2707414, "nfs", "Chickpeas, NFS")], { data_type: "survey_fndds_food" });
is("a food only ever cooked goes in on the form it opens on, named on its tile",
  ingredientOf({ ...surveyChickpeas, fdc_id: 2707418 }), {
    fdcId: 2707418, ownId: null, description: "Chickpeas, from canned, no added fat",
    name: "Chickpeas, survey, from canned, no added fat",
  });

is("a food with a raw form is listed before one only ever cooked",
  rawFirst([surveyChickpeas, chickpeas]).map((h) => h.name), ["Chickpeas", "Chickpeas, survey"]);
is("your own foods stay first, and nothing is dropped",
  rawFirst([own, surveyChickpeas, single, chickpeas]).map(displayName),
  ["Roasted chana, salted", "Tamarinds", "Chickpeas", "Chickpeas, survey"]);
is("a food an Indian name matched keeps its lead",
  rawFirst([{ ...surveyChickpeas, matched_alias: true }, chickpeas]).map((h) => h.name),
  ["Chickpeas, survey", "Chickpeas"]);

const rawCups: NamedServing[] = [{ name: "1 cup", amount: 207 }];
const boiledCups: NamedServing[] = [{ name: "1 cup", amount: 180 }, { name: "1 oz dry, yield after cooking", amount: 69 }];
const typed: Readout = { digits: "150", from: "typed" };
const kept: Readout = { digits: "474", from: "kept" };

is("grams typed stay through a change of form", readoutOnSwitch(typed, boiledCups, rawCups, 207), typed);
is("so does a reading kept under a bowl", readoutOnSwitch(kept, boiledCups, rawCups, 207), kept);
is("nothing typed stays nothing", readoutOnSwitch({ digits: "", from: "typed" }, boiledCups, rawCups, 207),
  { digits: "", from: "typed" });
is("a cup of boiled becomes a cup of raw",
  readoutOnSwitch({ digits: "180", from: "serving" }, boiledCups, rawCups, 207), { digits: "207", from: "serving" });
is("and back", readoutOnSwitch({ digits: "207", from: "serving" }, rawCups, boiledCups, 180),
  { digits: "180", from: "serving" });
is("a serving the new form does not have falls back to its starting figure",
  readoutOnSwitch({ digits: "69", from: "serving" }, boiledCups, rawCups, 207), { digits: "207", from: "guess" });
is("a guess is the new form's guess", readoutOnSwitch({ digits: "180", from: "guess" }, boiledCups, rawCups, 207),
  { digits: "207", from: "guess" });
is("a starting figure keeps a tenth of a gram",
  readoutOnSwitch({ digits: "100", from: "guess" }, [], [], 28.35), { digits: "28.4", from: "guess" });
is("a serving matched to a tenth, as its chip is",
  readoutOnSwitch({ digits: "12.5", from: "serving" }, [{ name: "1 tbsp", amount: 12.46 }], [{ name: "1 tbsp", amount: 9.9 }], 100),
  { digits: "9.9", from: "serving" });

console.log(failed === 0 ? `\nall ${held} claims held` : `\n${failed} of ${held + failed} claims FAILED`);
if (failed > 0) throw new Error(`${failed} claim(s) failed`);
