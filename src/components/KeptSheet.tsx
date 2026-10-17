import { useState } from "react";
import { finishKitchenFood, moveKitchenFood } from "../api";
import { nameOf, placeOf, refOf, usedLine } from "../lib/kitchen";
import type { KitchenFood, Place } from "../types";
import Sheet from "./Sheet";

const PLACES: [Place, string][] = [["pantry", "Pantry"], ["fridge", "Fridge"], ["freezer", "Freezer"]];

/**
 * One thing at home: where it is, and that it is finished. Both optional;
 * the kitchen is right enough without either.
 */
export default function KeptSheet(p: { food: KitchenFood | null; today: string; onClose: () => void; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const f = p.food;

  async function act(run: () => Promise<void>, close: boolean) {
    try {
      await run();
      setError(null);
      p.onChanged();
      if (close) p.onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <Sheet open={f !== null} onClose={p.onClose} title={f ? nameOf(f) : ""}>
      {f && (
        <div className="kept-sheet">
          <p className="kept-sheet__when">{usedLine(f, p.today)}</p>
          <div className="chips" role="group" aria-label="Where it is">
            {PLACES.map(([place, label]) => (
              <button
                key={place}
                className="chip"
                aria-pressed={placeOf(f) === place}
                onClick={() => act(() => moveKitchenFood(refOf(f), f.description, place), false)}
              >
                {label}
              </button>
            ))}
          </div>
          {error && <p className="alert" role="alert">{error}</p>}
          <button className="btn btn--quiet" onClick={() => act(() => finishKitchenFood(refOf(f), f.description, p.today), true)}>
            Finished
          </button>
        </div>
      )}
    </Sheet>
  );
}
