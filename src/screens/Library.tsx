import { useCallback, useEffect, useState } from "react";
import { listBottles, listCustomFoods, listRecipes, listSupplements, listVessels } from "../api";
import ScreenHead from "../components/ScreenHead";

interface Props {
  onOpenRecipes: () => void;
  onOpenCustomFoods: () => void;
  onOpenSupplements: () => void;
  onOpenVessels: () => void;
  onOpenBottles: () => void;
}

interface Counts {
  recipes: number;
  customFoods: number;
  supplements: number;
  vessels: number;
  bottles: number;
}

/**
 * The things you have taught the app, gathered in one place.
 *
 * Each of these used to be reached only mid-task — recipes had a tab of its
 * own, but your own foods and supplements were reachable only from a search
 * that had already come up empty, and vessels only from inside the weight
 * field. That is right for the moment you are logging something and wrong the
 * rest of the time: there was nowhere to go just to see what you had built, or
 * to clean one up. This screen is that place.
 *
 * It does not replace those entry points — Foods still opens the vessel
 * library and the custom-food screens directly when a search comes up short,
 * because that is still the faster path mid-log. This is the slower, browsing
 * path, and it is why each row carries a live count rather than a guess.
 */
export default function Library(p: Props) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [recipes, customFoods, supplements, vessels, bottles] = await Promise.all([
        listRecipes(),
        listCustomFoods(),
        listSupplements(),
        listVessels(),
        listBottles(),
      ]);
      setCounts({
        recipes: recipes.length,
        customFoods: customFoods.length,
        supplements: supplements.length,
        vessels: vessels.length,
        bottles: bottles.length,
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="screen screen--list">
      <ScreenHead
        title="Library"
        sub="recipes, your foods, supplements, vessels and bottles"
      />

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="card">
        <div className="rows">
          <button className="row" style={{ gridTemplateColumns: "1fr auto" }} onClick={p.onOpenRecipes}>
            <span className="row__main">
              <span className="row__title">Recipes</span>
              <span className="row__sub">Dishes you cook repeatedly</span>
            </span>
            <span className="nval">
              <span className="nval__amt tnum">{counts?.recipes ?? "…"}</span>
              <span className="row__chev" aria-hidden>›</span>
            </span>
          </button>

          <button className="row" style={{ gridTemplateColumns: "1fr auto" }} onClick={p.onOpenCustomFoods}>
            <span className="row__main">
              <span className="row__title">Your foods</span>
              <span className="row__sub">Transcribed from a pack</span>
            </span>
            <span className="nval">
              <span className="nval__amt tnum">{counts?.customFoods ?? "…"}</span>
              <span className="row__chev" aria-hidden>›</span>
            </span>
          </button>

          <button className="row" style={{ gridTemplateColumns: "1fr auto" }} onClick={p.onOpenSupplements}>
            <span className="row__main">
              <span className="row__title">Supplements</span>
              <span className="row__sub">Taken by count, not by weight</span>
            </span>
            <span className="nval">
              <span className="nval__amt tnum">{counts?.supplements ?? "…"}</span>
              <span className="row__chev" aria-hidden>›</span>
            </span>
          </button>

          <button className="row" style={{ gridTemplateColumns: "1fr auto" }} onClick={p.onOpenVessels}>
            <span className="row__main">
              <span className="row__title">Vessels</span>
              <span className="row__sub">Weighed empty once, so a plate can go on the scale</span>
            </span>
            <span className="nval">
              <span className="nval__amt tnum">{counts?.vessels ?? "…"}</span>
              <span className="row__chev" aria-hidden>›</span>
            </span>
          </button>

          <button className="row" style={{ gridTemplateColumns: "1fr auto" }} onClick={p.onOpenBottles}>
            <span className="row__main">
              <span className="row__title">Bottles</span>
              <span className="row__sub">Weighed full once, so a day's water can be read off it</span>
            </span>
            <span className="nval">
              <span className="nval__amt tnum">{counts?.bottles ?? "…"}</span>
              <span className="row__chev" aria-hidden>›</span>
            </span>
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Reference data</h2>
        </div>
        <p style={{ color: "var(--ink-2)", fontSize: 13, margin: 0 }}>
          <span className="num" style={{ fontWeight: 500 }}>13,694</span> foods bundled — USDA
          Foundation, SR Legacy and FNDDS, with Indian-name aliases so <em>urad dal</em> finds the
          right entry.
        </p>
      </section>
    </div>
  );
}
