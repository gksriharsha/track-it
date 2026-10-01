/**
 * Which drawing shows each lift, and which muscles each lift mainly works.
 *
 * Two different kinds of thing, kept apart on purpose. The drawings are Greg
 * Priday's, for Everkinetic, under CC BY-SA 3.0 — they live in
 * `src/assets/everkinetic/` with their licence and credits, and that licence
 * stops at that folder. Everything in THIS file is TrackIt's own: the choice of
 * drawing for each lift (`exerciseArt.json`, which `tools/everkinetic/
 * prepare.py` also reads to know which drawings to prepare) and the muscle
 * table below, written for this app and cross-checked against Everkinetic's
 * and free-exercise-db's own muscle fields. See docs/decisions.md D27.
 *
 * Keyed by the lift's name, normalised the way `trackit_core::activity::
 * name_key` normalises it, so a lift the user typed as "squat" gets the same
 * drawing as the common one, and a lift they invented gets none rather than a
 * guess.
 */
import entries from "./exerciseArt.json" with { type: "json" };

export interface LiftArt {
  lift: string;
  /** Everkinetic's id, e.g. "0122". */
  id: string;
  /** Which of the two frames is where the lift starts. */
  start: "relaxation" | "tension";
  /**
   * Set when the drawing is a close variant rather than the lift itself —
   * "Drawn seated" — so the picture never claims to be what it is not.
   */
  caption: string | null;
  /**
   * A hold rather than a movement. Looping a side plank's two frames reads as
   * hips dipping and lifting, which is a different exercise, so it is shown
   * still on its held frame.
   */
  still?: boolean;
}

export interface LiftMuscles {
  mostly: string[];
  also: string[];
}

/** The same normalisation as `trackit_core::activity::name_key`. */
export function nameKey(name: string): string {
  return name.trim().split(/\s+/).map((w) => w.toLowerCase()).join(" ");
}

const ART = new Map<string, LiftArt>(
  (entries as LiftArt[]).map((e) => [nameKey(e.lift), e]),
);

export function artFor(lift: string): LiftArt | null {
  return ART.get(nameKey(lift)) ?? null;
}

/** Every lift that has a drawing, for the checks in exerciseArt.test.ts. */
export function allArt(): LiftArt[] {
  return [...ART.values()];
}

/**
 * The muscles each common lift mainly works, in the words a lifter uses.
 *
 * "Mostly" is the prime movers, "also" the muscles that help or hold steady.
 * Deliberately short — at most three of each — because this is a reminder of
 * what a lift is for, not an anatomy lesson, and a list of eleven muscles
 * says nothing about which matter.
 */
export const MUSCLES: Record<string, LiftMuscles> = {
  "squat": { mostly: ["quads", "glutes"], also: ["adductors", "hamstrings", "lower back"] },
  "front squat": { mostly: ["quads", "glutes"], also: ["adductors", "upper back", "abs"] },
  "goblet squat": { mostly: ["quads", "glutes"], also: ["adductors", "abs"] },
  "deadlift": { mostly: ["glutes", "hamstrings", "lower back"], also: ["quads", "traps", "forearms"] },
  "romanian deadlift": { mostly: ["hamstrings", "glutes"], also: ["lower back", "forearms"] },
  "bench press": { mostly: ["chest", "triceps"], also: ["front shoulders"] },
  "incline bench press": { mostly: ["chest", "front shoulders"], also: ["triceps"] },
  "overhead press": { mostly: ["shoulders", "triceps"], also: ["traps", "abs"] },
  "barbell row": { mostly: ["upper back", "lats"], also: ["biceps", "rear shoulders", "lower back"] },
  "dumbbell row": { mostly: ["lats", "upper back"], also: ["biceps", "rear shoulders"] },
  "lat pulldown": { mostly: ["lats"], also: ["biceps", "upper back"] },
  "seated cable row": { mostly: ["upper back", "lats"], also: ["biceps", "rear shoulders"] },
  "leg press": { mostly: ["quads", "glutes"], also: ["adductors", "hamstrings"] },
  "leg curl": { mostly: ["hamstrings"], also: ["calves"] },
  "leg extension": { mostly: ["quads"], also: [] },
  "hip thrust": { mostly: ["glutes"], also: ["hamstrings", "quads"] },
  "calf raise": { mostly: ["calves"], also: [] },
  "lunge": { mostly: ["quads", "glutes"], also: ["hamstrings", "adductors"] },
  "bulgarian split squat": { mostly: ["quads", "glutes"], also: ["hamstrings", "adductors"] },
  "biceps curl": { mostly: ["biceps"], also: ["forearms"] },
  "triceps pushdown": { mostly: ["triceps"], also: [] },
  "lateral raise": { mostly: ["side shoulders"], also: ["traps", "front shoulders"] },
  "face pull": { mostly: ["rear shoulders", "upper back"], also: ["traps"] },
  "kettlebell swing": { mostly: ["glutes", "hamstrings"], also: ["lower back", "abs", "forearms"] },
  "pull-up": { mostly: ["lats"], also: ["biceps", "upper back"] },
  "chin-up": { mostly: ["lats", "biceps"], also: ["upper back"] },
  "push-up": { mostly: ["chest", "triceps"], also: ["front shoulders", "abs"] },
  "dip": { mostly: ["chest", "triceps"], also: ["front shoulders"] },
  "hanging leg raise": { mostly: ["abs", "hip flexors"], also: ["obliques", "forearms"] },
  "crunch": { mostly: ["abs"], also: ["obliques"] },
  "plank": { mostly: ["abs"], also: ["obliques", "shoulders", "glutes"] },
  "side plank": { mostly: ["obliques"], also: ["lower back", "glutes", "shoulders"] },
};

/*
  A Map, not the object above, for the lookup. A plain object answers for keys
  it inherits: a lift the user named "Constructor" would have come back as the
  Object function, and the muscle line would have thrown on it and blanked the
  app. A user's lift name is untrusted text.
*/
const MUSCLE_MAP = new Map<string, LiftMuscles>(Object.entries(MUSCLES));

export function musclesFor(lift: string): LiftMuscles | null {
  return MUSCLE_MAP.get(nameKey(lift)) ?? null;
}

/**
 * The part of the body a lift is filed under in the exercise picker, from the
 * first of its "mostly" muscles. Six places a lifter would look, not an anatomy
 * chart: a hip thrust is a legs lift and a face pull a shoulders one.
 */
export type Area = "legs" | "back" | "chest" | "shoulders" | "arms" | "core";

export const AREAS: { id: Area; label: string }[] = [
  { id: "legs", label: "Legs" },
  { id: "back", label: "Back" },
  { id: "chest", label: "Chest" },
  { id: "shoulders", label: "Shoulders" },
  { id: "arms", label: "Arms" },
  { id: "core", label: "Core" },
];

const AREA_OF: Record<string, Area> = {
  quads: "legs", glutes: "legs", hamstrings: "legs", adductors: "legs", calves: "legs",
  lats: "back", "upper back": "back", "lower back": "back", traps: "back",
  chest: "chest",
  shoulders: "shoulders", "front shoulders": "shoulders", "side shoulders": "shoulders", "rear shoulders": "shoulders",
  biceps: "arms", triceps: "arms", forearms: "arms",
  abs: "core", obliques: "core", "hip flexors": "core",
};

/** Null for a lift with no muscle row — the user's own, which shows under All only. */
export function areaFor(lift: string): Area | null {
  const m = musclesFor(lift);
  return m ? AREA_OF[m.mostly[0]] ?? null : null;
}

/** "quads", "quads and glutes", "adductors, hamstrings and lower back". */
function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "Quads and glutes" — the short form, for a row in a list. */
export function mostlyLine(m: LiftMuscles): string {
  const s = list(m.mostly);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Mostly quads and glutes. Also adductors, hamstrings and lower back." */
export function muscleLine(m: LiftMuscles): string {
  const mostly = `Mostly ${list(m.mostly)}.`;
  return m.also.length === 0 ? mostly : `${mostly} Also ${list(m.also)}.`;
}

/**
 * The credit the licence asks for, in the words the app prints it in.
 *
 * The licence's address is part of it, not decoration: CC BY-SA 3.0 asks for
 * its URI to travel with every copy, and the app is a copy. Each drawing also
 * carries the same notice inside its own file — see prepare.py.
 */
export const ART_LICENCE_URL = "creativecommons.org/licenses/by-sa/3.0";
export const ART_CREDIT =
  `Drawing by Greg Priday for Everkinetic (everkinetic.com), CC BY-SA 3.0, ${ART_LICENCE_URL}. Recoloured for TrackIt.`;
