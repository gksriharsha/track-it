import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { humanDate, todayIso } from "../api";
import {
  EFFORTS, KINDS, addSet, byLift, deleteSession, deleteSet, findExercises, getSession,
  minutesText, recentSessions, saveSession, sessionTitle, setText, updateSet,
} from "../lib/activity";
import type {
  ActivityKind, Effort, ExerciseHit, ExerciseRef, RecentSession, SessionSet, SetFigures,
} from "../lib/activity";
import { ART_CREDIT, artFor, mostlyLine, muscleLine, musclesFor, nameKey } from "../lib/exerciseArt";
import LiftFigure, { LiftFrames } from "../components/LiftFigure";
import ExerciseSheet, { BarbellGlyph } from "../components/ExerciseSheet";
import { useHashSheet } from "../lib/hashSheet";

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
  /**
   * Which row this is to React, for its whole life on the screen. Not the
   * exercise id: a lift never logged before has none until its first set is
   * written, and a key that changed then would remount the row and throw away
   * what it was showing — an open close-up snapping shut mid-set.
   */
  key: string;
}

let nextBlock = 0;

function blockFrom(
  ref: ExerciseRef,
  sets: SessionSet[],
  last: SetFigures[],
  lastOn: string | null,
  key: string = `lift-${(nextBlock += 1)}`,
): LiftBlock {
  // Pre-filled with the set just written, or else the first set last time:
  // the next set is usually one of those two, and "Same again" is one tap.
  const seed = sets[sets.length - 1] ?? last[0] ?? null;
  return {
    ref, sets, last, lastOn, editing: null, key,
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
  // The exercise sheet is a hash param, so the back gesture closes it.
  const sheet = useHashSheet("sheet", "lift");
  const addRef = useRef<HTMLButtonElement>(null);
  /** The lift just added or returned to, which scrolls itself into view. */
  const [arrived, setArrived] = useState<string | null>(null);
  /** Whether the sheet now closing was closed by choosing a lift. */
  const picked = useRef(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    // Closed without a choice: focus goes back where it came from. Closed by a
    // choice, the chosen lift takes it instead — see LiftLedger's `arrived`.
    if (wasOpen.current && !sheet.open && !picked.current) {
      addRef.current?.focus({ preventScroll: true });
    }
    wasOpen.current = sheet.open;
  }, [sheet.open]);

  function openSheet() {
    // Cleared on the way in, so choosing the same lift twice still arrives.
    picked.current = false;
    setArrived(null);
    sheet.show();
  }

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
      patch(i, (x) => blockFrom(x.ref, x.sets.filter((s) => s.id !== x.editing), x.last, x.lastOn, x.key));
      if (gone) { setSessionId(null); setEditingId(null); }
    } catch (e) {
      setError(String(e));
    }
  }

  /**
   * A lift chosen in the sheet joins the session, or — if it is already in it,
   * by name as well as by id, since a common lift has no id until its first
   * set — the session scrolls to the one that is there.
   */
  function addLift(ref: ExerciseRef, hit: ExerciseHit | null) {
    picked.current = true;
    sheet.hide();
    const there = lifts.find((b) => nameKey(b.ref.name) === nameKey(ref.name));
    if (there) {
      setArrived(there.key);
      return;
    }
    const block = blockFrom(ref, [], hit?.last_sets ?? [], hit?.last_on ?? null);
    setLifts((ls) => [...ls, block]);
    setArrived(block.key);
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

          {lifts.map((b, i) => (
            <LiftLedger
              key={b.key}
              block={b}
              // Only once the sheet has gone: closing it is a step back in
              // history, and the browser puts the old scroll position back as
              // it goes, which would undo a scroll made while it was open.
              arrived={!sheet.open && b.key === arrived}
              onChange={(f) => patch(i, f)}
              onWrite={() => writeSet(i)}
              onDrop={() => dropSet(i)}
            />
          ))}

          {/* The way to the next lift, as wide as the thumb that reaches for it.
              With nothing in the session yet it is the only thing to do, and
              says how the session is kept. */}
          <button ref={addRef} type="button" className="addlift" onClick={openSheet}>
            <span className="addlift__plus" aria-hidden>+</span>
            {lifts.length === 0 ? "Add the first exercise" : "Add exercise"}
          </button>
          {lifts.length === 0 && (
            <p className="activity__hint ledger__how">
              Each set is kept the moment you add it, so there is nothing to save at the end.
            </p>
          )}

          <div className="ledger__foot">
            {/* How long only once there is a session to put it on: the session
                is made by its first set. */}
            {sessionId !== null && (
              <label className="ledger__mins">
                <span className="activity__label">How long</span>
                <span className="lift__pair">
                  <input className="field lift__field tnum" inputMode="numeric" value={gymMinutes}
                    placeholder="—" aria-label="How long, in minutes (optional)"
                    onChange={(e) => setGymMinutes(e.target.value)} onBlur={saveGymMinutes} />
                  <span className="lift__unit">min</span>
                </span>
              </label>
            )}
            <div className="commit ledger__commit">
              {sessionId !== null && editingExisting && (
                <button className="btn btn--danger" onClick={removeSession} disabled={busy}>
                  Remove session
                </button>
              )}
              <button className="btn" onClick={async () => { await saveGymMinutes(); p.onDone(); }}>Done</button>
            </div>
          </div>
        </section>
      )}

      <ExerciseSheet
        open={sheet.open}
        onClose={sheet.hide}
        session={sessionId}
        added={new Set(lifts.map((b) => nameKey(b.ref.name)))}
        onPick={addLift}
      />

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
  /** Just added from the sheet, or chosen there while already here. */
  arrived: boolean;
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
  const rootRef = useRef<HTMLDivElement>(null);

  // A lift chosen in the sheet is brought into view, and with a keyboard to
  // hand its first field takes the cursor, so the set can be typed at once.
  useEffect(() => {
    if (!p.arrived) return;
    const el = rootRef.current;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A frame later, after the browser has finished restoring the scroll the
    // history step brought with it.
    const raf = requestAnimationFrame(() => {
      el?.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
      const keys = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
      // With keys, the first field so the set can be typed at once; on a phone
      // the lift's own heading, so a screen reader lands on it without the
      // keyboard springing up.
      const target = keys
        ? el?.querySelector<HTMLInputElement>("input")
        : el?.querySelector<HTMLElement>(".lift__name");
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [p.arrived]);

  function enter(e: KeyboardEvent<HTMLInputElement>, next?: () => void) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (next) next();
    else if (ready) p.onWrite();
  }

  const label =
    b.editing !== null ? "Save set" : b.sets.length > 0 && same(fig, lastSet) ? "Same again" : "Add set";
  const art = artFor(b.ref.name);
  const muscles = musclesFor(b.ref.name);
  const [open, setOpen] = useState(false);

  return (
    <div className="lift" ref={rootRef}>
      <div className="lift__head lift__head--art">
        {/* The drawing is a button because it opens the close-up: both frames
            side by side, named, with the full muscle line, what the drawing is
            a variant of, and who drew it. A lift with no drawing — the user's
            own, or one the set lacks — keeps the tile, with the shape of a
            barbell in it, so every lift's name starts in the same place. */}
        {art ? (
          <button className="lift__art" aria-expanded={open} aria-label={`How ${b.ref.name} is done`}
            onClick={() => setOpen((o) => !o)}>
            {/* Still while the close-up is open: the same two frames are
                standing side by side just below it. */}
            <LiftFigure lift={b.ref.name} still={art.still || open} />
          </button>
        ) : (
          <span className="lift__art lift__art--none" aria-hidden><BarbellGlyph /></span>
        )}
        <div className="lift__titles">
          <h3 className="lift__name" tabIndex={-1}>{b.ref.name}</h3>
          {/* The short form here, the full sentence in the close-up: beside
              the fields it is a reminder, not a lesson. */}
          {muscles && <span className="lift__muscles">{mostlyLine(muscles)}</span>}
          {b.last.length > 0 && b.lastOn && (
            <span className="lift__last tnum">
              {humanDate(b.lastOn)}: {b.last.map((s) => setText(s, load)).join(", ")}
            </span>
          )}
        </div>
      </div>

      {open && art && (
        <div className="lift__how">
          <LiftFrames lift={b.ref.name} />
          {muscles && <p className="lift__how-muscles">{muscleLine(muscles)}</p>}
          {art.caption && <p className="lift__caption">{art.caption}.</p>}
          <p className="lift__credit">{ART_CREDIT}</p>
        </div>
      )}

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
                    ? blockFrom(x.ref, x.sets, x.last, x.lastOn, x.key)
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
