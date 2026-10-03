/**
 * Setting an amount the way a kitchen scale reads one: the keys, the window,
 * and what the bowl takes off.
 *
 * What is typed is always what the scale reads. With nothing ticked under the
 * food that is the food; with a bowl ticked it is the food and the bowl, and
 * the window shows what is left once the bowl's weight is taken off — the
 * figure that is logged. Typing first and ticking the bowl after works too:
 * the reading stays, and the bowl comes off it, as a scale's tare would.
 *
 * Bare Node runs this file's test (`amount.test.ts`), so its imports carry
 * their `.ts`.
 */
import type { DailyTotal, Vessel } from "../types.ts";

/**
 * The digits in the window, and where they came from.
 *
 *   typed    a reading being keyed in, which the next key adds to
 *   kept     a reading keyed in before a bowl was ticked under it: it stays,
 *            and the bowl comes off it, but the next key starts a new one
 *   serving  a serving the person picked, the food on its own
 *   guess    the app's own starting figure — half of what is left in a pot,
 *            a recipe's smallest helping — drawn faint, as one to correct
 *
 * Every one but `typed` is replaced by the next key rather than added to, the
 * way a calculator starts a new number after a result.
 */
export interface Readout {
  digits: string;
  from: "typed" | "kept" | "serving" | "guess";
}

export type Key = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "del";

/** The keypad, in the order it is drawn: three across, the point and delete on the last row. */
export const KEYS: readonly Key[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"];

/**
 * Up to 9999.9 g. A kitchen scale reads to the gram, some to a tenth of one,
 * and none of them as far as ten kilograms.
 */
const WHOLE_DIGITS = 4;
const DECIMALS = 1;

/** The window after one key. A key that would make no number a scale shows is ignored. */
export function press(r: Readout, key: Key): Readout {
  // A guess or a serving is replaced, not added to; delete clears it.
  const digits = r.from === "typed" ? r.digits : "";
  if (key === "del") return { digits: r.from === "typed" ? digits.slice(0, -1) : "", from: "typed" };
  if (key === ".") {
    if (digits.includes(".")) return { digits, from: "typed" };
    return { digits: digits === "" ? "0." : `${digits}.`, from: "typed" };
  }
  const [whole, frac] = digits.split(".");
  if (frac !== undefined) {
    return frac.length < DECIMALS ? { digits: digits + key, from: "typed" } : { digits, from: "typed" };
  }
  // No leading zeros: a scale reads "5", never "05".
  if (whole === "0") return { digits: key, from: "typed" };
  if (whole.length >= WHOLE_DIGITS) return { digits, from: "typed" };
  return { digits: digits + key, from: "typed" };
}

/**
 * The window as a vessel is ticked or unticked under the food.
 *
 * A reading keyed in already stays, and the vessel comes off it — the tare
 * taken after the fact — but the next key starts a new reading, since putting
 * a bowl on the scale is what changes what it shows. A guess or a serving was
 * never a reading, so there is nothing yet for a bowl to come off.
 */
export function ticking(r: Readout): Readout {
  if ((r.from === "typed" || r.from === "kept") && r.digits !== "") return { digits: r.digits, from: "kept" };
  return { digits: "", from: "typed" };
}

/**
 * Text pasted into the window, as digits it can hold — or null when it is no
 * amount at all. A comma is read as the decimal point, as many keyboards
 * write it; "180 g" and " 180 " are 180.
 */
export function pasted(text: string): string | null {
  const t = text.trim().replace(/\s*g$/i, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac] = t.split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  if (w.length > WHOLE_DIGITS) return null;
  return frac === undefined ? w : `${w}.${frac.slice(0, DECIMALS)}`;
}

/** An amount as the window starts on it: whole grams, or one decimal where it has one. */
export function digitsOf(grams: number): string {
  const r = Math.round(grams * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** What the digits read, or null when they read nothing a portion could be. */
export function readingOf(digits: string): number | null {
  if (digits === "" || digits === ".") return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The food's own weight: the reading, less whatever was under it. Null when
 * there is no reading yet, or when what was under the food accounts for all
 * of it — the backend's own refusal, said before anything is sent.
 */
export function netOf(reading: number | null, tareG: number): number | null {
  if (reading === null) return null;
  if (tareG <= 0) return reading;
  return reading > tareG ? Math.round((reading - tareG) * 10) / 10 : null;
}

/** What the window and the vessels ticked under the food come to. */
export interface Weighing {
  /** The vessels that come off, as the library has them now. */
  vesselIds: string[];
  tareG: number;
  /** What the scale reads, or null before anything is typed. */
  reading: number | null;
  /** What is logged: the food's own grams, or null when there is nothing to log. */
  net: number | null;
}

/**
 * The window, less the vessels ticked under the food. Resolved against the
 * live library, so a vessel deleted there drops out of the tare instead of
 * lingering as a weight with no name.
 */
export function weighing(r: Readout, ticked: readonly string[], vessels: readonly Vessel[]): Weighing {
  const sel = vessels.filter((v) => ticked.includes(v.id));
  const tareG = sel.reduce((a, v) => a + v.grams, 0);
  const reading = readingOf(r.digits);
  return { vesselIds: sel.map((v) => v.id), tareG, reading, net: netOf(reading, tareG) };
}

/**
 * A total per 100 g, at `grams`.
 *
 * Energy is in proportion to the mass eaten — every part of a portion, a
 * dish's ingredients included, is the same fraction of what was made — so
 * the bounds scale and nothing else moves: the coverage is a share of the
 * mass, and stays the share it was. This is what `aggregate::sum` makes of a
 * portion of any size; see `per_100g` in Rust, whose test holds the two to it.
 */
export function atGrams(t: DailyTotal, grams: number): DailyTotal {
  const k = grams / 100;
  return { ...t, lower: t.lower * k, upper: t.upper === null ? null : t.upper * k };
}

/**
 * The 5×7 dot patterns the window draws its figures in, as an instrument's
 * display does. Drawn rather than set in a face: Archivo is the app's one
 * typeface, and the window is a picture of a scale, not text.
 */
export const DOTS: Readonly<Record<string, readonly string[]>> = {
  "0": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  ".": [".", ".", ".", ".", ".", ".", "#"],
};
