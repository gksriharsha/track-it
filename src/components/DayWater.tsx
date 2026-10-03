import { useCallback, useEffect, useRef, useState } from "react";
import { deleteLogEntry, listBottles, logBottleShare, logWholeBottle } from "../api";
import type { Bottle, LogEntry } from "../types";
import { describeVolume } from "../types";
import { shareMl, shareOf } from "../lib/bottleShare";
import { quantityText, waterNote } from "../lib/entryText";
import { useHashSheet } from "../lib/hashSheet";
import BottleShare from "./BottleShare";
import Glyph from "./Glyph";
import Sheet from "./Sheet";
import { useAnnounce } from "./UndoBar";

/**
 * The day's water, as one row: what it came to, the bottles it came from,
 * and a + that logs your usual bottle whole in one tap.
 *
 * Its own row and never a meal. A bottle is refilled and sipped from across
 * the whole day, so naming a sitting for it would record a fact the user never
 * gave — the database enforces that, and this screen draws it.
 *
 * One row because the user chose it, from rendered options, over a group with
 * a chip per bottle: water is a figure for the day, and the bottles behind it
 * are one tap away in the row's sheet, with each entry, a slider for part of a
 * bottle (see BottleShare), and the way to weigh one instead. The + logs the
 * bottle used most recently, and only one weighed empty — without the empty
 * weight, what a full one holds is not known, and a + that guessed would
 * write the guess into the day. With no such bottle it opens Add's Water tab.
 *
 * The total is in litres, which is how a day of water is thought about.
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
  const sheet = useHashSheet("sheet", "water");
  const [bottles, setBottles] = useState<Bottle[]>([]);

  const readBottles = useCallback(() => {
    listBottles().then(setBottles).catch(() => setBottles([]));
  }, []);
  useEffect(readBottles, [readBottles]);
  // A bottle just used moves to the front, so the list is read again too.
  const { drink, pending, error } = useBottleLog(p.date, () => {
    p.onChanged();
    readBottles();
  });

  // Most recently used first, as `listBottles` returns them. Only a bottle
  // weighed empty can be logged without the scale, whole or in part.
  const calibrated = bottles.filter((b) => b.empty_g !== null);
  const usual = calibrated[0] ?? null;
  // Summed from what each entry came to in millilitres — the bottle's own
  // scale where it has one — never from grams.
  const ml = p.entries.reduce((n, e) => n + (e.water?.ml ?? 0), 0);
  const names = [...new Set(p.entries.map((e) => e.description))];

  /*
    Logged from the sheet, the sheet goes: the bar that says what was written,
    and offers the way back, sits under any sheet, and an Undo nobody can see
    is no Undo. The row it closes onto already shows the new total.
  */
  async function drinkPart(b: Bottle, share: number): Promise<boolean> {
    const ok = await drink(b, share);
    if (ok) sheet.hide();
    return ok;
  }

  return (
    <section className="water" aria-label="Water">
      <div className="water__row">
        <button className="tile water__open" onClick={sheet.show} aria-haspopup="dialog">
          <span className="lead lead--water" aria-hidden><Glyph name="drop" size={20} /></span>
          <span className="row__main">
            <span className="row__title">Water</span>
            <span className="row__sub">{names.length > 0 ? names.join(", ") : "None logged yet"}</span>
          </span>
          {ml > 0 && <span className="entry__fig tnum">{litres(ml)}</span>}
        </button>
        <button
          className="water__add"
          onClick={() => (usual ? drink(usual) : p.onAdd())}
          disabled={pending !== null}
          aria-busy={pending !== null}
          aria-label={usual
            ? `Log a whole ${usual.name}${usual.volume_ml === null ? "" : `, ${describeVolume(usual.volume_ml)}`}`
            : "Add water"}
        >
          <PlusGlyph />
        </button>
      </div>
      {error && !sheet.open && <p className="alert" role="alert">{error}</p>}

      <Sheet open={sheet.open} onClose={sheet.hide} title={ml > 0 ? `Water, ${litres(ml)}` : "Water"}
        className="water-area">
        <div className="water-sheet">
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
          {calibrated.length > 0 && (
            <BottleShare bottles={calibrated.slice(0, 4)} busy={pending !== null} onLog={drinkPart} />
          )}
          {error && <p className="alert" role="alert">{error}</p>}
          <button className="btn btn--quiet" onClick={p.onAdd}>
            {calibrated.length > 0 ? "Weigh it on the scale instead" : "Weigh a bottle"}
          </button>
        </div>
      </Sheet>
    </section>
  );
}

/**
 * Logging a bottle without the scale — all of it, or a share judged by eye —
 * with the Undo every log gets. Shared by the water row and the bar's + sheet,
 * so a bottle is written and announced the same way from either.
 */
export function useBottleLog(date: string, onChanged: () => void) {
  const announce = useAnnounce();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The latest, for an Undo pressed after the screen that raised it has moved on.
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  /** True once it is written. */
  const drink = useCallback(async (b: Bottle, share = 1): Promise<boolean> => {
    if (pending !== null) return false;
    setPending(b.id);
    setError(null);
    try {
      const id = share === 1 ? await logWholeBottle(date, b.id) : await logBottleShare(date, b.id, share);
      changedRef.current();
      const held = shareMl(b, share);
      const amount = held === null ? "a whole bottle" : describeVolume(held);
      announce({
        message: share === 1 ? `${b.name}, ${amount}, added` : `${shareOf(share, b.name)}, ${amount}, added`,
        // Written seconds ago and nothing built on it yet, so taking it back
        // is removing it rather than rewriting history.
        undo: async () => {
          await deleteLogEntry(id);
          changedRef.current();
        },
      });
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setPending(null);
    }
  }, [announce, date, pending]);

  return { drink, pending, error };
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
