import { useEffect, useRef, useState } from "react";
import type { Vessel } from "../types";

/** What a scale reading is made of: the whole reading, and what was under the food. */
export interface Weighed {
  grossG: number;
  vesselIds: string[];
}

interface Props {
  /** Net grams, as a string, controlled by the parent. */
  grams: string;
  /**
   * Called on every change. `weighed` is non-null only in scale mode, and carries the
   * provenance the parent should log; in direct mode the parent logs `grams` as today.
   */
  onChange: (grams: string, weighed: Weighed | null) => void;
  vessels: Vessel[];
  /** Opens the vessel library. */
  onManageVessels: () => void;
  onSubmit?: () => void;
  /**
   * What is going on the scale, for the mode toggle's wording.
   *
   * A plate on the way to being logged and a pot on the way off the heat use
   * the same control and the same tare arithmetic, but "Weigh the plate" is
   * simply false on a cook sheet. Defaults to the plate, which is every
   * existing caller.
   */
  vesselNoun?: string;
}

type Mode = "direct" | "scale";

/**
 * The weight of the food, arrived at either way.
 *
 * In scale mode the net is DERIVED and never editable: it is the reading minus the
 * vessels, and showing it as a figure rather than a field is what makes that legible.
 * The ids — not the weights — are what the parent logs, so the backend subtracts from
 * the library rather than from anything this screen is holding. Until a reading leaves a
 * positive net, `weighed` goes out as null and the net as an empty string: there is
 * nothing to log yet, and the parent's own weight check is the one that says so.
 */
export default function WeightField(p: Props) {
  const [mode, setMode] = useState<Mode>("direct");
  const [gross, setGross] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  /** What was typed in direct mode, so a look at scale mode and back does not lose it. */
  const [heldDirect, setHeldDirect] = useState("");

  // Selection is resolved against the live list every render, so a vessel deleted in
  // the library drops out of the tare instead of lingering as a weight with no name.
  const sel = p.vessels.filter((v) => picked.includes(v.id));
  const tare = sel.reduce((a, v) => a + v.grams, 0);
  const grossN = parse(gross);
  const net = grossN !== null && grossN > tare ? grossN - tare : null;

  // The parent's onChange is typically a fresh closure each render, so it is read
  // through a ref: as an effect dependency it would re-fire the effect it triggers.
  const emit = useRef(p.onChange);
  useEffect(() => { emit.current = p.onChange; });

  const selKey = sel.map((v) => v.id).join(",");
  useEffect(() => {
    if (mode !== "scale") return;
    emit.current(
      net === null ? "" : String(Math.round(net * 100) / 100),
      net === null || grossN === null ? null : { grossG: grossN, vesselIds: sel.map((v) => v.id) },
    );
    // `sel` and `net` follow from these four; `tare` is in the list so a vessel
    // re-weighed in the library cannot leave the parent holding the old net.
  }, [mode, gross, selKey, tare]);

  function toDirect() {
    if (mode === "direct") return;
    setMode("direct");
    // The number carries across rather than resetting: the figure the user was just
    // looking at becomes the editable one.
    const carried = net !== null ? String(Math.round(net * 100) / 100) : heldDirect;
    p.onChange(carried, null);
  }

  function toScale() {
    if (mode === "scale") return;
    setHeldDirect(p.grams);
    setMode("scale");
  }

  function toggle(id: string) {
    setPicked((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  return (
    <div className="wf">
      <div className="chips wf__modes" role="group" aria-label="How the food was weighed">
        <button className="chip" aria-pressed={mode === "direct"} onClick={toDirect}>
          Just the food
        </button>
        <button className="chip" aria-pressed={mode === "scale"} onClick={toScale}>
          Weigh the {p.vesselNoun ?? "plate"}
        </button>
      </div>

      {mode === "direct" ? (
        <div className="commit wf__direct">
          <input
            className="field grams tnum"
            type="number"
            min="1"
            value={p.grams}
            onChange={(e) => p.onChange(e.target.value, null)}
            onKeyDown={(e) => e.key === "Enter" && p.onSubmit?.()}
            aria-label="Grams"
          />
          <span className="wf__unit">grams</span>
        </div>
      ) : p.vessels.length === 0 ? (
        <div className="wf__none">
          <p className="rangenote">
            Nothing weighed yet — put a vessel on the scale empty, save what it reads, and it
            comes off every weighing from then on.
          </p>
          <button className="btn btn--quiet" onClick={p.onManageVessels}>
            Add a vessel weight
          </button>
        </div>
      ) : (
        <>
          <div className="wf__calc">
            <label className="wf__cell">
              <span className="group__name">On the scale</span>
              <input
                className="field tnum wf__gross"
                type="number"
                min="0"
                inputMode="decimal"
                placeholder="740"
                value={gross}
                onChange={(e) => setGross(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && p.onSubmit?.()}
                aria-label="What the scale reads, vessels included"
                autoFocus
              />
            </label>

            <span className="wf__op" aria-hidden="true">−</span>

            <div className="wf__cell">
              <span className="group__name">Vessels</span>
              <span className="wf__fig num">
                {tare > 0 ? g(tare) : "—"}
                {tare > 0 && <span className="wf__u"> g</span>}
              </span>
            </div>

            <span className="wf__op wf__op--eq" aria-hidden="true">=</span>

            <div className="wf__cell">
              <span className="group__name">Just the food</span>
              {/* Derived. A field here would be a second number to keep in agreement
                  with the first, which is the error the tare exists to remove. */}
              <span className={`wf__net num${net === null ? " is-blank" : ""}`} aria-live="polite">
                {net !== null ? g(net) : "—"}
                {net !== null && <span className="wf__u"> g</span>}
              </span>
            </div>
          </div>

          {grossN !== null && net === null && (
            <p className="wf__snag">
              {grossN === tare
                ? "The vessels account for the whole reading, so there is no food weight left."
                : "The vessels weigh more than the scale reading."}
            </p>
          )}

          <div className="wf__vhead">
            <span className="group__name">Under the food</span>
            <button className="link" onClick={p.onManageVessels}>Vessel weights</button>
          </div>
          {/* Multi-select, and the total is the sum. A katori sits on a thali and both
              are under the food; ticking only one of them is wrong by the other. */}
          <div className="wf__vessels">
            {p.vessels.map((v) => {
              const on = picked.includes(v.id);
              return (
                <label className={`vsel${on ? " is-on" : ""}`} key={v.id}>
                  <input
                    type="checkbox"
                    className="vsel__box"
                    checked={on}
                    onChange={() => toggle(v.id)}
                  />
                  <span className="vsel__name">{v.name}</span>
                  <span className="vsel__g num">{g(v.grams)} g</span>
                </label>
              );
            })}
          </div>
          <p className="wf__note">
            {sel.length > 0
              ? `Coming off: ${sel.map((v) => v.name).join(" + ")}`
              : "Tick everything the scale is carrying — a katori on a thali means both."}
          </p>
        </>
      )}
    </div>
  );
}

function parse(s: string): number | null {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One decimal at most: scales read to a gram, and a katori's tare to half of one. */
const g = (n: number) => (Math.round(n * 10) / 10).toLocaleString();
