import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The control for adjusting one ingredient away from what the recipe says.
 *
 * A recipe line is an ideal; this is how far today's pot sits from it. The
 * centre is always "as written", and the drift either side is what the user
 * actually did.
 *
 * **The notch is relative, not absolute.** One recipe runs from 250 g of beans
 * to 1 g of hing, and a single 0–500 g scale cannot serve both: it would give
 * the hing no usable travel at all. So a notch is 2% of *that line's* planned
 * amount, floored at half a gram — the finest a kitchen scale shows — which
 * makes it 5 g on the beans and 0.5 g on the hing, and makes the control feel
 * the same on every row.
 *
 * Where the floor binds, the dial is honest about what it cannot do: on 1 g of
 * hing one notch is half the ingredient, and no interface can give resolution
 * the scale does not have.
 *
 * **Drift is never red.** The app keeps its warning colour for a limit actually
 * exceeded. More onion than written is information, not an error.
 */
interface Props {
  /** What the recipe calls for at this batch's scale. The centre. */
  plannedG: number;
  /** What is going in. */
  valueG: number;
  onChange: (grams: number) => void;
  /** For the accessible name — "Beans, kidney", not "ingredient 3". */
  label: string;
  /** Greyed and inert while the line is marked left out. */
  disabled?: boolean;
}

/**
 * How much one notch moves this line.
 *
 * Exported because the cook sheet's keyboard shortcuts and its "what moved"
 * summary have to agree with the dial about what a step is.
 */
export function notchFor(plannedG: number): number {
  return Math.max(0.5, roundHalf(plannedG * 0.02));
}

/** Kitchen-scale resolution: nothing here is finer than half a gram. */
function roundHalf(g: number): number {
  return Math.round(g * 2) / 2;
}

/** Ten notches fill each side, so the travel matches the step on every line. */
const NOTCHES_PER_SIDE = 10;

export default function IngredientDial(p: Props) {
  const notch = notchFor(p.plannedG);
  const span = notch * NOTCHES_PER_SIDE;
  const [dragging, setDragging] = useState(false);
  const track = useRef<HTMLDivElement>(null);

  const drift = p.valueG - p.plannedG;
  /**
   * Where the marker sits, as -1..1. Saturates rather than running off the
   * end: past ten notches the number keeps going and the bar simply reads
   * "well over", which is truer than a bar that silently rescales itself.
   */
  const t = span > 0 ? Math.max(-1, Math.min(1, drift / span)) : 0;

  const step = useCallback(
    (notches: number) => {
      if (p.disabled) return;
      // Off the notch grid — after a drag, or a typed figure — the first press
      // lands on the grid rather than moving a fractional step from nowhere.
      const from = Math.round(drift / notch) * notch;
      p.onChange(Math.max(0, roundHalf(p.plannedG + from + notches * notch)));
    },
    [drift, notch, p],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    const big = e.shiftKey ? 5 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); step(-big); }
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); step(big); }
    else if (e.key === "0" || e.key === "Home") { e.preventDefault(); p.onChange(p.plannedG); }
  }

  /** Pointer position on the track, mapped back to grams. */
  const fromPointer = useCallback(
    (clientX: number) => {
      const el = track.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      const frac = Math.max(-1, Math.min(1, ((clientX - r.left) / r.width) * 2 - 1));
      p.onChange(Math.max(0, roundHalf(p.plannedG + frac * span)));
    },
    [p, span],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => fromPointer(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging, fromPointer]);

  const atCentre = Math.abs(drift) < 0.05;

  return (
    <div className="dial">
      <button
        className="dial__step"
        onClick={() => step(-1)}
        disabled={p.disabled}
        aria-label={`${p.label}: one notch less, ${fmtG(notch)} g`}
        tabIndex={-1}
      >
        −
      </button>

      {/* The bar is the slider. A native range input cannot express a centre
          that means "as written" or a step that differs per row, and it reads
          to a screen reader as a position rather than as a drift. */}
      <div
        ref={track}
        className={`dial__track${p.disabled ? " dial__track--off" : ""}`}
        role="slider"
        tabIndex={p.disabled ? -1 : 0}
        aria-label={`${p.label}, against ${fmtG(p.plannedG)} g as written`}
        aria-valuenow={Math.round(p.valueG * 10) / 10}
        aria-valuetext={driftText(drift, p.plannedG)}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          if (p.disabled) return;
          (e.target as Element).setPointerCapture?.(e.pointerId);
          setDragging(true);
          fromPointer(e.clientX);
        }}
      >
        {/* The heavy mark at the centre is what the recipe says. */}
        <span className="dial__centre" />
        {!atCentre && (
          <span
            className="dial__fill"
            style={{
              left: t < 0 ? `${50 + t * 50}%` : "50%",
              width: `${Math.abs(t) * 50}%`,
            }}
          />
        )}
        <span className="dial__knob" style={{ left: `${50 + t * 50}%` }} />
      </div>

      <button
        className="dial__step"
        onClick={() => step(1)}
        disabled={p.disabled}
        aria-label={`${p.label}: one notch more, ${fmtG(notch)} g`}
        tabIndex={-1}
      >
        +
      </button>

      <button
        className="dial__reset"
        onClick={() => p.onChange(p.plannedG)}
        disabled={p.disabled || atCentre}
        title="Back to what the recipe says"
      >
        {atCentre ? "as written" : driftText(drift, p.plannedG)}
      </button>
    </div>
  );
}

/**
 * The drift in words. Grams first, because grams are what went in the pot;
 * the percentage is context for how big a change that was on this line.
 *
 * A line dialled to nothing says so rather than reading "−250 g", which
 * describes the movement and not the result.
 */
function driftText(drift: number, plannedG: number): string {
  if (Math.abs(drift) < 0.05) return "as written";
  if (plannedG > 0 && Math.abs(drift + plannedG) < 0.05) return "left out";
  const sign = drift > 0 ? "+" : "−";
  const g = `${sign}${fmtG(Math.abs(drift))} g`;
  if (plannedG <= 0) return g;
  return `${g} · ${sign}${Math.round((Math.abs(drift) / plannedG) * 100)}%`;
}

/** Half-gram resolution, and no trailing ".0" on a whole number. */
function fmtG(g: number): string {
  const r = roundHalf(g);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
