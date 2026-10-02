/**
 * Activity and strength sessions: the shapes the backend hands over, the words
 * the screens use for them, and one typed wrapper per command.
 *
 * Kept in its own module rather than appended to `types.ts` and `api.ts`.
 * Nothing in it is about food, and those two files are where every feature in
 * this app meets every other one — so the less of this that lives there, the
 * less it collides with work going on beside it. See `docs/decisions.md` D26.
 *
 * Named `Session`, never `Activity`: `Activity` already means the profile's
 * activity LEVEL, the factor the energy estimate is multiplied by, and the two
 * must not be confused — a logged walk never changes that figure.
 */
import { invoke } from "./bridge";

export type ActivityKind =
  | "walk" | "run" | "cycle" | "swim" | "yoga" | "strength" | "sport" | "dance" | "other";
export type Effort = "light" | "moderate" | "vigorous";
export type Load = "weight" | "body" | "time";

/** In the order the chips are drawn: the commonest first, strength among them. */
export const KINDS: { id: ActivityKind; label: string; effort: Effort; name?: string }[] = [
  { id: "walk", label: "Walk", effort: "moderate" },
  { id: "run", label: "Run", effort: "vigorous" },
  { id: "cycle", label: "Cycle", effort: "moderate" },
  { id: "swim", label: "Swim", effort: "moderate" },
  { id: "yoga", label: "Yoga", effort: "light" },
  { id: "strength", label: "Strength", effort: "moderate" },
  { id: "sport", label: "Sport", effort: "moderate", name: "Badminton, cricket…" },
  { id: "dance", label: "Dance", effort: "moderate", name: "Kathak, Zumba…" },
  { id: "other", label: "Other", effort: "moderate", name: "What was it?" },
];

export const KIND_LABEL: Record<ActivityKind, string> = Object.fromEntries(
  KINDS.map((k) => [k.id, k.label]),
) as Record<ActivityKind, string>;

/**
 * The talk test, in the words a person would use. Stored under the WHO's own
 * terms so the reference line can cite them; shown as these.
 */
export const EFFORTS: { id: Effort; label: string; test: string }[] = [
  { id: "light", label: "Easy", test: "You could sing." },
  { id: "moderate", label: "Moderate", test: "You can talk, but not sing." },
  { id: "vigorous", label: "Hard", test: "Only a few words at a time." },
];

export const EFFORT_LABEL: Record<Effort, string> = {
  light: "easy",
  moderate: "moderate",
  vigorous: "hard",
};

export const LOADS: { id: Load; label: string }[] = [
  { id: "weight", label: "Weights" },
  { id: "body", label: "Bodyweight" },
  { id: "time", label: "Held" },
];

export interface SessionSet {
  id: string;
  position: number;
  exercise_id: string;
  /** As it was when the set was written. */
  exercise_name: string;
  load: Load;
  reps: number | null;
  load_kg: number | null;
  seconds: number | null;
}

export interface Session {
  id: string;
  logged_on: string;
  kind: ActivityKind;
  label: string | null;
  minutes: number | null;
  effort: Effort | null;
  note: string | null;
  /** Set when it was edited after its own day. */
  corrected_at: string | null;
  sets: SessionSet[];
}

export interface SessionInput {
  id: string | null;
  logged_on: string;
  kind: ActivityKind;
  label: string | null;
  minutes: number | null;
  effort: Effort | null;
  note: string | null;
}

export interface SetFigures {
  reps: number | null;
  load_kg: number | null;
  seconds: number | null;
}

export interface ExerciseRef {
  /** Null to find a lift by name, or to make it. */
  id: string | null;
  name: string;
  load: Load;
}

export interface ExerciseHit {
  /** Null for a common lift never logged here yet. */
  id: string | null;
  name: string;
  load: Load;
  /** One of the person's own lifts, which rank first. */
  own: boolean;
  last_sets: SetFigures[];
  last_on: string | null;
}

export interface RecentSession {
  kind: ActivityKind;
  label: string | null;
  minutes: number | null;
  effort: Effort | null;
  last_on: string;
  /** For strength, the lifts of that session. */
  exercises: { id: string; name: string; load: Load }[];
}

export interface Week {
  /** 0 is the week ending on the period's last day. */
  index: number;
  /** Seven is a whole week of tracking; fewer, it began before the person started. */
  tracked_days: number;
  minutes: number;
  aerobic_minutes: number;
  active_days: number;
  strength_days: number;
}

export interface Typical {
  weeks: number;
  minutes: number;
  aerobic_minutes: number;
  active_days: number;
  strength_days: number;
}

export interface ExerciseRange {
  exercise_id: string;
  name: string;
  load: Load;
  summary: {
    sessions: number;
    usual: SetFigures | null;
    heaviest: SetFigures | null;
  };
}

export interface ActivityRange {
  from: string;
  to: string;
  span_days: number;
  tracked_since: string | null;
  /** Most recent first. */
  weeks: Week[];
  typical: Typical | null;
  sessions: number;
  by_kind: { kind: ActivityKind; sessions: number }[];
  exercises: ExerciseRange[];
  profile_activity: string | null;
  birth_year: number | null;
}

/* ── commands ──────────────────────────────────────────────────────────── */

export const listSessions = (loggedOn: string) =>
  invoke<Session[]>("list_activities", { loggedOn });

export const getSession = (id: string) => invoke<Session>("get_activity", { id });

/** A walk, a swim, a class — or a strength session's own fields. */
export const saveSession = (activity: SessionInput) =>
  invoke<string>("save_activity", { activity });

export const deleteSession = (id: string) => invoke<void>("delete_activity", { id });

/**
 * Said on the window when a session changes somewhere other than the screen
 * showing it: an Undo in the app's bar outlives the Activity tab it was raised
 * on, so it can be pressed on Today, under a card that would otherwise go on
 * listing the walk it just took away.
 */
export const ACTIVITY_CHANGED = "trackit:activity";
export const sayActivityChanged = () => window.dispatchEvent(new Event(ACTIVITY_CHANGED));

/**
 * Write one set, the moment it is entered. With no `activityId` this makes
 * the strength session too, so nothing has to be saved at the end.
 */
export const addSet = (
  activityId: string | null,
  loggedOn: string,
  exercise: ExerciseRef,
  set: SetFigures,
) =>
  invoke<{ activity_id: string; set: SessionSet }>("add_activity_set", {
    activityId,
    loggedOn,
    exercise,
    set,
  });

export const updateSet = (setId: string, set: SetFigures) =>
  invoke<void>("update_activity_set", { setId, set });

/** True when the session went with its last set. */
export const deleteSet = (setId: string) => invoke<boolean>("delete_activity_set", { setId });

export const recentSessions = (limit = 6) =>
  invoke<RecentSession[]>("recent_activities", { limit });

/** `session` is left out of "last time", so the set just written is not it. */
export const findExercises = (query: string, session: string | null) =>
  invoke<ExerciseHit[]>("find_exercises", { query, session });

export const getActivityRange = (from: string, to: string) =>
  invoke<ActivityRange>("get_activity_range", { from, to });

/* ── words ─────────────────────────────────────────────────────────────── */

/** "62.5", "60", with the app's own grouping; never "60.0". */
function kg(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** A space that never lets a set break across two lines. */
const NB = " ";

/**
 * One set, the way it is written in a notebook: `62.5 × 4`, `10 reps`, `60 s`.
 * A real multiplication sign, with spaces that do not break: a thin space read
 * as no space at all at the ledger's size, and "50×8" looked like a code.
 */
export function setText(s: SetFigures, load: Load, withUnit = false): string {
  if (load === "time") {
    const t = s.seconds === null ? "—" : seconds(s.seconds);
    return s.load_kg ? `${kg(s.load_kg)}${NB}kg, ${t}` : t;
  }
  const reps = s.reps ?? "—";
  if (s.load_kg === null || (load === "body" && s.load_kg === 0)) return `${reps}${NB}reps`;
  const head = load === "body" ? `+${kg(s.load_kg)}` : kg(s.load_kg);
  return `${head}${withUnit ? `${NB}kg` : ""}${NB}×${NB}${reps}`;
}

export function seconds(n: number): string {
  if (n < 60) return `${n} s`;
  const m = Math.floor(n / 60);
  const r = n % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

/** "35 min", "1 h 20 min" — minutes as a person reads them. */
export function minutesText(m: number): string {
  const r = Math.round(m);
  if (r < 60) return `${r} min`;
  const h = Math.floor(r / 60);
  const rest = r % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/** The one-line name of a session: its own label, or its kind. */
export function sessionTitle(s: { kind: ActivityKind; label: string | null }): string {
  return s.label ?? KIND_LABEL[s.kind];
}

/** What a session amounted to, for the line under its name. */
export function sessionSub(s: Session): string {
  if (s.kind === "strength") {
    const lifts = new Set(s.sets.map((x) => x.exercise_id)).size;
    const parts = [
      lifts === 1 ? "1 lift" : `${lifts} lifts`,
      s.sets.length === 1 ? "1 set" : `${s.sets.length} sets`,
    ];
    if (s.minutes !== null) parts.push(minutesText(s.minutes));
    return parts.join(", ");
  }
  const parts: string[] = [];
  if (s.minutes !== null) parts.push(minutesText(s.minutes));
  if (s.effort !== null) parts.push(EFFORT_LABEL[s.effort]);
  return parts.join(", ");
}

/** Sets grouped by lift, in the order each lift was first done. */
export function byLift(sets: SessionSet[]): { id: string; name: string; load: Load; sets: SessionSet[] }[] {
  const out: { id: string; name: string; load: Load; sets: SessionSet[] }[] = [];
  for (const s of sets) {
    let g = out.find((x) => x.id === s.exercise_id);
    if (!g) {
      g = { id: s.exercise_id, name: s.exercise_name, load: s.load, sets: [] };
      out.push(g);
    }
    g.sets.push(s);
  }
  return out;
}
