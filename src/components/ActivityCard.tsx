import { useEffect, useState } from "react";
import { listSessions, sessionSub, sessionTitle } from "../lib/activity";
import type { Session } from "../lib/activity";

/**
 * What was done on the day, under what was eaten (D26).
 *
 * Plain sans and plain lines: a day's activity is one more fact about the day,
 * not a headline and not a total to reach. No minutes summed against anything,
 * no ring, nothing for an empty day to fail at — on a day with nothing logged
 * the card is its own heading and the way to add something, and says nothing
 * else.
 *
 * Tinted rather than white so the two kinds of record on Today read apart at a
 * glance; the colour names the area and grades nothing in it.
 */
export default function ActivityCard(p: {
  date: string;
  canAdd: boolean;
  onAdd: () => void;
  onOpen: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);

  useEffect(() => {
    let live = true;
    setSessions(null);
    listSessions(p.date)
      .then((s) => { if (live) setSessions(s); })
      .catch(() => { if (live) setSessions([]); });
    return () => { live = false; };
  }, [p.date]);

  return (
    <section className="card activity-card" aria-label="Activity">
      <div className="card__head">
        <h2>Activity</h2>
        {p.canAdd && (
          <button className="link card__note" onClick={p.onAdd}>Add activity</button>
        )}
      </div>
      {sessions !== null && sessions.length > 0 && (
        <div className="rows">
          {sessions.map((s) => (
            <button key={s.id} className="row activity-card__row" onClick={() => p.onOpen(s.id)}>
              <span className="row__title">{sessionTitle(s)}</span>
              <span className="row__sub tnum">
                {sessionSub(s)}
                {s.corrected_at !== null && ", corrected"}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
