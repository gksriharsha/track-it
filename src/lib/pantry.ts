/**
 * How the pantry says its figures: amounts in the unit a container is read
 * in, dates as a person says them, and why a figure is not there yet.
 */
import { shiftIso, todayIso } from "../api";
import type { ContainerStretch, ContainerUnit, LastFigure, PantryWaiting, ReadBy } from "../types";

/** The pantry's figures cover this many days, today included. */
export const PANTRY_DAYS = 90;

export function pantryPeriod(): { from: string; to: string } {
  const to = todayIso();
  return { from: shiftIso(to, -(PANTRY_DAYS - 1)), to };
}

/** A weight or volume as it is read: whole numbers from 10 up, one decimal below. */
export function amount(v: number): string {
  const r = Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  return r.toLocaleString();
}

/** "1,214 g", "640 ml". A stored figure, in the unit it was stored in. */
export function figure(v: number, unit: "g" | "ml"): string {
  return `${amount(v)} ${unit}`;
}

/**
 * A figure in ml as a measuring cup says it, to the nearest quarter: "about
 * 1 cup", "about 1¾ cups", or "under ¼ cup" for less than one mark.
 */
export function cups(ml: number, cupMl: number): string {
  const c = ml / cupMl;
  const whole = Math.floor(c + 1e-9);
  const quarters = Math.round((c - whole) * 4);
  const frac = ["", "¼", "½", "¾", ""][quarters];
  const w = quarters === 4 ? whole + 1 : whole;
  if (w === 0 && frac === "") return "under ¼ cup";
  const text = `${w > 0 ? w : ""}${frac}`;
  return `about ${text} ${w > 1 || (w === 1 && frac !== "") ? "cups" : "cup"}`;
}

/** The unit a container's reading opens in. */
export function readingUnit(readBy: ReadBy): ContainerUnit {
  return readBy === "marks" ? "ml" : "g";
}

/** "On the scale" or "Read by its marks". */
export function howRead(readBy: ReadBy): string {
  return readBy === "marks" ? "Read by its marks" : "On the scale";
}

/** "28 Sep". */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "today", "yesterday", "5 days ago", or the date once it is a fortnight back. */
export function ago(iso: string): string {
  const today = todayIso();
  if (iso === today) return "today";
  if (iso === shiftIso(today, -1)) return "yesterday";
  for (let n = 2; n < 14; n++) if (iso === shiftIso(today, -n)) return `${n} days ago`;
  return shortDate(iso);
}

/** A container's last figure, as its row shows it. */
export function lastLine(last: LastFigure | null): { value: string; when: string } | null {
  if (!last) return null;
  const when = last.kind === "poured_in" ? `poured in ${ago(last.on)}` : ago(last.on);
  return { value: figure(last.amount, last.unit), when };
}

/** Why a food or a container has no figures yet, in a sentence. */
export function waitingLine(waiting: PantryWaiting, containerName: string, food: string): string {
  switch (waiting) {
    case "tare":
      return `Nothing counted yet. Weigh the empty ${containerName.toLowerCase()} once to start.`;
    case "density":
      return `Nothing counted yet. It needs ${food.toLowerCase()}'s weight per ml.`;
    case "reading":
      return "Record a reading after some cooking to start.";
    case "to_taste":
      return `Nothing added by feel to compare yet. Mark ${food.toLowerCase()} to taste in a recipe.`;
  }
}

/** One figure of a stretch, in the unit its container is read in where that is known. */
export function used(
  s: ContainerStretch,
  readBy: ReadBy,
): { raw: number; value: string; unit: "g" | "ml" } | null {
  const pick = (raw: number, unit: "g" | "ml") => ({ raw, value: amount(raw), unit });
  if (readBy === "marks" && s.used_ml !== null) return pick(s.used_ml, "ml");
  if (s.used_g !== null) return pick(s.used_g, "g");
  if (s.used_ml !== null) return pick(s.used_ml, "ml");
  return null;
}
