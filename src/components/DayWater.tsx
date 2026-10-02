import { useCallback, useEffect, useRef, useState } from "react";
import { deleteLogEntry, listBottles, logWholeBottle } from "../api";
import type { Bottle, LogEntry } from "../types";
import { describeVolume } from "../types";
import { quantityText, waterNote } from "../lib/entryText";
import { useAnnounce } from "./UndoBar";

/**
 * The day's water: what it came to, the bottles it came from, and a bottle
 * drunk in one tap.
 *
 * Its own group and never a meal. A bottle is refilled and sipped from across
 * the whole day, so naming a sitting for it would record a fact the user never
 * gave — the database enforces that, and this screen draws it.
 *
 * The total is in litres, which is how a day of water is thought about; each
 * row is the volume that bottle came to. Below them, up to three bottles to
 * log whole, most recently used first: one tap for "I finished the flask",
 * with the app's bar saying what was written and a way back. Only bottles
 * weighed empty are offered — without the empty weight, what a full one holds
 * is not known, and a chip that guessed would write the guess into the day.
 * Part of a bottle is still weighed, from Add's Water tab, behind the +.
 */
export default function DayWater(p: {
  date: string;
  /** The day's water entries, as Today groups them. */
  entries: LogEntry[];
  onOpen: (id: string) => void;
  onAdd: () => void;
  /** Something was written to the day: re-read it. */
  onChanged: () => void;
}) {
  const announce = useAnnounce();
  const [bottles, setBottles] = useState<Bottle[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changedRef = useRef(p.onChanged);
  changedRef.current = p.onChanged;

  const readBottles = useCallback(() => {
    listBottles().then(setBottles).catch(() => setBottles([]));
  }, []);
  useEffect(readBottles, [readBottles]);

  const whole = bottles.filter((b) => b.empty_g !== null).slice(0, 3);
  // Summed from what each entry came to in millilitres — the bottle's own
  // scale where it has one — never from grams.
  const ml = p.entries.reduce((n, e) => n + (e.water?.ml ?? 0), 0);

  async function drink(b: Bottle) {
    if (pending !== null) return;
    setPending(b.id);
    setError(null);
    try {
      const id = await logWholeBottle(p.date, b.id);
      changedRef.current();
      // Its last use moved, so it moves to the front.
      readBottles();
      const held = b.volume_ml === null ? "a whole bottle" : describeVolume(b.volume_ml);
      announce({
        message: `${b.name}, ${held}, added`,
        // Written seconds ago and nothing built on it yet, so taking it back
        // is removing it rather than rewriting history.
        undo: async () => {
          await deleteLogEntry(id);
          changedRef.current();
        },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="day-sec day-water" aria-labelledby="day-water">
      <div className="day-sec__head">
        <h2 id="day-water">Water</h2>
        <button className="day-add" onClick={p.onAdd} aria-label="Add water">
          <PlusGlyph />
        </button>
        {ml > 0 && <span className="day-sec__fig tnum">{litres(ml)}</span>}
      </div>

      {p.entries.length > 0 && (
        <div className="rows">
          {p.entries.map((e) => {
            const note = waterNote(e);
            return (
              <button key={e.id} className="row entry" onClick={() => p.onOpen(e.id)}>
                <span className="row__main">
                  <span className="row__title">{e.description}</span>
                  {note && <span className="row__sub">{note}</span>}
                </span>
                <span className="entry__fig tnum">{quantityText(e)}</span>
              </button>
            );
          })}
        </div>
      )}

      {whole.length > 0 && (
        <div className="usual">
          <div className="usual__chips">
            {whole.map((b) => (
              <button
                key={b.id}
                className="usual__chip"
                onClick={() => drink(b)}
                disabled={pending !== null}
                aria-busy={pending === b.id}
                aria-label={`Log a whole ${b.name}${b.volume_ml === null ? "" : `, ${describeVolume(b.volume_ml)}`}`}
              >
                <PlusGlyph />
                <span className="usual__name">{b.name}</span>
                {b.volume_ml !== null && <span className="usual__amt tnum">{describeVolume(b.volume_ml)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="alert" role="alert">{error}</p>}
    </section>
  );
}

/** A day of water, in litres: "1.5 L", and "0.75 L" for under one. */
function litres(ml: number): string {
  const l = ml / 1000;
  return `${l.toFixed(l < 1 ? 2 : 1)} L`;
}

/** The + the app draws on every "add" — the bottom bar's own, smaller. */
export function PlusGlyph() {
  return (
    <svg className="plus" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
