import { useEffect, useRef, useState } from "react";
import { getGoals } from "../api";
import { ACTIVITY_CHANGED, listSessions, sessionSub, sessionTitle } from "../lib/activity";
import type { Session } from "../lib/activity";
import { MINUTES_PER_SET, dayEnergy, energyUsed, kcalText } from "../lib/activityEnergy";

/**
 * What was done on the day, under what was eaten (D26).
 *
 * Plain sans and plain lines: a day's activity is one more fact about the day,
 * not a headline and not a total to reach. No minutes summed against anything,
 * no ring, nothing for an empty day to fail at — on a day with nothing logged
 * the card is its own heading and the way to add something, and says nothing
 * else.
 *
 * Each session carries a rough figure for the energy it used, and the foot the
 * day's, because the user asked for one. It is said as "about", in the same
 * plain type as the minutes, and the foot says in one line what it is and that
 * it is not taken off what was eaten — so it informs without turning the day
 * into a budget. See `lib/activityEnergy.ts`.
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
  // undefined while unread; null once read with no weight on file.
  const [weight, setWeight] = useState<number | null | undefined>(undefined);

  // Read again when a session changes off this screen — an Undo pressed here
  // in the app's bar for a walk added on the Activity tab.
  const [reread, setReread] = useState(0);
  useEffect(() => {
    const again = () => setReread((n) => n + 1);
    window.addEventListener(ACTIVITY_CHANGED, again);
    return () => window.removeEventListener(ACTIVITY_CHANGED, again);
  }, []);

  const readFor = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    // Blanked only for a new day; a re-read keeps the rows up until it lands.
    if (readFor.current !== p.date) setSessions(null);
    readFor.current = p.date;
    listSessions(p.date)
      .then((s) => { if (live) setSessions(s); })
      .catch(() => { if (live) setSessions([]); });
    return () => { live = false; };
  }, [p.date, reread]);

  // Read once per visit: the weight is the profile's current one, which is the
  // only weight the app keeps.
  useEffect(() => {
    let live = true;
    getGoals()
      .then((g) => { if (live) setWeight(g.profile.weight_kg); })
      .catch(() => { if (live) setWeight(null); });
    return () => { live = false; };
  }, []);

  const kg = weight ?? null;
  const day = sessions !== null ? dayEnergy(sessions, kg) : null;

  return (
    <section className="card activity-card" aria-label="Activity">
      <div className="card__head">
        <h2>Activity</h2>
        {p.canAdd && (
          <button className="link card__note" onClick={p.onAdd}>Add activity</button>
        )}
      </div>
      {sessions !== null && sessions.length > 0 && (
        <>
          <div className="rows">
            {sessions.map((s) => {
              const used = energyUsed(s, kg);
              const sub = [sessionSub(s), used && kcalText(used.kcal)].filter(Boolean).join(", ");
              return (
                <button key={s.id} className="row activity-card__row" onClick={() => p.onOpen(s.id)}>
                  <span className="row__title">{sessionTitle(s)}</span>
                  <span className="row__sub tnum">
                    {sub}
                    {s.corrected_at !== null && ", corrected"}
                  </span>
                </button>
              );
            })}
          </div>
          {day !== null && (
            <p className="card__foot activity-card__foot">
              <span className="tnum">{capital(kcalText(day.kcal))}</span> of activity in all, above what resting
              uses. A rough figure from your weight and published averages for activities like these, give or
              take about a third, and not taken off what you ate.
              {day.fromSets && ` A strength session with no time is counted at ${MINUTES_PER_SET} minutes a set.`}
            </p>
          )}
          {day === null && weight === null && (
            <p className="card__foot activity-card__foot">
              Add your weight in About you to see roughly what this used.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
