import { useEffect, useMemo, useRef, useState } from "react";
import { putAway, searchFoods } from "../api";
import { displayName } from "../lib/foodForms";
import { guess, nameOf, placeOf, refOf, usual } from "../lib/kitchen";
import { keyOf } from "../lib/useKitchen";
import type { FoodHit, FoodRef, KitchenFood, Place } from "../types";
import KitchenArt from "./KitchenArt";
import Sheet from "./Sheet";

const PLACES: [Place, string][] = [["pantry", "Pantry"], ["fridge", "Fridge"], ["freezer", "Freezer"]];

/** Moves a copy of `from` into `to` and gives `to` a nudge. Nothing with Reduce Motion on. */
function fly(from: HTMLElement, to: HTMLElement | undefined) {
  if (!to || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const ghost = from.cloneNode(true) as HTMLElement;
  Object.assign(ghost.style, { position: "fixed", left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px`, margin: "0", zIndex: "1000", pointerEvents: "none" });
  document.body.appendChild(ghost);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  ghost
    .animate([{ transform: "none", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.3)`, opacity: 0.2 }], { duration: 520, easing: "cubic-bezier(.4,0,.2,1)" })
    .finished.finally(() => ghost.remove());
  to.animate([{ transform: "none" }, { transform: "scale(1.08)" }, { transform: "none" }], { duration: 280, delay: 460 });
}

/**
 * Putting a shop away: one tap a thing. What has been at home before sits as
 * chips, finished or greyed-back things first, and each goes back to where it
 * lived. Anything new is found with the search at the foot. All of it is
 * optional; cooking with something puts it on its shelf anyway.
 */
export default function Unpack(p: {
  open: boolean;
  onClose: () => void;
  foods: KitchenFood[];
  today: string;
  counts: Record<Place, number> | null;
  onChanged: () => void;
}) {
  // Taken when the sheet opens, so chips do not move under a finger as the
  // kitchen is read again after each one.
  const chips = useMemo(() => (p.open ? usual(p.foods, p.today) : []), [p.open]);
  const [done, setDone] = useState<Record<string, Place>>({});
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FoodHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const targets = useRef<Partial<Record<Place, HTMLElement | null>>>({});

  useEffect(() => {
    if (!p.open) { setDone({}); setQuery(""); setHits([]); }
  }, [p.open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    const t = setTimeout(() => searchFoods(q, 8).then(setHits, () => setHits([])), 200);
    return () => clearTimeout(t);
  }, [query]);

  async function put(food: FoodRef, description: string, place: Place, from: HTMLElement) {
    const key = keyOf(food);
    if (done[key]) return;
    try {
      await putAway(food, description, place, p.today);
      setDone((d) => ({ ...d, [key]: place }));
      setError(null);
      fly(from, targets.current[place] ?? undefined);
      p.onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <Sheet open={p.open} onClose={p.onClose} title="Put away" size="full">
      <div className="unpack">
        <div className="unpack__targets">
          {PLACES.map(([place, label]) => (
            <div key={place} className="unpack__target" ref={(el) => { targets.current[place] = el; }}>
              <span className="unpack__n tnum">{p.counts ? p.counts[place] : "…"}</span>
              <span className="unpack__l">{label}</span>
            </div>
          ))}
        </div>

        {error && <p className="alert" role="alert">{error}</p>}

        {chips.length > 0 && (
          <>
            <h3 className="unpack__h">Usually at home</h3>
            <div className="unpack__chips">
              {chips.map((f) => {
                const key = keyOf(f);
                return (
                  <button
                    key={key}
                    className="unpack__chip"
                    aria-pressed={Boolean(done[key])}
                    onClick={(e) => put(refOf(f), f.description, placeOf(f), e.currentTarget.querySelector(".unpack__art") as HTMLElement)}
                  >
                    <span className="unpack__art"><KitchenArt art={guess(nameOf(f)).art} size={26} /></span>
                    <span className="unpack__name">{nameOf(f)}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {hits.length > 0 && (
          <div className="tiles unpack__hits">
            {hits.map((h) => {
              const food = { fdc_id: h.fdc_id, custom_food_id: h.custom_food_id };
              const name = displayName(h);
              const key = keyOf(food);
              return (
                <button key={key} className="tile unpack__hit" aria-pressed={Boolean(done[key])} onClick={(e) => put(food, h.description, guess(name).place, e.currentTarget.querySelector(".unpack__art") as HTMLElement)}>
                  <span className="unpack__art"><KitchenArt art={guess(name).art} size={26} /></span>
                  <span className="row__title">{name}</span>
                </button>
              );
            })}
          </div>
        )}

        <label className="unpack__search">
          <span className="vh">Something else</span>
          <input type="search" placeholder="Something else" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
    </Sheet>
  );
}
