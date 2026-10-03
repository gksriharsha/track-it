import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * How long the way back stays on screen. Long enough to read the sentence and
 * reach for it; short enough that it is gone before it becomes furniture.
 */
export const ANNOUNCE_MS = 8000;

/**
 * What was just done, said once, and the way back out of it when there is one.
 *
 * Plain facts in the words of the record — "Rice, 85 g added to lunch" — and
 * never a verdict on them. No "Nice!", no tick, nothing that makes a log a
 * small win: the bar is there so that a write the finger made is seen to have
 * landed, and can be taken back.
 */
export interface Announcement {
  message: string;
  /**
   * Takes the thing back. A throw is shown in the bar, as a sentence, in place
   * of the message — the screen that did the write may be gone by now.
   */
  undo?: () => Promise<void> | void;
  /** How long it stays, if not `ANNOUNCE_MS`. */
  ms?: number;
}

type Announce = (a: Announcement) => void;

const AnnounceContext = createContext<Announce | null>(null);

/**
 * Say something in the app's one bar. A new message replaces the one showing,
 * Undo and all: two bars stacked over the bottom bar would hide the way off
 * the screen, and the older one is about something already superseded.
 */
export function useAnnounce(): Announce {
  const announce = useContext(AnnounceContext);
  if (announce === null) throw new Error("useAnnounce needs the AnnounceProvider that App puts at its root");
  return announce;
}

interface Shown extends Announcement {
  /** Which announcement this is, so a new one is a new bar — timer, Undo and all. */
  n: number;
}

/**
 * The bar's owner, at the root of the app rather than on any one screen.
 *
 * It used to belong to the screen that did the write, and went when that
 * screen went: log a staple on Add, tap Today to look, and the way back had
 * vanished with Add. A log is not a fact about the screen it was made on, so
 * the bar outlives the screen and Undo still works from the next one.
 */
export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const seq = useRef(0);
  const announce = useCallback<Announce>((a) => {
    seq.current += 1;
    setShown({ ...a, n: seq.current });
  }, []);
  const gone = useCallback((n: number) => {
    // Only the bar that asked: a timer finishing as a new message arrives must
    // not take the new one with it.
    setShown((s) => (s?.n === n ? null : s));
  }, []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      {/* Always in the document, empty or not. A live region that is itself
          inserted with its message in it is announced unreliably; one that is
          already there and changes is announced every time. */}
      <div className="announce" role="status">
        {shown && <Bar key={shown.n} a={shown} onGone={() => gone(shown.n)} />}
      </div>
    </AnnounceContext.Provider>
  );
}

/**
 * One announcement. Sits above the phone's bottom bar rather than over it: the
 * bar is how you leave this screen, and covering it to announce a success would
 * trap someone who wanted to be somewhere else. Bottom right on a desktop.
 */
function Bar({ a, onGone }: { a: Shown; onGone: () => void }) {
  const [used, setUsed] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;

  /*
    The clock stops while a pointer is over the bar or focus is in it, and
    restarts with what was left — never less than a moment, so taking the
    pointer away does not take the bar with it. Someone who has reached the
    Undo button should not watch it disappear from under them.
  */
  const left = useRef(a.ms ?? ANNOUNCE_MS);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef({ pointer: false, focus: false, busy: false });

  const run = useCallback(() => {
    const h = held.current;
    if (timer.current !== null || h.pointer || h.focus || h.busy) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => goneRef.current(), left.current);
  }, []);
  const stop = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    left.current = Math.max(MIN_LEFT_MS, left.current - (Date.now() - startedAt.current));
  }, []);
  const hold = (why: "pointer" | "focus" | "busy", on: boolean) => {
    held.current[why] = on;
    if (on) stop();
    else run();
  };

  useEffect(() => {
    run();
    return stop;
  }, [run, stop]);

  /* Spent at once, so a slow undo cannot be pressed twice. A ref as well as
     the state: two presses inside one frame both see the state as it was
     before either landed, and a remove's Undo run twice would ask for the
     same entry back twice — and be refused the second time. */
  const spent = useRef(false);
  async function undo() {
    if (spent.current || !a.undo) return;
    spent.current = true;
    setUsed(true);
    hold("busy", true);
    try {
      await a.undo();
      goneRef.current();
    } catch (e) {
      // The backend's refusals are already sentences; an Error's own
      // "Error: " in front of one is noise in a bar this size.
      setFailed(e instanceof Error ? e.message : String(e));
      left.current = a.ms ?? ANNOUNCE_MS;
      hold("busy", false);
    }
  }

  return (
    /* One control, not two. A dismiss "×" sat beside Undo until it was clear
       what it was for: the bar takes itself away after eight seconds, so the
       cross only offered to do sooner what was going to happen anyway — and it
       put a second, similar-sized target next to the one that matters. */
    <div
      className="toast"
      onPointerEnter={() => hold("pointer", true)}
      onPointerLeave={() => hold("pointer", false)}
      onFocus={() => hold("focus", true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold("focus", false); }}
    >
      <span className="toast__text">{failed ?? a.message}</span>
      {a.undo && failed === null && (
        <button type="button" className="toast__undo" onClick={undo} disabled={used}>Undo</button>
      )}
    </div>
  );
}

/** What is left on the clock at least, once a pointer or focus lets go. */
const MIN_LEFT_MS = 2000;
