/**
 * Activity for the browser fixture (`pnpm dev`): nine weeks of a plausible
 * person, and writes that are kept for the life of the tab so the logging flow
 * can be walked through in a browser.
 *
 * Kept apart from `mock.ts` for the reason `activity.ts` is kept apart from
 * `api.ts`. Like the rest of the fixture it is deliberately uneven — a quiet
 * week, a run that happened once, a lift done twice — because a fixture where
 * every week looks alike hides what the Trends section is for.
 *
 * The arithmetic mirrors `trackit_core::activity` closely enough to draw the
 * screen, and no more. It is not a second implementation to be kept in step;
 * the real one is tested in Rust.
 */
import type {
  ActivityKind,
  ActivityRange,
  Effort,
  ExerciseHit,
  Load,
  RecentSession,
  Session,
  SessionInput,
  SessionSet,
  SetFigures,
  Week,
} from "./activity";

function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function today(): string {
  return iso(new Date());
}
function shift(on: string, days: number): string {
  const d = new Date(`${on}T12:00:00`);
  d.setDate(d.getDate() + days);
  return iso(d);
}
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000);
}
let seq = 0;
function uuid(): string {
  seq += 1;
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0").slice(-w);
  return `${hex(0xa1c0 + seq, 8)}-${hex(seq, 4)}-4${hex(seq, 3)}-8${hex(seq, 3)}-${hex(seq * 7919, 12)}`;
}

interface Lift {
  id: string;
  name: string;
  load: Load;
}

const LIFTS: Lift[] = [];
const SESSIONS: Session[] = [];

const COMMON: [string, Load][] = [
  ["Squat", "weight"], ["Front squat", "weight"], ["Goblet squat", "weight"], ["Deadlift", "weight"],
  ["Romanian deadlift", "weight"], ["Bench press", "weight"], ["Incline bench press", "weight"],
  ["Overhead press", "weight"], ["Barbell row", "weight"], ["Dumbbell row", "weight"],
  ["Lat pulldown", "weight"], ["Seated cable row", "weight"], ["Leg press", "weight"],
  ["Leg curl", "weight"], ["Leg extension", "weight"], ["Hip thrust", "weight"], ["Calf raise", "weight"],
  ["Lunge", "weight"], ["Bulgarian split squat", "weight"], ["Biceps curl", "weight"],
  ["Triceps pushdown", "weight"], ["Lateral raise", "weight"], ["Face pull", "weight"],
  ["Kettlebell swing", "weight"], ["Pull-up", "body"], ["Chin-up", "body"], ["Push-up", "body"],
  ["Dip", "body"], ["Hanging leg raise", "body"], ["Crunch", "body"], ["Plank", "time"],
  ["Side plank", "time"],
];

const key = (s: string) => s.trim().toLowerCase().split(/\s+/).join(" ");

function lift(name: string, load: Load): Lift {
  const found = LIFTS.find((l) => key(l.name) === key(name));
  if (found) return found;
  const l = { id: uuid(), name: name.trim().split(/\s+/).join(" "), load };
  LIFTS.push(l);
  return l;
}

function session(on: string, kind: ActivityKind, minutes: number | null, effort: Effort | null, label: string | null = null): Session {
  const s: Session = {
    id: uuid(), logged_on: on, kind, label, minutes, effort, note: null, corrected_at: null, sets: [],
  };
  SESSIONS.push(s);
  return s;
}

function sets(s: Session, l: Lift, figures: [number | null, number][]) {
  for (const [kg, reps] of figures) {
    s.sets.push({
      id: uuid(), position: s.sets.length, exercise_id: l.id, exercise_name: l.name, load: l.load,
      reps: l.load === "time" ? null : reps, load_kg: kg, seconds: l.load === "time" ? reps : null,
    });
  }
}

/* ── nine weeks of somebody ─────────────────────────────────────────────── */

(function seed() {
  const t = today();
  for (let back = 62; back >= 1; back--) {
    const on = shift(t, -back);
    const dow = new Date(`${on}T12:00:00`).getDay();
    const week = Math.floor(back / 7);
    // A quiet fortnight-old week: travel, by the look of it.
    if (week === 3 && dow !== 6) continue;
    if (dow === 1 || dow === 3 || dow === 5) session(on, "walk", 30 + ((back * 7) % 20), "moderate");
    if (dow === 0) session(on, "yoga", 45, "light");
    if (dow === 6 && back % 3 === 0) session(on, "sport", 60, "vigorous", "Badminton");
    if (dow === 2 || dow === 4) {
      const s = session(on, "strength", 50, null);
      const step = Math.floor((62 - back) / 14) * 2.5;
      sets(s, lift("Squat", "weight"), [[40 + step, 8], [50 + step, 5], [50 + step, 5], [50 + step, 5]]);
      if (dow === 2) sets(s, lift("Bench press", "weight"), [[30 + step / 2, 8], [35 + step / 2, 6], [35 + step / 2, 6]]);
      else sets(s, lift("Barbell row", "weight"), [[35 + step, 8], [35 + step, 8], [35 + step, 8]]);
      sets(s, lift("Plank", "time"), [[null, 45], [null, 45]]);
    }
  }
  session(shift(t, -9), "run", 25, "vigorous");
  // Today: a morning walk, so the Today card has something on it.
  session(t, "walk", 35, "moderate");
})();

/* ── reads ──────────────────────────────────────────────────────────────── */

const live = () => SESSIONS.filter((s) => s.kind !== "strength" || s.minutes !== null || s.sets.length > 0);

function top(sets: SetFigures[]): SetFigures | null {
  let best: SetFigures | null = null;
  for (const s of sets) {
    if (
      best === null ||
      (s.load_kg ?? 0) > (best.load_kg ?? 0) ||
      ((s.load_kg ?? 0) === (best.load_kg ?? 0) &&
        ((s.reps ?? 0) > (best.reps ?? 0) || ((s.reps ?? 0) === (best.reps ?? 0) && (s.seconds ?? 0) > (best.seconds ?? 0))))
    ) best = s;
  }
  return best;
}

function rank(a: SetFigures, b: SetFigures): number {
  return (a.load_kg ?? 0) - (b.load_kg ?? 0) || (a.reps ?? 0) - (b.reps ?? 0) || (a.seconds ?? 0) - (b.seconds ?? 0);
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

function range(from: string, to: string): ActivityRange {
  const span = daysBetween(from, to) + 1;
  const all = live().filter((s) => s.logged_on <= to);
  const first = all.map((s) => s.logged_on).sort()[0] ?? null;
  const since = first === null ? null : daysBetween(first, to);
  const inside = all.filter((s) => s.logged_on >= from);
  const weeks: Week[] = [];
  if (since !== null) {
    for (let i = 0; i < Math.floor(span / 7); i++) {
      const lo = i * 7;
      if (lo > since) break;
      const these = inside.filter((s) => {
        const d = daysBetween(s.logged_on, to);
        return d >= lo && d <= lo + 6;
      });
      const days = (pred: (s: Session) => boolean) => new Set(these.filter(pred).map((s) => s.logged_on)).size;
      weeks.push({
        index: i,
        tracked_days: Math.min(since, lo + 6) - lo + 1,
        minutes: these.reduce((n, s) => n + (s.minutes ?? 0), 0),
        aerobic_minutes: these.reduce(
          (n, s) => n + (s.kind === "strength" ? 0 : s.effort === "moderate" ? s.minutes ?? 0 : s.effort === "vigorous" ? 2 * (s.minutes ?? 0) : 0),
          0,
        ),
        active_days: days(() => true),
        strength_days: days((s) => s.kind === "strength"),
      });
    }
  }
  const whole = weeks.filter((w) => w.tracked_days === 7);
  const kinds = new Map<ActivityKind, number>();
  for (const s of inside) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  const tops = new Map<string, SetFigures[]>();
  for (const s of inside.filter((x) => x.kind === "strength")) {
    for (const id of new Set(s.sets.map((x) => x.exercise_id))) {
      const t = top(s.sets.filter((x) => x.exercise_id === id));
      if (t) tops.set(id, [...(tops.get(id) ?? []), t]);
    }
  }
  return {
    from, to, span_days: span, tracked_since: first, weeks,
    typical: whole.length === 0 ? null : {
      weeks: whole.length,
      minutes: median(whole.map((w) => w.minutes)),
      aerobic_minutes: median(whole.map((w) => w.aerobic_minutes)),
      active_days: median(whole.map((w) => w.active_days)),
      strength_days: median(whole.map((w) => w.strength_days)),
    },
    sessions: inside.length,
    by_kind: [...kinds.entries()].map(([kind, sessions]) => ({ kind, sessions })).sort((a, b) => b.sessions - a.sessions),
    exercises: [...tops.entries()].map(([id, t]) => {
      const l = LIFTS.find((x) => x.id === id)!;
      const sorted = [...t].sort(rank);
      return {
        exercise_id: id, name: l.name, load: l.load,
        summary: {
          sessions: t.length,
          usual: t.length >= 3 ? sorted[Math.floor((t.length - 1) / 2)] : null,
          heaviest: sorted[sorted.length - 1] ?? null,
        },
      };
    }).sort((a, b) => b.summary.sessions - a.summary.sessions || a.name.localeCompare(b.name)),
    profile_activity: "light",
    birth_year: 1994,
  };
}

function lastSets(liftId: string, excluding: string | null): { sets: SetFigures[]; on: string | null } {
  const s = live()
    .filter((x) => x.id !== excluding && x.sets.some((y) => y.exercise_id === liftId))
    .sort((a, b) => (a.logged_on < b.logged_on ? 1 : -1))[0];
  if (!s) return { sets: [], on: null };
  return {
    sets: s.sets.filter((y) => y.exercise_id === liftId).map(({ reps, load_kg, seconds }) => ({ reps, load_kg, seconds })),
    on: s.logged_on,
  };
}

function find(query: string, excluding: string | null): ExerciseHit[] {
  const k = key(query);
  const used = (id: string) =>
    live().filter((s) => s.sets.some((x) => x.exercise_id === id)).map((s) => s.logged_on).sort().pop() ?? "";
  const own: ExerciseHit[] = LIFTS.filter((l) => key(l.name).includes(k))
    .sort((a, b) => (used(a.id) < used(b.id) ? 1 : -1))
    .map((l) => {
      const last = lastSets(l.id, excluding);
      return { id: l.id, name: l.name, load: l.load, own: true, last_sets: last.sets, last_on: last.on };
    });
  const common: ExerciseHit[] = COMMON.filter(([n]) => key(n).includes(k) && !own.some((h) => key(h.name) === key(n)))
    .map(([name, load]) => ({ id: null, name, load, own: false, last_sets: [], last_on: null }));
  return [...own, ...common].slice(0, 40);
}

function recent(limit: number): RecentSession[] {
  const since = shift(today(), -90);
  const seen = new Map<string, RecentSession>();
  for (const s of [...live()].reverse()) {
    if (s.logged_on < since || s.kind === "strength") continue;
    const k = `${s.kind}|${s.label}|${s.minutes}|${s.effort}`;
    if (!seen.has(k)) {
      seen.set(k, { kind: s.kind, label: s.label, minutes: s.minutes, effort: s.effort, last_on: s.logged_on, exercises: [] });
    }
  }
  const out = [...seen.values()].sort((a, b) => (a.last_on < b.last_on ? 1 : -1)).slice(0, limit);
  const gym = [...live()].filter((s) => s.kind === "strength" && s.sets.length > 0)
    .sort((a, b) => (a.logged_on < b.logged_on ? 1 : -1))[0];
  if (gym) {
    const lifts: { id: string; name: string; load: Load }[] = [];
    for (const x of gym.sets) {
      if (!lifts.some((l) => l.id === x.exercise_id)) {
        const l = LIFTS.find((y) => y.id === x.exercise_id)!;
        lifts.push({ id: l.id, name: l.name, load: l.load });
      }
    }
    const at = out.findIndex((r) => r.last_on < gym.logged_on);
    out.splice(at === -1 ? out.length : at, 0, {
      kind: "strength", label: null, minutes: null, effort: null, last_on: gym.logged_on, exercises: lifts,
    });
  }
  return out.slice(0, Math.max(1, limit));
}

/* ── the command table ──────────────────────────────────────────────────── */

const copy = <T,>(v: T): T => structuredClone(v);

function byId(id: string): Session {
  const s = SESSIONS.find((x) => x.id === id);
  if (!s) throw new Error("That session is no longer in the log.");
  return s;
}

export const ACTIVITY_TABLE: Record<string, (a: Record<string, unknown>) => unknown> = {
  list_activities: (a) => copy(live().filter((s) => s.logged_on === String(a.loggedOn ?? today()))),
  get_activity: (a) => copy(byId(String(a.id))),
  save_activity: (a) => {
    const input = a.activity as SessionInput;
    if (input.logged_on > today()) throw new Error("That day has not happened yet.");
    if (input.kind !== "strength" && (input.minutes === null || input.effort === null)) {
      throw new Error("Say how long it was and how hard.");
    }
    if (input.id) {
      const s = byId(input.id);
      Object.assign(s, { ...input, id: s.id, sets: s.sets });
      if (s.logged_on < today()) s.corrected_at = new Date().toISOString();
      return s.id;
    }
    return session(input.logged_on, input.kind, input.minutes, input.effort, input.label).id;
  },
  delete_activity: (a) => {
    const i = SESSIONS.findIndex((x) => x.id === String(a.id));
    if (i >= 0) SESSIONS.splice(i, 1);
    return undefined;
  },
  add_activity_set: (a) => {
    const ex = a.exercise as { id: string | null; name: string; load: Load };
    const l = ex.id ? LIFTS.find((x) => x.id === ex.id)! : lift(ex.name, ex.load);
    const f = a.set as SetFigures;
    if (l.load !== "time" && f.reps === null) throw new Error("A set of this lift needs its repetitions.");
    if (l.load === "time" && f.seconds === null) throw new Error("A hold needs how many seconds it lasted.");
    const s = a.activityId ? byId(String(a.activityId)) : session(String(a.loggedOn), "strength", null, null);
    const set: SessionSet = {
      id: uuid(), position: s.sets.length, exercise_id: l.id, exercise_name: l.name, load: l.load,
      reps: l.load === "time" ? null : f.reps, load_kg: f.load_kg, seconds: l.load === "time" ? f.seconds : null,
    };
    s.sets.push(set);
    return { activity_id: s.id, set: copy(set) };
  },
  update_activity_set: (a) => {
    for (const s of SESSIONS) {
      const set = s.sets.find((x) => x.id === String(a.setId));
      if (set) Object.assign(set, a.set as SetFigures);
    }
    return undefined;
  },
  delete_activity_set: (a) => {
    for (const s of SESSIONS) {
      const i = s.sets.findIndex((x) => x.id === String(a.setId));
      if (i >= 0) {
        s.sets.splice(i, 1);
        if (s.sets.length === 0 && s.minutes === null) {
          SESSIONS.splice(SESSIONS.indexOf(s), 1);
          return true;
        }
        return false;
      }
    }
    return false;
  },
  recent_activities: (a) => recent(Number(a.limit ?? 6)),
  find_exercises: (a) => find(String(a.query ?? ""), (a.session as string | null) ?? null),
  get_activity_range: (a) => range(String(a.from ?? today()), String(a.to ?? today())),
};

/** For the export fixture: the same sessions, in the export's own shape. */
export function exportActivity(from: string, to: string) {
  const inside = live().filter((s) => s.logged_on >= from && s.logged_on <= to);
  return {
    activities: inside.map((s) => ({
      logged_on: s.logged_on, kind: s.kind, label: s.label, minutes: s.minutes, effort: s.effort,
      sets: s.sets.length, note: s.note,
    })),
    sets: inside.flatMap((s) => {
      const n = new Map<string, number>();
      return s.sets.map((x) => {
        n.set(x.exercise_id, (n.get(x.exercise_id) ?? 0) + 1);
        return {
          logged_on: s.logged_on, exercise: x.exercise_name, set: n.get(x.exercise_id)!,
          reps: x.reps, load_kg: x.load_kg, seconds: x.seconds,
        };
      });
    }),
  };
}
