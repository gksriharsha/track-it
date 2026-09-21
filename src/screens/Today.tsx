import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  deleteLogEntry, frequentFoods, getDayNote, humanDate, loggedDates, setDayNote, setEntryTags,
  shiftIso, todayIso,
} from "../api";
import CorrectEntry from "../components/CorrectEntry";
import type { DayView, FrequentFood, LogEntry, Meal, Origin } from "../types";
import { MEALS, ORIGIN_LABEL, describeVolume } from "../types";
import { plural, read, unassessable } from "../lib/nutrient";
import TagPicker from "../components/TagPicker";
import DayTabs from "../components/DayTabs";
import { QuickAddStrip, UndoToast, useQuickLog } from "../components/QuickLog";

interface Props {
  day: DayView | null;
  loading: boolean;
  date: string;
  label: string;
  canGoForward: boolean;
  /** Which sitting a one-tap repeat goes into. Shared with the Add food screen. */
  meal: Meal;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  /** Any of the seven days in the strip. */
  onPickDate: (iso: string) => void;
  onRemoved: () => void;
  onSeeAll: () => void;
  onAddFood: () => void;
  /** The profile, reached from the hero when there is no target to show. */
  onOpenProfile: () => void;
}

/**
 * The day at a glance — a triage surface, not a summary.
 *
 * It answers three questions and nothing else: am I on track for energy, what
 * is off, and what can't I judge yet. The full 47-nutrient panel lives on its
 * own screen; putting it here is what made the old layout an info dump.
 */
export default function Today(p: Props) {
  const day = p.day;
  const entries = day?.entries ?? [];
  const totals = day?.totals ?? [];

  const energy = totals.find((t) => t.id === 1008);
  // `coverage` is null on a day holding only supplements — no food mass to have
  // covered. A pill's energy is not the day's energy, so the hero stays blank
  // rather than reporting a near-zero figure that reads as "you barely ate".
  const kcal =
    energy && energy.total.coverage !== null && energy.total.coverage > 0
      ? Math.round(energy.total.lower)
      : null;
  /**
   * What the day is read against, or null.
   *
   * There is deliberately no default here. This used to be a hard-coded 2,200
   * kcal, which described nobody in particular and yet had a progress rail
   * drawn against it — the same class of confident falsehood the nutrient panel
   * exists to avoid. With no profile and no figure of the user's own, the hero
   * now reports what was eaten and says there is nothing to compare it to.
   */
  const energyTarget = day?.energy_target ?? null;
  const target = energyTarget?.kcal ?? null;

  const macros = [1003, 1005, 1004]
    .map((id) => totals.find((t) => t.id === id))
    .filter(Boolean)
    .map((t) => ({
      id: t!.id,
      name: t!.name,
      r: read(t!),
      range: (day?.macro_ranges ?? []).find((m) => m.nutrient_id === t!.id) ?? null,
      lower: t!.total.lower,
    }));

  const unknown = unassessable(totals);
  const covered = totals.filter((t) => read(t).state === "measured").length;

  const [open, setOpen] = useState<string | null>(null);

  /* The days the strip is going to draw, and the first of them.
     `stripDays` is the single definition of the strip's reach: the marks below
     are read for exactly this span, so a dot cannot be missing from a day the
     strip shows. Recomputed on every date change and almost always identical,
     which is why the read is keyed on `from` — a string — rather than on the
     array. */
  const stripDates = useMemo(() => stripDays(p.date), [p.date]);
  const from = stripDates[0];

  /* The foods you have most days. Read once per mount: it does not change as
     you step between days, and re-reading it on every date change would put a
     round trip in front of a tap that should feel instant. */
  const [quick, setQuick] = useState<FrequentFood[]>([]);
  useEffect(() => {
    let live = true;
    frequentFoods(8).then((f) => live && setQuick(f)).catch(() => {});
    return () => { live = false; };
  }, []);

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
    A repeat is written straight in, and the way back out of it sits over the
    screen for eight seconds. `refreshAll` rather than `onRemoved` alone: a
    day that had nothing in it before this tap now has something, and the dot
    under its date in the strip has to follow.
  */
  const refreshAll = () => {
    p.onRemoved();
    loggedDates(from).then((d) => setLogged(new Set(d))).catch(() => {});
  };
  const q = useQuickLog(p.date, p.meal, refreshAll);
  /**
   * Tags being edited, held here until the day reloads.
   *
   * Without this, each change reads the other dimension off the entry as the
   * server last returned it — so setting an origin and then a cuisine before
   * the refetch lands would write the new cuisine beside the OLD origin and
   * silently drop the first answer.
   */
  const [pendingTags, setPendingTags] = useState<Record<string, { origin: Origin | null; cuisine: string | null }>>({});

  async function remove(id: string) {
    await deleteLogEntry(id);
    p.onRemoved();
  }

  /**
   * The day, in the groups it actually happened in.
   *
   * Four sittings, and then one group for the things that were not had at a
   * sitting at all. Water is the only one of those today: a bottle is refilled
   * and drunk from across the whole day, so it carries no meal — see the
   * `meal` column in store.rs, which enforces that rather than merely allowing
   * it. Grouping on `e.meal === null` rather than on `source_kind === "water"`
   * keys off the fact that decides the layout, so anything else that turns out
   * to have no sitting lands here without this needing to know about it.
   *
   * Empty groups are dropped, so a day with no water shows no water heading.
   */
  const groups: { key: string; label: string; entries: LogEntry[] }[] = [
    ...MEALS.map((m) => ({
      key: m,
      label: m,
      entries: entries.filter((e) => e.meal === m),
    })),
    {
      key: "no-meal",
      label: "Water",
      entries: entries.filter((e) => e.meal === null),
    },
  ].filter((g) => g.entries.length > 0);

  return (
    // screen--today: hook for the desktop-only two-column layout in
    // styles.css. No other screen uses it, and it does nothing below 1080px.
    <div className="screen screen--today">
      {/* The date IS the page title on mobile — a separate heading would just
          repeat it. Desktop shows the date in App.tsx's own toolbar instead
          (see styles.css, `.daybar` is hidden there), so this block still
          renders here for the phone but nowhere on a wide window. */}
      <div className="daybar">
        <div className="daybar__row">
          <h1>{p.label}</h1>
          {p.canGoForward && (
            <button className="btn btn--quiet daybar__today" onClick={p.onToday}>Today</button>
          )}
          {entries.length > 0 && (
            <span className="screen__sub daybar__count">
              {plural(entries.length, "item")}
            </span>
          )}
        </div>
        <WeekStrip date={p.date} days={stripDates} logged={logged} onPick={p.onPickDate} />
      </div>

      {/* Phone only. The nutrient panel is this same day counted differently,
          not another place — see DayTabs. */}
      <DayTabs current="day" onDay={() => {}} onNutrients={p.onSeeAll} />

      {/* Above the day, and outside the empty branch on purpose: a day with
          nothing in it is exactly when a one-tap repeat is worth most. */}
      <QuickAddStrip foods={quick} meal={p.meal} pending={q.pending} onLog={q.log} />
      {q.error && <p className="alert" role="alert">{q.error}</p>}

      {p.loading ? (
        <Skeleton />
      ) : entries.length === 0 ? (
        <div className="empty">
          <h3>Nothing logged yet</h3>
          <p>
            Add what you have eaten and this becomes a picture of the day — including
            what the data can and cannot tell you.
          </p>
          <button className="btn" onClick={p.onAddFood}>Add your first food</button>
        </div>
      ) : (
        <>
          {/*
            What today came to — reported, not scored.

            This used to be the anchor of the app: a 52px serif figure with a
            green bar filling toward a target beneath it, over the words "498
            left of 2,240". Three separate ways of saying the same thing, which
            was that a day is an allowance to spend down and there is a line to
            reach. It is now an ordinary line of text, in the plain sans, the
            same size as everything else on the screen.

            The number has not been hidden — this is a tracker and a person is
            entitled to it. It has been put in proportion: one day is a noisy
            sample, and what it is worth knowing against is the fortnight above
            it, not a target below it.
          */}
          <section className="day-hero">
            <div className="hero__value">
              <span className="tnum hero__num">{kcal !== null ? kcal.toLocaleString() : "—"}</span>
              <span className="hero__unit">kcal today</span>
            </div>
            <div className="hero__sub">
              {kcal === null ? (
                "energy not measured in these items"
              ) : target === null ? (
                <>
                  no target set —{" "}
                  <button className="link" onClick={p.onOpenProfile}>
                    tell the app about you
                  </button>{" "}
                  and it can work one out
                </>
              ) : (
                <>
                  {/*
                    The reference figure, named, and NOT as a remainder.
                    "498 left of 2,240" floored the difference at zero so the
                    day could only ever count down to a finish line, and called
                    a published estimate "your target" — a figure the user never
                    set, presented as a personal commitment.
                  */}
                  {energyTarget === null
                    ? `read against ${Math.round(target).toLocaleString()}`
                    : energyTarget.basis === "estimated"
                      ? `an estimate for you is ${Math.round(target).toLocaleString()}`
                      : `the figure you set is ${Math.round(target).toLocaleString()}`}
                </>
              )}
            </div>
            <div className="macros">
              {macros.map((m) => {
                // A macronutrient has no single right number, so where a range
                // exists it is shown as one and the reading says whether the
                // day sits inside it. Printing the midpoint of 20–35% as "the
                // target" would invent a precision the evidence lacks.
                const inRange =
                  m.range && m.r.state === "measured"
                    ? m.lower >= m.range.low_g && m.lower <= m.range.high_g
                    : null;
                return (
                  <div key={m.id}>
                    <div className="macro__v tnum">{m.r.amount}</div>
                    <div className="macro__k">{m.name.toLowerCase()}</div>
                    {m.range && (
                      <div
                        className={`macro__range${inRange === false ? " is-outside" : ""}`}
                        title={`${m.range.low_pct}–${m.range.high_pct}% of energy`}
                      >
                        {Math.round(m.range.low_g)}–{Math.round(m.range.high_g)} g
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/*
            What today held, and what could not be measured in it — no ranking.

            This was "Worth a look": the five nutrients furthest from target,
            worst first, each with a direction arrow, a percentage and a bar,
            under a heading that graded the day. It ran `worthALook`, which
            sorted a ONE-DAY sample by shortfall against an undocumented 60%
            line and cut it to five — a leaderboard of the day's failures,
            recomputed every morning, on a sample far too small to mean
            anything. Its empty state read "Nothing stands out. Every nutrient
            with enough data to judge is within range", which is a pass mark.

            What has actually been high or low is a question about weeks, and
            it is asked on Statistics, where there are enough days to answer it.
            What belongs here is only what this day can honestly say: what was
            measured in it, and what was not.
          */}
          <section className="card">
            <div className="card__head">
              <h2>What could be measured</h2>
            </div>
            <p className="daynote">
              {covered} of the {totals.length} nutrients this app tracks had data in
              today&rsquo;s items.
              {unknown.length > 0 && (
                <> The other {unknown.length} are not zero — nothing logged today carried a
                figure for them.</>
              )}{" "}
              <button className="link" onClick={p.onSeeAll}>See them all</button>
            </p>
          </section>

          {/* Not "What you ate": a supplement is not eaten and a bottle of
              water certainly is not, and this card holds both. */}
          {/* No heading. The switch above this screen already says "What you
              had", and the meal names below are the structure — a card titled
              with the words of the tab that selected it is the page telling you
              twice where you are. The "Add food" link that sat here went with
              it: the bottom bar carries that button on every screen now. */}
          <section className="card day-ate">
            {groups.map((g) => (
              <div className="group" key={g.key}>
                <div className="group__name">{g.label}</div>
                <div className="rows">
                  {g.entries
                    .map((e) => {
                      const b = day?.breakdowns.find((x) => x.entry_id === e.id);
                      const ings = b?.components ?? [];
                      // Every dish can be opened, whether or not it has a
                      // breakdown to show: the tag editor lives in there, and a
                      // plain reference food has no components at all. Without
                      // this, most entries could never be tagged.
                      const expandable = ings.length > 0 || e.source_kind !== "supplement";
                      const isOpen = open === e.id;
                      // One of the user's own foods carries a single component
                      // too, but it is a statement of where its values came from
                      // — not an ingredient. A packaged bar is not a
                      // one-ingredient recipe and must not be described as one.
                      const isCustom = e.source_kind === "custom";
                      const isSupplement = e.source_kind === "supplement";
                      const isWater = e.source_kind === "water";
                      const noData = ings.some((c) => !c.has_data);
                      return (
                        <div key={e.id}>
                          <div className="row entryrow">
                            <button
                              className="entryrow__main"
                              onClick={() => expandable && setOpen(isOpen ? null : e.id)}
                              aria-expanded={expandable ? isOpen : undefined}
                              disabled={!expandable}
                            >
                              <span className="row__title">{e.description}</span>
                              <span className="row__sub">
                                {quantityText(e)}
                                {/* Water is excluded alongside the other two:
                                    a bottle has no ingredients, and "0
                                    ingredients" beside it reads as a
                                    measurement rather than as the category
                                    error it is. */}
                                {expandable && !isCustom && !isSupplement && !isWater &&
                                  ` · ${plural(ings.length, "ingredient")}`}
                                {noData &&
                                  (isCustom
                                    ? " · nothing off the pack"
                                    : isSupplement
                                      ? " · nothing off the panel"
                                      : " · some unmeasured")}
                                {tagText(e, pendingTags[e.id]) &&
                                  ` · ${tagText(e, pendingTags[e.id])}`}
                              </span>
                            </button>
                            {expandable && (
                              <span className={`row__chev${isOpen ? " is-open" : ""}`} aria-hidden>›</span>
                            )}
                            <button className="iconbtn" onClick={() => remove(e.id)}
                              aria-label={`Remove ${e.description}`}>×</button>
                          </div>

                          {isOpen && isSupplement && (
                            <div className="breakdown">
                              <div className="breakdown__head">What the panel says</div>
                              {ings.map((c, i) => (
                                <div className="breakdown__row" key={i}>
                                  <span className={c.has_data ? "" : "no-data"}>{c.description}</span>
                                </div>
                              ))}
                              <p className="breakdown__note">
                                Counted per dose rather than by weight, so it adds to the day's
                                nutrients without changing how well your food is measured.
                              </p>
                            </div>
                          )}

                          {isOpen && isCustom && (
                            <div className="breakdown">
                              <div className="breakdown__head">Where its values come from</div>
                              {ings.map((c, i) => (
                                <div className="breakdown__row" key={i}>
                                  <span className={c.has_data ? "" : "no-data"}>{c.description}</span>
                                </div>
                              ))}
                              {noData && (
                                <p className="breakdown__note">
                                  Nothing is measured for this food, so it counts towards the day as
                                  unmeasured rather than as zero — which is why some nutrients above
                                  read “—”.
                                </p>
                              )}
                            </div>
                          )}

                          {isOpen && !isCustom && !isSupplement && ings.length > 0 && (
                            <div className="breakdown">
                              <div className="breakdown__head">
                                What went into it
                                {/* The yield is what makes the portion legible
                                    — it is the number the breakdown was divided
                                    by. The servings count is a separate,
                                    optional clause: since a recipe need not
                                    carry one, requiring it here would have
                                    silently dropped this whole sentence from
                                    every entry logged afterwards. */}
                                {b?.recipe_yield_g && e.grams !== null ? (
                                  <span>
                                    {" "}— {Math.round(e.grams)} g of a{" "}
                                    {Math.round(b.recipe_yield_g).toLocaleString()} g batch
                                    {b.recipe_servings !== null &&
                                      ` (${b.recipe_servings} servings)`}
                                  </span>
                                ) : null}
                              </div>
                              {ings.map((c, i) => (
                                <div className="breakdown__row" key={i}>
                                  <span className={c.has_data ? "" : "no-data"}>
                                    {c.description}
                                    {!c.has_data && <span className="breakdown__flag"> no composition data</span>}
                                  </span>
                                  <span className="tnum">
                                    {c.grams === null ? "—" : `${c.grams.toFixed(c.grams < 10 ? 1 : 0)} g`}
                                  </span>
                                </div>
                              ))}
                              {noData && (
                                <p className="breakdown__note">
                                  Whatever those contribute is counted as unmeasured for the day,
                                  not as zero — which is why some nutrients above read “—”.
                                </p>
                              )}
                            </div>
                          )}

                          {/* Neither a supplement nor a bottle is a dish, and
                              neither has a cuisine. */}
                          {isOpen && !isSupplement && !isWater && (
                            <div className="breakdown">
                              <div className="breakdown__head">Where it came from</div>
                              <TagPicker
                                origin={pendingTags[e.id]?.origin ?? e.origin}
                                cuisine={pendingTags[e.id]?.cuisine ?? e.cuisine}
                                onChange={async (origin, cuisine) => {
                                  // Held locally first so the next change in
                                  // this session builds on this one rather than
                                  // on whatever the last refetch returned.
                                  setPendingTags((t) => ({ ...t, [e.id]: { origin, cuisine } }));
                                  await setEntryTags(e.id, origin, cuisine);
                                  p.onRemoved();
                                }}
                              />
                            </div>
                          )}

                          {/* A logged entry keeps the nutrition it had when it
                              was logged. This is the deliberate way to fix a
                              mistake in it — see CorrectEntry. */}
                          {isOpen && (
                            <div className="breakdown">
                              <div className="breakdown__head">If something here is wrong</div>
                              <CorrectEntry entryId={e.id} onChanged={p.onRemoved} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      {/* Outside the branch above on purpose, and last on purpose.

          Outside, because a day with nothing logged is a day you may well have
          something to say about — a fast, a day away, a day you gave up
          weighing — and the empty state is exactly when the arithmetic has
          least to offer. Last, because it is a footnote to the day and not a
          headline: the screen still opens on what was eaten. */}
      <DayNote date={p.date} />

      <UndoToast last={q.last} onUndo={q.undo} />
    </div>
  );
}

/**
 * How far back the date strip reaches: twelve weeks, ending on today.
 *
 * A reach and not a page size. The strip shows seven days at a time and scrolls
 * a week per swipe, so this is how many swipes there are — twelve, about a
 * quarter. Beyond that the Days calendar is the right instrument: it draws a
 * month at a time with its month named, and jumping four months back through a
 * seven-day window would be sixteen swipes past dates you cannot identify.
 */
const STRIP_WEEKS = 12;
const STRIP_DAYS = STRIP_WEEKS * 7;

/**
 * The days the strip draws for a given selection, oldest first.
 *
 * Exported from module scope rather than computed inside `WeekStrip` because
 * two things need to agree about it: the strip, and the read that marks which
 * of those days hold something. One function, called once, is what makes them
 * agree — see the `stripDays` call in `Today`.
 */
function stripDays(date: string): string[] {
  const today = todayIso();
  /*
    The strip's last day, and the ONLY thing that moves its contents.

    Today, normally: there is nothing to the right of today because the future
    holds nothing to log, so the strip ends there and the days ahead are not
    drawn at all. The exception is a day picked out of the Days calendar that
    twelve weeks does not reach — that day ends the strip instead, so the day
    being read is on screen, and the daybar's own Today button is the way back.

    Note what this is not: it does not move when you tap a date inside the
    strip. That was the old behaviour and it cannot survive a scroller — you
    would scroll back to August, tap the 14th, and have the whole rail jump out
    from under your thumb to put the 14th at the right-hand edge.
  */
  const end = date >= shiftIso(today, -(STRIP_DAYS - 1)) ? today : date;
  return Array.from({ length: STRIP_DAYS }, (_, i) => shiftIso(end, i - (STRIP_DAYS - 1)));
}

/**
 * Twelve weeks of days, seven at a time, as a strip you scroll.
 *
 * Two earlier versions of this row are worth recording, because each fixed the
 * one before it and left something behind.
 *
 * The first was `‹ Thursday 11 September ›`: two bare chevrons in icon buttons,
 * the left of which sat in the corner Back lives in, in a screen's title row,
 * pointing the way Back points. Every reader took it for a way out. It also
 * made every day a separate press — four taps to reach Monday, with the date
 * changing under you each time.
 *
 * The second was seven fixed dates ending on today. One tap to any day of the
 * past week, nothing that could be mistaken for Back — and no way at all to
 * reach the week before, which the user found on the fifth day of using the
 * app: *"the top row of dates cannot move?"* Reaching a fortnight back meant
 * the Days calendar, for a date that is four days off the edge of the screen.
 *
 * So the seven dates stay and the rail behind them grows. The gesture is the
 * one they already tried; the contents do not move when you pick a day; and
 * scrolling browses without selecting, so nothing is logged against a week you
 * merely looked at.
 *
 * Still deliberately NOT a progress track. The marks say a day exists in the
 * record, never how well it went, and there is nothing here to fill or beat.
 */
function WeekStrip({
  date, days, logged, onPick,
}: {
  date: string;
  /** The strip's whole reach, oldest first. See `stripDays`. */
  days: string[];
  logged: ReadonlySet<string>;
  onPick: (iso: string) => void;
}) {
  const today = todayIso();
  const rail = useRef<HTMLDivElement | null>(null);

  /** Which week of the rail holds the day being read. */
  const page = Math.max(0, Math.floor(days.indexOf(date) / 7));

  /*
    Which week is on screen, which is not the same question as which day is
    selected — the whole point of a scroller is that you can look at one week
    while reading another. Tracked so the caption can name the month: seven
    bare numbers are ambiguous the moment they are not this week's, and a
    person scrolling back three weeks should not have to tap a date to find out
    which month they are in.
  */
  const [shown, setShown] = useState(page);
  useEffect(() => { setShown(page); }, [page]);

  /*
    Put the week holding the selected day on screen.

    `useLayoutEffect` and not `useEffect`: this runs on mount, when the rail is
    scrolled to its oldest week and the correct position is its newest. After
    paint that is a visible jump from twelve weeks ago to today.
  */
  useLayoutEffect(() => {
    const el = rail.current;
    if (el === null) return;
    const w = el.clientWidth;
    // Zero on a wide window, where `.daybar` is display:none. There is no
    // layout to scroll and no scroll position worth overwriting.
    if (w === 0) return;
    const want = page * w;
    /*
      Left alone when the selected day is already on screen. Without this,
      scrolling back to August and tapping the 14th would re-run this effect
      and snap the rail to wherever it computed — which is where it already is,
      but only because the arithmetic agrees; a half-swipe in progress would be
      yanked straight. Half a page is the tolerance because a snapped rail is
      always within a rounding error of an exact multiple.
    */
    if (Math.abs(el.scrollLeft - want) > w / 2) el.scrollLeft = want;
  }, [page, days.length]);

  const weeks = Array.from({ length: STRIP_WEEKS }, (_, i) => days.slice(i * 7, i * 7 + 7));

  return (
    <div className="weekwrap">
      <div className="week__caption">{monthSpan(weeks[shown] ?? [], today)}</div>
      <div
        className="week"
        ref={rail}
        role="group"
        aria-label="Pick a day"
        onScroll={(e) => {
          const el = e.currentTarget;
          const w = el.clientWidth;
          if (w > 0) setShown(Math.min(STRIP_WEEKS - 1, Math.round(el.scrollLeft / w)));
        }}
      >
        {weeks.map((week, i) => (
          <div className="week__page" key={week[0]} data-page={i}>
            {week.map((iso) => {
              const d = new Date(`${iso}T00:00:00`);
              const ahead = iso > today;
              return (
                <button
                  key={iso}
                  className="week__day"
                  onClick={() => onPick(iso)}
                  disabled={ahead}
                  aria-current={iso === date ? "date" : undefined}
                  aria-label={humanDate(iso)}
                >
                  <span className="week__wd">
                    {d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)}
                  </span>
                  <span className="week__n tnum">{d.getDate()}</span>
                  <span className={logged.has(iso) ? "week__dot is-on" : "week__dot"} aria-hidden />
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The month the visible week sits in, or both months when it straddles two.
 *
 * The year is named only when it is not this one. A strip reaching twelve weeks
 * back crosses New Year for a quarter of the year, and "January" next to a
 * December day is worse than useless — but printing 2026 beside every week for
 * the other nine months is noise nobody reads.
 */
function monthSpan(week: string[], today: string): string {
  if (week.length === 0) return "";
  const thisYear = today.slice(0, 4);
  const name = (iso: string) => {
    const d = new Date(`${iso}T00:00:00`);
    const month = d.toLocaleDateString(undefined, { month: "long" });
    return iso.slice(0, 4) === thisYear ? month : `${month} ${iso.slice(0, 4)}`;
  };
  const first = name(week[0]);
  const last = name(week[week.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

/**
 * The day in the user's own words.
 *
 * Everything else on this screen is arithmetic, and arithmetic cannot hold the
 * reasons: that the sambar could not be weighed because it was somebody else's
 * pot, that a day was a fast, that the numbers look odd because of a flight.
 * Those are facts about the day that belong beside it, and there was nowhere to
 * put them. The user asked for somewhere.
 *
 * It is NOT nutrition and nothing reads it as any — see the `day_notes` comment
 * in store.rs. No figure on this screen moves because of what is typed here,
 * which is exactly what makes it safe to write freely in.
 *
 * Saved by itself, on a pause and on losing focus, because a note nobody
 * pressed a button for is a note that has to survive the thumb that reaches
 * for the bottom bar. The screen unmounts when you leave it, so the last write
 * happens from the cleanup below.
 */
function DayNote({ date }: { date: string }) {
  /** null while the note for `date` has not come back yet. */
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "kept">("idle");
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="card day-note">
      <div className="card__head">
        <h2>Note</h2>
        {status !== "idle" && (
          <span className="card__note">{status === "saving" ? "Saving…" : "Saved"}</span>
        )}
      </div>

      <textarea
        className="field day-note__field"
        rows={3}
        maxLength={2000}
        value={draft ?? ""}
        placeholder="Anything worth writing down about this day."
        aria-label={`Note for ${humanDate(date)}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void flush()}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      <div className="card__foot">
        Yours, and not part of the arithmetic. Nothing here is read as food and nothing in it
        changes a figure on this screen — which is the point: it is for what the numbers cannot
        hold.
      </div>
    </section>
  );
}

/**
 * How much of it, in the unit the thing is actually measured in.
 *
 * A supplement has no mass this app knows, so it is never given one — "0 g" on
 * a tablet is the same class of lie as a nutrient rendered as 0.
 */
function quantityText(e: LogEntry): string {
  if (e.source_kind === "supplement") {
    const n = e.units ?? 0;
    const rounded = Math.round(n * 100) / 100;
    return `${rounded} ${rounded === 1 ? "dose" : "doses"}`;
  }
  // Water is drunk by volume and weighed by mass. The scale gave grams; the
  // bottle says what that comes to, and that is the number to show — nobody
  // thinks about their day in grams of water.
  if (e.water) return describeVolume(e.water.ml);
  return e.grams === null ? "weight not recorded" : `${Math.round(e.grams)} g`;
}

/** The tags, when the user has given them. Silence stays silent. */
function tagText(e: LogEntry, pending?: { origin: Origin | null; cuisine: string | null }): string {
  const origin = pending?.origin ?? e.origin;
  const cuisine = pending?.cuisine ?? e.cuisine;
  const bits = [origin ? ORIGIN_LABEL[origin].toLowerCase() : null, cuisine].filter(Boolean);
  return bits.join(", ");
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the day">
      <div className="skel" style={{ height: 72, width: 220, marginBottom: "var(--s5)" }} />
      <div className="card">
        {[0, 1, 2, 3].map((i) => (
          <div className="skel skel--row" key={i} style={{ width: `${90 - i * 12}%` }} />
        ))}
      </div>
    </div>
  );
}
