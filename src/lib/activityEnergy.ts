/**
 * A rough figure for the energy a logged activity used, for the day's
 * Activity card (D26).
 *
 * The standard method, and the one every published table assumes: an
 * activity's MET (how many times the energy of sitting still it takes) times
 * body weight times hours, with 1 MET taken as 1 kcal per kg per hour. One MET
 * is subtracted first, so the figure is only what the activity used ABOVE
 * resting. Resting energy is already in the day's estimate, and counting it
 * again here would put the same hours in twice.
 *
 * Two things this figure is not:
 * - Precise. MET values describe an average adult doing the activity, and
 *   effort here is the person's own talk-test call. Between people, measured
 *   METs spread by about 12% for walking or running at a set pace and 20–28%
 *   for sports (Kozey et al. 2010), before any error in the minutes logged, so
 *   for one person it is out by about a third either way. The card says so,
 *   and rounds to the nearest 10 kcal so it never looks more exact than it is.
 * - Part of the day's energy. Nothing here is added to or taken off the figure
 *   for what was eaten: the energy estimate already allows for usual exercise
 *   through the activity level in About you, and taking a walk off a meal is
 *   the budget the app does not keep.
 */
import type { ActivityKind, Effort, Session } from "./activity";

/**
 * METs from the 2024 Adult Compendium of Physical Activities (Herrmann et al.,
 * J Sport Health Sci 2024; pacompendium.com), one entry per kind and effort:
 * the entry that best fits that talk-test level, never an average of several,
 * which the Compendium asks its users not to make. The code beside each is the
 * 2024 edition's own. Codes were reused between editions (01015 was "bicycling,
 * general" in 2011), so a code means nothing without its year.
 *
 * Where the Compendium marks a value as estimated rather than measured, the
 * comment says so. Where it has no entry at all, the row borrows the nearest
 * general one and says that too: there is no measured figure for Kathak, so a
 * dance session is counted as dance of that effort, not as Kathak.
 */
export const MET: Record<ActivityKind, Record<Effort, number>> = {
  // 17152 walking 3.2–3.9 km/h, slow; 17190 4.5–5.5 km/h, moderate pace; 17220 6.4–7.1 km/h, very brisk.
  walk: { light: 2.8, moderate: 3.8, vigorous: 5.5 },
  // 12020 jogging, self-selected pace; 12045 running 8.9–9.3 km/h; 12070 running 11.3 km/h.
  run: { light: 7.5, moderate: 9.0, vigorous: 11.0 },
  // 01015, 01016, 01017: bicycling at a self-selected easy, moderate and vigorous pace.
  cycle: { light: 4.3, moderate: 7.0, vigorous: 9.0 },
  // 18240 laps, freestyle, slow; 18290 crawl, medium speed; 18230 laps, freestyle, fast. By pace,
  // because the talk test does not work in water and the Compendium's own effort labels for swimming
  // do not agree with its paces.
  swim: { light: 5.8, moderate: 8.0, vigorous: 9.8 },
  // 02150 hatha; 02180 Surya Namaskar; 02160 power yoga (marked estimated). The one "high intensity"
  // hatha entry, 02153 at 8.0, is double every other yoga value with no study named, so it is not used.
  yoga: { light: 2.3, moderate: 3.5, vigorous: 4.0 },
  // 02054 weight training, multiple exercises, 8–15 reps; 02052 squats and deadlifts, slow or explosive
  // (marked estimated; there is no general moderate entry); 02050 power lifting or body building, vigorous.
  strength: { light: 3.5, moderate: 5.0, vigorous: 6.0 },
  // No general sport entry exists. 15660 table tennis; 15030 badminton, social; 15020 badminton,
  // competitive — badminton because the app's own hint names it. (Cricket, 15150, is 4.8.)
  sport: { light: 4.0, moderate: 5.5, vigorous: 7.0 },
  // 03040 ballroom, slow; 03033 folk dancing, moderate; 03012 ballet, modern or jazz, vigorous.
  dance: { light: 3.0, moderate: 5.0, vigorous: 6.8 },
  // Not Compendium entries. 4.0 is the moderate value WHO's GPAQ guide assigns; 2.5 sits inside the light
  // band (1.6–2.9); 6.0 is the floor of the vigorous band, below GPAQ's 8.0, which is meant for
  // population surveys and is high for one person.
  other: { light: 2.5, moderate: 4.0, vigorous: 6.0 },
};

/**
 * A strength session may be logged without how long it took: the sets are the
 * record, and the time is optional. Its length is then taken from its sets,
 * at this many minutes for each set with the rest after it: about half a
 * minute of lifting and a minute and a half of rest, the low end of the
 * ACSM's rest guidance (1–2 minutes for most sets, 2–3 for heavy lifts). It
 * leaves out warming up and moving between lifts, so it understates a
 * session rather than inflating it.
 */
export const MINUTES_PER_SET = 2;

/** The effort a session with none recorded is taken at. Only strength can have none. */
const UNSAID: Effort = "moderate";

export interface EnergyGuess {
  /** Above resting, rounded to the nearest 10 kcal; never below 10. */
  kcal: number;
  /** True when the minutes were taken from the sets rather than logged. */
  fromSets: boolean;
}

/** The unrounded figure and how its minutes were found, or null when there is nothing to go on. */
function raw(s: Session, weightKg: number): { kcal: number; fromSets: boolean } | null {
  let minutes = s.minutes;
  let fromSets = false;
  if (minutes === null && s.kind === "strength" && s.sets.length > 0) {
    minutes = s.sets.length * MINUTES_PER_SET;
    fromSets = true;
  }
  if (minutes === null || !(minutes > 0)) return null;
  const met = MET[s.kind][s.effort ?? UNSAID];
  return { kcal: (met - 1) * weightKg * (minutes / 60), fromSets };
}

function round10(kcal: number): number {
  return Math.max(10, Math.round(kcal / 10) * 10);
}

function usable(weightKg: number | null): weightKg is number {
  return weightKg !== null && Number.isFinite(weightKg) && weightKg > 0;
}

/** One session's figure; null with no weight on file, or no time and no sets. */
export function energyUsed(s: Session, weightKg: number | null): EnergyGuess | null {
  if (!usable(weightKg)) return null;
  const r = raw(s, weightKg);
  return r === null ? null : { kcal: round10(r.kcal), fromSets: r.fromSets };
}

/**
 * The day's figure: the sessions summed before rounding, so three walks of
 * 14 kcal read as 40, not 30. Null when no session has a figure.
 */
export function dayEnergy(sessions: Session[], weightKg: number | null): EnergyGuess | null {
  if (!usable(weightKg)) return null;
  let kcal = 0;
  let any = false;
  let fromSets = false;
  for (const s of sessions) {
    const r = raw(s, weightKg);
    if (r === null) continue;
    any = true;
    kcal += r.kcal;
    fromSets ||= r.fromSets;
  }
  return any ? { kcal: round10(kcal), fromSets } : null;
}

/** "about 90 kcal", with a non-breaking space so the unit never wraps alone. */
export function kcalText(kcal: number): string {
  return `about ${kcal.toLocaleString("en-GB")} kcal`;
}
