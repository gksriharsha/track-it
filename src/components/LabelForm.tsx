import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { CustomNutrient } from "../types";
import { LABEL_NUTRIENTS } from "../types";
import { plural } from "../lib/nutrient";

interface Props {
  /** The serving weight as typed upstairs — the basis every figure here is per. */
  servingG: string;
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

const STRIP_TEXT: CSSProperties = {
  flex: "1 1 220px",
  minWidth: 0,
  color: "var(--ink-2)",
  fontSize: "13px",
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

/** Kept to the 44px minimum: these sit between rows, under a thumb. */
const ACT: CSSProperties = {
  padding: "var(--s2) var(--s4)",
  minHeight: "44px",
  whiteSpace: "nowrap",
};

/**
 * What is typed on one line. The figure is held as TEXT, not as a number: "0." and
 * a cleared box are both things a person types on the way to a value, and rounding
 * them into the saved food mid-keystroke would change what they meant.
 */
type Row = { text: string; lt: boolean; ltKind: "below_loq" | "trace" };

const BLANK: Row = { text: "", lt: false, ltKind: "below_loq" };

/** The ids this form has a line for. */
const SPINE = new Set(LABEL_NUTRIENTS.map((n) => n.id));

type Resolved =
  | { state: "none"; lt: boolean }
  | { state: "printed"; value: CustomNutrient; amount: number }
  | { state: "zero"; value: CustomNutrient; ceiling: number }
  | { state: "under"; value: CustomNutrient; upper: number }
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
    setRows((was) => reseed(was, p.nutrients));
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

  const serving = Number(p.servingG);
  const per100 = Number.isFinite(serving) && serving > 0 ? 100 / serving : null;

  // Anything the food carries that a panel does not print. Nothing in this app
  // writes one today, but a line this form cannot show is not a line it may
  // silently drop on the next keystroke.
  const kept = p.nutrients.filter((n) => !SPINE.has(n.nutrient_id));

  /** Send a whole set of lines up, and remember what we sent. */
  function commit(next: Map<number, Row>) {
    setRows(next);
    const built = [...build(next), ...kept];
    mine.current = JSON.stringify(built);
    p.onChange(built);
  }

  function edit(id: number, patch: Partial<Row>) {
    const next = new Map(rows);
    next.set(id, { ...(rows.get(id) ?? BLANK), ...patch });
    commit(next);
  }

  const resolved = LABEL_NUTRIENTS.map((n) => ({ n, r: resolve(n.id, rows.get(n.id) ?? BLANK) }));
  const printed = resolved.filter((x) => x.r.state !== "none" && x.r.state !== "snag").length;
  const snags = resolved.filter((x) => x.r.state === "snag").length;

  // Readings still awaiting an answer, in the panel's own order.
  const live = new Map<number, CustomNutrient>();
  for (const s of p.suggestions ?? []) {
    // A reading with no figure in it cannot be confirmed, so it is not offered.
    if (!SPINE.has(s.nutrient_id) || handled.has(s.nutrient_id) || !usable(s)) continue;
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
          {printed} of {LABEL_NUTRIENTS.length}
        </span>
      </div>

      <p className="lform__basis">
        {per100 !== null ? (
          <>
            Every figure below is per serving — per {fig(serving)} g. They are converted to
            this app's per-100 g basis when the food is saved.
          </>
        ) : (
          <>
            These figures are per serving, so set the serving weight above first. Without it
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
          <p style={{ ...STRIP_TEXT, margin: 0, flexBasis: "260px" }}>
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
          const row = rows.get(n.id) ?? BLANK;
          const o = offers.get(n.id);
          return (
            <div className={`lrow${r.state === "none" ? " is-blank" : ""}`} key={n.id}>
              <span className="lrow__name">
                {n.name}
                <span className="lrow__unit">{n.unit}</span>
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
                aria-label={`${n.name} on the pack, in ${n.unit} per serving`}
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

              <span className={`lrow__says${r.state === "snag" ? " is-snag" : ""}`}>
                {says(r, n.unit, per100, p.baseName ?? null)}
              </span>

              {o && (
                <div style={STRIP} role="group" aria-label={`Read from the photo for ${n.name}`}>
                  <span style={STRIP_TEXT}>
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
  base: string | null,
): string {
  switch (r.state) {
    case "none":
      if (r.lt) return "type the figure the pack prints after “less than”";
      return base ? `not printed — from ${base}` : "not printed — unmeasured";
    case "printed":
      return per100 !== null
        ? `${fig(r.amount * per100)} ${unit} per 100 g`
        : `${fig(r.amount)} ${unit} per serving`;
    case "zero":
      return `a printed 0 means under ${fig(r.ceiling)} ${unit} — kept as that bound, not as none`;
    case "under":
      return `no more than ${fig(r.upper)} ${unit} per serving, and no floor under it`;
    case "snag":
      return r.why;
  }
}

/** One line's typed text, read as what the pack says. */
function resolve(id: number, row: Row): Resolved {
  const t = row.text.trim();
  if (t === "") return { state: "none", lt: row.lt };

  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) {
    return { state: "snag", why: "not a figure a pack can print" };
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
    const ceiling = CEILING[id];
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

function build(rows: Map<number, Row>): CustomNutrient[] {
  const out: CustomNutrient[] = [];
  for (const n of LABEL_NUTRIENTS) {
    const r = resolve(n.id, rows.get(n.id) ?? BLANK);
    if (r.state === "none" || r.state === "snag") continue;
    out.push(r.value);
  }
  return out;
}

/**
 * One stored or read value as a typed line. A `label_zero` becomes the "0" a person
 * would have typed, and `resolve` derives its bound again from the nutrient — so a
 * reading that arrives with no bound on it still saves as the right one.
 */
function rowOf(saved: CustomNutrient): Row {
  switch (saved.kind) {
    case "measured":
      return { text: saved.amount === null ? "" : String(saved.amount), lt: false, ltKind: "below_loq" };
    case "label_zero":
      return { text: "0", lt: false, ltKind: "below_loq" };
    // A `trace` row cannot be typed here, but a food could carry one from
    // elsewhere. It edits as the bound it is, and keeps its own kind rather
    // than being quietly reclassified on the way back out.
    case "below_loq":
    case "trace":
      return { text: saved.upper === null ? "" : String(saved.upper), lt: true, ltKind: saved.kind };
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
function reseed(was: Map<number, Row>, nutrients: CustomNutrient[]): Map<number, Row> {
  const by = new Map<number, CustomNutrient>();
  for (const n of nutrients) by.set(n.nutrient_id, n);

  const rows = new Map<number, Row>();
  for (const n of LABEL_NUTRIENTS) {
    const row = was.get(n.id) ?? BLANK;
    const r = resolve(n.id, row);
    const ours = r.state === "none" || r.state === "snag" ? null : r.value;
    const theirs = by.get(n.id) ?? null;
    // Field by field rather than by serialisation: a value that arrived from
    // the scan carries the same facts in a different key order.
    const same =
      ours === null
        ? theirs === null
        : theirs !== null &&
          ours.kind === theirs.kind &&
          ours.amount === theirs.amount &&
          ours.upper === theirs.upper;
    rows.set(n.id, same ? row : theirs ? rowOf(theirs) : BLANK);
  }
  return rows;
}

function seed(nutrients: CustomNutrient[]): Map<number, Row> {
  const by = new Map<number, CustomNutrient>();
  for (const n of nutrients) by.set(n.nutrient_id, n);

  const rows = new Map<number, Row>();
  for (const n of LABEL_NUTRIENTS) {
    const saved = by.get(n.id);
    rows.set(n.id, saved ? rowOf(saved) : BLANK);
  }
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
