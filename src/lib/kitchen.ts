/**
 * Where a food at home sits, and how the kitchen says it.
 *
 * The kitchen keeps itself: a food is at home when a pot used it or it was
 * logged at home (see `kitchen.rs`). Nothing here is stored. The place and
 * shelf are guessed from the food's name, unless its owner moved it, and a
 * thing not used for a while greys back instead of having to be cleared out.
 * Pure, so it runs under `node src/lib/kitchen.test.ts`.
 */
import type { FoodRef, KitchenFood, Place } from "../types";

/** How far back the kitchen looks. Older than this has left the shelves. */
export const KITCHEN_DAYS = 180;

/** Days since last used before a thing greys back: a week for the fridge. */
const FADE: Record<Place, number> = { pantry: 90, fridge: 7, freezer: 90 };

export type Art =
  | "jar" | "jarLow" | "jarTall" | "spice" | "bag" | "bag2" | "box" | "tea" | "tin" | "ghee"
  | "dispenser" | "squeeze" | "carton" | "eggs" | "tub" | "paneer" | "tofu" | "butter"
  | "spinach" | "tomato" | "cucumber" | "pot" | "peas";

/** Shelves top to bottom; the last of each place takes whatever was moved there. */
export const SHELVES: Record<Place, readonly string[]> = {
  pantry: ["Grains and flour", "Beans and lentils", "Oils and spices", "Everything else"],
  fridge: ["Shelves", "In the door", "Vegetable drawer"],
  freezer: ["Freezer"],
};
const MOVED_TO: Record<Place, string> = { pantry: "Everything else", fridge: "Shelves", freezer: "Freezer" };

// First match wins, so "peanut butter" is caught before "butter" and
// "rice flour" before "rice".
const RULES: [RegExp, Place, string, Art][] = [
  [/frozen|ice cream/, "freezer", "Freezer", "peas"],
  [/peanut butter|almond butter|nut butter|\bjam\b|honey/, "pantry", "Everything else", "jar"],
  [/milk|juice/, "fridge", "In the door", "carton"],
  [/\beggs?\b/, "fridge", "In the door", "eggs"],
  [/ketchup|sauce|chutney|mayo/, "fridge", "In the door", "squeeze"],
  [/yogh?urt|\bcurd|dahi/, "fridge", "Shelves", "tub"],
  [/paneer|cheese|chicken|mutton|lamb|fish|prawn|shrimp|\bmeat/, "fridge", "Shelves", "paneer"],
  [/tofu/, "fridge", "Shelves", "tofu"],
  [/butter|cream/, "fridge", "Shelves", "butter"],
  [/spinach|lettuce|coriander leaves|cilantro|\bmint|greens|kale|methi|herbs?\b/, "fridge", "Vegetable drawer", "spinach"],
  [/cucumber|zucchini|okra|gourd|eggplant|brinjal|green beans|snap beans/, "fridge", "Vegetable drawer", "cucumber"],
  [/tomato|carrot|capsicum|bell pepper|peppers?, (sweet|bell)|broccoli|cabbage|cauliflower|mushroom|lemon|\blime|ginger|berr|grape/, "fridge", "Vegetable drawer", "tomato"],
  [/\boats\b|cereal|muesli|granola|pasta|noodle|vermicelli/, "pantry", "Grains and flour", "box"],
  [/flour|atta|besan|maida|semolina|rava|sooji|suji/, "pantry", "Grains and flour", "bag2"],
  [/rice|wheat|poha|quinoa|millet|bread|cornmeal/, "pantry", "Grains and flour", "bag"],
  [/canned/, "pantry", "Beans and lentils", "tin"],
  [/\bdal\b|lentil|bean|chickpea|chana|rajma|moong|mung|urad|toor|masoor|\bpeas?\b|soy/, "pantry", "Beans and lentils", "jar"],
  [/\boil\b/, "pantry", "Oils and spices", "dispenser"],
  [/ghee/, "pantry", "Oils and spices", "ghee"],
  [/\bsalt\b/, "pantry", "Oils and spices", "jarLow"],
  [/sugar|jaggery/, "pantry", "Oils and spices", "jarTall"],
  [/cumin|jeera|turmeric|chil+i|pepper|masala|mustard|cardamom|clove|cinnamon|coriander|fenugreek|asafoetida|\bhing|spice|seeds?\b/, "pantry", "Oils and spices", "spice"],
  [/\btea\b|coffee/, "pantry", "Everything else", "tea"],
];

/** Where a food of this name usually lives, and what to draw it as. */
export function guess(name: string): { place: Place; shelf: string; art: Art } {
  const n = name.toLowerCase();
  const r = RULES.find(([re]) => re.test(n));
  return r ? { place: r[1], shelf: r[2], art: r[3] } : { place: "pantry", shelf: "Everything else", art: "jar" };
}

export const nameOf = (f: KitchenFood): string => f.name ?? f.description;
export const refOf = (f: KitchenFood): FoodRef => ({ fdc_id: f.fdc_id, custom_food_id: f.custom_food_id });
export const sameFood = (a: FoodRef, b: FoodRef): boolean =>
  a.fdc_id === b.fdc_id && a.custom_food_id === b.custom_food_id;

export const placeOf = (f: KitchenFood): Place => f.place ?? guess(nameOf(f)).place;

export function shelfOf(f: KitchenFood): string {
  const g = guess(nameOf(f));
  return g.place === placeOf(f) ? g.shelf : MOVED_TO[placeOf(f)];
}

/** The last day it was touched: used, or put away. ISO dates compare as text. */
export function latest(f: KitchenFood): string {
  return [f.last_used, f.put_on].filter((d): d is string => d !== null).sort().pop() ?? "";
}

/** Not said to be finished since it was last used or put away. */
export const atHome = (f: KitchenFood): boolean => !(f.out_on !== null && f.out_on >= latest(f));

export function daysBetween(from: string, to: string): number {
  const [a, b] = [from, to].map((iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  });
  return Math.round((b - a) / 86_400_000);
}

/** Greyed back: not used or put away for longer than its place keeps things. */
export const faded = (f: KitchenFood, today: string): boolean => daysBetween(latest(f), today) > FADE[placeOf(f)];

/** One place's shelves in order, fresh things first and newest first on each. */
export function shelvesOf(foods: KitchenFood[], place: Place, today: string): { shelf: string; items: KitchenFood[] }[] {
  const here = foods.filter((f) => atHome(f) && placeOf(f) === place);
  const order = (f: KitchenFood) => (faded(f, today) ? "0" : "1") + latest(f);
  return SHELVES[place]
    .map((shelf) => ({
      shelf,
      items: here.filter((f) => shelfOf(f) === shelf).sort((a, b) => order(b).localeCompare(order(a))),
    }))
    .filter((s) => s.items.length > 0);
}

/** How many things a place holds that have not greyed back. */
export const countIn = (foods: KitchenFood[], place: Place, today: string): number =>
  foods.filter((f) => atHome(f) && placeOf(f) === place && !faded(f, today)).length;

/**
 * What each place holds, with the open pots in the fridge and the jars you
 * weigh on the pantry shelves. A food that stands in a jar counts once, as
 * the jar.
 */
export function counts(foods: KitchenFood[], today: string, pots: number, jars: FoodRef[]): Record<Place, number> {
  const loose = foods.filter((f) => !jars.some((j) => sameFood(j, refOf(f))));
  return {
    pantry: countIn(loose, "pantry", today) + jars.length,
    fridge: countIn(loose, "fridge", today) + pots,
    freezer: countIn(loose, "freezer", today),
  };
}

/**
 * What a shop is likely to bring back: things finished or greyed back first,
 * then the rest, newest first. Everything here was at home once.
 */
export function usual(foods: KitchenFood[], today: string, n = 12): KitchenFood[] {
  const fresh = (f: KitchenFood) => (atHome(f) && !faded(f, today) ? 1 : 0);
  return [...foods].sort((a, b) => fresh(a) - fresh(b) || latest(b).localeCompare(latest(a))).slice(0, n);
}

/** "Used today", "Used Wed", "In since 2 Oct": the line under a thing on a shelf. */
export function usedLine(f: KitchenFood, today: string): string {
  const l = latest(f);
  const d = daysBetween(l, today);
  const [y, m, dd] = l.split("-").map(Number);
  const date = new Date(y, m - 1, dd);
  const day =
    d === 0 ? "today"
    : d === 1 ? "yesterday"
    : d < 7 ? date.toLocaleDateString(undefined, { weekday: "short" })
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (f.put_on === l && f.last_used !== l) return d === 0 ? "Put away today" : `In since ${day}`;
  return `Used ${day}`;
}
