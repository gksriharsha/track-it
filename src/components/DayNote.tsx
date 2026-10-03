import { useCallback, useEffect, useRef, useState } from "react";
import { getDayNote, humanDate, setDayNote } from "../api";
import Info from "./Info";

/**
 * The day in the user's own words.
 *
 * Everything else on Today is arithmetic, and arithmetic cannot hold the
 * reasons: that the sambar could not be weighed because it was somebody else's
 * pot, that a day was a fast, that the numbers look odd because of a flight.
 * Those are facts about the day that belong beside it, and there was nowhere to
 * put them. The user asked for somewhere.
 *
 * It is NOT nutrition and nothing reads it as any — see the `day_notes` comment
 * in store.rs. No figure in the app moves because of what is typed here, which
 * is exactly what makes it safe to write freely in.
 *
 * One line until there is something to say. It used to be a card holding an
 * empty three-row field and a 36-word paragraph about what the field was not,
 * on every day whether or not anything was written — a box nobody used that
 * cost a fifth of a phone screen. Now an empty note is "Add a note", the field
 * opens when that is pressed, and the paragraph is behind the (i). A day that
 * already has a note opens on it, because a note is worth reading back.
 *
 * Saved by itself, on a pause and on losing focus, because a note nobody
 * pressed a button for is a note that has to survive the thumb that reaches
 * for the bottom bar. The screen unmounts when you leave it, so the last write
 * happens from the cleanup below.
 */
export default function DayNote({ date }: { date: string }) {
  /** null while the note for `date` has not come back yet. */
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "kept">("idle");
  const [error, setError] = useState<string | null>(null);
  /** The field, opened by "Add a note" on a day with none yet. */
  const [writing, setWriting] = useState(false);

  /*
    What the database holds, and the day it holds it for. Both in refs, because
    the only reader is `flush`, which runs from a cleanup — after `date` has
    already changed in props and before this component has rendered for the new
    one. A note typed on Tuesday must not be written to Wednesday because the
    user tapped Wednesday first, and the date that travels with the text is the
    only thing that can prevent it.
  */
  const stored = useRef<{ date: string; body: string } | null>(null);
  const draftRef = useRef<string | null>(null);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const flush = useCallback(async () => {
    const at = stored.current;
    const body = draftRef.current;
    if (at === null || body === null) return;
    if (body.trim() === at.body.trim()) return;
    setStatus("saving");
    try {
      await setDayNote(at.date, body);
      /*
        Only if the day has not moved underneath this write. The day being
        left is saved from a cleanup, and by the time it lands `stored` may
        already describe the day arrived at — writing the old body there would
        make the new day's note look already-saved and lose the next edit.
      */
      if (stored.current?.date !== at.date) return;
      stored.current = { date: at.date, body };
      setStatus("kept");
      setError(null);
    } catch (e) {
      if (stored.current?.date !== at.date) return;
      setStatus("idle");
      setError(String(e));
    }
  }, []);

  /* Read the day arrived at, and write the day being left. */
  useEffect(() => {
    let live = true;
    setStatus("idle");
    setError(null);
    setWriting(false);
    getDayNote(date)
      .then((body) => {
        if (!live) return;
        stored.current = { date, body: body ?? "" };
        // Only if nothing has been typed in the meantime. The read is a
        // single-row lookup and wins this race every time in practice, but
        // losing it would silently delete a sentence.
        setDraft((d) => (d === null ? body ?? "" : d));
      })
      .catch((e) => { if (live) setError(String(e)); });
    return () => {
      live = false;
      void flush();
      setDraft(null);
    };
  }, [date, flush]);

  /*
    A pause is a save. Long enough that it is not a write per keystroke, short
    enough that putting the phone down mid-sentence keeps the sentence.
  */
  useEffect(() => {
    if (draft === null || stored.current === null) return;
    if (draft.trim() === stored.current.body.trim()) return;
    const t = setTimeout(() => { void flush(); }, 700);
    return () => clearTimeout(t);
  }, [draft, flush]);

  // Open whenever there is something in it, and from the moment it is written
  // in — `writing` is set on focus too — so clearing a note to start it again
  // does not snap the field shut under the cursor.
  const open = writing || (draft !== null && draft !== "");

  return (
    <section className="day-sec day-note" aria-label="Note">
      <div className="day-sec__head">
        <h2>Note</h2>
        <Info title="What the note is for">
          <p>
            Yours, and not part of the arithmetic. Nothing in a note is read as food, and nothing
            in it changes any figure in the app — which is the point: it is for what the numbers
            cannot hold. A fast, a day away, a pot that was somebody else's.
          </p>
          <p>It is kept as you type, for this day only.</p>
        </Info>
        {status !== "idle" ? (
          <span className="day-sec__aside">{status === "saving" ? "Saving…" : "Saved"}</span>
        ) : !open && draft !== null ? (
          <button className="link day-sec__aside" onClick={() => setWriting(true)}>Add a note</button>
        ) : null}
      </div>

      {open && (
        <textarea
          className="field day-note__field"
          rows={3}
          maxLength={2000}
          // Pressing "Add a note" is asking to write, so the keys come up; a
          // day that opens on a note it already has does not grab them.
          autoFocus={writing}
          value={draft ?? ""}
          placeholder="Anything worth writing down about this day."
          aria-label={`Note for ${humanDate(date)}`}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setWriting(true)}
          onBlur={() => void flush()}
        />
      )}

      {error && <p className="alert" role="alert">{error}</p>}
    </section>
  );
}
