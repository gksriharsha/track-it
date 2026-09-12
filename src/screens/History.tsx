import { useCallback, useEffect, useMemo, useState } from "react";
import { getRange, humanDate, shiftIso, todayIso } from "../api";
import NutrientRow from "../components/NutrientRow";
import type { DaySummary, NutrientTotal, RangeView, TagBreakdown } from "../types";
import { ORIGIN_LABEL } from "../types";
import { perDay, read } from "../lib/nutrient";
import ScreenHead from "../components/ScreenHead";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type Preset = "7" | "30" | "month" | "custom";

interface Props {
  onPickDate: (iso: string) => void;
  /** Open the spreadsheet importer. Reached from here because this is the
   * screen that already shows past days — the natural place to add to them. */
  onImport: () => void;
}

export default function History({ onPickDate, onImport }: Props) {
  const today = todayIso();
  const [month, setMonth] = useState(() => today.slice(0, 7)); // YYYY-MM
  const [preset, setPreset] = useState<Preset>("30");
  const [from, setFrom] = useState(shiftIso(today, -29));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<RangeView | null>(null);
  const [monthData, setMonthData] = useState<RangeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The range the averages cover, derived from the preset.
  const range = useMemo(() => {
    if (preset === "7") return { from: shiftIso(today, -6), to: today };
    if (preset === "30") return { from: shiftIso(today, -29), to: today };
    if (preset === "month") return { from: `${month}-01`, to: lastDayOf(month) };
    return { from, to };
  }, [preset, month, from, to, today]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, m] = await Promise.all([
        getRange(range.from, range.to),
        getRange(`${month}-01`, lastDayOf(month)),
      ]);
      setData(r);
      setMonthData(m);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, month]);

  useEffect(() => { load(); }, [load]);

  const byDate = useMemo(() => {
    const m = new Map<string, DaySummary>();
    for (const d of monthData?.days ?? []) m.set(d.date, d);
    return m;
  }, [monthData]);

  const cells = useMemo(() => monthGrid(month), [month]);
  const maxKcal = Math.max(1, ...(monthData?.days ?? []).map((d) => d.kcal ?? 0));

  const daysLogged = data?.days_logged ?? 0;
  const averaged: NutrientTotal[] = useMemo(
    () => (data && daysLogged > 0 ? data.totals.map((t) => perDay(t, daysLogged)) : []),
    [data, daysLogged],
  );

  const worst = useMemo(
    () =>
      averaged
        .map((t) => ({ t, r: read(t) }))
        .filter((x) => x.r.state === "measured" && x.r.pct !== null && !x.t.is_limit && x.r.pct! < 70)
        .sort((a, b) => a.r.pct! - b.r.pct!)
        .slice(0, 6),
    [averaged],
  );

  return (
    <div className="screen">
      <ScreenHead
        /* The name the bottom bar uses. A screen whose heading disagrees with
           the button that reached it makes a person doubt they arrived. */
        title="Days"
        sub="pick a day, or average a period"
        action={<button className="btn btn--quiet" onClick={onImport}>Import data</button>}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      {/* ── Calendar ─────────────────────────────────────────── */}
      <section className="card">
        {/* Drawn arrows in bounded buttons, not bare “‹” and “›” glyphs.

            A lone chevron reads as Back — that is what it means everywhere
            else on a phone — and Today's own date row was replaced for exactly
            that reason. Here the control is genuinely a stepper rather than a
            way out, so it keeps its arrows and says so with its shape: two
            segments bounded together, the month between them. */}
        <div className="card__head monthnav">
          <div className="stepper stepper--sm">
            <button className="stepper__seg" onClick={() => setMonth(shiftMonth(month, -1))}
              aria-label="Previous month">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 6l-6 6 6 6" />
              </svg>
            </button>
            <h2 className="stepper__mid monthnav__label">{monthLabel(month)}</h2>
            <button
              className="stepper__seg"
              onClick={() => setMonth(shiftMonth(month, 1))}
              disabled={month >= today.slice(0, 7)}
              aria-label="Next month"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>

        {/* Under the month rather than beside it. As a `.card__note` with
            `margin-left: auto` this sentence and the stepper were two flex
            items competing for one row, and the sentence won — on a 390pt
            screen it squeezed the month nav down to the width of its own
            border. */}
        {monthData && (
          <p className="monthnav__note">
            {monthData.days_logged} day{monthData.days_logged === 1 ? "" : "s"} of food
            {monthData.days_with_supplements > 0 &&
              `, ${monthData.days_with_supplements} with a supplement`}
            {monthData.days_with_water > 0 &&
              `, ${monthData.days_with_water} with water logged`}
          </p>
        )}

        <div className="cal">
          {WEEKDAYS.map((w) => (
            <div className="cal__wd" key={w}>{w}</div>
          ))}
          {cells.map((iso, i) =>
            iso === null ? (
              <div key={`pad-${i}`} />
            ) : (
              <CalendarCell
                key={iso}
                iso={iso}
                today={today}
                day={byDate.get(iso) ?? null}
                maxKcal={maxKcal}
                onPick={onPickDate}
              />
            ),
          )}
        </div>

        <div className="callegend">
          {ORIGIN_KEYS.map((o) => (
            <span className="callegend__item" key={o}>
              <span className={`callegend__sw is-${o}`} aria-hidden />
              {ORIGIN_LABEL[o]}
            </span>
          ))}
          <span className="callegend__item">
            <span className="callegend__sw is-untagged" aria-hidden />
            not recorded
          </span>
          <span className="callegend__item">
            <span className="callegend__sw is-supplement" aria-hidden />
            supplement only
          </span>
        </div>
      </section>

      {/* ── Where it came from, and what it was ──────────────── */}
      <section className="card">
        <div className="card__head">
          <h2>Cuisine and origin</h2>
          <span className="card__note">
            {humanDate(range.from)} – {humanDate(range.to)}
          </span>
        </div>

        {loading ? (
          [0, 1, 2, 3].map((i) => (
            <div className="skel skel--row" key={i} style={{ width: `${88 - i * 12}%` }} />
          ))
        ) : (data?.cuisines.length ?? 0) === 0 && (data?.origins.length ?? 0) === 0 ? (
          <div className="empty" style={{ padding: "var(--s5) 0" }}>
            <h3>Nothing tagged in this period</h3>
            <p>
              Tag a dish as you log it — or open one on the day it was logged and say where it
              came from — and this becomes a picture of how much you cook.
            </p>
          </div>
        ) : (
          <>
            <div className="group__name">Where it came from</div>
            <TagBars rows={data?.origins ?? []} label={(k) => ORIGIN_LABEL[k as never] ?? k} />

            <div className="group__name" style={{ marginTop: "var(--s5)" }}>
              Cuisine
            </div>
            <TagBars rows={data?.cuisines ?? []} />

            <div className="card__foot">
              Counted by dish, over the {countOf(data)} dish
              {countOf(data) === 1 ? "" : "es"} you logged in this period. Supplements are not
              dishes and are left out. “Not recorded” is shown rather than hidden — how much you
              have not said is part of the picture.
            </div>
          </>
        )}
      </section>

      {/* ── Period averages ──────────────────────────────────── */}
      <section className="card">
        <div className="card__head">
          <h2>Average per day</h2>
          <span className="card__note">
            {loading ? "…" : `${daysLogged} logged day${daysLogged === 1 ? "" : "s"}`}
          </span>
        </div>

        <div className="chips" style={{ marginBottom: "var(--s3)" }}>
          {([["7", "Last 7 days"], ["30", "Last 30 days"], ["month", "This month"], ["custom", "Custom"]] as const).map(
            ([id, label]) => (
              <button key={id} className="chip" aria-pressed={preset === id} onClick={() => setPreset(id)}>
                {label}
              </button>
            ),
          )}
        </div>

        {preset === "custom" && (
          <div className="daterange">
            <label>
              <span className="group__name">From</span>
              <input className="field" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              <span className="group__name">To</span>
              <input className="field" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        )}

        {loading ? (
          [0, 1, 2, 3, 4].map((i) => <div className="skel skel--row" key={i} style={{ width: `${92 - i * 8}%` }} />)
        ) : daysLogged === 0 ? (
          <div className="empty" style={{ padding: "var(--s6) 0" }}>
            <h3>Nothing logged in this period</h3>
            <p>Averages need at least one logged day. Pick a different range, or log a meal.</p>
          </div>
        ) : (
          <>
            <p className="rangenote">
              Averaged over the <strong>{daysLogged}</strong> day
              {daysLogged === 1 ? "" : "s"} you logged between {humanDate(range.from)} and{" "}
              {humanDate(range.to)} — not over the whole calendar period, which would divide
              your intake by days you never recorded.
            </p>

            {worst.length > 0 && (
              <>
                <div className="group__name" style={{ marginTop: "var(--s4)" }}>
                  Furthest from their reference figure
                </div>
                <div className="rows">
                  {worst.map(({ t }) => <NutrientRow key={t.id} t={t} />)}
                </div>
              </>
            )}

            <div className="group__name" style={{ marginTop: "var(--s5)" }}>All nutrients</div>
            <div className="rows">
              {averaged.map((t) => <NutrientRow key={t.id} t={t} />)}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * The origins, in the order the calendar strip and the legend both use.
 * Ordering matters: "ordered in" and "ate out" sit next to each other so the
 * two ways of not cooking read as one block at a glance, without the data
 * having collapsed them.
 */
const ORIGIN_KEYS = ["home", "ordered_in", "eaten_out", "packaged"] as const;

/**
 * One day in the month grid.
 *
 * Three things are encoded and they have to stay separable at 44 px: the date,
 * how much energy the day carried, and where its dishes came from. Energy is
 * the bar's opacity, origin is a segmented strip below it.
 *
 * A day with nothing on it stays blank — never a zero-height bar, which would
 * read as "you ate almost nothing" rather than "you did not log". A day
 * holding only a supplement and/or water gets its own mark for the same
 * reason: it has no food energy, and drawing it at minimum opacity would say
 * something false about what was eaten.
 */
function CalendarCell({
  iso,
  today,
  day,
  maxKcal,
  onPick,
}: {
  iso: string;
  today: string;
  day: DaySummary | null;
  maxKcal: number;
  onPick: (iso: string) => void;
}) {
  const noFoodOnly =
    day !== null && day.food_items === 0 && (day.supplement_items > 0 || day.water_items > 0);
  const hasFood = day !== null && day.food_items > 0;

  const label = day === null
    ? `${humanDate(iso)}, nothing logged`
    : noFoodOnly
      ? `${humanDate(iso)}, ${describeNoFood(day)}`
      : `${humanDate(iso)}, ${day.items} items${describeMix(day)}`;

  return (
    <button
      className={`cal__day${iso === today ? " is-today" : ""}${day ? " has-data" : ""}`}
      onClick={() => onPick(iso)}
      disabled={iso > today}
      aria-label={label}
    >
      <span className="cal__n tnum">{Number(iso.slice(8))}</span>
      {day && (
        <>
          <span className="cal__k tnum">
            {day.kcal !== null ? Math.round(day.kcal) : noFoodOnly ? "+" : "·"}
          </span>
          {hasFood ? (
            <>
              {/* Intensity encodes energy, so a month reads at a glance. */}
              <span
                className="cal__bar"
                style={{ opacity: 0.25 + 0.75 * ((day.kcal ?? 0) / maxKcal) }}
              />
              <span className="cal__mix" aria-hidden>
                {ORIGIN_KEYS.filter((k) => day.origins.some((o) => o.key === k)).map((k) => (
                  <span
                    key={k}
                    className={`cal__seg is-${k}`}
                    style={{ flexGrow: day.origins.find((o) => o.key === k)!.entries }}
                  />
                ))}
                {day.untagged_origin > 0 && (
                  <span className="cal__seg is-untagged" style={{ flexGrow: day.untagged_origin }} />
                )}
              </span>
            </>
          ) : (
            /* No food, so no energy bar and no origin strip — there is nothing
               for either to be about. */
            <span className="cal__pill" aria-hidden />
          )}
        </>
      )}
    </button>
  );
}

/** What a food-free day held, for the cell's accessible name. */
function describeNoFood(day: DaySummary): string {
  const bits: string[] = [];
  if (day.supplement_items > 0) bits.push("a supplement");
  if (day.water_items > 0) bits.push("water");
  return `${bits.join(" and ")} only`;
}

/** The day's mix, for the cell's accessible name. */
function describeMix(day: DaySummary): string {
  const bits = day.origins.map((o) => `${o.entries} ${ORIGIN_LABEL[o.key as never] ?? o.key}`);
  if (day.untagged_origin > 0) bits.push(`${day.untagged_origin} not recorded`);
  return bits.length > 0 ? `, ${bits.join(", ")}` : "";
}

/**
 * A frequency chart, as bars proportional to the largest row.
 *
 * Counted by DISH rather than by day or by meal: a dish is the unit the user
 * actually tagged, and it is the only count that needs no rule for what a mixed
 * day or a mixed meal should be called.
 *
 * The untagged row is rendered like any other and never folded away. "Other",
 * typed by the user, is a positive claim; "not recorded" is the absence of one,
 * and collapsing the second into the first would be the same mistake as
 * rendering an unmeasured nutrient as zero.
 */
function TagBars({
  rows,
  label,
}: {
  rows: TagBreakdown[];
  label?: (key: string) => string;
}) {
  if (rows.length === 0) {
    return (
      <p style={{ color: "var(--ink-3)", fontSize: 14, margin: "var(--s2) 0" }}>
        Nothing tagged in this period.
      </p>
    );
  }
  const max = Math.max(...rows.map((r) => r.entries), 1);
  const total = rows.reduce((a, r) => a + r.entries, 0);

  return (
    <div className="rows">
      {rows.map((r) => {
        const name =
          r.key === null
            ? "Not recorded"
            : label
              ? label(r.key)
              : r.label ?? r.key;
        return (
          <div className={`row nrow${r.key === null ? " is-untagged" : ""}`} key={r.key ?? "__none"}>
            <span className="row__main">
              <span className="row__title">{name}</span>
              <span className="row__sub">
                on {r.days} day{r.days === 1 ? "" : "s"}
              </span>
            </span>
            <span className="track">
              <span
                className={`track__fill${r.key === null ? " track__fill--muted" : ""}`}
                style={{ width: `${(r.entries / max) * 100}%` }}
              />
            </span>
            <span className="nval">
              <span className="nval__amt tnum">{r.entries}</span>
              <span className="nval__pct tnum">
                {total > 0 ? `${Math.round((r.entries / total) * 100)}%` : ""}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** How many dishes the period's tagging covers. */
function countOf(data: RangeView | null): number {
  return (data?.origins ?? []).reduce((a, r) => a + r.entries, 0);
}

/* ── date helpers (local calendar, never UTC) ────────────────── */

function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Week starts Monday, with leading blanks so columns line up. */
function monthGrid(month: string): (string | null)[] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) {
    cells.push(`${month}-${String(d).padStart(2, "0")}`);
  }
  return cells;
}
