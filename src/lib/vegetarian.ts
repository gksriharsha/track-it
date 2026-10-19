/**
 * The words in an ingredient list that say a food is not vegetarian.
 *
 * The line is FSSAI's (Labelling and Display Regulations 2020, reg. 2(1)(o)):
 * milk and milk products, honey, beeswax, carnauba wax and shellac are
 * vegetarian; any other part or product of an animal, bird, fish or insect is
 * not. Eggs count as vegetarian here, because that is the diet the user keeps.
 * See docs/indian-foods-plan.md §2 for the definition and the false friends.
 *
 * It reads words, not the food. Whether a cheese's rennet or an emulsifier came
 * from an animal is often not printed at all, so those come back `sure: false`,
 * and a list with nothing flagged is not a promise.
 */

export interface VegFlag {
  /** As printed: "Gelatine", "INS 120 (carmine)". */
  word: string;
  /** False when the word only may be from an animal, or sits in a "may contain" line. */
  sure: boolean;
}

// Regex sources, longest phrase first so "animal rennet" is read before "rennet".
const ANIMAL = [
  "animal (?:fat|rennet|enzymes?|shortening)", "calf rennet", "bone char",
  "meat", "beef", "pork", "chicken", "turkey", "duck", "goose", "lamb", "mutton", "goat", "veal",
  "venison", "bacon", "ham", "salami", "pepperoni", "prosciutto", "chorizo", "sausage",
  "lard", "tallow", "suet", "gelatine?", "collagen", "bone", "pepsin", "chondroitin",
  "fish", "anchov(?:y|ies)", "tuna", "salmon", "sardine", "mackerel", "cod", "tilapia", "trout",
  "shrimp", "prawn", "crab", "lobster", "crayfish", "shellfish", "crustacean", "mollus[ck]",
  "oyster", "clam", "mussel", "squid", "octopus", "scallop", "krill", "caviar", "roe",
  "isinglass", "carmine", "cochineal", "insect",
];
const MAYBE = [
  "mono-?\\s*(?:and|&)\\s*di-?\\s*glycerides", "mono-?\\s*glycerides", "di-?\\s*glycerides",
  "rennet", "enzyme", "glucosamine", "worcestershire", "l-cysteine", "cysteine",
  "disodium inosinate", "parmesan", "parmigiano", "pecorino", "grana padano", "gruy[eè]re",
];

/** Additive numbers (E or INS) that name one of the above. */
const CODES: Record<string, [name: string, sure: boolean]> = {
  "120": ["carmine", true],
  "441": ["gelatin", true],
  "542": ["bone phosphate", true],
  "471": ["mono- and diglycerides", false],
  "472": ["esters of mono- and diglycerides", false],
  "920": ["L-cysteine", false],
  "631": ["disodium inosinate", false],
};

/** Phrases that hold an animal word and are not animal. Blanked before reading. */
const NOT_ANIMAL = [
  /coconut meat/g, /cream of tartar/g, /crab ?apples?/g, /lamb'?s lettuce/g, /oyster mushrooms?/g,
  /goat'?s? (?:milk|cheese)/g, /butter ?beans?/g, /duck sauce/g, /turkey berr(?:y|ies)/g,
  /(?:made|produced|packed|product|produce|manufactured|origin)\s*(?:in|of|:)\s*turkey/g,
];

// The word right before says it is not the animal: "microbial rennet", "no meat",
// "free from gelatin". shortcut: "vegetable beef soup" reads as not beef; such a
// compound almost never appears inside an ingredient list.
const NOT_BEFORE =
  /\b(?:no|non|not|without|free from|vegetarian|vegan|veg|imitation|mock|meatless|plant[- ]based|vegetable|plant|microbial|fungal|non-animal|synthetic)[\s-]+$/;
const NOT_AFTER = /^[\s-]*free\b/;

/** "May contain fish", "made in a facility that handles shellfish": cross-contact, not an ingredient. */
const CROSS_CONTACT = /(?:may contain|traces? of|facility|equipment|same line)[^.\n]*/g;

/** An unprefixed number counts only inside an additive's brackets: "Emulsifiers (471, 322)". */
const ADDITIVE_OPEN =
  /(?:colou?rs?|emulsifiers?|stabili[sz]ers?|gelling agents?|thickeners?|flavou?r enhancers?|flour treatment agents?|glazing agents?)\s*[([:][^)\]]*$/;

export function nonVegetarian(text: string): VegFlag[] {
  let lower = text.toLowerCase().replace(/[’`]/g, "'");
  for (const re of NOT_ANIMAL) lower = lower.replace(re, (m) => " ".repeat(m.length));

  const cross: [number, number][] = [];
  for (const m of lower.matchAll(CROSS_CONTACT)) cross.push([m.index, m.index + m[0].length]);
  const inCross = (i: number) => cross.some(([a, b]) => i >= a && i < b);

  const taken: [number, number][] = [];
  const found: (VegFlag & { at: number })[] = [];
  const take = (at: number, end: number, word: string, sure: boolean) => {
    if (taken.some(([a, b]) => at < b && end > a)) return;
    taken.push([at, end]);
    if (NOT_BEFORE.test(lower.slice(Math.max(0, at - 30), at)) || NOT_AFTER.test(lower.slice(end))) return;
    found.push({ at, word, sure: sure && !inCross(at) });
  };

  for (const [list, sure] of [[ANIMAL, true], [MAYBE, false]] as const) {
    for (const src of list) {
      for (const m of lower.matchAll(new RegExp(`\\b(?:${src})(?:e?s)?\\b`, "g"))) {
        take(m.index, m.index + m[0].length, text.slice(m.index, m.index + m[0].length), sure);
      }
    }
  }
  for (const m of lower.matchAll(/\b(?:(?:e|ins)\s?-?)?(120|441|542|471|472[a-f]?|920|631)\b/g)) {
    const prefixed = m[0].length > m[1].length;
    if (!prefixed && !ADDITIVE_OPEN.test(lower.slice(0, m.index))) continue;
    const [name, sure] = CODES[m[1].slice(0, 3)];
    take(m.index, m.index + m[0].length, `${text.slice(m.index, m.index + m[0].length)} (${name})`, sure);
  }

  // One flag per word, in printed order; a sure sighting outranks a "may contain" one.
  const byWord = new Map<string, VegFlag & { at: number }>();
  for (const f of found.sort((a, b) => a.at - b.at)) {
    const key = f.word.toLowerCase();
    const had = byWord.get(key);
    if (!had) byWord.set(key, f);
    else if (f.sure) had.sure = true;
  }
  return [...byWord.values()].map(({ word, sure }) => ({ word, sure }));
}
