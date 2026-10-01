import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { humanDate, todayIso } from "../api";
import {
  EFFORTS, KINDS, LOADS, addSet, byLift, deleteSession, deleteSet, findExercises, getSession,
  minutesText, recentSessions, saveSession, sessionTitle, setText, updateSet,
} from "../lib/activity";
import type {
  ActivityKind, Effort, ExerciseHit, ExerciseRef, Load, RecentSession, SessionSet, SetFigures,
} from "../lib/activity";

/**
 * The Add screen's Activity tab: something done, beside things eaten (D26).
 *
 * Two shapes behind one row of chips. A walk, a swim or a class is a length and
 * an effort, written once. A strength session is its sets, written one at a
 * time as they are done — each the moment it is entered, so a phone that kills
 * the app between sets loses nothing, and "Done" saves nothing because there
 * is nothing left to save.
 *
 * Nothing here is scored. There is no calories-burned figure, no tick beside a
 * set, and nothing about the session changes the day's energy line.
 */
interface Props {
  /** The day being logged into: the one Today is showing. */
  date: string;
  /** A session to carry on with or correct, from Today. */
  sessionId: string | null;
  onDone: () => void;
}

const UNDO_MS = 8000;

/** One lift in the session being written, and what is in its entry fields. */
interface LiftBlock {
  ref: ExerciseRef;
  sets: SessionSet[];
  last: SetFigures[];
  lastOn: string | null;
  kg: string;
  reps: string;
  secs: string;
  /** The set whose figures are in the fields, when one is being corrected. */
  editing: string | null;
}

function blockFrom(ref: ExerciseRef, sets: SessionSet[], last: SetFigures[], lastOn: string | null): LiftBlock {
  // Pre-filled with the set just written, or else the first set last time:
  // the next set is usually one of those two, and "Same again" is one tap.
  const seed = sets[sets.length - 1] ?? last[0] ?? null;
  return {
    ref, sets, last, lastOn, editing: null,
    kg: seed?.load_kg != null ? String(seed.load_kg) : "",
    reps: seed?.reps != null ? String(seed.reps) : "",
    secs: seed?.seconds != null ? String(seed.seconds) : "",
  };
}

/** A number typed into a field, or null. Commas as decimal points are fine. */
function num(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function figures(b: LiftBlock): SetFigures {
  const reps = num(b.reps);
  const secs = num(b.secs);
  return {
    reps: reps === null ? null : Math.round(reps),
    load_kg: num(b.kg),
    seconds: secs === null ? null : Math.round(secs),
  };
}

function same(a: SetFigures, b: SetFigures | undefined): boolean {
  return b !== undefined && a.reps === b.reps && a.load_kg === b.load_kg && a.seconds === b.seconds;
}

function dayWords(on: string): string {
  return on === todayIso() ? "today" : humanDate(on);
}

export default function ActivityPane(p: Props) {
  const [recent, setRecent] = useState<RecentSession[]>([]);
  const [kind, setKind] = useState<ActivityKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // An existing session, when one was opened from Today.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [day, setDay] = useState(p.date);

  // A walk, a swim, a class.
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [effort, setEffort] = useState<Effort>("moderate");
  const [note, setNote] = useState("");

  // A strength session. `sessionId` is null until its first set is written.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lifts, setLifts] = useState<LiftBlock[]>([]);
  const [gymMinutes, setGymMinutes] = useState("");
  const [picking, setPicking] = useState(false);

  // The last one-tap log, and the way back out of it.
  const [last, setLast] = useState<{ id: string; label: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    recentSessions(6).then(setRecent).catch(() => setRecent([]));
  }, []);

  /** Lifts with their last sessions looked up, for a session being started or resumed. */
  const withLast = useCallback(async (refs: ExerciseRef[], sets: SessionSet[], exclude: string | null) => {
    const out: LiftBlock[] = [];
    for (const r of refs) {
      const hits = await findExercises(r.name, exclude).catch(() => [] as ExerciseHit[]);
      const hit = hits.find((h) => h.id !== null && h.id === r.id);
      const mine = sets.filter((s) => s.exercise_id === r.id);
      out.push(blockFrom(r, mine, hit?.last_sets ?? [], hit?.last_on ?? null));
    }
    return out;
  }, []);

  // Opened from Today: load what is there and carry on from it.
  useEffect(() => {
    if (p.sessionId === null) return;
    let live = true;
    (async () => {
      try {
        const s = await getSession(p.sessionId as string);
        if (!live) return;
        setEditingId(s.id);
        setDay(s.logged_on);
        setKind(s.kind);
        if (s.kind === "strength") {
          setSessionId(s.id);
          setGymMinutes(s.minutes === null ? "" : String(s.minutes));
          const refs = byLift(s.sets).map((g) => ({ id: g.id, name: g.name, load: g.load }));
          const blocks = await withLast(refs, s.sets, s.id);
          if (live) setLifts(blocks);
        } else {
          setLabel(s.label ?? "");
          setMinutes(s.minutes === null ? "" : String(s.minutes));
          setEffort(s.effort ?? "moderate");
          setNote(s.note ?? "");
        }
      } catch (e) {
        if (live) setError(String(e));
      }
    })();
    return () => { live = false; };
  }, [p.sessionId, withLast]);

  function choose(k: ActivityKind) {
    if (k === kind) return;
    setError(null);
    setKind(k);
    if (k === "strength") return;
    // A new kind brings its usual effort with it. Editing keeps what was said.
    if (editingId === null) setEffort(KINDS.find((x) => x.id === k)?.effort ?? "moderate");
  }

  /** One tap on something done before. */
  async function again(r: RecentSession) {
    if (busy) return;
    setError(null);
    if (r.kind === "strength") {
      setKind("strength");
      setLifts(await withLast(r.exercises, [], null));
      return;
    }
    setBusy(true);
    try {
      const id = await saveSession({
        id: null, logged_on: p.date, kind: r.kind, label: r.label,
        minutes: r.minutes, effort: r.effort, note: null,
      });
      if (timer.current) clearTimeout(timer.current);
      setLast({ id, label: `${sessionTitle(r)}, ${minutesText(r.minutes ?? 0)}` });
      timer.current = setTimeout(() => setLast(null), UNDO_MS);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!last) return;
    const { id } = last;
    if (timer.current) clearTimeout(timer.current);
    setLast(null);
    try { await deleteSession(id); } catch (e) { setError(String(e)); }
  }

  async function commit(e: FormEvent) {
    e.preventDefault();
    if (kind === null || kind === "strength" || busy) return;
    const m = num(minutes);
    if (m === null || m <= 0) { setError("Say how many minutes it was."); return; }
    setBusy(true);
    setError(null);
    try {
      await saveSession({
        id: editingId, logged_on: day, kind, label: label.trim() || null,
        minutes: m, effort, note: note.trim() || null,
      });
      p.onDone();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeSession() {
    const id = editingId ?? sessionId;
    if (id === null) return;
    setBusy(true);
    try {
      await deleteSession(id);
      p.onDone();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  /* ── strength ── */

  function patch(i: number, f: (b: LiftBlock) => LiftBlock) {
    setLifts((ls) => ls.map((b, j) => (j === i ? f(b) : b)));
  }

  async function writeSet(i: number) {
    const b = lifts[i];
    const fig = figures(b);
    setError(null);
    try {
      if (b.editing !== null) {
        await updateSet(b.editing, fig);
        patch(i, (x) => ({
          ...x, editing: null,
          sets: x.sets.map((s) => (s.id === x.editing ? { ...s, ...fig } : s)),
        }));
        return;
      }
      const out = await addSet(sessionId, day, b.ref, fig);
      setSessionId(out.activity_id);
      if (editingId === null) setEditingId(out.activity_id);
      patch(i, (x) => ({
        ...x,
        ref: { id: out.set.exercise_id, name: out.set.exercise_name, load: out.set.load },
        sets: [...x.sets, out.set],
      }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function dropSet(i: number) {
    const b = lifts[i];
    if (b.editing === null) return;
    try {
      const gone = await deleteSet(b.editing);
      patch(i, (x) => ({ ...blockFrom(x.ref, x.sets.filter((s) => s.id !== x.editing), x.last, x.lastOn) }));
      if (gone) { setSessionId(null); setEditingId(null); }
    } catch (e) {
      setError(String(e));
    }
  }

  function addLift(ref: ExerciseRef, hit: ExerciseHit | null) {
    setPicking(false);
    const at = lifts.findIndex((b) => b.ref.id !== null && b.ref.id === ref.id);
    if (at >= 0) return;
    setLifts((ls) => [...ls, blockFrom(ref, [], hit?.last_sets ?? [], hit?.last_on ?? null)]);
  }

  async function saveGymMinutes() {
    if (sessionId === null) return;
    const m = num(gymMinutes);
    try {
      await saveSession({
        id: sessionId, logged_on: day, kind: "strength", label: null,
        minutes: m !== null && m > 0 ? m : null, effort: null, note: null,
      });
    } catch (e) {
      setError(String(e));
    }
  }

  const editingExisting = p.sessionId !== null;
  const tiles = !editingExisting && kind !== "strength" ? recent : [];
  const kindInfo = KINDS.find((k) => k.id === kind);

  return (
    <div className="activity">
      {tiles.length > 0 && (
        <section className="again">
          <div className="again__head">
            <h2>Done before</h2>
            <span className="again__note">one tap, into {dayWords(p.date)}</span>
          </div>
          <div className="again__strip">
            {tiles.map((r, i) => (
              <button key={i} className="again__tile" onClick={() => again(r)} disabled={busy}
                aria-label={r.kind === "strength"
                  ? `Start a strength session with ${r.exercises.map((x) => x.name).join(", ")}`
                  : `Add ${sessionTitle(r)}, ${minutesText(r.minutes ?? 0)}, to ${dayWords(p.date)}`}>
                <span className="again__name">
                  {r.kind === "strength" ? "Strength, like last time" : sessionTitle(r)}
                </span>
                <span className="again__amt tnum">
                  {r.kind === "strength"
                    ? (r.exercises.length === 1 ? "1 lift" : `${r.exercises.length} lifts`)
                    : minutesText(r.minutes ?? 0)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {!(editingExisting && kind === "strength") && (
        <section className="activity__kinds">
          <h2 className="activity__q">What did you do?</h2>
          <div className="chips">
            {KINDS.map((k) => (
              <button
                key={k.id}
                className="chip"
                aria-pressed={kind === k.id}
                // A session already written as one shape stays that shape: a
                // walk has no sets to keep, and a gym session's sets have
                // nowhere to go on a walk.
                disabled={editingExisting && kind !== null && (k.id === "strength") !== (kind === "strength")}
                onClick={() => choose(k.id)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {error && <p className="alert" role="alert">{error}</p>}

      {kind !== null && kind !== "strength" && (
        <form className="card activity__form" onSubmit={commit}>
          {kindInfo?.name && (
            <label className="activity__row">
              <span className="activity__label">Name</span>
              <input className="field" value={label} maxLength={80}
                placeholder={kindInfo.name} onChange={(e) => setLabel(e.target.value)} />
            </label>
          )}

          <div className="activity__row">
            <span className="activity__label" id="act-minutes">How long</span>
            <div className="stepper activity__minutes" role="group" aria-labelledby="act-minutes">
              <button type="button" className="stepper__seg" aria-label="Five minutes less"
                onClick={() => setMinutes((m) => String(Math.max(5, Math.round(((num(m) ?? 30) - 5) / 5) * 5)))}>−</button>
              <label className="stepper__mid">
                <input className="activity__mins tnum" inputMode="numeric" value={minutes}
                  aria-label="Minutes" onChange={(e) => setMinutes(e.target.value)} />
                <span className="activity__unit">min</span>
              </label>
              <button type="button" className="stepper__seg" aria-label="Five minutes more"
                onClick={() => setMinutes((m) => String(Math.min(1440, Math.round(((num(m) ?? 25) + 5) / 5) * 5)))}>+</button>
            </div>
          </div>

          <div className="activity__row">
            <span className="activity__label">How hard</span>
            <div>
              <div className="chips">
                {EFFORTS.map((x) => (
                  <button type="button" key={x.id} className="chip" aria-pressed={effort === x.id}
                    onClick={() => setEffort(x.id)}>{x.label}</button>
                ))}
              </div>
              <p className="activity__hint">{EFFORTS.find((x) => x.id === effort)?.test}</p>
            </div>
          </div>

          <label className="activity__row">
            <span className="activity__label">Note</span>
            <input className="field" value={note} maxLength={1000} placeholder="Optional"
              onChange={(e) => setNote(e.target.value)} />
          </label>

          <div className="commit">
            <button className="btn" type="submit" disabled={busy}>
              {editingId === null ? `Add to ${dayWords(day)}` : "Save changes"}
            </button>
            {editingId !== null && (
              <button type="button" className="btn btn--danger" onClick={removeSession} disabled={busy}>
                Remove
              </button>
            )}
          </div>
        </form>
      )}

      {kind === "strength" && (
        <section className="card ledger">
          <div className="card__head">
            <h2>Strength</h2>
            <span className="card__note">{editingExisting ? humanDate(day) : `into ${dayWords(day)}`}</span>
          </div>

          {lifts.length === 0 && !picking && (
            <p className="activity__hint">
              Each set is kept the moment you add it, so there is nothing to save at the end.
            </p>
          )}

          {lifts.map((b, i) => (
            <LiftLedger
              key={b.ref.id ?? b.ref.name}
              block={b}
              onChange={(f) => patch(i, f)}
              onWrite={() => writeSet(i)}
              onDrop={() => dropSet(i)}
            />
          ))}

          {picking ? (
            <ExercisePicker
              session={sessionId}
              onPick={addLift}
              onCancel={() => setPicking(false)}
            />
          ) : (
            <button className="btn btn--quiet activity__addlift" onClick={() => setPicking(true)}>
              Add exercise
            </button>
          )}

          <div className="activity__row activity__foot">
            <label className="activity__label" htmlFor="act-gym-min">How long</label>
            <div className="activity__inline">
              <input id="act-gym-min" className="field lift__field tnum" inputMode="numeric"
                value={gymMinutes} placeholder="min" disabled={sessionId === null}
                onChange={(e) => setGymMinutes(e.target.value)} onBlur={saveGymMinutes} />
              <span className="activity__hint">
                {sessionId === null ? "after the first set" : "optional"}
              </span>
            </div>
          </div>

          <div className="commit">
            <button className="btn" onClick={async () => { await saveGymMinutes(); p.onDone(); }}>Done</button>
            {sessionId !== null && editingExisting && (
              <button className="btn btn--danger" onClick={removeSession} disabled={busy}>
                Remove this session
              </button>
            )}
          </div>
        </section>
      )}

      {last && (
        <div className="toast" role="status">
          <span className="toast__text">Added to {dayWords(p.date)}: {last.label}</span>
          <button className="toast__undo" onClick={undo}>Undo</button>
        </div>
      )}
    </div>
  );
}

/**
 * One lift: its sets written left to right, the way a gym notebook reads, and
 * the pair of fields the next set goes into.
 *
 * No table and no tick boxes. A set exists because it was written, not because
 * it was ticked off a plan, so there is nothing here to complete.
 */
function LiftLedger(p: {
  block: LiftBlock;
  onChange: (f: (b: LiftBlock) => LiftBlock) => void;
  onWrite: () => void;
  onDrop: () => void;
}) {
  const b = p.block;
  const load = b.ref.load;
  const fig = figures(b);
  const lastSet = b.sets[b.sets.length - 1];
  const ready = load === "time" ? fig.seconds !== null && fig.seconds > 0 : fig.reps !== null && fig.reps > 0;
  const repsRef = useRef<HTMLInputElement>(null);

  function enter(e: KeyboardEvent<HTMLInputElement>, next?: () => void) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (next) next();
    else if (ready) p.onWrite();
  }

  const label =
    b.editing !== null ? "Save set" : b.sets.length > 0 && same(fig, lastSet) ? "Same again" : "Add set";

  return (
    <div className="lift">
      <div className="lift__head">
        <h3 className="lift__name">{b.ref.name}</h3>
        {b.last.length > 0 && b.lastOn && (
          <span className="lift__last">
            {humanDate(b.lastOn)}: {b.last.map((s) => setText(s, load)).join(", ")}
          </span>
        )}
      </div>

      {b.sets.length > 0 && (
        <div className="lift__sets" aria-label={`${b.ref.name}, ${b.sets.length} sets`}>
          {b.sets.map((s) => (
            <button
              key={s.id}
              className="lift__set tnum"
              aria-pressed={b.editing === s.id}
              aria-label={`Change set ${s.position + 1}: ${setText(s, load, true)}`}
              onClick={() =>
                p.onChange((x) =>
                  x.editing === s.id
                    ? blockFrom(x.ref, x.sets, x.last, x.lastOn)
                    : {
                        ...x, editing: s.id,
                        kg: s.load_kg === null ? "" : String(s.load_kg),
                        reps: s.reps === null ? "" : String(s.reps),
                        secs: s.seconds === null ? "" : String(s.seconds),
                      },
                )
              }
            >
              {setText(s, load)}
            </button>
          ))}
        </div>
      )}

      <div className={load === "time" ? "lift__entry lift__entry--held" : "lift__entry"}>
        {load !== "time" && (
          <label className="lift__pair">
            <input className="field lift__field tnum" inputMode="decimal" value={b.kg}
              placeholder={load === "body" ? "+0" : "0"}
              aria-label={load === "body" ? "Added weight, kg" : "Weight, kg"}
              onChange={(e) => p.onChange((x) => ({ ...x, kg: e.target.value }))}
              onKeyDown={(e) => enter(e, () => repsRef.current?.focus())} />
            <span className="lift__unit">kg</span>
          </label>
        )}
        {load !== "time" && <span className="lift__x" aria-hidden>×</span>}
        {load !== "time" ? (
          <label className="lift__pair">
            <input ref={repsRef} className="field lift__field tnum" inputMode="numeric" value={b.reps}
              placeholder="0" aria-label="Repetitions"
              onChange={(e) => p.onChange((x) => ({ ...x, reps: e.target.value }))}
              onKeyDown={(e) => enter(e)} />
            <span className="lift__unit">reps</span>
          </label>
        ) : (
          <label className="lift__pair">
            <input className="field lift__field tnum" inputMode="numeric" value={b.secs}
              placeholder="0" aria-label="Seconds held"
              onChange={(e) => p.onChange((x) => ({ ...x, secs: e.target.value }))}
              onKeyDown={(e) => enter(e)} />
            <span className="lift__unit">s</span>
          </label>
        )}
        <button className="btn btn--again" onClick={p.onWrite} disabled={!ready}>{label}</button>
        {b.editing !== null && (
          <button className="btn btn--danger lift__drop" onClick={p.onDrop}>Remove set</button>
        )}
      </div>
    </div>
  );
}

/**
 * Choosing a lift: the person's own first, then the common ones.
 *
 * A name that matches nothing can be added as a new lift, once its kind of set
 * is chosen — weights, bodyweight, or held — because that decides which fields
 * the ledger draws and cannot be guessed from a name.
 */
function ExercisePicker(p: {
  session: string | null;
  onPick: (ref: ExerciseRef, hit: ExerciseHit | null) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ExerciseHit[]>([]);
  const [hi, setHi] = useState(0);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      findExercises(query, p.session)
        .then((h) => { if (live) { setHits(h); setHi(0); } })
        .catch(() => { if (live) setHits([]); });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [query, p.session]);

  const key = (s: string) => s.trim().toLowerCase().split(/\s+/).join(" ");
  const exact = useMemo(() => hits.some((h) => key(h.name) === key(query)), [hits, query]);
  const shown = hits.slice(0, 12);

  function pick(h: ExerciseHit) {
    p.onPick({ id: h.id, name: h.name, load: h.load }, h);
  }

  function nav(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && shown[hi]) { e.preventDefault(); pick(shown[hi]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); p.onCancel(); }
  }

  return (
    <div className="picker">
      <input className="field" autoFocus value={query} placeholder="Squat, bench press, plank…"
        aria-label="Find an exercise" onChange={(e) => setQuery(e.target.value)} onKeyDown={nav} />
      <div className="rows picker__rows" role="listbox">
        {shown.map((h, i) => (
          <button key={h.id ?? h.name} className={i === hi ? "row picker__row is-hi" : "row picker__row"}
            role="option" aria-selected={i === hi} onMouseEnter={() => setHi(i)} onClick={() => pick(h)}>
            <span className="row__main">
              <span className="row__title">{h.name}</span>
              <span className="row__sub">
                {h.own && h.last_on
                  ? `${humanDate(h.last_on)}: ${h.last_sets.map((s) => setText(s, h.load)).join(", ")}`
                  : h.own ? "yours" : LOADS.find((l) => l.id === h.load)?.label}
              </span>
            </span>
          </button>
        ))}
      </div>
      {query.trim() !== "" && !exact && (
        <div className="picker__new">
          <span className="activity__hint">Add “{query.trim()}” as a new exercise, counted in</span>
          <div className="chips">
            {LOADS.map((l) => (
              <button key={l.id} className="chip" onClick={() => p.onPick({ id: null, name: query.trim(), load: l.id as Load }, null)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <button className="link" onClick={p.onCancel}>Cancel</button>
    </div>
  );
}
