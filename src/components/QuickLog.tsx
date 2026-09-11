import { useCallback, useEffect, useRef, useState } from "react";
import { addLogEntry, deleteLogEntry, recallTags } from "../api";
import type { FrequentFood, Meal } from "../types";

/**
 * How long the way back stays on screen. Long enough to read the sentence and
 * reach for it; short enough that it is gone before it becomes furniture.
 */
const UNDO_MS = 8000;

interface Logged {
  entryId: string;
  /** What was written, in the words the button carried before it was pressed. */
  label: string;
  meal: Meal;
}

/**
 * Logging a food you have had before, in one tap.
 *
 * The app used to refuse this on principle: every shortcut opened the amount
 * step first, on the argument that a row which logged on one tap would be "a
 * button that writes to somebody's history out of a list they never asked to
 * have built". That objection is real, and it is answered rather than
 * overruled — by making the write visible before it happens and reversible
 * after it. The weight is printed ON the control, so nothing is logged that
 * the finger had not already read; and the moment it lands, a way back sits
 * over the bottom bar for eight seconds.
 *
 * What is written is the same entry the long way round would have written: the
 * current food (read live, never the name the log remembers), the weight it was
 * last logged at, and the origin and cuisine the user themselves last gave it.
 * Nothing here guesses.
 */
export function useQuickLog(date: string, meal: Meal, onLogged: () => void) {
  const [last, setLast] = useState<Logged | null>(null);
  /** The key of the row being written, so only it shows the wait. */
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // Leaving the screen must not leave a timer holding a setState on an
  // unmounted component — and a way back that outlives the screen it belongs to
  // would be offering to undo something the user can no longer see.
  useEffect(() => clear, [clear]);

  const log = useCallback(
    async (f: FrequentFood) => {
      if (pending !== null) return;
      const source =
        f.source_kind === "custom"
          ? f.custom_food_id === null
            ? null
            : { customFoodId: f.custom_food_id }
          : f.fdc_id === null
            ? null
            : { fdcId: f.fdc_id };
      if (source === null) {
        setError("That shortcut has lost the food behind it, so nothing was logged.");
        return;
      }
      setPending(f.key);
      setError(null);
      try {
        // The user's own last answer for this food. A failure here is not a
        // reason to refuse the log: an untagged entry is a perfectly good
        // entry, and the tags can be set on it afterwards from Today.
        const tags = await recallTags(source).catch(() => ({ origin: null, cuisine: null }));
        const entryId = await addLogEntry(date, meal, source, f.description, f.last_grams, tags);
        clear();
        setLast({ entryId, label: `${f.description}, ${f.last_amount_label}`, meal });
        timer.current = setTimeout(() => setLast(null), UNDO_MS);
        onLogged();
      } catch (e) {
        setError(String(e));
      } finally {
        setPending(null);
      }
    },
    [clear, date, meal, onLogged, pending],
  );

  const undo = useCallback(async () => {
    if (last === null) return;
    const { entryId } = last;
    // Dismissed first, so a slow delete cannot be pressed twice.
    clear();
    setLast(null);
    try {
      await deleteLogEntry(entryId);
      onLogged();
    } catch (e) {
      setError(String(e));
    }
  }, [clear, last, onLogged]);

  return { log, pending, last, undo, error };
}

/**
 * What was just written, and the way back out of it.
 *
 * Sits above the bottom bar rather than over it: the bar is how you leave this
 * screen, and covering it to announce a success would trap someone who wanted
 * to be somewhere else.
 */
export function UndoToast({
  last, onUndo,
}: {
  last: { label: string; meal: Meal } | null;
  onUndo: () => void;
}) {
  if (last === null) return null;
  return (
    /* One control, not two. A dismiss “×” sat beside Undo until it was clear
       what it was for: the bar takes itself away after eight seconds, so the
       cross only offered to do sooner what was going to happen anyway — and it
       put a second, similar-sized target next to the one that matters. */
    <div className="toast" role="status">
      <span className="toast__text">
        Added to {last.meal} — {last.label}
      </span>
      <button className="toast__undo" onClick={onUndo}>Undo</button>
    </div>
  );
}

/**
 * The foods you have most days, as buttons that log them.
 *
 * A shortcut, and it still has to read as one. There is no count on a tile, no
 * rank number, no "favourites" and no heading that congratulates anyone for
 * having habits — a tally beside a food name is a leaderboard of your own
 * eating. What each tile prints is the one fact that helps you decide whether
 * to press it: what you weighed out last time. That is a fact about the food.
 *
 * The meal is named in the heading rather than left to be discovered, because
 * it is the one part of the write the tile cannot show you.
 */
export function QuickAddStrip({
  foods, meal, pending, onLog,
}: {
  foods: FrequentFood[];
  meal: Meal;
  pending: string | null;
  onLog: (f: FrequentFood) => void;
}) {
  if (foods.length === 0) return null;
  return (
    <section className="again">
      <div className="again__head">
        {/* The same name this section carries on the Add food screen. One idea
            should not have two names in one app, and "Had it before" names the
            contents while the buttons name the action. */}
        <h2>Had it before</h2>
        <span className="again__note">one tap, into {meal}</span>
      </div>
      <div className="again__strip">
        {foods.map((f) => (
          <button
            key={f.key}
            className="again__tile"
            onClick={() => onLog(f)}
            disabled={pending !== null}
            aria-busy={pending === f.key}
          >
            <span className="again__name">{f.description}</span>
            <span className="again__amt tnum">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
              {f.last_amount_label}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
