import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { labelPercentTable } from "../api";
import type {
  CustomNutrient,
  DvBasis,
  LabelForm as Compound,
  PercentBasis,
  PercentLine,
  ServingUnit,
} from "../types";
import { LABEL_NUTRIENTS } from "../types";
import { plural } from "../lib/nutrient";

interface Props {
  /** The serving as typed upstairs — the basis every figure here is per. */
  serving: string;
  /** What that serving is measured in: grams, or millilitres for a can. */
  unit: ServingUnit;
  nutrients: CustomNutrient[];
  onChange: (n: CustomNutrient[]) => void;
  /**
   * The generic entry this food overrides, if one was chosen, so a line left blank
   * can say where its value comes from instead of leaving the user to guess.
   */
  baseName?: string | null;
  /**
   * What a photo of the panel was read as. Deliberately a separate prop from
   * `nutrients`: a reading is a machine's guess at 6pt type, and a misread "1.5"
   * as "15" logged as a measurement would be wrong on every day it appears in.
   * Nothing here reaches `nutrients` except through an accept below.
   */
  suggestions?: CustomNutrient[] | null;
  /**
   * One reading confirmed by the user. The parent puts it into `nutrients` and
   * retires it from the set; this form does not also write it through `onChange`,
   * or the same figure would land twice. Left unwired, the form takes the reading
   * into its own lines instead, so it still works on its own.
   */
  onAcceptSuggestion?: (n: CustomNutrient) => void;
  /**
   * The whole set confirmed at once. Fires only when this form is showing all of
   * it and nothing was held back — a reading that contradicts a typed figure, or
   * one already waved off, is reported singly through `onAcceptSuggestion`
   * instead, because a callback that takes "all of them" cannot express either.
   */
  onAcceptAll?: () => void;
  /**
   * Which Daily Values the pack's percentages are of. A statement about the
   * pack, owned by the food, so it is a prop rather than state here: it is
   * saved with the food and decides every percentage line at once.
   */
  dvBasis: DvBasis;
  onDvBasisChange: (b: DvBasis) => void;
}

/**
 * The amount below which a US panel may print 0, per serving (21 CFR 101.9).
 *
 * This mirrors `rounding_ceiling` in crates/core/src/label.rs, which is the
 * authority; the copy on each row quotes the figure, so the number has to be here
 * as well as there. The micronutrients are written as the arithmetic the regulation
 * actually specifies — 2% of the Daily Value — rather than as a constant that would
 * look invented.
 */
const CEILING: Record<number, number> = {
  1008: 5, // energy, 101.9(c)(1)
  1004: 0.5, // total fat, 101.9(c)(2)
  1258: 0.5, // saturated fat
  1257: 0.5, // trans fat
  1253: 2, // cholesterol, 101.9(c)(3)
  1093: 5, // sodium, 101.9(c)(4)
  1005: 0.5, // carbohydrate, 101.9(c)(6)
  1079: 0.5, // fibre
  2000: 0.5, // total sugars
  1235: 0.5, // added sugars
  1003: 0.5, // protein, 101.9(c)(7)
  // 101.9(c)(8)(iii): declared as a percent of the Daily Value, and 0 is allowed
  // below 2% of it.
  1114: 20 * 0.02, // vitamin D, DV 20 µg
  1087: 1300 * 0.02, // calcium, DV 1300 mg
  1089: 18 * 0.02, // iron, DV 18 mg
  1092: 4700 * 0.02, // potassium, DV 4700 mg
};

/**
 * A reading is drawn as a dashed inset UNDER the line it belongs to, never inside
 * the line's own boxes. The field stays empty until the user puts the figure in it,
 * so there is no state in which the form looks filled in with something nobody read
 * off the pack themselves.
 */
const STRIP: CSSProperties = {
  gridColumn: "1 / -1",
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--s2) var(--s3)",
  margin: "var(--s1) 0 var(--s2)",
  padding: "var(--s2) var(--s3)",
  border: "1px dashed var(--ink-3)",
  borderRadius: "var(--r-md)",
  background: "var(--sunken)",
};

/** Set in `.t-sm` by the elements that use it — the size is the type scale's. */
const STRIP_TEXT: CSSProperties = {
  flex: "1 1 220px",
  minWidth: 0,
  color: "var(--ink-2)",
};

const BANNER: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--s3)",
  marginTop: "var(--s4)",
  padding: "var(--s3) var(--s4)",
  border: "1px dashed var(--ink-3)",
  borderRadius: "var(--r-md)",
  background: "var(--sunken)",
};

/**
 * These sit between rows, under a thumb, and `.btn` already gives them the
 * button's own height (--btn-h) — so all this adds is the narrower padding of
 * a control inside a row, and no wrapping.
 */
const ACT: CSSProperties = {
  paddingInline: "var(--s4)",
  whiteSpace: "nowrap",
};

/**
 * What is typed on one line. The figure is held as TEXT, not as a number: "0." and
 * a cleared box are both things a person types on the way to a value, and rounding
 * them into the saved food mid-keystroke would change what they meant.
 */
type Row = {
  text: string;
  lt: boolean;
  ltKind: "below_loq" | "trace";
  /** The figure is a percentage of the Daily Value, not an amount. */
  pct: boolean;
  /** The compound an older panel's percentage needs, where it needs one. */
  form: Compound | null;
};

const BLANK: Row = { text: "", lt: false, ltKind: "below_loq", pct: false, form: null };

/** The ids of a current panel's fifteen lines, always shown. */
const SPINE = new Set(LABEL_NUTRIENTS.map((n) => n.id));

/** One line on screen. */
type Line = { id: number; name: string; unit: string };

/**
 * Lines an older panel always prints, so they are shown whenever the pack is
 * one: "Vitamin A 10% • Vitamin C 4%" was mandatory before 2020.
 */
const OLDER_ALWAYS = [1106, 1162];

/**
 * The lines an older panel gives in grams or milligrams beside their
 * percentage: its Daily Reference Values. Every other line it has a Daily
 * Value for is a vitamin or mineral, which it prints as a percentage only, so
 * on an older pack those lines start in %.
 */
const OLDER_AMOUNTS = new Set([1004, 1258, 1253, 1093, 1092, 1005, 1079, 1003]);

/** A converted figure without the float noise: 2.4, not 2.4000000000000004. */
const tidy = (x: number) => String(Math.round(x * 1000) / 1000);

/** The reference database's "ug", the way a pack writes it. */
const shown = (u: string) => (u === "ug" ? "µg" : u);

/** The chips for a compound — the supplement editor's wording, for the same choice. */
const COMPOUND: Partial<Record<Compound, string>> = {
  retinol: "Retinol / retinyl ester",
  beta_carotene_supplemental: "Beta-carotene (supplemental)",
  beta_carotene_dietary: "Beta-carotene (from food)",
  alpha_tocopherol_natural: "Natural — d-alpha-tocopherol",
  alpha_tocopherol_synthetic: "Synthetic — dl-alpha-tocopherol",
  folic_acid: "Added folic acid",
  food_folate: "Folate the food has naturally",
};

/** What a line asks while its compound is unnamed. */
const ASK: Record<number, string> = {
  1106: "say which vitamin A this is — milk is fortified with retinol, listed as vitamin A palmitate",
  1109: "say whether this vitamin E is natural or synthetic",
  1190: "say whether this is added folic acid or folate the food has naturally",
};

type Resolved =
  | { state: "none"; lt: boolean }
  | { state: "printed"; value: CustomNutrient; amount: number; pct?: number }
  | { state: "zero"; value: CustomNutrient; ceiling: number; pct?: number }
  | { state: "under"; value: CustomNutrient; upper: number; pct?: number }
  | { state: "snag"; why: string };

/** A reading on offer, against whatever the line already says. */
type Offer = {
  s: CustomNutrient;
  /** How the reading would be worded on the pack. */
  reads: string;
  /** What the line says now, when it says something that disagrees. */
  clash: string | null;
  /** The reading and the typed figure are the same fact. */
  agrees: boolean;
};

/**
 * Transcribe a nutrition panel.
 *
 * Four things a pack can say about a nutrient, and the whole component exists to
 * keep them apart:
 *
 *   (blank)        not printed — no row saved, so the value stays unknown
 *   13             printed — a measurement, per serving
 *   0              printed as zero — which under FDA rounding means "under the
 *                  threshold", so it is stored as that BOUND and never as none
 *   less than 1    printed as a bound already
 *
 * Blank is the default and the common case: a panel prints about fifteen figures
 * and this app tracks forty-seven. The state is read off what is typed rather than
 * from a mode control per line — an empty box is already the clearest way to say
 * "the pack does not print this", and forty-five extra buttons on the way to a
 * number would tax the case that happens on nearly every line.
 *
 * A photo of the panel can be READ into a fifth thing — a suggestion — which is
 * none of the four until the user says it is.
 */
export default function LabelForm(p: Props) {
  const [rows, setRows] = useState<Map<number, Row>>(() => seed(p.nutrients));
  /**
   * What 1% of each Daily Value is, current and older, from the backend — the
   * same functions that convert a percentage when the food is saved, so the
   * figure shown here is the figure stored. Null until it arrives; without it
   * the form is exactly the amounts-only form it always was.
   */
  const [table, setTable] = useState<PercentLine[] | null>(null);
  /** Lines added by hand beyond the fifteen: Vitamin A, B12, zinc. */
  const [added, setAdded] = useState<Set<number>>(() => new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    labelPercentTable()
      .then((t) => { if (live) setTable(t); })
      .catch(() => { /* percentages unavailable; amounts still work */ });
    return () => { live = false; };
  }, []);

  /** This line's percentage arithmetic under the pack's basis, if it has any. */
  const infoOf = (id: number): PercentBasis | null =>
    table?.find((t) => t.nutrient_id === id)?.[p.dvBasis] ?? null;
  /** Whether a line nobody has typed in starts in %: on an older pack, its vitamins and minerals. */
  const startsInPercent = (id: number): boolean =>
    p.dvBasis === "older" && !OLDER_AMOUNTS.has(id) && infoOf(id) !== null;
  const blankFor = (id: number): Row => (startsInPercent(id) ? { ...BLANK, pct: true } : BLANK);
  /** 1% of a line in the unit the app stores, under the compound named if it needs one. */
  const perPercent = (id: number, form: Compound | null): number | null => {
    const info = infoOf(id);
    if (!info) return null;
    return info.per_percent ?? info.forms.find((f) => f.form === form)?.per_percent ?? null;
  };
  /** The zero threshold for a line typed as an amount that is not on the spine. */
  const fallbackCeiling = (id: number): number | null => {
    const per = table?.find((t) => t.nutrient_id === id)?.current?.per_percent;
    return per != null ? 2 * per : null;
  };
  /**
   * What we last sent up, compared by VALUE. A parent that rebuilds the array on
   * every render — `nutrients={food?.nutrients ?? []}` is enough to do it — would
   * otherwise look like an outside edit on every keystroke and reseed the lines
   * out from under whoever is typing.
   */
  const mine = useRef(JSON.stringify(p.nutrients));
  const incoming = JSON.stringify(p.nutrients);

  /**
   * Readings the user has already answered, accepted or waved off, so an answer
   * stands even if the parent keeps offering the set unchanged.
   */
  const [handled, setHandled] = useState<Set<number>>(() => new Set());
  /**
   * What was on offer last render, by value. A reading that is NEW — a second
   * photo, or a different figure for the same nutrient — is asked again; one that
   * merely disappeared from the set (because the parent retired it) is not.
   */
  const offered = useRef<Map<number, string>>(new Map());
  const offerKey = JSON.stringify(p.suggestions ?? []);

  useEffect(() => {
    // `p.nutrients` is what `incoming` is a serialisation of; depending on the
    // array itself would put this effect back on identity.
    if (incoming === mine.current) return;
    // Genuinely different from what we sent: the parent loaded a food, or restored
    // a draft. Re-read the lines from it.
    mine.current = incoming;
    setRows((was) => reseed(was, p.nutrients, resolveRow, blankFor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  useEffect(() => {
    const now = new Map<number, string>();
    const fresh: number[] = [];
    for (const s of p.suggestions ?? []) {
      const json = JSON.stringify(s);
      now.set(s.nutrient_id, json);
      if (offered.current.get(s.nutrient_id) !== json) fresh.push(s.nutrient_id);
    }
    offered.current = now;
    if (fresh.length === 0) return;
    setHandled((h) => {
      if (!fresh.some((id) => h.has(id))) return h;
      const next = new Set(h);
      for (const id of fresh) next.delete(id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerKey]);

  const serving = Number(p.serving);
  const per100 = Number.isFinite(serving) && serving > 0 ? 100 / serving : null;
  /** What a line's converted figure is per: the app's basis, in the serving's own unit. */
  const basis = `per 100 ${p.unit}`;

  // Which lines are on screen: the fifteen, then anything this pack also
  // prints — always Vitamins A and C on an older panel, plus any line with a
  // figure in it or added by hand.
  const have = new Set<number>(p.nutrients.map((n) => n.nutrient_id));
  for (const [id, r] of rows) if (r.text.trim() !== "" || r.lt) have.add(id);
  const lines = linesFor(p.dvBasis, table, added, have);
  const lineIds = new Set(lines.map((l) => l.id));

  // Anything the food carries that this form has no line for — a nutrient
  // with no Daily Value, or any extra line while the table has not arrived. A
  // line this form cannot show is not a line it may silently drop on the next
  // keystroke.
  const kept = p.nutrients.filter((n) => !lineIds.has(n.nutrient_id));

  const resolveRow = (id: number, row: Row) => resolve(id, row, infoOf(id), fallbackCeiling(id));

  /** Send a whole set of lines up, and remember what we sent. */
  function commit(next: Map<number, Row>) {
    setRows(next);
    const built = [...build(lines, next, resolveRow), ...kept];
    mine.current = JSON.stringify(built);
    p.onChange(built);
  }

  // A percentage is worth a different amount under the other basis, and is
  // worth nothing until the table arrives — so both re-derive every line.
  const derivedKey = `${p.dvBasis}|${table === null ? 0 : table.length}`;
  useEffect(() => {
    const built = [...build(lines, rows, resolveRow), ...kept];
    if (JSON.stringify(built) === mine.current) return;
    mine.current = JSON.stringify(built);
    p.onChange(built);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedKey]);

  // A line nobody has typed in follows the pack's notation, so an older
  // panel's "Calcium 30%" is typed as it reads, without a toggle first. A
  // line with a figure in it keeps whatever it was written in.
  useEffect(() => {
    if (!table) return;
    setRows((was) => {
      let next: Map<number, Row> | null = null;
      for (const t of table) {
        const row = was.get(t.nutrient_id);
        const pct = startsInPercent(t.nutrient_id);
        if (row && row.text.trim() === "" && !row.lt && row.pct !== pct) {
          next ??= new Map(was);
          next.set(t.nutrient_id, { ...row, pct, form: null });
        }
      }
      return next ?? was;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.dvBasis, table]);

  function edit(id: number, patch: Partial<Row>) {
    const next = new Map(rows);
    next.set(id, { ...(rows.get(id) ?? blankFor(id)), ...patch });
    commit(next);
  }

  /**
   * Amount or percentage: a change in how a figure is written, never in what
   * it comes to. 300 mg of calcium becomes 30% on an older pack, not 300%.
   * With nothing to convert by — a compound not named yet — the box is emptied
   * rather than left to mean something else.
   */
  function writeAs(id: number, pct: boolean) {
    const row = rows.get(id) ?? blankFor(id);
    if (row.pct === pct) return;
    const t = row.text.trim();
    const n = Number(t);
    const per = perPercent(id, row.form);
    const text = t !== "" && Number.isFinite(n) && per !== null && per > 0 ? tidy(pct ? n / per : n * per) : "";
    edit(id, { pct, text });
  }

  const resolved = lines.map((n) => ({ n, r: resolveRow(n.id, rows.get(n.id) ?? blankFor(n.id)) }));
  const printed = resolved.filter((x) => x.r.state !== "none" && x.r.state !== "snag").length;
  const snags = resolved.filter((x) => x.r.state === "snag").length;

  // Readings still awaiting an answer, in the panel's own order.
  const live = new Map<number, CustomNutrient>();
  for (const s of p.suggestions ?? []) {
    // A reading with no figure in it cannot be confirmed, so it is not offered.
    if (!lineIds.has(s.nutrient_id) || handled.has(s.nutrient_id) || !usable(s)) continue;
    live.set(s.nutrient_id, s);
  }
  const offers = new Map<number, Offer>();
  for (const { n, r } of resolved) {
    const s = live.get(n.id);
    if (s) offers.set(n.id, offer(s, r, n.unit));
  }
  const pending = [...offers.values()];
  const clashes = pending.filter((o) => o.clash !== null).length;

  /**
   * Put one reading into the lines.
   *
   * The parent owns the food and the set of readings, so when it is listening the
   * value goes in through it and comes back down as an ordinary outside edit —
   * writing it here as well would put the same figure in twice. The local path is
   * what runs when this form is used without a scan wired up at all.
   */
  function accept(s: CustomNutrient) {
    setHandled((h) => new Set(h).add(s.nutrient_id));
    if (p.onAcceptSuggestion) {
      p.onAcceptSuggestion(s);
      return;
    }
    const next = new Map(rows);
    next.set(s.nutrient_id, rowOf(s));
    commit(next);
  }

  function dismiss(id: number) {
    // The line is left exactly as it was — which for an untouched line means
    // "not printed", and never a zero.
    setHandled((h) => new Set(h).add(id));
  }

  function acceptAll() {
    // Never in bulk over something typed. A figure read off the pack by hand
    // outranks one read off it by a camera, so a clash keeps its own accept.
    const taken = pending.filter((o) => o.clash === null);
    setHandled((h) => {
      const set = new Set(h);
      for (const o of taken) set.add(o.s.nutrient_id);
      return set;
    });

    // The bulk callback takes the parent's WHOLE set, so it may only be used when
    // this form is showing all of it and holding nothing back — otherwise a
    // reading the user has already waved off would go in with the rest.
    const showingAll = (p.suggestions ?? []).length === pending.length;
    if (clashes === 0 && showingAll && p.onAcceptAll) {
      p.onAcceptAll();
      return;
    }
    if (p.onAcceptSuggestion) {
      // An agreeing reading is already what the line says; there is nothing to put.
      for (const o of taken) if (!o.agrees) p.onAcceptSuggestion(o.s);
      return;
    }
    if (taken.length === 0) return;
    const next = new Map(rows);
    for (const o of taken) next.set(o.s.nutrient_id, rowOf(o.s));
    commit(next);
  }

  function dismissAll() {
    setHandled((h) => {
      const set = new Set(h);
      for (const o of pending) set.add(o.s.nutrient_id);
      return set;
    });
  }

  return (
    <div className="lform">
      <div className="lform__head">
        <span className="group__name">What the pack prints</span>
        <span className="lform__count num">
          {printed} of {lines.length}
        </span>
      </div>

      {table !== null && (
        <div className="lform__kind">
          <div className="chips" role="group" aria-label="Kind of label">
            <button
              className="chip chip--sm"
              type="button"
              aria-pressed={p.dvBasis === "current"}
              onClick={() => p.onDvBasisChange("current")}
            >
              Current label
            </button>
            <button
              className="chip chip--sm"
              type="button"
              aria-pressed={p.dvBasis === "older"}
              onClick={() => p.onDvBasisChange("older")}
            >
              Older label, before 2020
            </button>
          </div>
          <p className="lform__basis">
            {p.dvBasis === "older" ? (
              <>
                Percentages are read against the older Daily Values — calcium 1,000 mg, vitamin
                D 400 IU — not today's.
              </>
            ) : (
              <>
                An older label prints vitamins as a percentage only (Vitamin A 10% • Vitamin C
                4%) and ends with a table for 2,000 and 2,500 calorie diets.
              </>
            )}
          </p>
        </div>
      )}

      <p className="lform__basis">
        {per100 !== null ? (
          <>
            Every figure below is per serving — per {fig(serving)} {p.unit}. They are converted to
            a figure {basis} when the food is saved.
          </>
        ) : (
          <>
            These figures are per serving, so set the serving size above first. Without it
            every number here is wrong by whatever the serving turns out to be.
          </>
        )}
      </p>
      <p className="lform__basis">
        Leave a line blank when the pack does not print it — that is the ordinary case, not an
        omission. A blank line stays unknown{" "}
        {p.baseName ? (
          <>
            and takes its value from <strong>{p.baseName}</strong>.
          </>
        ) : (
          <>and is counted as unmeasured, never as zero.</>
        )}
      </p>

      {pending.length > 0 && (
        <div style={BANNER} role="group" aria-label="Read from the photo">
          <p className="t-sm" style={{ ...STRIP_TEXT, margin: 0, flexBasis: "260px" }}>
            <strong>{plural(pending.length, "figure")} read from the photo.</strong> None is
            entered yet — a camera can read a 5 as a 6, so check each against the pack before
            you take it.
            {clashes > 0 && (
              <>
                {" "}
                {clashes === 1
                  ? "One of them disagrees with what you typed, and is left for you."
                  : `${clashes} of them disagree with what you typed, and are left for you.`}
              </>
            )}
          </p>
          {pending.length > clashes && (
            <button className="btn btn--quiet" style={ACT} type="button" onClick={acceptAll}>
              {clashes > 0 ? `Accept the other ${pending.length - clashes}` : "Accept all"}
            </button>
          )}
          <button className="btn btn--quiet" style={ACT} type="button" onClick={dismissAll}>
            Ignore all
          </button>
        </div>
      )}

      <div className="lrows">
        {resolved.map(({ n, r }) => {
          const row = rows.get(n.id) ?? blankFor(n.id);
          const o = offers.get(n.id);
          const info = infoOf(n.id);
          return (
            <div className={`lrow${r.state === "none" ? " is-blank" : ""}`} key={n.id}>
              <span className="lrow__name">
                {n.name}
                {info || row.pct ? (
                  <span className="chips lrow__units" role="group" aria-label={`${n.name} is printed as`}>
                    <button
                      type="button"
                      className="chip chip--sm"
                      aria-pressed={!row.pct}
                      onClick={() => writeAs(n.id, false)}
                      aria-label={`${n.name} as an amount in ${n.unit}`}
                    >
                      {n.unit}
                    </button>
                    <button
                      type="button"
                      className="chip chip--sm"
                      aria-pressed={row.pct}
                      onClick={() => writeAs(n.id, true)}
                      aria-label={`${n.name} as a percentage of the Daily Value`}
                    >
                      %
                    </button>
                  </span>
                ) : (
                  <span className="lrow__unit">{n.unit}</span>
                )}
              </span>

              <input
                className="field tnum lrow__amt"
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="—"
                value={row.text}
                onChange={(e) => edit(n.id, { text: e.target.value })}
                aria-label={
                  row.pct
                    ? `${n.name} on the pack, as a percentage of the Daily Value`
                    : `${n.name} on the pack, in ${n.unit} per serving`
                }
              />

              {/* A bound, not a figure: "contains less than 1 g of fat" is a ceiling
                  with no floor under it, and storing it as 1 g would invent one. */}
              <button
                className="chip lrow__lt"
                type="button"
                aria-pressed={row.lt}
                aria-label={`The pack prints ${n.name} as "less than"`}
                onClick={() => edit(n.id, { lt: !row.lt })}
              >
                less than
              </button>

              {row.pct && info && info.forms.length > 0 && (
                <div className="chips lrow__forms" role="group" aria-label={`Which ${n.name}`}>
                  {info.forms.map((f) => (
                    <button
                      key={f.form}
                      className="chip chip--sm"
                      type="button"
                      aria-pressed={row.form === f.form}
                      onClick={() => edit(n.id, { form: f.form })}
                    >
                      {COMPOUND[f.form] ?? f.form}
                    </button>
                  ))}
                </div>
              )}

              <span className={`lrow__says${r.state === "snag" ? " is-snag" : ""}`}>
                {says(r, n.unit, per100, basis, p.baseName ?? null, row.pct ? info : null)}
              </span>

              {o && (
                <div style={STRIP} role="group" aria-label={`Read from the photo for ${n.name}`}>
                  <span className="t-sm" style={STRIP_TEXT}>
                    {o.clash !== null ? (
                      <>
                        You typed <span className="num">{o.clash}</span>. The photo reads{" "}
                        <span className="num">{o.reads}</span>.
                      </>
                    ) : o.agrees ? (
                      <>
                        The photo reads <span className="num">{o.reads}</span> too.
                      </>
                    ) : (
                      <>
                        Read from the photo: <span className="num">{o.reads}</span>. Not entered
                        until you take it.
                      </>
                    )}
                  </span>

                  {!o.agrees && (
                    <button
                      className="btn btn--quiet"
                      style={ACT}
                      type="button"
                      onClick={() => accept(o.s)}
                      aria-label={`Use the photo's ${n.name}, ${o.reads}`}
                    >
                      {o.clash !== null ? "Use the photo's" : "Use this"}
                    </button>
                  )}
                  <button
                    className="btn btn--quiet"
                    style={ACT}
                    type="button"
                    onClick={() => dismiss(n.id)}
                    aria-label={`Discard the photo's reading of ${n.name}`}
                  >
                    {o.clash !== null ? "Keep mine" : o.agrees ? "Got it" : "Ignore"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {table !== null && (() => {
        const more = table.filter((t) => !lineIds.has(t.nutrient_id));
        if (more.length === 0) return null;
        return adding ? (
          <div className="lform__add">
            <div className="chips">
              {more.map((t) => (
                <button
                  key={t.nutrient_id}
                  className="chip chip--sm"
                  type="button"
                  onClick={() => {
                    setAdded((a) => new Set(a).add(t.nutrient_id));
                    setAdding(false);
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <button className="link" type="button" onClick={() => setAdding(false)}>
              cancel
            </button>
          </div>
        ) : (
          <button className="btn btn--quiet lform__addbtn" type="button" onClick={() => setAdding(true)}>
            Add a line the pack prints
          </button>
        );
      })()}

      {snags > 0 && (
        <p className="lform__snag">
          {plural(snags, "line")} cannot be read as printed, and will be saved as not printed.
        </p>
      )}
    </div>
  );
}

/** What one line says it is now — and, on a snag, why it says nothing. */
function says(
  r: Resolved,
  unit: string,
  per100: number | null,
  basis: string,
  base: string | null,
  info: PercentBasis | null,
): string {
  if (info && r.state !== "none" && r.state !== "snag" && r.pct !== undefined) {
    // Non-breaking spaces keep each figure with its unit when the line wraps.
    const nb = "\u00a0";
    const of = `${r.pct}% of ${info.reference_amount.toLocaleString()}${nb}${shown(info.reference_unit)}`;
    switch (r.state) {
      case "printed":
        return per100 !== null
          ? `${of} — ${fig(r.amount)}${nb}${unit} a serving, ${fig(r.amount * per100)}${nb}${unit} ${basis.replace(/ /g, nb)}`
          : `${of} — ${fig(r.amount)}${nb}${unit} a serving`;
      case "zero":
        return `a printed 0% means under ${fig(r.ceiling)}${nb}${unit} — kept as that bound, not as none`;
      case "under":
        return `less than ${of} — no more than ${fig(r.upper)}${nb}${unit} a serving`;
    }
  }
  switch (r.state) {
    case "none":
      if (r.lt) return "type the figure the pack prints after “less than”";
      return base ? `not printed — from ${base}` : "not printed — unmeasured";
    case "printed":
      return per100 !== null
        ? `${fig(r.amount * per100)} ${unit} ${basis}`
        : `${fig(r.amount)} ${unit} per serving`;
    case "zero":
      return `a printed 0 means under ${fig(r.ceiling)} ${unit} — kept as that bound, not as none`;
    case "under":
      return `no more than ${fig(r.upper)} ${unit} per serving, and no floor under it`;
    case "snag":
      return r.why;
  }
}

/**
 * One line's typed text, read as what the pack says.
 *
 * A percentage becomes the amount it stands for here, for the preview, by the
 * backend's own figure for 1% (`info`). Saving converts it again from what
 * was printed, so this is a preview of the stored amount and never its source.
 */
function resolve(id: number, row: Row, info: PercentBasis | null, fallback: number | null): Resolved {
  const t = row.text.trim();
  if (t === "") return { state: "none", lt: row.lt };

  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) {
    return { state: "snag", why: "not a figure a pack can print" };
  }

  if (row.pct) {
    if (!info) {
      return {
        state: "snag",
        why: "this kind of label has no Daily Value for it, so a percentage is not a figure — type the amount",
      };
    }
    let per = info.per_percent;
    let form: Compound | null = null;
    if (per === null) {
      const f = info.forms.find((x) => x.form === row.form);
      if (!f) return { state: "snag", why: ASK[id] ?? "say which form the pack names" };
      per = f.per_percent;
      form = f.form;
    }
    const base = { nutrient_id: id, printed_pct: n, label_form: form };
    if (row.lt) {
      if (n === 0) {
        return { state: "snag", why: "“less than 0%” is a claim of absence, not a bound" };
      }
      return {
        state: "under",
        upper: n * per,
        pct: n,
        value: { ...base, kind: row.ltKind, amount: null, upper: n * per },
      };
    }
    if (n === 0) {
      return {
        state: "zero",
        ceiling: 2 * per,
        pct: 0,
        value: { ...base, kind: "label_zero", amount: null, upper: 2 * per },
      };
    }
    return {
      state: "printed",
      amount: n * per,
      pct: n,
      value: { ...base, kind: "measured", amount: n * per, upper: null },
    };
  }

  if (row.lt) {
    if (n === 0) {
      return { state: "snag", why: "“less than 0” is a claim of absence, not a bound" };
    }
    return {
      state: "under",
      upper: n,
      value: { nutrient_id: id, kind: row.ltKind, amount: null, upper: n },
    };
  }

  if (n === 0) {
    const ceiling = CEILING[id] ?? fallback;
    if (ceiling === null || ceiling === undefined) {
      return { state: "snag", why: "a printed 0 here has no threshold to bound it with" };
    }
    return {
      state: "zero",
      ceiling,
      value: { nutrient_id: id, kind: "label_zero", amount: null, upper: ceiling },
    };
  }

  return {
    state: "printed",
    amount: n,
    value: { nutrient_id: id, kind: "measured", amount: n, upper: null },
  };
}

/**
 * A reading is offered only when it carries something a person could have typed
 * themselves. A `measured` with no amount, or a bound with no ceiling, is not a
 * figure — accepting it would blank the line while claiming to have filled it.
 */
function usable(s: CustomNutrient): boolean {
  if (s.kind === "label_zero") return true;
  if (s.kind === "measured") return s.amount !== null && Number.isFinite(s.amount) && s.amount >= 0;
  return s.upper !== null && Number.isFinite(s.upper) && s.upper > 0;
}

/** A reading set against the line it lands on. */
function offer(s: CustomNutrient, r: Resolved, unit: string): Offer {
  const reads = wording(s, unit);
  const typed = r.state === "printed" || r.state === "zero" || r.state === "under" ? r.value : null;

  if (typed !== null) {
    if (agree(typed, s)) return { s, reads, clash: null, agrees: true };
    return { s, reads, clash: wording(typed, unit), agrees: false };
  }
  if (r.state === "snag") {
    // Nothing usable is typed, but something IS typed. Treating that as an empty
    // line and taking the reading in bulk would erase a keystroke the user made.
    return { s, reads, clash: "something the app cannot read", agrees: false };
  }
  return { s, reads, clash: null, agrees: false };
}

/** How a value would be worded on a pack. */
function wording(n: CustomNutrient, unit: string): string {
  switch (n.kind) {
    case "measured":
      return `${fig(n.amount ?? 0)} ${unit}`;
    case "label_zero":
      return `0 ${unit}`;
    default:
      return `less than ${fig(n.upper ?? 0)} ${unit}`;
  }
}

/**
 * The same fact, not the same struct. Any two zeros agree whatever bound each
 * carries, because the bound is derived from the nutrient rather than read off the
 * pack — the pack printed a 0 either way, and a line that took one is stored as
 * the bound regardless of which shape the value arrived in.
 */
function agree(a: CustomNutrient, b: CustomNutrient): boolean {
  if (zeroish(a) && zeroish(b)) return true;
  if (a.kind !== b.kind) return false;
  return a.kind === "measured" ? a.amount === b.amount : a.upper === b.upper;
}

function zeroish(n: CustomNutrient): boolean {
  return n.kind === "label_zero" || (n.kind === "measured" && n.amount === 0);
}

function build(
  lines: Line[],
  rows: Map<number, Row>,
  resolveRow: (id: number, row: Row) => Resolved,
): CustomNutrient[] {
  const out: CustomNutrient[] = [];
  for (const n of lines) {
    const r = resolveRow(n.id, rows.get(n.id) ?? BLANK);
    if (r.state === "none" || r.state === "snag") continue;
    out.push(r.value);
  }
  return out;
}

/**
 * The lines on screen, in the order the pack prints them.
 *
 * The fifteen always; then what else this pack carries. An older panel lists
 * Vitamins A and C straight after protein ("Vitamin A 10% • Vitamin C 4%,
 * Vitamin D 25% • Calcium 30%"), so they go there; anything else follows.
 */
function linesFor(
  basis: DvBasis,
  table: PercentLine[] | null,
  added: Set<number>,
  have: Set<number>,
): Line[] {
  const spine: Line[] = LABEL_NUTRIENTS.map((n) => ({ id: n.id, name: n.name, unit: n.unit }));
  const extras: Line[] = (table ?? [])
    .filter(
      (t) =>
        !SPINE.has(t.nutrient_id) &&
        (added.has(t.nutrient_id) ||
          have.has(t.nutrient_id) ||
          (basis === "older" && OLDER_ALWAYS.includes(t.nutrient_id))),
    )
    .map((t) => ({ id: t.nutrient_id, name: t.name, unit: shown(t.unit) }));
  if (basis !== "older") return [...spine, ...extras];
  const ac = extras.filter((e) => OLDER_ALWAYS.includes(e.id));
  const rest = extras.filter((e) => !OLDER_ALWAYS.includes(e.id));
  const at = spine.findIndex((l) => l.id === 1114);
  return [...spine.slice(0, at), ...ac, ...spine.slice(at), ...rest];
}

/**
 * One stored or read value as a typed line. A `label_zero` becomes the "0" a person
 * would have typed, and `resolve` derives its bound again from the nutrient — so a
 * reading that arrives with no bound on it still saves as the right one.
 */
function rowOf(saved: CustomNutrient): Row {
  // A line the pack printed as a percentage edits as that percentage: the
  // amount stored beside it is derived, and showing it would ask the user to
  // check a number that is not on the pack.
  if (saved.printed_pct !== undefined && saved.printed_pct !== null) {
    const pct = { pct: true, form: saved.label_form ?? null };
    switch (saved.kind) {
      case "measured":
        return { text: String(saved.printed_pct), lt: false, ltKind: "below_loq", ...pct };
      case "label_zero":
        return { text: "0", lt: false, ltKind: "below_loq", ...pct };
      case "below_loq":
      case "trace":
        return { text: String(saved.printed_pct), lt: true, ltKind: saved.kind, ...pct };
    }
  }
  const amount = { pct: false, form: null };
  switch (saved.kind) {
    case "measured":
      return { text: saved.amount === null ? "" : String(saved.amount), lt: false, ltKind: "below_loq", ...amount };
    case "label_zero":
      return { text: "0", lt: false, ltKind: "below_loq", ...amount };
    // A `trace` row cannot be typed here, but a food could carry one from
    // elsewhere. It edits as the bound it is, and keeps its own kind rather
    // than being quietly reclassified on the way back out.
    case "below_loq":
    case "trace":
      return { text: saved.upper === null ? "" : String(saved.upper), lt: true, ltKind: saved.kind, ...amount };
  }
}

/**
 * Re-read the lines from an outside change without discarding what is being
 * typed.
 *
 * Not every line is representable in the array this form emits. An armed "less
 * than" with no figure yet resolves to "none", so `build` sends nothing for it
 * and the armed state lives only here; so does text the app cannot read. A
 * plain reseed rebuilds all fifteen lines from the saved values alone and drops
 * both — and accepting a single suggestion IS an outside change, because the
 * parent owns the set and hands the whole array back. So one accept on the
 * sodium line would disarm a "less than" the user had pressed on trans fat, and
 * the 0.5 typed there afterwards would save as a measurement rather than as a
 * bound with no floor under it.
 *
 * A line is therefore only rebuilt when the value arriving for it differs from
 * the one that line already emits. Every id the change did not touch keeps its
 * text, its toggle and its caret.
 */
function reseed(
  was: Map<number, Row>,
  nutrients: CustomNutrient[],
  resolveRow: (id: number, row: Row) => Resolved,
  blank: (id: number) => Row,
): Map<number, Row> {
  const by = new Map<number, CustomNutrient>();
  for (const n of nutrients) by.set(n.nutrient_id, n);

  // Every line either side knows about: the fifteen, anything typed here, and
  // anything arriving — Vitamin A on an older panel is not on the spine.
  const ids = new Set<number>([...LABEL_NUTRIENTS.map((n) => n.id), ...was.keys(), ...by.keys()]);
  const rows = new Map<number, Row>();
  for (const id of ids) {
    const row = was.get(id) ?? blank(id);
    const r = resolveRow(id, row);
    const ours = r.state === "none" || r.state === "snag" ? null : r.value;
    const theirs = by.get(id) ?? null;
    // Field by field rather than by serialisation: a value that arrived from
    // the scan carries the same facts in a different key order.
    const same =
      ours === null
        ? theirs === null
        : theirs !== null &&
          ours.kind === theirs.kind &&
          ours.amount === theirs.amount &&
          ours.upper === theirs.upper &&
          (ours.printed_pct ?? null) === (theirs.printed_pct ?? null) &&
          (ours.label_form ?? null) === (theirs.label_form ?? null);
    rows.set(id, same ? row : theirs ? rowOf(theirs) : blank(id));
  }
  return rows;
}

function seed(nutrients: CustomNutrient[]): Map<number, Row> {
  const rows = new Map<number, Row>();
  for (const n of LABEL_NUTRIENTS) rows.set(n.id, BLANK);
  for (const n of nutrients) rows.set(n.nutrient_id, rowOf(n));
  return rows;
}

/**
 * Enough digits to check a transcription against the pack. Deliberately finer than
 * the dashboard's rounding: 30.23 g per 100 g shown as "30 g" would look like a
 * different number from the one just typed.
 */
function fig(n: number): string {
  const r = n >= 100 ? Math.round(n) : n >= 10 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
  return r.toLocaleString();
}
