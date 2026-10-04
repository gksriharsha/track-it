import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { FoodForm, Meal, Origin, Per100g, ServingUnit, Vessel } from "../types";
import { ORIGIN_LABEL } from "../types";
import { DOTS, KEYS, atGrams, digitsOf, pasted, press, ticking, weighing } from "../lib/amount";
import type { Key, Readout } from "../lib/amount";
import { formLabel } from "../lib/foodForms";
import { rowFigure } from "../lib/energy";
import { stateOf } from "../lib/nutrient";
import { useKeepAwake } from "../lib/awake";
import { nounFor, pluralNoun } from "../lib/pieces";
import TagPicker from "./TagPicker";
import Glyph from "./Glyph";

/**
 * A serving to start from: what its chip says ("1 cup · 185 g"), and how much
 * it is in the food's own unit — what it weighs, or for a can what it holds.
 */
export interface Serving {
  label: string;
  amount: number;
}

interface Props {
  /** The tile the food's rows lead with, its name and the line under it. */
  lead: ReactNode;
  name: string;
  sub: ReactNode;
  /**
   * Draw the name over the window. A sheet carries it in its own title bar
   * (`AmountTitle`) instead, beside the sheet's own close.
   */
  head: boolean;
  /** Put the food down: only where the panel stands beside the list. */
  onClose?: () => void;
  /**
   * The window and the vessels under the food, held by the screen rather than
   * here: a trip to the vessel library unmounts a sheet, and a reading typed
   * before it must still be there after. The screen logs what they come to
   * (`weighing`), the reading and the vessels' ids when any came off, so the
   * backend does the subtraction from its own library.
   */
  readout: Readout;
  setReadout: Dispatch<SetStateAction<Readout>>;
  ticked: string[];
  setTicked: Dispatch<SetStateAction<string[]>>;
  servings: Serving[];
  /**
   * What the window reads in. Grams, off a scale, for nearly everything;
   * millilitres for one of the user's own foods whose pack is per ml — a can,
   * a carton — which is measured and never weighed, so it has no bowl to take
   * off either.
   */
  unit?: ServingUnit;
  /**
   * A pack that counts its serving — "2 figs (57 g)": what one piece is
   * called, and how much of `unit` one is, the pack's own share of its
   * serving. With it the window can count pieces rather than weigh.
   */
  piece?: { noun: string; each: number };
  /** The window is counting pieces now, not reading `unit`. */
  counting?: boolean;
  /** Count pieces, or go back to the food's own unit. */
  onCounting?: (counting: boolean) => void;
  /**
   * The food's forms, where it comes in several — raw, boiled — and the one
   * the window is for. Search shows such a food as one row, so this is the
   * one place the form is chosen, once, beside the grams; changing it keeps
   * what the window reads (see `readoutOnSwitch`).
   */
  forms?: FoodForm[];
  form?: number;
  onForm?: (fdcId: number) => void;
  /**
   * The food per 100 of `unit`, for the line under the window; undefined
   * while it is read.
   */
  per100: Per100g | null | undefined;
  vessels: Vessel[];
  onManageVessels: () => void;
  meal: Meal;
  saving: boolean;
  onCommit: () => void;
  origin: Origin | null;
  cuisine: string | null;
  onTags: (origin: Origin | null, cuisine: string | null) => void;
  /** Said when the tags were recalled rather than chosen here. */
  recalledNote: string | null;
  /** What only this kind of food has: a pot's links, a pack's values. */
  foot?: ReactNode;
  /** The keys, where there is no keyboard. */
  keypad: boolean;
  /** Take the keyboard on arrival, where there is one. */
  autoFocus: boolean;
}

/**
 * How much: the amount in a scale's display window, as the user picked it
 * ("Scale readout"), with the bowl's weight taken off and the keys under it.
 *
 * Whatever is typed is what the scale reads (see `lib/amount.ts`). The window
 * shows the food's own weight, which is what is logged: the reading itself
 * with nothing under the food, and the reading less the bowl with one ticked.
 * The line under the window says which, and what the portion comes to.
 *
 * The look is spent here and nowhere else. It is the one screen where a
 * person is copying a number off an instrument on the counter, and an
 * instrument's window everywhere would be a gimmick.
 */
export default function Amount(p: Props) {
  const { readout: r, setReadout: setR, setTicked } = p;
  const unit = p.unit ?? "g";
  const measured = unit === "ml";
  /* Pieces off a pack that counts its serving are counted, never weighed:
     nothing is under them, and the window says how many. */
  const counting = !!p.piece && !!p.counting;
  const [showVessels, setShowVessels] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const formsRef = useRef<HTMLDivElement>(null);

  const w = weighing(r, p.ticked, p.vessels);
  const sel = p.vessels.filter((v) => w.vesselIds.includes(v.id));
  const { reading, net, tareG: tare } = w;

  // Weighing with vessels is the read-tick-re-read loop, the phone on the
  // counter and the hands full: the screen stays on for it, as it did for the
  // weight field's scale mode. Android only in effect; see lib/awake.ts.
  useKeepAwake(sel.length > 0);

  useEffect(() => {
    if (p.autoFocus) inputRef.current?.focus({ preventScroll: true });
    // On arrival only: a later focus would pull the keyboard from wherever it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* On a phone the forms are one line that scrolls sideways, and the panel
     may open on any of them — the one logged last, the one an Indian name
     means. The chosen chip is brought into that line's view, on arrival and
     on every change, so the form about to be logged is always one the person
     can see. Only the line scrolls: the sheet stays where it is. */
  const formCount = p.forms?.length ?? 0;
  useEffect(() => {
    const row = formsRef.current;
    const chip = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
    const pad = parseFloat(getComputedStyle(row).paddingLeft) || 0;
    const r = row.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    // Its start wins over its end: a chip wider than the line still shows
    // where its words begin.
    if (c.right > r.right - pad) row.scrollLeft += Math.min(c.right - r.right + pad, c.left - r.left - pad);
    else if (c.left < r.left + pad) row.scrollLeft += c.left - r.left - pad;
  }, [p.form, formCount]);

  const key = (k: Key) => setR((x) => press(x, k));

  function tick(id: string) {
    setTicked((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
    setR(ticking);
  }

  function serve(s: Serving) {
    // A serving is an amount of food on its own; nothing is under it.
    setTicked([]);
    setR({ digits: digitsOf(s.amount), from: "serving" });
  }

  /* A real keyboard, on a desktop: the same keys, by the same rules. Native
     editing never runs, so the window cannot hold what the keypad could not
     have typed. */
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key === "," ? "." : e.key === "Backspace" || e.key === "Delete" ? "del" : e.key;
    if ((KEYS as readonly string[]).includes(k)) {
      e.preventDefault();
      key(k as Key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (net !== null && !p.saving) p.onCommit();
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const d = pasted(e.clipboardData.getData("text"));
    if (d !== null) setR({ digits: d, from: "typed" });
  }

  const tared = sel.length > 0;
  const shown = tared ? (net === null ? "" : digitsOf(net)) : r.digits;
  const faint = shown === "" || (!tared && r.from === "guess");
  const off = listed(sel.map((v) => v.name));
  const tareLine = !tared
    ? "Take off the bowl's weight"
    : reading === null
      ? `Type what the scale reads, less ${off} (${g(tare)} g)`
      : net === null
        ? `${g(reading)} g on the scale is no more than ${off} (${g(tare)} g)`
        : `${g(reading)} g on the scale, less ${off} (${g(tare)} g)`;

  // A count is valued as that many of the pack's shares of its serving, in
  // the unit the food's figures per 100 are in.
  const amountOf = net === null ? null : counting && p.piece ? net * p.piece.each : net;
  const energy = amountOf !== null && p.per100 ? atGrams(p.per100.energy, amountOf) : null;
  const protein = amountOf !== null && p.per100 ? atGrams(p.per100.protein, amountOf) : null;

  const origin = p.origin ? ORIGIN_LABEL[p.origin] : null;
  const tagLine = [origin, p.cuisine].filter(Boolean).join(", ");

  return (
    <div className="amount">
      {p.head && (
        <header className="amount__bar">
          <AmountTitle lead={p.lead} name={p.name} sub={p.sub} />
          {p.onClose && (
            <button type="button" className="sheet__close" aria-label="Close" onClick={p.onClose}>×</button>
          )}
        </header>
      )}

      {/* Which form, under the title the forms share: the food is named
          once, and what tells its rows apart is chosen here. */}
      {p.forms && p.forms.length >= 2 && (
        <div className="chips amount__forms" role="group" aria-label="Form" ref={formsRef}>
          {p.forms.map((f) => (
            <button type="button" key={f.fdc_id} className="chip" aria-pressed={f.fdc_id === p.form}
              onClick={() => p.onForm?.(f.fdc_id)}>
              {formLabel(f)}
            </button>
          ))}
        </div>
      )}

      <div className={`readout${focused ? " is-focused" : ""}`}>
        <div className="readout__win">
          <Dots text={shown === "" ? "0" : shown} faint={faint} />
          {focused && <span className="readout__caret" aria-hidden />}
          <span className="readout__u" aria-hidden>
            {counting && p.piece ? nounFor(Number(shown) || 0, p.piece.noun) : unit}
          </span>
          {/* The keyboard's way in, laid over the window. Its own value is
              only ever what the keys made, for a screen reader to read out;
              where the keypad is drawn it asks the phone for no keyboard. */}
          <input
            ref={inputRef}
            className="readout__input"
            value={r.digits}
            onChange={() => undefined}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            inputMode={p.keypad ? "none" : "decimal"}
            enterKeyHint="done"
            autoComplete="off"
            aria-label={tared ? "What the scale reads, bowl and all, in grams"
              : counting && p.piece ? `How many ${pluralNoun(p.piece.noun)}`
              : measured ? "Millilitres" : "Grams of food"}
          />
        </div>
        {/* Counted or weighed, for a pack that counts its serving: what the
            pack says a serving is, or what the scale says. */}
        {p.piece && (
          <div className="chips readout__units" role="group" aria-label="Count or weigh">
            <button type="button" className="chip" aria-pressed={counting}
              onClick={() => p.onCounting?.(true)}>
              {pluralNoun(p.piece.noun)}
            </button>
            <button type="button" className="chip" aria-pressed={!counting}
              onClick={() => p.onCounting?.(false)}>
              {unit}
            </button>
          </div>
        )}
        {/* A volume is poured or drunk from the can, and pieces are counted:
            neither is weighed, so there is no bowl under them to take off. */}
        {!measured && !counting && (
          <button type="button" className="readout__tare" aria-expanded={showVessels || tared}
            onClick={() => setShowVessels((s) => !s)}>
            <Glyph name="bowl" size={18} />
            <span>{tareLine}</span>
          </button>
        )}
        {tared && (
          <span className="vh" aria-live="polite">
            {net === null ? "" : `${digitsOf(net)} grams of food`}
          </span>
        )}
      </div>

      {!measured && !counting && (showVessels || tared) && (
        p.vessels.length === 0 ? (
          <p className="amount__note">
            No bowls weighed yet.{" "}
            <button type="button" className="link" onClick={p.onManageVessels}>Weigh one empty</button>
          </p>
        ) : (
          <div className="chips amount__vessels" role="group" aria-label="Under the food">
            {p.vessels.map((v) => (
              <button type="button" key={v.id} className="chip" aria-pressed={p.ticked.includes(v.id)}
                onClick={() => tick(v.id)}>
                {v.name} <span className="tnum">{g(v.grams)} g</span>
              </button>
            ))}
            <button type="button" className="link" onClick={p.onManageVessels}>Vessel weights</button>
          </div>
        )
      )}

      {/* What the portion comes to, by the rule every row of a day reads by:
          "≥" where some of it has no figure, "—" where none of it has. */}
      <p className="amount__result" aria-live="polite">
        {energy && (
          <>
            <b className="tnum">{rowFigure(energy)} kcal</b>
            {protein && stateOf(protein) !== "unknown" && (
              <span className="tnum">{rowFigure(protein)} g protein</span>
            )}
          </>
        )}
      </p>

      {/* Not while weighing with a bowl: a serving is the food on its own,
          and picking one puts the bowl back down. */}
      {p.servings.length > 0 && !tared && (
        <div className="amount__servings" role="group" aria-label="Servings">
          {p.servings.map((s, i) => (
            <button type="button" key={`${i}-${s.label}`} className="chip"
              aria-pressed={reading !== null && reading === Math.round(s.amount * 10) / 10}
              onClick={() => serve(s)}>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {p.keypad && (
        <div className="keypad">
          {KEYS.map((k) => (
            <button type="button" key={k} className="keypad__key" onClick={() => key(k)}
              aria-label={k === "del" ? "Delete" : k === "." ? "Decimal point" : undefined}>
              {k === "del" ? <Glyph name="del" size={24} /> : k}
            </button>
          ))}
        </div>
      )}

      {/* Where it came from and its cuisine: usually recalled from the last
          time, so one line saying so, opened only to change it. */}
      <div className="amount__tags">
        <button type="button" className="amount__tagline" aria-expanded={showTags}
          onClick={() => setShowTags((s) => !s)}>
          <span className={tagLine ? undefined : "is-blank"}>
            {tagLine || "Where it came from, and its cuisine"}
          </span>
          {p.recalledNote && tagLine && !showTags && <span className="amount__as">as last time</span>}
          <span className="amount__chev" aria-hidden><Chev open={showTags} /></span>
        </button>
        {showTags && (
          <TagPicker origin={p.origin} cuisine={p.cuisine} onChange={p.onTags} recalledNote={p.recalledNote} />
        )}
      </div>

      <button type="button" className="btn amount__log" onClick={p.onCommit}
        disabled={p.saving || net === null}>
        {p.saving ? "Adding…" : `Add to ${p.meal}`}
      </button>

      {p.foot && <div className="amount__foot">{p.foot}</div>}
    </div>
  );
}

/** The food the amount is for: its tile, its name, and a line under it. */
export function AmountTitle(p: { lead: ReactNode; name: string; sub: ReactNode }) {
  return (
    <span className="amount__head">
      {p.lead}
      <span className="amount__title">
        <span className="amount__name">{p.name}</span>
        {p.sub && <span className="amount__sub">{p.sub}</span>}
      </span>
    </span>
  );
}

/**
 * A supplement, counted rather than weighed: no window and no bowl, since a
 * tablet does not go on a scale. Whole units a tap at a time, and a half
 * below one, for a tablet split in two.
 */
export function Dose(p: {
  units: string;
  onUnits: (units: string) => void;
  noun: string;
  /** How many units the panel is written per. */
  perUnits: number;
  meal: Meal;
  saving: boolean;
  onCommit: () => void;
  head?: ReactNode;
}) {
  const n = Number(p.units);
  const count = Number.isFinite(n) && n > 0 ? n : 1;
  const unit = `${p.noun}${count === 1 ? "" : "s"}`;
  return (
    <div className="amount">
      {p.head}
      <div className="dosepick">
        <button type="button" className="dosepick__step" aria-label={`One ${p.noun} fewer`}
          disabled={count <= 0.5} onClick={() => p.onUnits(String(count > 1 ? count - 1 : 0.5))}>−</button>
        <span className="dosepick__n" aria-live="polite">
          <span className="tnum">{count === 0.5 ? "½" : String(count)}</span>
          <span className="dosepick__u">{unit}</span>
        </span>
        <button type="button" className="dosepick__step" aria-label={`One ${p.noun} more`}
          onClick={() => p.onUnits(String(count < 1 ? 1 : count + 1))}>+</button>
      </div>
      {p.perUnits !== 1 && (
        <p className="amount__note amount__note--c">Its panel is written per {p.perUnits} {p.noun}s.</p>
      )}
      <button type="button" className="btn amount__log" onClick={p.onCommit} disabled={p.saving}>
        {p.saving ? "Adding…" : `Add to ${p.meal}`}
      </button>
    </div>
  );
}

/**
 * Figures as a scale's display draws them: a 5×7 matrix of dots for each,
 * the unlit ones faintly there, as on the instrument. One dark column between
 * characters; the point takes one column of its own.
 */
export function Dots({ text, faint }: { text: string; faint: boolean }) {
  const PITCH = 10;
  const R = 3.9;
  const on: [number, number][] = [];
  const unlit: [number, number][] = [];
  let x = 0;
  for (const ch of text) {
    const rows = DOTS[ch] ?? DOTS["0"];
    const w = rows[0].length;
    rows.forEach((row, y) => {
      for (let c = 0; c < w; c++) (row[c] === "#" ? on : unlit).push([x + c, y]);
    });
    x += w + 1;
  }
  const cols = Math.max(1, x - 1);
  const at = (n: number) => n * PITCH + PITCH / 2;
  return (
    <svg className={`dots${faint ? " is-faint" : ""}`} viewBox={`0 0 ${cols * PITCH} ${7 * PITCH}`}
      width={cols * PITCH} height={7 * PITCH} aria-hidden>
      {unlit.map(([c, y]) => <circle key={`u${c}.${y}`} className="dots__off" cx={at(c)} cy={at(y)} r={R} />)}
      {on.map(([c, y]) => <circle key={`o${c}.${y}`} className="dots__on" cx={at(c)} cy={at(y)} r={R} />)}
    </svg>
  );
}

function Chev({ open }: { open: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden
      style={{ transform: open ? "rotate(-90deg)" : "rotate(90deg)" }}>
      <path d="M10 7l5 5-5 5" />
    </svg>
  );
}

/** "Steel katori", "Steel katori and Dinner thali": the vessels as a sentence names them. */
function listed(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One decimal at most: scales read to a gram, and a katori's tare to half of one. */
const g = (n: number) => (Math.round(n * 10) / 10).toLocaleString();
