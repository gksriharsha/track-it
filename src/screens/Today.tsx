import { useEffect, useState } from "react";
import {
  deleteLogEntry, frequentFoods, humanDate, loggedDates, setEntryTags, shiftIso, todayIso,
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

  /* The foods you have most days, and the days the record holds something on —
     the two things the top of this screen needs that the day itself cannot
     say. Both are read once per mount: neither changes as you step between
     days, and re-reading them on every date change would put two round trips
     in front of a tap that should feel instant. */
  const [quick, setQuick] = useState<FrequentFood[]>([]);
  const [logged, setLogged] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    frequentFoods(8).then((f) => live && setQuick(f)).catch(() => {});
    loggedDates().then((d) => live && setLogged(new Set(d))).catch(() => {});
    return () => { live = false; };
  }, []);

  /*
    A repeat is written straight in, and the way back out of it sits over the
    screen for eight seconds. `refreshAll` rather than `onRemoved` alone: a
    day that had nothing in it before this tap now has something, and the dot
    under its date in the strip has to follow.
  */
  const refreshAll = () => {
    p.onRemoved();
    loggedDates().then((d) => setLogged(new Set(d))).catch(() => {});
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
        <WeekStrip date={p.date} logged={logged} onPick={p.onPickDate} />
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

      <UndoToast last={q.last} onUndo={q.undo} />
    </div>
  );
}

/**
 * The last seven days, as seven buttons.
 *
 * This replaced a `‹ Thursday 11 September ›` row: two bare chevrons in icon
 * buttons, the left of which every person reading it took for a Back arrow —
 * it sat in the top-left corner where Back lives, in a screen's title row, and
 * pointed the way Back points. It also made every day a separate press: four
 * taps to reach Monday, with the date changing under you each time.
 *
 * Seven dates instead. Any of them is one tap, the day you are reading is
 * marked, and a day that has something logged in it carries a dot — so the
 * strip answers "when did I last record anything" without a trip to Days.
 *
 * Deliberately NOT a progress track: the marks say a day exists in the record,
 * never how well it went.
 */
function WeekStrip({
  date, logged, onPick,
}: {
  date: string;
  logged: ReadonlySet<string>;
  onPick: (iso: string) => void;
}) {
  const today = todayIso();
  /*
    The strip ends on today while the chosen day is inside this past week, and
    on the chosen day once it is older. Anchoring it always to today would show
    seven days that do not contain the one being read; anchoring it always to
    the selection would move the whole strip every time you stepped a day.
  */
  const end = date >= shiftIso(today, -6) ? today : date;
  const days = Array.from({ length: 7 }, (_, i) => shiftIso(end, i - 6));

  return (
    <div className="week" role="group" aria-label="Pick a day">
      {days.map((iso) => {
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
