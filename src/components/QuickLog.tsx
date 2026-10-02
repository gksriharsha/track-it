import { useCallback, useRef, useState } from "react";
import { addLogEntry, deleteLogEntry, recallTags } from "../api";
import type { FrequentFood, Meal } from "../types";
import { useAnnounce } from "./UndoBar";

/**
 * Logging a food you have had before, in one tap.
 *
 * The app used to refuse this on principle: every shortcut opened the amount
 * step first, on the argument that a row which logged on one tap would be "a
 * button that writes to somebody's history out of a list they never asked to
 * have built". That objection is real, and it is answered rather than
 * overruled — by making the write visible before it happens and reversible
 * after it. The weight is printed ON the control, so nothing is logged that
 * the finger had not already read; and the moment it lands, the app's one bar
 * says what was written, with a way back, for eight seconds (see UndoBar.tsx).
 *
 * What is written is the same entry the long way round would have written: the
 * current food (read live, never the name the log remembers), the weight it was
 * last logged at, and the origin and cuisine the user themselves last gave it.
 * Nothing here guesses.
 */
export function useQuickLog(date: string, meal: Meal, onLogged: () => void) {
  const announce = useAnnounce();
  /** The key of the row being written, so only it shows the wait. */
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
    The latest, not the one in force when the log was made. The bar outlives
    this screen, so its Undo can be pressed after the screen has re-rendered or
    gone; the callback it reaches must be today's, not a closure over a day the
    app has since moved off.
  */
  const onLoggedRef = useRef(onLogged);
  onLoggedRef.current = onLogged;

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
        onLoggedRef.current();
        announce({
          // In the words the button carried before it was pressed.
          message: `${f.description}, ${f.last_amount_label} added to ${meal}`,
          // Taking back an entry written seconds ago is removing it, not
          // rewriting history: nothing else can have been built on it yet.
          undo: async () => {
            await deleteLogEntry(entryId);
            onLoggedRef.current();
          },
        });
      } catch (e) {
        setError(String(e));
      } finally {
        setPending(null);
      }
    },
    [announce, date, meal, pending],
  );

  return { log, pending, error };
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
