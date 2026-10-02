import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { frequentFoods, loggedDates, todayIso } from "../api";
import type { DayView, EntryBreakdown, FrequentFood, LogEntry, Meal } from "../types";
import { MEALS } from "../types";
import { dayFigure, rowFigure } from "../lib/energy";
import { rowSub } from "../lib/entryText";
import { useHashSheet, useHashSheetValue } from "../lib/hashSheet";
import { plural } from "../lib/nutrient";
import ActivityCard from "../components/ActivityCard";
import DayNote from "../components/DayNote";
import DaySheet from "../components/DaySheet";
import DayWater, { PlusGlyph } from "../components/DayWater";
import EntrySheet from "../components/EntrySheet";
import Info from "../components/Info";
import { useQuickLog } from "../components/QuickLog";
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
 * The day, as a ledger: what was had, sitting by sitting, with what each came
 * to on the right.
 *
 * It used to do three jobs before it did this one. A carousel of foods to log
 * again, the day's energy and macronutrients against their ranges, and a card
 * about what could be measured all came first — and a switch to a second
 * screen holding the same day's nutrients came before those. None of the
 * twelve things eaten were on the first screen. Each of those still exists;
 * none of them is in front of the log any more:
 *
 * - The day's figures are ONE line, in the plain sans, and the line opens the
 *   day's nutrients as a sheet — with what could be measured at its head and
 *   each reference figure, named, beside its amount (`DaySheet`).
 * - Logging again is one tap from the meal it belongs to: an empty sitting
 *   offers what is usually had at it.
 * - What each figure means and how it was arrived at is behind an (i) beside
 *   it. What state it is in — "≥", "—", "some unmeasured" — is on the line.
 *
 * Every entry is one row, and the whole row opens it (`EntrySheet`). Nothing
 * unfolds in place, so the day never moves under your thumb.
 */
export default function Today(p: Props) {
  const day = p.day;
  const entries = day?.entries ?? [];

  const entrySheet = useHashSheetValue("entry");
  const daySheet = useHashSheet("sheet", "nutrients");

  /* The days the strip is going to draw, and the first of them.
     `stripDays` is the single definition of the strip's reach: the marks below
     are read for exactly this span, so a dot cannot be missing from a day the
     strip shows. Recomputed on every date change and almost always identical,
     which is why the read is keyed on `from` — a string — rather than on the
     array. */
  const stripDates = useMemo(() => stripDays(p.date), [p.date]);
  const from = stripDates[0];

  /* Which of those days hold something. Keyed on the strip's first day, so it
     is re-read only when the strip's reach actually moves — which happens when
     a day older than the strip is picked out of the Days calendar, and not
     when you step from Tuesday to Wednesday. */
  const [logged, setLogged] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    loggedDates(from).then((d) => live && setLogged(new Set(d))).catch(() => {});
    return () => { live = false; };
  }, [from]);

  /*
    A write from this screen — a usual food, a bottle, a remove, an Undo of
    any of them — changes the day and perhaps whether the day has anything in
    it at all, so the dot under its date follows. The latest, through a ref:
    an Undo can be pressed from the app's bar after this screen has gone.
  */
  const changed = useRef(() => {});
  changed.current = () => {
    p.onChanged();
    loggedDates(from).then((d) => setLogged(new Set(d))).catch(() => {});
  };
  const onChanged = useCallback(() => changed.current(), []);

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

  return (
    // screen--today: hook for the desktop-only two-column layout in
    // styles.css. No other screen uses it, and it does nothing below 1080px.
    <div className="screen screen--today">
      {/* The date IS the page title on mobile — a separate heading would just
          repeat it. Desktop shows the date in App.tsx's own toolbar instead
          (see styles.css, `.daybar` is hidden there). */}
      <div className="daybar">
        <div className="daybar__row">
          <h1>{p.label}</h1>
          {p.canGoForward && (
            <button className="btn btn--quiet daybar__today" onClick={p.onToday}>Today</button>
          )}
          {entries.length > 0 && (
            <span className="screen__sub daybar__count">{plural(entries.length, "item")}</span>
          )}
        </div>
        <WeekStrip date={p.date} days={stripDates} logged={logged} onPick={p.onPickDate} />
      </div>

      <div className="day-log">
        {p.loading ? (
          <Skeleton />
        ) : entries.length === 0 ? (
          /* One line and the way to fill it. Not "your first food": on a day
             already behind you, there is nothing first about it. */
          <div className="day-empty">
            <p>{isToday ? "Nothing logged yet today." : "Nothing logged on this day."}</p>
            <button className="btn" onClick={() => p.onAddFood()}>Add food</button>
          </div>
        ) : (
          <DayLine day={day!} onOpen={daySheet.show} />
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
 * What the day came to, in one line: energy, then protein, carbohydrate and
 * fat — "2,156 kcal · P 68 · C 224 · F 58 g".
 *
 * This was the anchor of the app once: a 52px serif figure over a green bar
 * filling toward a target, over "498 left of 2,240". Then an ordinary line of
 * text with the reference beside it and three macronutrient ranges under it,
 * one of which turned bold when a single day fell outside it. Now it is the
 * figures and nothing to read them against, in the same sans as every other
 * line: a day is a noisy sample, and what the figures are read against is a
 * question for the day's sheet, which this line opens, and for Trends.
 *
 * Each figure reads in the three states. A day only partly measured says "≥",
 * one with no figure "—", and never 0.
 */
function DayLine({ day, onOpen }: { day: DayView; onOpen: () => void }) {
  const t = (id: number) => day.totals.find((x) => x.id === id)?.total;
  return (
    <div className="dayline">
      <button className="dayline__open" onClick={onOpen} aria-haspopup="dialog"
        aria-label={`Every nutrient for the day: ${dayFigure(t(1008))} kcal, protein ${dayFigure(t(1003))}, carbohydrate ${dayFigure(t(1005))}, fat ${dayFigure(t(1004))} grams`}>
        <span className="dayline__kcal tnum">{dayFigure(t(1008))} kcal</span>
        <span className="dayline__macros tnum">
          {" · "}P {dayFigure(t(1003))} · C {dayFigure(t(1005))} · F {dayFigure(t(1004))} g
        </span>
      </button>
      <Info title="How the day's energy is counted">
        <p>
          Added up from every entry, the same way each row's figure is: the energy each one was
          worth when it was logged. P, C and F are protein, carbohydrate and fat, in grams.
        </p>
        <p>
          Where part of what was eaten has no figure, the day reads “≥” — at least this much — and
          where nothing could be measured it reads “—”. Neither is counted as zero. A day holding
          only supplements reads “—” too: a pill's few calories are not the day's energy.
        </p>
        <p>
          Activity is not taken off it. Pressing the day's line opens every nutrient in the day,
          each beside the figure it is read against — for energy, your own figure or an estimate
          from About you.
        </p>
      </Info>
      <span className="dayline__chev" aria-hidden>›</span>
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
 * eating. "Usually" is the whole of what it says about why these two.
 */
function MealGroup(p: {
  meal: Meal;
  date: string;
  entries: LogEntry[];
  breakdown: (e: LogEntry) => EntryBreakdown | undefined;
  /** Null for a sitting with nothing, or nothing but a tablet: no subtotal, never 0. */
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
  return (
    <section className="day-sec meal" aria-labelledby={id}>
      <div className="day-sec__head">
        <h2 id={id}>{name}</h2>
        <button className="day-add" onClick={() => p.onAdd(p.meal)} aria-label={`Add to ${p.meal}`}>
          <PlusGlyph />
        </button>
        {p.subtotal && <span className="day-sec__fig tnum">{rowFigure(p.subtotal)} kcal</span>}
      </div>

      {p.entries.length > 0 ? (
        <div className="rows">
          {p.entries.map((e) => <EntryRow key={e.id} e={e} b={p.breakdown(e)} onOpen={p.onOpen} />)}
        </div>
      ) : p.usual.length > 0 ? (
        <div className="usual">
          <span className="usual__label">Usually</span>
          {p.usual.map((f) => (
            <button
              key={f.key}
              className="usual__chip"
              onClick={() => q.log(f)}
              disabled={q.pending !== null}
              aria-busy={q.pending === f.key}
              aria-label={`Log ${f.description}, ${f.last_amount_label}, to ${p.meal}`}
            >
              <PlusGlyph />
              <span className="usual__name">{f.description}</span>
              <span className="usual__amt tnum">{f.last_amount_label}</span>
            </button>
          ))}
        </div>
      ) : null}

      {q.error && <p className="alert" role="alert">{q.error}</p>}
    </section>
  );
}

/**
 * One entry: what it was, a quiet line of how much and what is not known
 * about it, and its energy on the right. No chevron and no ×: the row is the
 * target, and removing is one of the things its sheet does — with an Undo,
 * which the × beside a 15px chevron never had.
 */
function EntryRow({ e, b, onOpen }: {
  e: LogEntry;
  b: EntryBreakdown | undefined;
  onOpen: (id: string) => void;
}) {
  return (
    <button className="row entry" onClick={() => onOpen(e.id)} aria-haspopup="dialog">
      <span className="row__main">
        <span className="row__title">{e.description}</span>
        <span className="row__sub entry__sub">{rowSub(e, b)}</span>
      </span>
      <span className="entry__fig tnum">{rowFigure(b?.energy ?? null)}</span>
    </button>
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
