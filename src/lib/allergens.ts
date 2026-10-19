/**
 * A person's allergens, found in an ingredient list; and, across the days they
 * marked a reaction that none of those allergens explains, what else they ate
 * more often than on other days.
 *
 * The second half is a list to be aware of, never a cause: it counts days, and
 * a food eaten on the same day as a reaction is only that.
 */
import { CROSS_CONTACT, NOT_AFTER } from "./vegetarian.ts";

export interface Allergen {
  id: string;
  label: string;
  /** Regex sources; a plural -s/-es is allowed after each. */
  words: string[];
}

const WHEAT = ["wheat", "atta", "maida", "semolina", "sooji", "suji", "rava", "durum", "spelt", "farina", "bulgur", "couscous", "seitan"];
const FISH = ["fish", "anchov(?:y|ies)", "tuna", "salmon", "sardine", "mackerel", "cod", "tilapia", "trout", "pomfret", "hilsa"];

/** The common ones, offered as chips. Stored by id; anything else is stored as typed. */
export const COMMON: Allergen[] = [
  { id: "milk", label: "Milk", words: ["milk", "whey", "casein(?:ate)?", "lactose", "lactalbumin", "butter(?:milk)?", "ghee", "cream", "cheese", "paneer", "curd", "yogh?urt", "dahi", "khoa", "khoya", "malai"] },
  { id: "egg", label: "Egg", words: ["egg", "albumin", "ovalbumin", "lysozyme", "mayonnaise", "meringue"] },
  { id: "peanut", label: "Peanut", words: ["peanut", "groundnut", "arachis", "monkey nut"] },
  { id: "tree-nuts", label: "Tree nuts", words: ["almond", "cashew", "walnut", "pistachio", "hazelnut", "pecan", "macadamia", "brazil nut", "pine nut", "chestnut", "badam", "kaju", "akhrot", "tree nut"] },
  { id: "wheat", label: "Wheat", words: WHEAT },
  { id: "gluten", label: "Gluten", words: [...WHEAT, "gluten", "barley", "rye", "malt"] },
  { id: "soy", label: "Soy", words: ["soy", "soya", "soybean", "edamame", "tofu", "tempeh", "miso", "shoyu"] },
  { id: "sesame", label: "Sesame", words: ["sesame", "til", "gingelly", "tahini", "benne"] },
  { id: "fish", label: "Fish", words: FISH },
  { id: "shellfish", label: "Shellfish", words: ["shellfish", "crustacean", "mollus[ck]", "shrimp", "prawn", "crab", "lobster", "crayfish", "oyster", "clam", "mussel", "squid", "octopus", "scallop", "krill"] },
  { id: "mustard", label: "Mustard", words: ["mustard", "rai", "sarson"] },
  { id: "sulphites", label: "Sulphites", words: ["sul(?:ph|f)ites?", "metabisul(?:ph|f)ite", "sul(?:ph|f)ur dioxide", "(?:e|ins)\\s?-?22[0-8]"] },
];

/** An allergen as stored: a common id, or the user's own word. */
export function resolve(name: string): Allergen {
  const key = name.trim().toLowerCase();
  const common = COMMON.find((c) => c.id === key || c.label.toLowerCase() === key || `${c.id}s` === key);
  return common ?? { id: key, label: name.trim(), words: [key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")] };
}

// An allergen word inside a phrase that is not that allergen: the word is
// blanked, the rest stays so "peanut butter" is still peanut.
const NOT_IT = [
  /(?<=\b(?:cocoa|shea|peanut|almond|cashew|nut|apple|kokum|mango|illipe)\s)butter\b/g,
  /(?<=\b(?:coconut|almond|soya?|oat|rice|cashew)\s)milk\b/g,
  /(?<=\bcoconut\s)cream\b/g,
  /\bcream of tartar\b/g,
  /\bmilk thistle\b/g,
  /\bwater chestnuts?\b/g,
];
const NOT_BEFORE = /\b(?:no|non|not|without|free from)[\s-]+$/;

export interface AllergenHit {
  /** The allergen's label: "Peanut", or the user's own word. */
  allergen: string;
  /** As printed. */
  word: string;
  /** False when it sits in a "may contain" line. */
  sure: boolean;
}

export function findAllergens(text: string, names: string[]): AllergenHit[] {
  let lower = text.toLowerCase().replace(/[’`]/g, "'");
  for (const re of NOT_IT) lower = lower.replace(re, (m) => " ".repeat(m.length));
  const cross = [...lower.matchAll(CROSS_CONTACT)].map((m) => [m.index, m.index + m[0].length]);

  const hits = new Map<string, AllergenHit>();
  for (const a of names.map(resolve)) {
    for (const src of a.words) {
      for (const m of lower.matchAll(new RegExp(`\\b(?:${src})(?:e?s)?\\b`, "g"))) {
        const end = m.index + m[0].length;
        if (NOT_BEFORE.test(lower.slice(Math.max(0, m.index - 20), m.index)) || NOT_AFTER.test(lower.slice(end))) continue;
        const word = text.slice(m.index, end);
        const sure = !cross.some(([s, e]) => m.index >= s && m.index < e);
        const key = `${a.label}\u0000${word.toLowerCase()}`;
        const had = hits.get(key);
        if (!had) hits.set(key, { allergen: a.label, word, sure });
        else if (sure) had.sure = true;
      }
    }
  }
  return [...hits.values()];
}

/** "Peanut (groundnut), Milk": each allergen once, with the printed words that are not its own name. */
export function describe(hits: AllergenHit[]): string {
  const by = new Map<string, string[]>();
  for (const h of hits) {
    const words = by.get(h.allergen) ?? [];
    if (h.word.toLowerCase() !== h.allergen.toLowerCase() && !words.some((w) => w.toLowerCase() === h.word.toLowerCase())) words.push(h.word);
    by.set(h.allergen, words);
  }
  return [...by].map(([a, w]) => (w.length ? `${a} (${w.join(", ")})` : a)).join(", ");
}

/** One printed list as the ingredients it names: "Wheat flour (atta), salt" → wheat flour, atta, salt. */
export function ingredientItems(list: string): string[] {
  return list
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?\s*%/g, " ")
    .replace(/\b(?:other ingredients|ingredients|may contain|contains)\b\s*:?/g, ",")
    .split(/[,;:()[\]{}\n]|\.(?:\s|$)/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 2);
}

/** What one logged day held, as the backend reads it. */
export interface IngredientDay {
  date: string;
  reaction: boolean;
  /** What each entry was, frozen when logged: "Onions, raw", a pot's lines, "Fruit bar — 0 of 47 values off the pack". */
  names: string[];
  /** Printed ingredient lists of the packs and supplements eaten. */
  lists: string[];
}

export interface Aware {
  item: string;
  onReaction: number;
  onOther: number;
}

export interface ReactionView {
  /** Reaction days, each with the allergens eaten on it (none when unexplained). */
  reactions: { date: string; allergens: string[] }[];
  /** Days logged without a reaction. */
  otherDays: number;
  /** Each allergen eaten in the period: on how many days, and the last. */
  eaten: { allergen: string; days: number; last: string }[];
  /** Eaten on a reaction no allergen explains, and more often then than on other days. */
  aware: Aware[];
}

export function readReactions(days: IngredientDay[], allergens: string[], limit = 12): ReactionView {
  const read = days.map((d) => {
    const items = new Set([
      // The food, not its form or the provenance and place a snapshot appends.
      ...d.names.map((n) => n.split(/,| — | · /)[0].trim().toLowerCase()).filter((n) => n.length >= 2),
      ...d.lists.flatMap(ingredientItems),
    ]);
    const found = findAllergens([...d.names, ...d.lists].join("\n"), allergens).filter((h) => h.sure);
    return { ...d, items, allergens: [...new Set(found.map((h) => h.allergen))] };
  });

  const reactions = read.filter((d) => d.reaction);
  const unexplained = reactions.filter((d) => d.allergens.length === 0);
  const other = read.filter((d) => !d.reaction && d.items.size > 0);

  const eaten = new Map<string, { days: number; last: string }>();
  for (const d of read) {
    for (const a of d.allergens) {
      const e = eaten.get(a) ?? { days: 0, last: d.date };
      eaten.set(a, { days: e.days + 1, last: d.date > e.last ? d.date : e.last });
    }
  }

  const count = (pool: typeof read, item: string) => pool.filter((d) => d.items.has(item)).length;
  const aware = [...new Set(unexplained.flatMap((d) => [...d.items]))]
    .map((item) => ({ item, onReaction: count(unexplained, item), onOther: count(other, item) }))
    // More often on a reaction day than on any other day, as a share of each.
    .filter((a) => other.length === 0 || a.onReaction / unexplained.length > a.onOther / other.length)
    .sort((a, b) => b.onReaction - a.onReaction || a.onOther - b.onOther || a.item.localeCompare(b.item))
    .slice(0, limit);

  return {
    reactions: reactions.map((d) => ({ date: d.date, allergens: d.allergens })),
    otherDays: other.length,
    eaten: [...eaten].map(([allergen, e]) => ({ allergen, ...e })).sort((a, b) => b.days - a.days),
    aware,
  };
}
