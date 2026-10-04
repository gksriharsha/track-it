/**
 * A food that comes in several forms, said once.
 *
 * USDA lists one food several times over — "Mungo beans, mature seeds, raw",
 * "…cooked, boiled, without salt" — and search used to show them as rows that
 * differed only in their last words. Search now returns ONE entry for such a
 * food, carrying its forms, and the form is chosen once, at the scale, where
 * the grams are set ("Pick at the scale"). What the list says about the
 * entry, what a chip says, which form an ingredient picker takes, and what
 * the window keeps when the form changes are worked out here, away from
 * React, so they can be held to by a test.
 *
 * Bare Node runs this file's test (`foodForms.test.ts`), so its imports carry
 * their `.ts`.
 */
import type { FoodFamily, FoodForm, FoodHit } from "../types.ts";
import { digitsOf, readingOf } from "./amount.ts";
import type { Readout } from "./amount.ts";

/** The two fields that name a hit. `name` is missing on older shapes and the fixture. */
type Named = Pick<FoodHit, "name" | "description">;

/**
 * What a row is called: the family's name, or a single food's tidied one.
 * A custom food has no `name` and keeps its own. The full USDA description is
 * never thrown away — the amount panel's foot and every logged entry carry
 * it — it is only not what a list leads with.
 *
 * The same for what has been logged: an entry on a day, a line of a dish and
 * a quick-add chip carry the backend's short name for a reference food
 * ("Mungo beans, boiled"), and null for everything that has a name of its own.
 */
export function displayName(hit: Named): string {
  return hit.name ?? hit.description;
}

/**
 * The hit's forms when it comes in two or more, under the name they share;
 * otherwise null, and the hit is one food like any other.
 */
export function familyOf(hit: Named & Pick<FoodHit, "forms">): FoodFamily | null {
  const forms = hit.forms ?? [];
  return forms.length >= 2 ? { name: displayName(hit), forms } : null;
}

/**
 * What a form's chip says: its label with a capital, "Boiled, salted". A
 * form whose description is nothing but the food's name has no label of its
 * own; its description is then the chip, and is short for the same reason.
 * USDA's survey abbreviations keep USDA's capitals — "NFS", not "Nfs", which
 * reads as a typo.
 */
export function formLabel(form: FoodForm): string {
  return capital(said(form.label.trim() === "" ? form.description : form.label));
}

/**
 * Whether the family's name is one form's full description: what the backend
 * falls back to when two entries on screen would otherwise share a name. The
 * name then belongs to that form alone, and must not stand over the others.
 */
function nameIsAForm(family: FoodFamily): boolean {
  return family.forms.some((f) => f.description === family.name);
}

/**
 * What a family is called while `form` is the one chosen: the name the forms
 * share, or — where that name is one form's own description — the chosen
 * form's description, so a title never names the form that was switched away
 * from.
 */
export function familyTitle(family: FoodFamily, form: FoodForm): string {
  return nameIsAForm(family) ? form.description : family.name;
}

/**
 * The quiet line under a family's row, naming its forms in form order:
 * "Raw or boiled", "Raw, stir-fried or boiled", "Raw, boiled and 6 more".
 *
 * Only the first word takes a capital — it is one phrase, not a list of
 * titles. A label may carry a comma of its own ("canned, drained"), and a
 * comma inside a name that is itself separated from the next by commas would
 * read as two forms; so a list that would put one there is said shorter
 * instead, with fewer names before "and N more". The last name is set off by
 * "or" and may keep its comma.
 */
export function formsLine(forms: readonly FoodForm[]): string {
  const labels = forms.map((f) => said(f.label.trim() === "" ? f.description : f.label));
  if (labels.length === 0) return "";
  if (labels.length === 1) return capital(labels[0]);
  const plain = (s: string) => !s.includes(",");
  if (labels.length <= 3 && labels.slice(0, -1).every(plain)) {
    return capital(`${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`);
  }
  const heads = plain(labels[0]) && plain(labels[1]) ? labels.slice(0, 2) : labels.slice(0, 1);
  return capital(`${heads.join(", ")} and ${labels.length - heads.length} more`);
}

/**
 * One form called by the family's name and its own label, "Mungo beans, raw":
 * what an ingredient tile says, where the form is part of what the line is.
 * A family named by one form's description has no shared name to build on,
 * so each form is then called by its own description — and so is a form
 * whose chip already is its description, lower-cased because two labels
 * read alike ("Yardlong bean, yardlong bean, raw" would say the name twice).
 * The backend names a logged entry by the same rule (`Index::entry_name`).
 */
export function formName(family: FoodFamily, form: FoodForm): string {
  if (nameIsAForm(family) || chipIsDescription(form)) return form.description;
  return form.label.trim() === "" ? family.name : `${family.name}, ${said(form.label)}`;
}

/**
 * Whether a form's chip fell back to its whole description, read the way the
 * backend wrote it (`tidy::norm`): lower case, the food-programme note gone,
 * one space between words.
 */
function chipIsDescription(form: FoodForm): boolean {
  const norm = form.description
    .toLowerCase()
    .replace(/ \(includes foods for usda's food distribution program\)/g, "")
    .replace(/boiled\. drained/g, "boiled, drained")
    .split(/\s+/)
    .filter((w) => w !== "")
    .join(" ");
  return form.label !== "" && form.label === norm;
}

/**
 * How near a form is to the state a recipe weighs its ingredients in, from
 * its label alone: 0 says so outright ("raw", "dry", "unroasted"), 1 says
 * nothing either way ("canned, drained", "enriched", a form with no label),
 * 2 says it was cooked or is a dish as eaten ("boiled", "from dried, no added
 * fat", "NFS").
 *
 * Read from the words, not from where the form sits: the backend's form order
 * puts the uncooked forms first for most foods, but not for all — a survey
 * family may lead with "salted", a survey row with no label of its own may
 * sort ahead of the SR "raw" one — and a recipe weighed off a cooked row
 * would be wrong by the water it took up, in history that cannot be changed.
 */
export function rawness(label: string): 0 | 1 | 2 {
  const l = label.toLowerCase();
  const words = new Set(l.match(/[a-z]+/g) ?? []);
  const segs = l.split(/[,;]/).map((s) => s.trim());
  if (COOKED_WORDS.some((w) => words.has(w)) || COOKED_PHRASES.some((p) => l.includes(p))) return 2;
  // A survey row told from an SR row of the same name by nothing else: the
  // survey records what was eaten, the SR row the food as bought.
  if (segs.includes("survey")) return 2;
  if (segs.some((s) => UNCOOKED.includes(s))) return 0;
  return 1;
}

/** Words that say a form was cooked: whole words, so "unroasted" and "uncooked" are not among them. */
const COOKED_WORDS = [
  "boiled", "cooked", "steamed", "baked", "roasted", "fried", "microwaved", "microwave", "sauteed",
  "braised", "simmered", "grilled", "broiled", "stewed", "poached", "toasted", "heated", "scrambled",
  // "Not further specified": a survey code, and every survey row is a food as eaten.
  "nfs",
];
/** Phrases only a survey's cooked dishes carry: how it was made, and what with. */
const COOKED_PHRASES = [
  "fat added", "no added fat", "made with", "with oil", "with butter", "ns as to fat", "ns as to form",
  "as ingredient", "from dried", "from canned", "from frozen", "from fresh",
];
/** Segments that say a form is as it went on the scale before any cooking. */
const UNCOOKED = ["raw", "dry", "uncooked", "unroasted", "unprepared", "as purchased"];

/** What an ingredient line stores, and what its tile is called. */
export interface Ingredient {
  fdcId: number | null;
  ownId: string | null;
  /** The full USDA description, or the user's own food's name: what is saved. */
  description: string;
  /** What the tile says. */
  name: string;
}

type Pickable = Pick<FoodHit, "kind" | "fdc_id" | "custom_food_id" | "description" | "name" | "forms">;

/**
 * The food an ingredient picker takes from a hit.
 *
 * A recipe, a pot or a jar is weighed raw, because that is the one state each
 * ingredient can go on a scale in. So of a food in several forms it takes:
 *
 * - the form the words typed name, where they name one the others are not
 *   ("chickpeas canned", "spinach frozen", "urad dal raw") — what was typed
 *   is a choice already made, and is not asked again;
 * - of those, or of all the forms where nothing was named, the ones nearest
 *   raw (`rawness`), never a cooked one while an uncooked one is there;
 * - of those, the form the hit opens on where it is one of them — the form
 *   this person used last, or the one the Indian name typed points at, with
 *   its note — and otherwise the first in form order with no salt added.
 *
 * The form the hit opens on is NOT taken when it is further from raw: the
 * boiled form logged last at the Food screen was eaten, not weighed into a
 * pot. A food with no uncooked form at all — a survey's cooked dishes — goes
 * in on the form it opens on, which the tile then names; `rawFirst` puts such
 * a food after the ones that have one. The full description is what is
 * stored; the short name is only shown.
 */
export function ingredientOf(hit: Pickable, query = ""): Ingredient {
  if (hit.kind === "custom") {
    return { fdcId: null, ownId: hit.custom_food_id, description: hit.description, name: hit.description };
  }
  const family = familyOf(hit);
  if (family !== null) {
    const named = namedBy(query, family.forms);
    const pool = nearestRaw(named.length > 0 ? named : family.forms);
    // The backend opens on the first form when it knows nothing better, so
    // only another form says anything about this person or the name typed.
    const told = hit.fdc_id !== family.forms[0].fdc_id ? pool.find((f) => f.fdc_id === hit.fdc_id) : undefined;
    // Else no salt added, where the forms differ by that: the pot gets its
    // salt from the pantry, which counts it there.
    const form = told ?? [...pool.filter((f) => !salted(f.label)), ...pool.filter((f) => salted(f.label))][0];
    return { fdcId: form.fdc_id, ownId: null, description: form.description, name: formName(family, form) };
  }
  return { fdcId: hit.fdc_id, ownId: null, description: hit.description, name: displayName(hit) };
}

/** The forms at the lowest `rawness` among these, in their order. */
function nearestRaw(forms: readonly FoodForm[]): FoodForm[] {
  const best = Math.min(...forms.map((f) => rawness(f.label)));
  return forms.filter((f) => rawness(f.label) === best);
}

/** Whether a label says salt was added: "salted", "lightly salted", "with salt added" — not "no salt added". */
function salted(label: string): boolean {
  const l = label.toLowerCase();
  if (/\b(unsalted|no salt|without salt|no added salt|without added salt)\b/.test(l)) return false;
  return /\b(salted|salt added|with salt|added salt|sodium added)\b/.test(l);
}

/**
 * The forms the words typed single out: those whose descriptions carry every
 * typed word that some forms' descriptions carry and others' do not, each
 * word matched as the start of one of theirs, as the search matches it.
 * Words every form shares ("chickpeas") or none has (an Indian name that
 * reached the food through its alias) single nothing out. Empty when nothing
 * was named, or when no form carries all that was.
 */
function namedBy(query: string, forms: readonly FoodForm[]): FoodForm[] {
  const wordsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const has = (f: FoodForm, term: string) => wordsOf(f.description).some((w) => w.startsWith(term));
  const telling = wordsOf(query).filter((t) => {
    const n = forms.filter((f) => has(f, t)).length;
    return n > 0 && n < forms.length;
  });
  if (telling.length === 0) return [];
  return forms.filter((f) => telling.every((t) => has(f, t)));
}

/**
 * Hits in the order an ingredient picker shows them: a food that offers a
 * form to weigh raw before one that is only ever cooked — the SR
 * "Chickpeas", dry, ahead of the survey's cooked chickpea dishes — and
 * otherwise as search ranked them. The user's own foods are never moved (they
 * lead, as everywhere), nor a food an Indian name matched, which leads with
 * its note; nothing is dropped, only put after.
 */
export function rawFirst<T extends Pick<FoodHit, "kind" | "matched_alias" | "forms">>(hits: readonly T[]): T[] {
  const cookedOnly = (h: T) => h.kind !== "custom" && !h.matched_alias
    && (h.forms ?? []).length >= 2 && (h.forms ?? []).every((f) => rawness(f.label) === 2);
  return [...hits.filter((h) => !cookedOnly(h)), ...hits.filter(cookedOnly)];
}

/**
 * A serving chip as the window needs it to follow a change of form: what the
 * portion is called with its weight left off — "1 cup", or "100 g" for one
 * that is nothing but a weight — and what it weighs.
 */
export interface NamedServing {
  name: string;
  amount: number;
}

/**
 * The window after the form changes under it.
 *
 * A reading typed or kept is the person's own — the food on the scale did
 * not change because a chip did — so it stays, and so do the vessels ticked
 * under it. A serving chosen is a portion of the OLD form: a cup of raw mungo
 * beans is 207 g and a cup of boiled ones 180 g, so it becomes the portion of
 * the new form with the same name, or, where the new form has none, the new
 * form's own starting figure. A guess was only ever the old form's, and is
 * replaced by the new one's.
 */
export function readoutOnSwitch(r: Readout, was: readonly NamedServing[], now: readonly NamedServing[],
  guess: number): Readout {
  if (r.from === "typed" || r.from === "kept") return r;
  if (r.from === "serving") {
    const reading = readingOf(r.digits);
    // Which chip it was, by the test the chips themselves use to show pressed.
    const chosen = was.find((s) => reading !== null && Math.round(s.amount * 10) / 10 === reading);
    const same = chosen === undefined ? undefined : now.find((s) => s.name === chosen.name);
    if (same !== undefined) return { digits: digitsOf(same.amount), from: "serving" };
  }
  return { digits: digitsOf(guess), from: "guess" };
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A label as USDA spells its survey abbreviations: "NFS", "NS as to form". */
function said(label: string): string {
  return label.replace(/\b(nfs|ns)\b/g, (w) => w.toUpperCase());
}
