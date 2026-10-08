/**
 * A dish someone else made, pasted in as the JSON an AI assistant gave back.
 *
 * Ordered-in and eaten-out food has no pack to transcribe and no recipe worth
 * writing, so the figures come from an estimate the user asked for elsewhere.
 * This reads that reply as loosely as a person would — a code fence around it,
 * `protein_g` or `"Protein (g)"` or `"protein": "22 g"`, one dish or a list —
 * and turns it into the rows `import_log_rows` already writes: a one-off food
 * and a frozen entry for it.
 *
 * Nutrient names go through the spreadsheet importer's own matcher, so the two
 * ways in agree on what "carbs" or "sodium (mg)" means and on refusing a unit
 * they cannot convert. Nothing is guessed: a key that matches nothing, or a
 * value that is not a single non-negative number, is reported and left out —
 * an unknown nutrient stays unknown rather than becoming a zero.
 */
import { convertMass, matchHeader } from "./spreadsheet.ts";
import { LABEL_NUTRIENTS } from "../types.ts";

export interface PastedNutrient {
  nutrient_id: number;
  amount: number;
  label: string;
}

export interface PastedDish {
  name: string;
  /**
   * Where it came from, as the user named it to the assistant ("from
   * Paradise"), handed back under "restaurant". Their own words passed
   * through, shown in the sheet to keep or change; null when none was named.
   */
  place: string | null;
  /** The whole dish's weight, if the reply estimated one. */
  grams: number | null;
  nutrients: PastedNutrient[];
  /** Keys that were read as nothing, so the sheet can say what was left out. */
  ignored: string[];
}

export type PasteResult =
  | {
      ok: true;
      dishes: PastedDish[];
      /** Whole entries read as nothing — a "Total" row that sums the others. */
      skipped: string[];
    }
  | { ok: false; error: string };

/**
 * What to ask an assistant for. One shape, so the reply reads back cleanly.
 * Every figure in the template is null, never 0: a template handed back
 * unfilled must read as unknown, and pasting the prompt itself by mistake
 * must log nothing. Whether it was ordered in or eaten out and what cuisine
 * it is are the user's own answers (D15), so the assistant is not asked for
 * either. The restaurant is asked for only as the user named it: the same dish
 * differs from one place to the next, and a chain's portion may be known.
 */
export const DISH_PROMPT = `Estimate the nutrition of the dish below for the whole portion I ate. Reply with only JSON, no prose, in this shape: one object, or a list of them for several dishes, with no total row. Use single numbers, not ranges. Leave any figure you cannot estimate as null; never put 0 for something unknown. Put the restaurant in "restaurant" only if I name one, and size the portion for that place if you know it.
{"name": "", "restaurant": null, "grams": null, "calories": null, "protein_g": null, "carbs_g": null, "fat_g": null, "saturated_fat_g": null, "fiber_g": null, "sugars_g": null, "sodium_mg": null, "cholesterol_mg": null, "potassium_mg": null, "calcium_mg": null, "iron_mg": null}
Dish (and where from): `;

/** A dish's name, best first: a later key only replaces an earlier one it outranks. */
const NAME_RANK: Record<string, number> = {
  name: 0, "dish name": 0, dish: 0,
  food: 1, item: 1, title: 1,
  description: 2, meal: 2,
};
/** A sitting is not a dish's name: {"meal": "dinner"} names when, not what. */
const SITTINGS = new Set(["breakfast", "lunch", "dinner", "snack", "snacks", "brunch", "supper"]);
/**
 * Read and set aside without a word. Where a dish came from and what cuisine
 * it is are the user's to say, never an assistant's (D15), and the rest is
 * the assistant talking about its own answer.
 */
const QUIET_KEYS = new Set(["cuisine", "cuisine type", "origin", "source", "notes", "note", "assumptions", "confidence"]);
/** Where the dish came from, in the words the user gave the assistant. */
const PLACE_KEYS = new Set(["restaurant", "restaurant name", "place", "where from", "from", "outlet", "eatery", "vendor"]);
/** A weight however it is written; a bare number is grams. */
const WEIGHT_KEYS = new Set(["grams", "weight", "mass", "total weight"]);
/** A serving's size only when it says grams: "portion": 1 is a count, not 1 g. */
const SERVING_KEYS = new Set(["serving", "serving size", "portion", "portion size"]);
/** Containers a reply may wrap its figures or its dishes in. */
const NEST_KEYS = new Set(["nutrition", "nutrients", "macros", "nutrition facts", "per portion", "totals", "total"]);
const LIST_KEYS = new Set(["dishes", "items", "foods", "meal items", "order"]);
/** A row of a list that sums the others, and would count them twice. */
const TOTAL_NAME = /^(grand |meal |order )?totals?$|^(overall|combined|whole order|whole meal)$/i;

/** `saturatedFat_g`, `sodium_mg`, `"Sodium (mg)"` → `{ name, unit }`. */
function splitKey(raw: string): { name: string; unit: string | null } {
  let k = raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-]+/g, " ").trim().toLowerCase();
  const paren = k.match(/^(.*?)\s*\(([^()]*)\)$/);
  if (paren) return { name: paren[1].trim(), unit: paren[2].trim() };
  const suffix = k.match(/^(.*\S)\s+(g|mg|mcg|ug|µg|kcal|cal|kj)$/);
  if (suffix) k = suffix[1];
  return { name: k.replace(/\s+/g, " "), unit: suffix ? suffix[2] : null };
}

/** One spelling per unit, so "µg" beside "mcg" or "cal" beside "kcal" agree. */
function canonUnit(u: string | null): string | null {
  if (u === null) return null;
  const s = u.toLowerCase();
  if (s === "cal" || s === "kcal") return "kcal";
  if (s === "mcg" || s === "ug" || s === "µg") return "ug";
  return s;
}

/** `22`, `"22"`, `"22 g"`, `"1,100mg"` → the number and any unit written with it. */
function readValue(v: unknown): { amount: number; unit: string | null } | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? { amount: v, unit: null } : null;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^~?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([a-zµ]+)?$/i);
  if (!m) return null;
  return { amount: Number(m[1].replace(/,/g, "")), unit: m[2]?.toLowerCase() ?? null };
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** One object → one dish, or null when it carries no nutrient at all. */
function readDish(obj: Record<string, unknown>, fallbackName: string): PastedDish | null {
  const dish: PastedDish = { name: "", place: null, grams: null, nutrients: [], ignored: [] };
  const seen = new Set<number>();
  let nameRank = Infinity;

  const visit = (o: Record<string, unknown>) => {
    for (const [rawKey, v] of Object.entries(o)) {
      const { name, unit } = splitKey(rawKey);
      if (isPlainObject(v) && NEST_KEYS.has(name)) {
        visit(v);
        continue;
      }
      if (name in NAME_RANK) {
        const t = text(v);
        if (t && NAME_RANK[name] < nameRank && !SITTINGS.has(t.toLowerCase())) {
          dish.name = t;
          nameRank = NAME_RANK[name];
        }
        continue;
      }
      if (PLACE_KEYS.has(name)) { dish.place ??= text(v); continue; }
      if (QUIET_KEYS.has(name)) continue;
      if (v === null || v === "") continue; // left blank: not estimated, not zero
      const val = readValue(v);
      // A unit in the key and a different one beside the number: one of them
      // is wrong, and guessing which is how a figure comes out 1000 times off.
      const keyUnit = canonUnit(unit), valueUnit = canonUnit(val?.unit ?? null);
      if (keyUnit !== null && valueUnit !== null && keyUnit !== valueUnit) { dish.ignored.push(rawKey); continue; }
      const u = keyUnit ?? valueUnit;
      if (WEIGHT_KEYS.has(name) || SERVING_KEYS.has(name)) {
        const grams = WEIGHT_KEYS.has(name) ? u === null || u === "g" : u === "g";
        if (val && val.amount > 0 && grams) dish.grams ??= val.amount;
        else dish.ignored.push(rawKey);
        continue;
      }
      const match = matchHeader(u ? `${name} (${u})` : name);
      if (!match || match.kind !== "nutrient" || !val) { dish.ignored.push(rawKey); continue; }
      if (seen.has(match.nutrientId)) continue; // "calories" and "energy_kcal" both: the first stands
      seen.add(match.nutrientId);
      const amount = match.convertFrom
        ? convertMass(val.amount, match.convertFrom, ownUnit(match.nutrientId))
        : val.amount;
      dish.nutrients.push({ nutrient_id: match.nutrientId, amount, label: match.label });
    }
  };
  visit(obj);
  if (dish.nutrients.length === 0) return null;
  dish.name ||= fallbackName;
  return dish;
}

/** A label nutrient's own mass unit; only asked of one `matchHeader` converted. */
function ownUnit(id: number): "g" | "mg" | "ug" {
  const u = LABEL_NUTRIENTS.find((n) => n.id === id)?.unit;
  return u === "mg" ? "mg" : u === "µg" ? "ug" : "g";
}

/** The JSON in a reply, block by block: code fences and prose around them are dropped. */
function extractJson(raw: string): string[] {
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const blocks = fenced.length > 0 ? fenced : [raw];
  const out: string[] = [];
  for (const b of blocks) {
    const s = b.trim();
    const start = s.search(/[[{]/);
    if (start < 0) continue;
    const close = s[start] === "[" ? "]" : "}";
    const end = s.lastIndexOf(close);
    if (end > start) out.push(s.slice(start, end + 1));
  }
  return out;
}

/** The dishes one parsed value holds: a dish, a list of them, or a list under a key. */
function entriesOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isPlainObject(data)) return [];
  // A dish with figures of its own is the dish, whatever list it also carries:
  // {"name": "Biryani", "calories": 800, "items": [...]} is one biryani.
  if (readDish(data, "Dish") !== null) return [data];
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v) && LIST_KEYS.has(splitKey(k).name) && v.some(isPlainObject)) return v;
  }
  return [data];
}

export function parsePastedDishes(raw: string): PasteResult {
  if (raw.trim() === "") return { ok: false, error: "" };
  const blocks = extractJson(raw);
  if (blocks.length === 0) return { ok: false, error: "No JSON found in what was pasted." };
  const entries: unknown[] = [];
  for (const b of blocks) {
    try {
      entries.push(...entriesOf(JSON.parse(b)));
    } catch {
      return { ok: false, error: "That JSON doesn’t read — it may have been cut off." };
    }
  }
  const objects = entries.filter(isPlainObject);
  const read = objects.map((d, i) => readDish(d, objects.length > 1 ? `Dish ${i + 1}` : "Dish"));
  const dishes: PastedDish[] = [];
  const skipped: string[] = [];
  read.forEach((dish) => {
    if (!dish) return;
    // Only beside dishes it could be the sum of: a lone "Total" is the meal.
    if (read.filter(Boolean).length > 1 && TOTAL_NAME.test(dish.name)) skipped.push(dish.name);
    else dishes.push(dish);
  });
  if (dishes.length === 0) return { ok: false, error: "No nutrient figures were recognised in it." };
  return { ok: true, dishes, skipped };
}
