import { useEffect, useState } from "react";
import { humanDate, shiftIso } from "../api";
import { ACTIVITIES } from "../types";
import { KIND_LABEL, getActivityRange, minutesText, setText } from "../lib/activity";
import type { ActivityRange } from "../lib/activity";
import { plural } from "../lib/nutrient";
import Spread from "./Spread";

/** Below this many whole weeks, the profile's level and the log are not compared. */
const ENOUGH_TO_COMPARE = 4;

/**
 * Activity over the period, on Trends (D26).
 *
 * Counted by the week, because that is the unit activity happens in — a walk
 * on Monday and none on Tuesday is a week with a walk in it, not a bad Tuesday
 * — and the unit the WHO guideline is written in. The guideline is printed
 * beside the figure as a reference, named, never as a bar to fill or a mark
 * to pass.
 *
 * What is NOT here is as deliberate: no calories burned, no streak of weeks, no
 * heaviest-ever lift. The profile's activity level sits beside what the log
 * shows so the person can see whether the energy estimate is being fed the
 * right number, and decide for themselves.
 */
export default function ActivityTrends(p: {
  from: string;
  to: string;
  onOpenProfile?: () => void;
}) {
  const [data, setData] = useState<ActivityRange | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getActivityRange(p.from, p.to)
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [p.from, p.to]);

  if (error) return <p className="alert" role="alert">{error}</p>;
  if (data === null) return null;

  if (data.tracked_since === null) {
    return (
      <section className="stats__block stats__block--act">
        <h2 className="stats__h">Activity</h2>
        <p className="stats__note">
          Nothing logged yet. A walk, a class or a gym session is added from the Add screen,
          one tab along from Water, and is counted here by the week.
        </p>
      </section>
    );
  }

  const whole = data.weeks.filter((w) => w.tracked_days === 7);
  // Oldest first, for the short list: a few weeks read in the order they happened.
  const inOrder = [...whole].reverse();
  const partial = data.weeks.find((w) => w.tracked_days < 7) ?? null;
  const t = data.typical;
  const age = data.birth_year === null ? null : new Date().getFullYear() - data.birth_year;
  // The guideline quoted is the adult one; under 18 it is a different guideline.
  const adult = age === null || age >= 18;
  const level = ACTIVITIES.find((a) => a.id === data.profile_activity) ?? null;
  const totalSessions = data.by_kind.reduce((n, k) => n + k.sessions, 0);
  // The newest week is the last seven days; "Week to Today" is not a phrase.
  const weekTo = (index: number) =>
    index === 0 ? "Last 7 days" : `Week to ${humanDate(shiftIso(data.to, -index * 7))}`;

  return (
    <>
      <section className="stats__block stats__block--act">
        <h2 className="stats__h">Activity</h2>
        <p className="stats__note">
          {data.tracked_since >= data.from ? <>You started logging activity {onDay(data.tracked_since)}. </> : null}
          {whole.length === 0
            ? "There is not yet a whole week of it in this period, so it is counted by the days so far."
            : `Counted by the week: ${plural(whole.length, "whole week")} of it ${
                whole.length === 1 ? "falls" : "fall"
              } in these ${data.span_days} days.`}
        </p>

        {whole.length === 0 && partial !== null && (
          <p className="stats__figure">
            {/* Sessions rather than minutes when no session has a length: a
                gym session with its sets written and no time beside it is
                not "0 min", and printing that would misreport it. */}
            <span className="stats__n num">
              {partial.minutes > 0 ? minutesText(partial.minutes) : plural(data.sessions, "session")}
            </span>
            <span className="stats__when">
              in the {plural(partial.tracked_days, "day")} since you started
            </span>
          </p>
        )}

        {whole.length > 0 && whole.length < 5 && (
          <dl className="stats__list stats__list--one">
            {inOrder.map((w) => (
              <div className="stats__row" key={w.index}>
                <dt className="stats__name">{weekTo(w.index)}</dt>
                <dd className="stats__amt num">{minutesText(w.minutes)}</dd>
                <dd className="stats__ref">
                  {w.active_days === 0 ? "no sessions" : `active on ${plural(w.active_days, "day")}`}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {whole.length >= 5 && (
        <Spread
          label="Time active"
          values={whole.map((w) => w.minutes)}
          unit="min"
          per="week"
          tone="act"
          reference={null}
          format={minutesText}
        />
      )}

      {t !== null && (
        <section className="stats__block stats__block--act">
          <h2 className="stats__h">
            {t.weeks === 1 ? "The whole week" : `A typical week, of ${t.weeks}`}
          </h2>
          <p className="stats__note">
            The middle week for each figure separately. A hard minute counts as two, the way
            the WHO guideline counts it; easy minutes are in the time above but not in this line.
            Strength training is counted in days, as the guideline counts it.
          </p>
          <dl className="stats__list">
            <div className="stats__row">
              <dt className="stats__name">Moderate or hard</dt>
              {/* Plain minutes, in the unit of the reference beside it:
                  "2 h 34 min" next to "150–300 min" made the reader convert. */}
              <dd className="stats__amt num">{Math.round(t.aerobic_minutes).toLocaleString()} min</dd>
              <dd className="stats__ref">{adult ? "WHO 150–300 min" : ""}</dd>
            </div>
            <div className="stats__row">
              <dt className="stats__name">Strength training</dt>
              <dd className="stats__amt num">{days(t.strength_days)}</dd>
              <dd className="stats__ref">{adult ? "WHO 2 or more days" : ""}</dd>
            </div>
            <div className="stats__row">
              <dt className="stats__name">Days with any activity</dt>
              <dd className="stats__amt num">{days(t.active_days)}</dd>
              <dd className="stats__ref" />
            </div>
          </dl>

          {t.weeks >= ENOUGH_TO_COMPARE && (
            <p className="stats__read">
              {level === null ? (
                <>About you has no activity level set, so the energy estimate has none to use. </>
              ) : (
                <>
                  About you gives your activity as <b>{level.label.toLowerCase()}</b>, {level.note}.
                  In your log, a typical week had activity on{" "}
                  <b className="num">{days(t.active_days)}</b>.{" "}
                </>
              )}
              {p.onOpenProfile && (
                <button className="link" onClick={p.onOpenProfile}>
                  {level === null ? "Set it in About you" : "Change it in About you"}
                </button>
              )}
            </p>
          )}
        </section>
      )}

      {totalSessions > 0 && (
        <section className="stats__block stats__block--act">
          <h2 className="stats__h">What you did</h2>
          <dl className="stats__list">
            {data.by_kind.map((k) => (
              <div className="stats__row" key={k.kind}>
                <dt className="stats__name">{KIND_LABEL[k.kind]}</dt>
                <dd className="stats__amt num">{k.sessions}</dd>
                <dd className="stats__ref">
                  {Math.round((k.sessions / totalSessions) * 100)}% of sessions
                </dd>
              </div>
            ))}
          </dl>
          <p className="stats__note">Counted by session, so a gym session with no length still counts.</p>
        </section>
      )}

      {data.exercises.length > 0 && (
        <section className="stats__block stats__block--act">
          <h2 className="stats__h">Lifts</h2>
          <p className="stats__note">
            Each session&rsquo;s heaviest set, and the middle one of those once a lift has three
            sessions behind it. The middle is a set that was actually lifted, not an average of two.
          </p>
          <dl className="stats__list stats__list--one">
            {data.exercises.map((x) => {
              const s = x.summary;
              return (
                <div className="stats__row" key={x.exercise_id}>
                  <dt className="stats__name">{x.name}</dt>
                  <dd className="stats__amt num">
                    {s.usual ? <>usually {setText(s.usual, x.load, true)}</> : ""}
                  </dd>
                  <dd className="stats__ref">
                    {plural(s.sessions, "session")}
                    {s.heaviest && `, heaviest ${setText(s.heaviest, x.load, true)}`}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}
    </>
  );
}

/** "today", "yesterday", "on Thu, Jul 30" — a date that can end a sentence. */
function onDay(iso: string): string {
  const h = humanDate(iso);
  return h === "Today" || h === "Yesterday" ? h.toLowerCase() : `on ${h}`;
}

/** "2 days", "1.5 days", "1 day". */
function days(n: number): string {
  const r = Math.round(n * 2) / 2;
  return r === 1 ? "1 day" : `${r.toLocaleString()} days`;
}
