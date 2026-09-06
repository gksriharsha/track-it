import { useState } from "react";
import { deleteLogEntry, setEntryTags } from "../api";
import CorrectEntry from "../components/CorrectEntry";
import type { DayView, LogEntry, Origin } from "../types";
import { MEALS, ORIGIN_LABEL } from "../types";
import { plural, read, unassessable, worthALook } from "../lib/nutrient";
import TagPicker from "../components/TagPicker";

interface Props {
  day: DayView | null;
  loading: boolean;
  date: string;
  label: string;
  canGoForward: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
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

  const watch = worthALook(totals);
  const unknown = unassessable(totals);
  const covered = totals.filter((t) => read(t).state === "measured").length;

  const [open, setOpen] = useState<string | null>(null);
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
          (see styles.css, `.daybar` is hidden there), so this row still
          renders here for the phone but nowhere on a wide window. */}
      <div className="screen__head daybar">
        <button className="iconbtn" onClick={p.onPrev} aria-label="Previous day">‹</button>
        <h1>{p.label}</h1>
        <button className="iconbtn" onClick={p.onNext} disabled={!p.canGoForward} aria-label="Next day">›</button>
        {p.canGoForward && (
          <button className="link" onClick={p.onToday} style={{ marginLeft: "var(--s2)" }}>
            back to today
          </button>
        )}
        {entries.length > 0 && (
          <span className="screen__sub" style={{ marginLeft: "auto" }}>
            {entries.length} item{entries.length > 1 ? "s" : ""}
          </span>
        )}
      </div>

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
          {/* Hero. Floats on the page — no card. It is the anchor. */}
          <section className="day-hero">
            <div className="hero__value">
              <span className="num hero__num">{kcal !== null ? kcal.toLocaleString() : "—"}</span>
              <span className="hero__unit">kcal</span>
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
                  {Math.max(target - kcal, 0).toLocaleString()} left of{" "}
                  {Math.round(target).toLocaleString()}
                  <span className="hero__basis">
                    {energyTarget?.basis === "estimated" ? " · estimated" : " · your target"}
                  </span>
                </>
              )}
            </div>
            {kcal !== null && target !== null && (
              <div className="hero__rail">
                <div className="hero__fill" style={{ width: `${Math.min((kcal / target) * 100, 100)}%` }} />
              </div>
            )}
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

          {/* Worth a look. The only place alarm colour appears, and only for
              a limit actually exceeded. */}
          <section className="card day-watch">
            <div className="card__head">
              <h2>Worth a look</h2>
              <span className="card__note">{covered} of {totals.length} measured</span>
            </div>
            {watch.length === 0 ? (
              <p style={{ color: "var(--ink-3)", fontSize: 14, margin: "var(--s2) 0" }}>
                Nothing stands out. Every nutrient with enough data to judge is within range.
              </p>
            ) : (
              <div className="rows">
                {watch.map(({ t, r }) => (
                  <div key={t.id} className={`row nrow ${r.over ? "is-over" : ""}`}>
                    <span className="row__main">
                      <span className="row__title">
                        <span aria-hidden style={{ color: r.over ? "var(--over)" : "var(--ink-3)", marginRight: 8 }}>
                          {r.over ? "↑" : "↓"}
                        </span>
                        {t.name}
                      </span>
                      {r.over && <span className="row__sub">above the daily limit</span>}
                    </span>
                    <span className="track">
                      <span
                        className={`track__fill${r.over ? " track__fill--over" : ""}`}
                        style={{ width: `${Math.min(r.pct ?? 0, 100)}%` }}
                      />
                    </span>
                    <span className="nval">
                      <span className="nval__amt tnum">{r.amount}</span>
                      <span className="nval__pct tnum">{Math.round(r.pct ?? 0)}%</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="card__foot">
              {unknown.length > 0
                ? `${unknown.length} more can't be assessed — some items have no data for them. `
                : ""}
              <button className="link" onClick={p.onSeeAll}>See all {totals.length} nutrients</button>
            </div>
          </section>

          {/* Not "What you ate": a supplement is not eaten and a bottle of
              water certainly is not, and this card holds both. */}
          <section className="card day-ate">
            <div className="card__head">
              <h2>What you had</h2>
              <button className="link card__note" onClick={p.onAddFood}>Add food</button>
            </div>
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
