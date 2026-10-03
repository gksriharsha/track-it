import { useId, useState } from "react";
import type { CSSProperties } from "react";
import type { Bottle } from "../types";
import { describeVolume } from "../types";
import { STEP_PCT, STOPS, shareMl, shareOf } from "../lib/bottleShare";

/**
 * Part of a bottle, judged by eye: a slider from an empty bottle to a full
 * one, in the water sheet.
 *
 * The user asked for it in these words: a slider "from empty bottle weight to
 * full bottle weight", so that a bottle partly drunk, or a second fill only
 * partly finished, can be logged without putting it on the scale. Where the
 * slider is left is how much of the bottle was drunk, and the bottle beside
 * the figure fills to it. A quarter, a half, three quarters and the whole
 * bottle are one tap each under the track, because those are the amounts
 * people say.
 *
 * It starts empty, and Log does nothing until it has been moved, so nothing
 * is written that the hand did not set. Only bottles weighed empty are
 * offered: without that weight what a full one holds is not known, and nor is
 * any share of it. Not drawn as the scale's readout, because no scale was read.
 */
export default function BottleShare(p: {
  /** Bottles weighed empty, the one used last first. */
  bottles: Bottle[];
  busy: boolean;
  /** Resolves true once it is written, and the slider goes back to empty. */
  onLog: (b: Bottle, share: number) => Promise<boolean>;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const b = p.bottles.find((x) => x.id === chosen) ?? p.bottles[0];
  if (!b) return null;
  const share = pct / 100;
  const ml = shareMl(b, share);
  const amount = ml === null || pct === 0 ? null : describeVolume(ml);

  async function log() {
    if (pct === 0 || p.busy) return;
    if (await p.onLog(b, share)) setPct(0);
  }

  return (
    <section className="bshare" aria-label="Part of a bottle">
      {p.bottles.length > 1 && (
        <div className="chips" role="group" aria-label="Which bottle">
          {p.bottles.map((x) => (
            <button key={x.id} className="chip" aria-pressed={x.id === b.id} onClick={() => setChosen(x.id)}>
              {x.name}
            </button>
          ))}
        </div>
      )}

      <div className="bshare__read">
        <BottleDrawing share={share} />
        <div className="bshare__words">
          <span className="bshare__ml tnum">{amount ?? "—"}</span>
          <span className="bshare__what">
            {pct === 0 ? `How much of ${b.name} did you drink?` : shareOf(share, b.name)}
          </span>
        </div>
      </div>

      <div className="bshare__range" style={{ "--f": share } as CSSProperties}>
        <input
          type="range"
          className="bshare__input"
          min={0}
          max={100}
          step={STEP_PCT}
          value={pct}
          aria-label={`How much of ${b.name} you drank`}
          aria-valuetext={amount === null ? "None yet" : `${shareOf(share, b.name)}, ${amount}`}
          onChange={(e) => setPct(Number(e.target.value))}
        />
        <div className="bshare__stops">
          {STOPS.map((s) => (
            <button
              key={s.pct}
              className="bshare__stop tnum"
              style={{ "--at": s.pct / 100 } as CSSProperties}
              aria-pressed={pct === s.pct}
              aria-label={shareOf(s.pct / 100, b.name)}
              onClick={() => setPct(s.pct)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <button className="btn bshare__log" disabled={pct === 0 || p.busy} aria-busy={p.busy} onClick={log}>
        {amount === null ? "Log" : `Log ${amount}`}
      </button>
    </section>
  );
}

/** The glass, from the neck down; the water is clipped to it. */
const BODY =
  "M13.5 6.5h9v3.2c0 1.8 6.5 3.4 6.5 8.8v33.8a5.2 5.2 0 0 1-5.2 5.2H12.2A5.2 5.2 0 0 1 7 52.3V18.5c0-5.4 6.5-7 6.5-8.8z";

/** A bottle holding the share set: what the figure beside it says, drawn. */
function BottleDrawing({ share }: { share: number }) {
  // An id fit for `url(#…)`: React's own carries characters a reference can trip on.
  const clip = `bottle${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // From the base (57.5) up to where the neck starts (9.7) for a whole bottle.
  const top = 57.5 - 47.8 * share;
  return (
    <svg className="bshare__bottle" width="36" height="60" viewBox="0 0 36 60" aria-hidden>
      <defs>
        <clipPath id={clip}>
          <path d={BODY} />
        </clipPath>
      </defs>
      {share > 0 && (
        <rect className="bshare__water" clipPath={`url(#${clip})`} x="0" y={top} width="36" height={60 - top} />
      )}
      <path className="bshare__glass" d={BODY} />
      <rect className="bshare__cap" x="12.5" y="1.5" width="11" height="5" rx="1.5" />
    </svg>
  );
}
