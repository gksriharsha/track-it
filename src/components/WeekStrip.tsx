import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { humanDate, shiftIso, todayIso } from "../api";

/*
  Today's date strip, moved here unchanged from screens/Today.tsx when that
  screen was rewritten around its log. Nothing in it moved: the centred
  today, the twelve-week reach, the dots that say a day exists in the record
  and never how it went.
*/

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
 * How many days sit to the RIGHT of the anchor day, which is what puts it in
 * the middle of its week rather than hard against the right-hand edge.
 *
 * Three, because seven days have one middle and it is the fourth.
 *
 * The strip used to end ON today, and the reasoning for that was too narrow:
 * the future holds nothing to log, so drawing it looked like drawing dead
 * cells. But the row is not only a set of buttons — it is where you are in the
 * week, and a rail that stops at today can only show what is behind you. On a
 * Thursday it said nothing about the weekend ahead; on any day it put the one
 * cell you press most into the worst place on the screen, against the edge and
 * against the scroll boundary.
 *
 * The three days ahead stay unpressable, because a day that has not happened
 * has nothing to record. They are dimmed rather than hidden, which is the
 * honest shape: they are days, they are simply not yet.
 *
 * Nothing about this is a plan or a target. There is no cell to fill and no
 * run to keep — an empty Thursday ahead looks exactly like an empty Thursday
 * behind, which is the point.
 */
const STRIP_LEAD = 3;

/**
 * The days the strip draws for a given selection, oldest first.
 *
 * Exported from module scope rather than computed inside `WeekStrip` because
 * two things need to agree about it: the strip, and the read that marks which
 * of those days hold something. One function, called once, is what makes them
 * agree — see the `stripDays` call in `Today`.
 */
export function stripDays(date: string): string[] {
  const today = todayIso();
  /*
    The day the strip is built around, and the ONLY thing that moves its
    contents.

    Today, normally. The exception is a day picked out of the Days calendar
    that twelve weeks does not reach — that day becomes the anchor instead, so
    the day being read is on screen and centred the same way, with the daybar's
    own Today button as the way back.

    Note what this is not: it does not move when you tap a date inside the
    strip. That was the old behaviour and it cannot survive a scroller — you
    would scroll back to August, tap the 14th, and have the whole rail jump out
    from under your thumb to put the 14th at the right-hand edge.
  */
  const anchor = date >= shiftIso(today, -(STRIP_DAYS - 1 - STRIP_LEAD)) ? today : date;
  /*
    The rail's last day. `anchor + 3`, so the anchor lands in the middle of the
    final week: the rail holds `STRIP_DAYS` days ending here, and the anchor is
    therefore the fourth of the last seven.
  */
  const end = shiftIso(anchor, STRIP_LEAD);
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
 * Today sits in the MIDDLE of its week rather than at the end of it — see
 * `STRIP_LEAD` for why the rail stopped ending on today.
 *
 * Still deliberately NOT a progress track. The marks say a day exists in the
 * record, never how well it went, and there is nothing here to fill or beat.
 */
export default function WeekStrip({
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

    const position = () => {
      const w = el.clientWidth;
      // Zero on a wide window, where `.daybar` is display:none. There is no
      // layout to scroll and no scroll position worth overwriting.
      if (w === 0) return;
      const target = el.children[page] as HTMLElement | undefined;
      if (target === undefined) return;
      /*
        Measured off the page itself rather than computed as `page * w`, which
        is what this did first and what put today's own cell half off the right
        edge of a phone.

        `clientWidth` is an INTEGER and a page's real width is not: a 448.33 px
        column reports 448, and eleven pages of that lose four pixels — enough
        to sit a whole week's worth of rounding short of the end. It is also
        why the fault was invisible in a 375 px browser window, where the width
        came out a round 343 and the arithmetic happened to be exact. Asking
        the element where it is cannot drift.
      */
      const want = target.getBoundingClientRect().left
        - el.getBoundingClientRect().left
        + el.scrollLeft;
      /*
        Left alone when the selected day is already on screen. Without this,
        scrolling back to August and tapping the 14th would re-run this effect
        and snap the rail to where it computes the week to be — which is where
        it already is, but a half-swipe in progress would be yanked straight.
      */
      if (Math.abs(el.scrollLeft - want) > w / 2) el.scrollLeft = want;
    };

    position();

    /*
      And again whenever the rail changes WIDTH. A snap position is a fraction
      of the container, so every one of them moves when the container does —
      leaving the strip stranded between two weeks after a rotation, or after
      any late reflow that settles the width once this effect has already run.

      Width specifically, and the guard is not a micro-optimisation. A
      ResizeObserver fires for a height change and for a sub-pixel settle as
      readily as for a rotation, and re-positioning on one of those mid-fling
      is a rail that jumps back under the thumb: on a phone the first swipe
      after launch was being eaten outright, and the second worked, which is
      exactly what an observer racing a gesture looks like.
    */
    let seen = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w === seen) return;
      seen = w;
      position();
    });
    ro.observe(el);
    return () => ro.disconnect();
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
