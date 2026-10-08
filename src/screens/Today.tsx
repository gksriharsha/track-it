import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { frequentFoods, getRange, shiftIso, todayIso } from "../api";
import type { DayView, EntryBreakdown, FrequentFood, LogEntry, Meal } from "../types";
import { MEALS } from "../types";
import { dayFigure, energyShares, mealFigure, rowFigure } from "../lib/energy";
import { leadOf, rowSub } from "../lib/entryText";
import { displayName, oneTapName } from "../lib/foodForms";
import { useHashSheet, useHashSheetValue } from "../lib/hashSheet";
import ActivityCard from "../components/ActivityCard";
import DayNote from "../components/DayNote";
import DaySheet from "../components/DaySheet";
import DayWater, { PlusGlyph } from "../components/DayWater";
import EntrySheet from "../components/EntrySheet";
import Glyph from "../components/Glyph";
import Info from "../components/Info";
import { useQuickLog } from "../components/QuickLog";
import { summarise } from "../components/Spread";
import WeekStrip, { stripDays } from "../components/WeekStrip";

interface Props {
  day: DayView | null;
  loading: boolean;
  date: string;
  label: string;
  canGoForward: boolean;
  onToday: () => void;
  /** Any of the days in the strip. */
  onPickDate: (iso: string) => void;
  /** Something was written to the day — re-read it. */
  onChanged: () => void;
  /** Add, opened on a sitting when one is given. */
  onAddFood: (meal?: Meal) => void;
  /** Add's Water tab, for part of a bottle weighed on the scale. */
  onAddWater: () => void;
  /** About you, reached from the day's sheet when there is no energy figure to read against. */
  onOpenProfile: () => void;
  /** The Add screen's Activity tab, and a session already on this day. */
  onAddActivity: () => void;
  onOpenActivity: (id: string) => void;
}

/**
 * The day, as a departure board: each record a white cell on the grey page,
 * every figure lined up in one column on the right.
 *
 * The look was chosen by the user from rendered options (October 2026), after
 * a first redesign set the day as a hairline-ruled ledger on an off-white
 * page and read as a printed document. What it kept from that ledger, and
 * from the screen before it, is the order and the honesty:
 *
 * - The day's energy leads, in the normal width (a period's figures are set
 *   wide; a day's are not), with how the day's protein, carbohydrate and fat
 *   split it, and the month's middle day beside it so the day is read against
 *   the period rather than against a target. It opens the day's nutrients as
 *   a sheet, each reference figure named beside its amount (`DaySheet`).
 * - Each food is its own tile, led by a mark of where it came from: a pot for
 *   home cooking, initials for a food of your own, an outline for anything
 *   bought (`leadOf`). Its state — "≥", "—", "pot not weighed" — is on its
 *   line, and the whole tile opens it (`EntrySheet`).
 * - Logging again is one tap from the meal it belongs to: an empty sitting
 *   offers what is usually had at it.
 * - What each figure means and how it was arrived at is behind an (i).
 *
 * Nothing unfolds in place, so the day never moves under your thumb.
 */
export default function Today(p: Props) {
  const day = p.day;
  const entries = day?.entries ?? [];

  const entrySheet = useHashSheetValue("entry");
  const daySheet = useHashSheet("sheet", "nutrients");

  /* The days the strip is going to draw. `stripDays` is the single definition
     of its reach, decided here from the day being read. */
  const stripDates = useMemo(() => stripDays(p.date), [p.date]);

  /*
    The latest `onChanged`, through a ref: an Undo can be pressed from the
    app's bar after this screen has gone.
  */
  const changed = useRef(() => {});
  changed.current = () => p.onChanged();
  const onChanged = useCallback(() => changed.current(), []);

  /*
    A middle day of the last thirty — the figure Trends opens on, computed by
    the same function from the same days, so Today and Trends cannot give two
    answers for one month. Re-read whenever the day is, because a write here
    moves the month too. Null below the five logged days a middle needs.
  */
  const [middle, setMiddle] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const to = todayIso();
    getRange(shiftIso(to, -29), to)
      .then((r) => {
        const kcal = r.days.filter((d) => d.food_items > 0 && d.kcal !== null).map((d) => d.kcal as number);
        if (live) setMiddle(summarise(kcal)?.median ?? null);
      })
      .catch(() => { if (live) setMiddle(null); });
    return () => { live = false; };
  }, [day]);

  /* What each sitting usually holds, two foods apiece. Read once per visit:
     it does not change as you step between days, and re-reading it on every
     date change would put a round trip in front of a tap that should feel
     instant. */
  const [usual, setUsual] = useState<Partial<Record<Meal, FrequentFood[]>>>({});
  useEffect(() => {
    let live = true;
    Promise.all(MEALS.map((m) => frequentFoods(2, m).catch(() => [] as FrequentFood[])))
      .then((lists) => { if (live) setUsual(Object.fromEntries(MEALS.map((m, i) => [m, lists[i]]))); });
    return () => { live = false; };
  }, []);

  const breakdown = (e: LogEntry) => day?.breakdowns.find((b) => b.entry_id === e.id);
  // Water is the one thing on the day that belongs to no sitting — see the
  // `meal` column in store.rs, which enforces it. Keyed on the missing meal
  // rather than on `source_kind`, so anything else that turns out to have no
  // sitting lands here without this needing to know about it.
  const water = entries.filter((e) => e.meal === null);
  const isToday = p.date === todayIso();
  // A day of nothing but water has nothing eaten to add up: the bottles carry
  // no energy, so its figure would be a dash over an empty bar. It is said in
  // a sentence instead, and the water is right there in its own row below.
  const onlyWater = entries.length > 0 && water.length === entries.length;

  /* The title names the day as it is spoken — Today, Yesterday, Thursday —
     and the line under it gives the date, so the month is always on screen. */
  const dt = new Date(`${p.date}T00:00:00`);
  const relative = isToday || p.date === shiftIso(todayIso(), -1);
  const thisYear = p.date.slice(0, 4) === todayIso().slice(0, 4);
  const title = relative ? p.label : dt.toLocaleDateString(undefined, { weekday: "long" });
  const dateLine = dt.toLocaleDateString(undefined, {
    ...(relative ? { weekday: "long" as const } : {}),
    day: "numeric", month: "long",
    ...(thisYear ? {} : { year: "numeric" as const }),
  });

  return (
    // screen--today: hook for the desktop-only two-column layout in
    // styles.css. No other screen uses it, and it does nothing below 1080px.
    <div className="screen screen--today">
      {/* The day IS the page title on mobile — a separate heading would just
          repeat it. Desktop shows the date in App.tsx's own toolbar instead
          (see styles.css, `.daybar` is hidden there). */}
      <div className="daybar">
        <div className="daybar__row">
          <div className="daybar__title">
            <h1>{title}</h1>
            <p className="daybar__date">{dateLine}</p>
          </div>
          {p.canGoForward && (
            <button className="btn btn--quiet daybar__today" onClick={p.onToday}>Today</button>
          )}
        </div>
        <WeekStrip date={p.date} days={stripDates} onPick={p.onPickDate} />
      </div>

      <div className="day-log">
        {p.loading ? (
          <Skeleton />
        ) : entries.length === 0 || onlyWater ? (
          /* One line. Not "your first food": on a day already behind you,
             there is nothing first about it. And no button: each sitting's +
             is right under it, and the bar's own + (the sidebar's, on a
             desktop) is the screen's one filled action — a second "Add food"
             here was two primary buttons doing one thing. */
          <div className="day-empty">
            <p>
              {onlyWater
                ? isToday ? "No food logged yet today." : "No food logged on this day."
                : isToday ? "Nothing logged yet today." : "Nothing logged on this day."}
            </p>
          </div>
        ) : (
          <DayFigure day={day!} isToday={isToday} middle={middle} onOpen={daySheet.show} />
        )}

        {!p.loading && MEALS.map((m) => (
          <MealGroup
            key={m}
            meal={m}
            date={p.date}
            entries={entries.filter((e) => e.meal === m)}
            breakdown={breakdown}
            subtotal={day?.meals.find((x) => x.meal === m)?.energy ?? null}
            usual={usual[m] ?? []}
            onOpen={entrySheet.show}
            onAdd={p.onAddFood}
            onChanged={onChanged}
          />
        ))}
      </div>

      <div className="day-side">
        {!p.loading && (
          <DayWater date={p.date} entries={water} onOpen={entrySheet.show}
            onAdd={p.onAddWater} onChanged={onChanged} />
        )}
        {/* Outside the empty branch on purpose: a day with nothing eaten on it
            can still have had a walk in it. */}
        <ActivityCard date={p.date} canAdd onAdd={p.onAddActivity} onOpen={p.onOpenActivity} />
        {/* Last, because it is a footnote to the day and not a headline; and
            there on an empty day too, which is exactly when there may be most
            to say — a fast, a day away, a day you gave up weighing. */}
        <DayNote date={p.date} />
      </div>

      <EntrySheet day={day} id={entrySheet.value} onClose={entrySheet.hide} onChanged={onChanged} />
      <DaySheet day={day} label={p.label} open={daySheet.open} onClose={daySheet.hide}
        onOpenProfile={p.onOpenProfile} />
    </div>
  );
}

/**
 * What the day came to: its energy, and where that energy came from.
 *
 * This was the anchor of the app once: a 52px serif figure over a green bar
 * filling toward a target, over "498 left of 2,240". The bar here is not
 * that bar. It is a share of a whole — how the day's protein, carbohydrate
 * and fat split the energy they carry (`energyShares`) — so it says what the
 * day was made of and has nothing to fill. The figure beside the energy is
 * the month's middle day, the one Trends opens on, never a target: a day is
 * a noisy sample, and the period is what it is read against.
 *
 * Each figure reads in the three states. A day only partly measured says "≥",
 * one with no figure "—", and never 0. They are read over what was EATEN: the
 * backend leaves water out of them, and a pill that states none of them, so
 * the day is the sum of its sittings and a litre of water cannot pass a day
 * of unmeasured food off as a measured one. With any of the three unmeasured
 * there is no bar, rather than a split of the other two.
 */
function DayFigure({ day, isToday, middle, onOpen }: {
  day: DayView;
  isToday: boolean;
  middle: number | null;
  onOpen: () => void;
}) {
  const t = (id: number) => day.totals.find((x) => x.id === id)?.total;
  const kcal = dayFigure(t(1008));
  const shares = energyShares(t(1003), t(1005), t(1004));
  const parts = [
    { key: "protein", name: "Protein", grams: dayFigure(t(1003)), share: shares?.protein },
    { key: "carbs", name: "Carbs", grams: dayFigure(t(1005)), share: shares?.carbs },
    { key: "fat", name: "Fat", grams: dayFigure(t(1004)), share: shares?.fat },
  ];
  const sub = [
    isToday ? "so far today" : null,
    middle !== null ? `middle day of the last 30: ${Math.round(middle).toLocaleString()}` : null,
  ].filter(Boolean).join(", ");
  return (
    <div className="dayfig">
      <button className="dayfig__open" onClick={onOpen} aria-haspopup="dialog"
        aria-label={`Every nutrient for the day: ${kcal} kcal, ${parts.map((x) => `${x.name.toLowerCase()} ${x.grams} grams`).join(", ")}`}>
        <span className="dayfig__kcal tnum">{kcal}<span className="dayfig__unit">kcal</span></span>
        {sub && <span className="dayfig__sub">{sub}</span>}
        {shares && (
          <span className="share" aria-hidden>
            {parts.map((x) => <i key={x.key} className={`share__${x.key}`} style={{ flexGrow: x.share }} />)}
          </span>
        )}
        <span className="share__key tnum">
          {parts.map((x) => (
            <span key={x.key}>
              {shares && <b className={`share__${x.key}`} aria-hidden />}
              {x.name} {x.grams} g{shares && <em> {x.share}%</em>}
            </span>
          ))}
        </span>
      </button>
      <Info title="How the day's energy is counted">
        <p>
          Added up from every entry, the same way each row's figure is, from the values each entry
          was frozen with. Water is not in it, and nor is a supplement whose label states none of
          protein, carbohydrate and fat.
        </p>
        <p>
          Where at least four-fifths of what was eaten, by weight, has a figure, the day reads as a
          figure, and the day's sheet says how much of it was measured. Where less does, it reads
          “≥” — at least this much — and where nothing could be measured, “—”. Neither is counted
          as zero.
        </p>
        <p>
          The bar is how protein, carbohydrate and fat split the energy the three of them carry, at
          4, 4 and 9 kcal a gram, over what is accounted for of each. It is a share of the day, not
          progress toward anything, and it is left out when any of the three has no figure.
        </p>
        <p>
          The middle day is the one Trends shows for the last 30 days: half the days logged came to
          less, half to more. Activity is not taken off either figure.
        </p>
      </Info>
    </div>
  );
}

/**
 * One sitting: its name, a + that opens Add on it, what it came to, and its
 * entries — or, when nothing has been had at it yet, what usually is.
 *
 * All four are always drawn, because "nothing at lunch" is part of the day,
 * and an empty one is one line. Its usual foods are one tap each, through the
 * same path as Add's own "Had it before": the weight is printed on the chip
 * before it is pressed, and the app's bar says what was written with a way
 * back. They go the moment the sitting has something in it.
 *
 * Still a shortcut, and drawn as one: no count on a chip, no rank, no
 * "favourites" — a tally beside a food name is a leaderboard of your own
 * eating. "Usually" is the whole of what it says about why these two, so the
 * backend offers only a food had at this sitting on more than one day.
 */
function MealGroup(p: {
  meal: Meal;
  date: string;
  entries: LogEntry[];
  breakdown: (e: LogEntry) => EntryBreakdown | undefined;
  /**
   * Null for a sitting with nothing, or nothing but a tablet: no subtotal,
   * never 0. Read by the day's rule (`mealFigure`), so a sitting of nothing
   * but softgels has none either.
   */
  subtotal: NonNullable<EntryBreakdown["energy"]> | null;
  usual: FrequentFood[];
  onOpen: (id: string) => void;
  onAdd: (meal: Meal) => void;
  onChanged: () => void;
}) {
  const q = useQuickLog(p.date, p.meal, p.onChanged);
  // Capitalised here rather than by CSS: the heading is sentence case, so
  // "breakfast" would print as the meal's id.
  const name = p.meal.charAt(0).toUpperCase() + p.meal.slice(1);
  const id = `meal-${p.meal}`;
  const fig = mealFigure(p.subtotal);
  return (
    <section className="day-sec meal" aria-labelledby={id}>
      <div className="day-sec__head">
        <span className="meal__glyph"><Glyph name={p.meal} size={18} /></span>
        <h2 id={id}>{name}</h2>
        <button className="day-add" onClick={() => p.onAdd(p.meal)} aria-label={`Add to ${p.meal}`}>
          <PlusGlyph />
        </button>
        {/* A dash alone, not "— kcal": a unit beside no figure reads as a figure. */}
        {fig !== null && <span className="day-sec__fig tnum">{fig === "—" ? fig : `${fig} kcal`}</span>}
      </div>

      {p.entries.length > 0 ? (
        <div className="tiles">
          {p.entries.map((e) => <EntryTile key={e.id} e={e} b={p.breakdown(e)} onOpen={p.onOpen} />)}
        </div>
      ) : p.usual.length > 0 ? (
        <div className="usual">
          <span className="usual__label">Usually</span>
          {/* Their own box, so a chip that wraps lines up under the first
              chip rather than under the word. */}
          <div className="usual__chips">
            {p.usual.map((f) => (
              <button
                key={f.key}
                className="usual__chip"
                onClick={() => q.log(f)}
                disabled={q.pending !== null}
                aria-busy={q.pending === f.key}
                aria-label={`Log ${oneTapName(f)}, ${f.last_amount_label}, to ${p.meal}`}
              >
                <PlusGlyph />
                <span className="usual__name">{oneTapName(f)}</span>
                <span className="usual__amt tnum">{f.last_amount_label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {q.error && <p className="alert" role="alert">{q.error}</p>}
    </section>
  );
}

/**
 * One entry, as its own tile: a mark of where it came from, what it was, a
 * quiet line of how much and what is not known about it, and its energy on
 * the right. No chevron and no ×: the tile is the target, and removing is one
 * of the things its sheet does — with an Undo.
 *
 * Tiles rather than ruled rows: each food a white cell 2px from the next, the
 * run of them rounder at its ends, so a meal reads as one group without a
 * line drawn between every pair of foods.
 */
function EntryTile({ e, b, onOpen }: {
  e: LogEntry;
  b: EntryBreakdown | undefined;
  onOpen: (id: string) => void;
}) {
  return (
    <button className="tile entry" onClick={() => onOpen(e.id)} aria-haspopup="dialog">
      <Lead e={e} />
      <span className="row__main">
        <span className="row__title">{displayName(e)}</span>
        <span className="row__sub entry__sub">{rowSub(e, b)}</span>
      </span>
      <span className="entry__fig tnum">{rowFigure(b?.energy ?? null)}</span>
    </button>
  );
}

/** The mark a tile leads with. Decoration to a screen reader: the sheet says it in words. */
function Lead({ e }: { e: LogEntry }) {
  const l = leadOf(e);
  return (
    <span className={`lead lead--${l.kind}`} aria-hidden>
      {"initials" in l ? l.initials : <Glyph name={l.glyph} size={20} />}
    </span>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the day">
      <div className="skel" style={{ height: 24, width: 260, marginBottom: "var(--s5)" }} />
      {[0, 1, 2, 3, 4].map((i) => (
        <div className="skel skel--row" key={i} style={{ width: `${90 - i * 10}%` }} />
      ))}
    </div>
  );
}
