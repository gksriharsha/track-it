import { useEffect, useRef, useState } from "react";
import { getGoals } from "../api";
import { ACTIVITY_CHANGED, byLift, listSessions, sessionSub, sessionTitle, setText } from "../lib/activity";
import type { Load, Session, SessionSet } from "../lib/activity";
import { MINUTES_PER_SET, dayEnergy, energyUsed, kcalText } from "../lib/activityEnergy";
import { PlusGlyph } from "./DayWater";
import Glyph from "./Glyph";
import Info from "./Info";
import LiftFigure from "./LiftFigure";

/**
 * What was done on the day, under what was eaten (D26).
 *
 * Laid out the way a meal is — its name, a + beside it and what it came to on
 * the right, then one tile per session — so that activity reads as the other
 * half of the day rather than a footnote to it. A strength session is a card
 * in the activity colour with the drawing of its first lift and each lift's
 * sets, the layout the user picked from rendered options; a walk or a class
 * is a tile like a food's, led by a plum mark.
 *
 * Still not a headline and not a total to reach. No minutes summed against
 * anything, no ring, nothing for an empty day to fail at — on a day with
 * nothing logged the section is its heading and the way to add something.
 *
 * Each session carries a rough figure for the energy it used, and the head
 * the day's, because the user asked for one. It is said as "about", in the
 * same plain type as the minutes, so the state of the figure — rough — is on
 * the line it qualifies. What it is, how rough, and that it is not taken off
 * what was eaten is method, and sits behind the (i). See
 * `lib/activityEnergy.ts`.
 *
 * The colour names the area and grades nothing in it.
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
    <section className="day-sec activity-card" aria-labelledby="day-activity">
      <div className="day-sec__head">
        <span className="meal__glyph"><Glyph name="walk" size={18} /></span>
        <h2 id="day-activity">Activity</h2>
        {/* The same + every group on Today has beside its name, in plum
            because the section is an activity area (see styles.css). */}
        {p.canAdd && (
          <button className="day-add" onClick={p.onAdd} aria-label="Add activity">
            <PlusGlyph />
          </button>
        )}
        {sessions !== null && sessions.length > 0 && (
          <Info title="How activity's energy is worked out">
            <p>
              A rough figure for the energy an activity used above what resting uses, worked out
              from your weight and published averages for activities like these. For any one
              person it is out by about a third either way, which is why it reads “about” and is
              rounded to the nearest 10 kcal.
            </p>
            <p>
              It is not taken off what you ate. The estimate of what you need already allows for
              your usual exercise, through the activity level in About you.
            </p>
            {day?.fromSets && (
              <p>A strength session with no time is counted at {MINUTES_PER_SET} minutes a set.</p>
            )}
          </Info>
        )}
        {/* The day's rough figure, where a meal's total sits — only for more
            than one session: with one, it IS the session's, already on its
            tile. */}
        {day !== null && sessions !== null && sessions.length > 1 && (
          <span className="day-sec__fig tnum">{kcalText(day.kcal)}</span>
        )}
      </div>
      {sessions !== null && sessions.length > 0 && (
        <>
          <div className="tiles">
            {sessions.map((s) => {
              const used = energyUsed(s, kg);
              const sub = [sessionSub(s), used && kcalText(used.kcal), s.corrected_at !== null && "corrected"]
                .filter(Boolean).join(", ");
              const lifts = s.kind === "strength" ? byLift(s.sets) : [];
              if (lifts.length > 0) {
                return (
                  <button key={s.id} className="tile actcard" onClick={() => p.onOpen(s.id)}>
                    <span className="actcard__head">
                      <LiftFigure lift={lifts[0].name} still className="actcard__fig" />
                      <span className="row__main">
                        <span className="row__title">{sessionTitle(s)}</span>
                        <span className="row__sub tnum">{sub}</span>
                      </span>
                    </span>
                    <span className="actcard__sets tnum">
                      {lifts.map((l) => (
                        <span key={l.id} className="actcard__lift">
                          <span className="actcard__name">{l.name}</span>
                          <span className="actcard__did">{liftText(l.sets, l.load)}</span>
                        </span>
                      ))}
                    </span>
                  </button>
                );
              }
              return (
                <button key={s.id} className="tile entry" onClick={() => p.onOpen(s.id)}>
                  <span className="lead lead--act" aria-hidden><Glyph name={s.kind === "strength" ? "lift" : "walk"} size={20} /></span>
                  <span className="row__main">
                    <span className="row__title">{sessionTitle(s)}</span>
                    <span className="row__sub tnum">{sub}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {day === null && weight === null && (
            <p className="day-sec__note">Add your weight in About you to see roughly what this used.</p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * One lift's sets on the card: "60 kg × 5, 4 sets" when every set was the
 * same, and each set in turn — "60 × 5, 62.5 × 4" — when they were not.
 */
function liftText(sets: SessionSet[], load: Load): string {
  const each = sets.map((x) => setText(x, load));
  if (each.every((t) => t === each[0])) {
    const one = setText(sets[0], load, true);
    return sets.length === 1 ? one : `${one}, ${sets.length} sets`;
  }
  return each.join(", ");
}
