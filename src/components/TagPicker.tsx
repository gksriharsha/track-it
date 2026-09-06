import { useEffect, useState } from "react";
import { listCuisines } from "../api";
import type { Origin } from "../types";
import { CUISINE_SUGGESTIONS, ORIGINS } from "../types";

interface Props {
  origin: Origin | null;
  cuisine: string | null;
  onChange: (origin: Origin | null, cuisine: string | null) => void;
  /**
   * Where a pre-filled value came from, when it was not typed here — "from the
   * last time you logged this". Shown so a recalled answer reads as something
   * to confirm rather than something written on the user's behalf.
   */
  recalledNote?: string | null;
}

/**
 * Where a dish came from, and what the user calls it.
 *
 * Two dimensions, neither ever inferred. Origin is a closed set — who cooked it
 * and where has few stable answers. Cuisine is free text, because a fixed list
 * forces a wrong answer on the dishes eaten most: gobi manchurian is neither
 * "Indian" nor "Chinese", pav bhaji is not either of them, and one "Indian" bar
 * covering four fifths of every period is a constant rather than a chart.
 *
 * Both controls can be left blank, and blank is a real answer meaning "not
 * recorded" — distinct from every value they could hold, the same way
 * `NutrientValue::Absent` is distinct from a zero. Nothing here fills one in.
 */
export default function TagPicker(p: Props) {
  const [mine, setMine] = useState<string[]>([]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    listCuisines().then(setMine).catch(() => setMine([]));
  }, []);

  // The user's own vocabulary, once they have one. The starter suggestions are
  // only ever a cold-start affordance and are never written anywhere until
  // picked, so they cannot show up in the chart as a cuisine never eaten.
  const suggestions = mine.length >= 6 ? mine.slice(0, 8) : [...mine, ...CUISINE_SUGGESTIONS.filter((c) => !mine.some((m) => m.toLowerCase() === c.toLowerCase()))].slice(0, 8);

  const pickCuisine = (c: string | null) => {
    setTyping(false);
    p.onChange(p.origin, c);
  };

  return (
    <div className="tags">
      <div className="group__name">Where it came from</div>
      <div className="chips">
        {ORIGINS.map((o) => (
          <button
            key={o.id}
            className="chip"
            aria-pressed={p.origin === o.id}
            // Tapping the selected one clears it: "not recorded" has to stay
            // reachable, or a mis-tap becomes permanent.
            onClick={() => p.onChange(p.origin === o.id ? null : o.id, p.cuisine)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="group__name" style={{ marginTop: "var(--s3)" }}>
        Cuisine
      </div>
      <div className="chips">
        {suggestions.map((c) => (
          <button
            key={c}
            className="chip"
            aria-pressed={p.cuisine?.toLowerCase() === c.toLowerCase()}
            onClick={() => pickCuisine(p.cuisine?.toLowerCase() === c.toLowerCase() ? null : c)}
          >
            {c}
          </button>
        ))}
        {/* A cuisine already chosen that is not in the list still has to show as
            chosen, or editing an old entry would look like it had no answer. */}
        {p.cuisine && !suggestions.some((c) => c.toLowerCase() === p.cuisine!.toLowerCase()) && (
          <button className="chip" aria-pressed onClick={() => pickCuisine(null)}>
            {p.cuisine}
          </button>
        )}
        {typing ? (
          <input
            className="field tags__type"
            autoFocus
            value={draft}
            placeholder="Type a cuisine"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const v = draft.trim();
              setDraft("");
              setTyping(false);
              // An empty box is someone changing their mind, not an answer.
              // Committing `p.cuisine` back here would re-fire onChange with a
              // value nothing had changed, and clicking a suggestion chip
              // (which blurs this input first) would apply the typed text over
              // the chip they actually pressed.
              if (v !== "") pickCuisine(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setDraft("");
                setTyping(false);
              }
            }}
          />
        ) : (
          <button className="chip chip--ghost" onClick={() => setTyping(true)}>
            + Other
          </button>
        )}
      </div>

      {p.recalledNote && <p className="tags__note">{p.recalledNote}</p>}
    </div>
  );
}
