/**
 * Which drawing shows each lift, and which muscles each lift mainly works.
 *
 * Two different kinds of thing, kept apart on purpose. The drawings are Greg
 * Priday's, for Everkinetic, under CC BY-SA 3.0 — they live in
 * `src/assets/everkinetic/` with their licence and credits, and that licence
 * stops at that folder. The few lifts his set has nothing for were drawn for
 * TrackIt and live apart from his, in `src/assets/figures/`, so neither is
 * ever credited with the other's work. Everything in THIS file is TrackIt's own: the choice of
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
  /**
   * Who drew it. Absent for Everkinetic's drawings, which are most of them;
   * "trackit" for the few lifts the set has nothing for, drawn for this app
   * in `src/assets/figures/` and never credited to Priday.
   */
  by?: "trackit";
  /** Everkinetic's id, e.g. "0122", or a TrackIt drawing's name, e.g. "face-pull". */
  id: string;
  /**
   * Everkinetic's only: which of its two frames is where the lift starts.
   * TrackIt's frames are named for what they show (`-start`, `-halfway`, or
   * `-held` for a hold), so they need no such key.
   */
  start?: "relaxation" | "tension";
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
 * The files a lift's frames are in, relative to `src/assets/`, start frame
 * first. A hold drawn for TrackIt has only its held frame, so no halfway; an
 * Everkinetic hold still has two on disk, of which the app shows the start.
 */
export function framesOf(a: LiftArt): { start: string; halfway: string | null } {
  if (a.by === "trackit") {
    return a.still
      ? { start: `figures/${a.id}-held.svg`, halfway: null }
      : { start: `figures/${a.id}-start.svg`, halfway: `figures/${a.id}-halfway.svg` };
  }
  const start = a.start ?? "relaxation";
  const other = start === "relaxation" ? "tension" : "relaxation";
  return { start: `everkinetic/${a.id}-${start}.svg`, halfway: `everkinetic/${a.id}-${other}.svg` };
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

/**
 * What a close-up says about who drew it. A drawing made for TrackIt must not
 * carry Priday's name: crediting an artist with work that is not theirs is as
 * wrong as leaving their name off their own.
 */
export function creditFor(a: LiftArt): string {
  return a.by === "trackit" ? "Drawn for TrackIt." : ART_CREDIT;
}

/**
 * "The face pull, kettlebell swing and plank were drawn for TrackIt, not by
 * him.", for the credits on the You screen, so the line that credits Priday
 * does not claim drawings that are not his. Empty when there are none.
 */
export function ownArtLine(): string {
  const own = allArt().filter((a) => a.by === "trackit").map((a) => a.lift.toLowerCase());
  if (own.length === 0) return "";
  return `The ${list(own)} ${own.length === 1 ? "was" : "were"} drawn for TrackIt, not by him.`;
}
