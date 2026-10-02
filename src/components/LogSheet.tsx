import { useEffect, useState } from "react";
import { frequentFoods, humanDate, listBottles } from "../api";
import type { Bottle, FrequentFood, Meal } from "../types";
import { describeVolume } from "../types";
import {
  deleteSession, minutesText, recentSessions, saveSession, sayActivityChanged, sessionTitle,
} from "../lib/activity";
import type { RecentSession } from "../lib/activity";
import { PlusGlyph, useBottleLog } from "./DayWater";
import Glyph from "./Glyph";
import { useQuickLog } from "./QuickLog";
import Sheet from "./Sheet";
import { useAnnounce } from "./UndoBar";

/**
 * What the bar's + opens: food or activity, as two equal choices, with the
 * usual of each one tap away beneath them.
 *
 * The user chose this from rendered options, after turning down every bar
 * that made food the obvious thing to log and left activity a step further
 * away ("An easy way to add/record activity like the meal"). So the + names
 * neither; it asks. Food and Activity are drawn the same size, each in its own
 * colour, and under them are the foods usually had at this time of day and
 * the sessions done lately — each written in one tap, with Undo, the way a
 * meal's usual foods already are on Today. Water, which is neither, is the
 * last row: its + logs the usual bottle whole, and the row opens the water
 * sheet for part of one.
 *
 * The cost, which the user accepted when choosing it: one tap more before
 * searching for a food.
 *
 * A one-tap log closes the sheet, because the bar that says what was written
 * and offers the way back sits under every sheet.
 */
export default function LogSheet(p: {
  open: boolean;
  onClose: () => void;
  /** The day being logged into: the one Today is showing. */
  date: string;
  /** The sitting a food logged from here goes into. */
  meal: Meal;
  onFood: () => void;
  onActivity: () => void;
  /** A strength session, started with the lifts of the last one. */
  onStrength: () => void;
  /** The water sheet, for part of a bottle or another bottle. */
  onWater: () => void;
  /** Something was written to the day: re-read it. */
  onChanged: () => void;
}) {
  const announce = useAnnounce();
  const [foods, setFoods] = useState<FrequentFood[]>([]);
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [bottle, setBottle] = useState<Bottle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quick = useQuickLog(p.date, p.meal, p.onChanged);
  const water = useBottleLog(p.date, p.onChanged);

  // Read each time it opens: what was had at this hour, and done lately, moves.
  useEffect(() => {
    if (!p.open) return;
    let live = true;
    setError(null);
    frequentFoods(2, p.meal).then((f) => { if (live) setFoods(f); }).catch(() => { if (live) setFoods([]); });
    recentSessions(2).then((r) => { if (live) setSessions(r); }).catch(() => { if (live) setSessions([]); });
    // The bottle the water row's + logs: the one used last, of those weighed
    // empty, as on Today.
    listBottles()
      .then((bs) => { if (live) setBottle(bs.find((b) => b.empty_g !== null) ?? null); })
      .catch(() => { if (live) setBottle(null); });
    return () => { live = false; };
  }, [p.open, p.meal]);

  const label = humanDate(p.date);
  const day = label === "Today" || label === "Yesterday" ? label.toLowerCase() : label;

  async function food(f: FrequentFood) {
    if (await quick.log(f)) p.onClose();
  }

  /** A walk, a swim, a class: written again as it was. Strength opens, since its sets are done one at a time. */
  async function again(r: RecentSession) {
    if (busy) return;
    if (r.kind === "strength") {
      p.onStrength();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = await saveSession({
        id: null, logged_on: p.date, kind: r.kind, label: r.label,
        minutes: r.minutes, effort: r.effort, note: null,
      });
      sayActivityChanged();
      announce({
        message: `Added to ${day}: ${sessionTitle(r)}, ${minutesText(r.minutes ?? 0)}`,
        undo: async () => {
          await deleteSession(id);
          sayActivityChanged();
        },
      });
      p.onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function wholeBottle(b: Bottle) {
    if (await water.drink(b)) p.onClose();
  }

  const shown = error ?? quick.error ?? water.error;

  return (
    <Sheet open={p.open} onClose={p.onClose} title={`Add to ${day}`}>
      <div className="logsheet">
        <div className="logsheet__pair">
          <button className="logbig logbig--food" onClick={p.onFood}>
            <Glyph name="bowl" size={26} />
            <span className="logbig__name">Food</span>
            <span className="logbig__what">Search or weigh</span>
          </button>
          <button className="logbig logbig--act" onClick={p.onActivity}>
            <Glyph name="walk" size={26} />
            <span className="logbig__name">Activity</span>
            <span className="logbig__what">A walk, a session</span>
          </button>
        </div>

        {(foods.length > 0 || sessions.length > 0) && (
          <section className="logsheet__again" aria-label="One tap">
            <div className="logsheet__h">
              <h3>One tap</h3>
              {foods.length > 0 && <span className="logsheet__note">food into {p.meal}</span>}
            </div>
            <div className="usual__chips">
              {foods.map((f) => (
                <button
                  key={f.key}
                  className="usual__chip"
                  onClick={() => food(f)}
                  disabled={quick.pending !== null || busy}
                  aria-busy={quick.pending === f.key}
                  aria-label={`Log ${f.description}, ${f.last_amount_label}, to ${p.meal}`}
                >
                  <PlusGlyph />
                  <span className="usual__name">{f.description}</span>
                  <span className="usual__amt tnum">{f.last_amount_label}</span>
                </button>
              ))}
              {sessions.map((r, i) => (
                <button
                  key={`${r.kind}-${r.label ?? ""}-${i}`}
                  className="usual__chip chip--act"
                  onClick={() => again(r)}
                  disabled={quick.pending !== null || busy}
                  aria-label={r.kind === "strength"
                    ? `Start a strength session with ${r.exercises.map((x) => x.name).join(", ")}`
                    : `Add ${sessionTitle(r)}, ${minutesText(r.minutes ?? 0)}, to ${day}`}
                >
                  <Glyph name="repeat" size={15} />
                  <span className="usual__name">{sessionTitle(r)}</span>
                  <span className="usual__amt tnum">
                    {r.kind === "strength"
                      ? (r.exercises.length === 1 ? "1 lift" : `${r.exercises.length} lifts`)
                      : minutesText(r.minutes ?? 0)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="water__row">
          <button className="tile water__open" onClick={p.onWater} aria-haspopup="dialog">
            <span className="lead lead--water" aria-hidden><Glyph name="drop" size={20} /></span>
            <span className="row__main">
              <span className="row__title">Water</span>
              <span className="row__sub">
                {bottle
                  ? `${bottle.name}${bottle.volume_ml === null ? "" : `, ${describeVolume(bottle.volume_ml)}`}`
                  : "Weigh a bottle"}
              </span>
            </span>
          </button>
          {bottle && (
            <button
              className="water__add"
              onClick={() => wholeBottle(bottle)}
              disabled={water.pending !== null}
              aria-busy={water.pending !== null}
              aria-label={`Log a whole ${bottle.name}${bottle.volume_ml === null ? "" : `, ${describeVolume(bottle.volume_ml)}`}`}
            >
              <PlusGlyph />
            </button>
          )}
        </div>

        {shown && <p className="alert" role="alert">{shown}</p>}
      </div>
    </Sheet>
  );
}
