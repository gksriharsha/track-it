import { useCallback, useEffect, useState } from "react";
import { deleteRecipe, listRecipes } from "../api";
import RecipeBuilder from "./RecipeBuilder";
import { plural } from "../lib/nutrient";
import type { Recipe } from "../types";
import ScreenHead from "../components/ScreenHead";

/**
 * Saved recipes. A recipe is stored as ingredients in proportion rather than as
 * a nutrient snapshot — that is what lets a logged dish show what went into it,
 * and what makes its gaps honest: an ingredient with no composition data stays
 * visible and keeps counting against the day's coverage.
 *
 * What is here is the ideal. What was actually made — this batch, at this
 * scale, minus the hing — is a cook, and it is a portion of that which is
 * logged.
 */
interface Props {
  /** Back to the Library. */
  onBack: () => void;
  /** Open the cook sheet on a fresh pot of this recipe. */
  onCook: (recipeId: string) => void;
}

export default function Recipes(p: Props) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  const load = useCallback(async () => {
    try {
      setRecipes(await listRecipes());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete “${name}”? Days that already used it keep their entries.`)) return;
    await deleteRecipe(id);
    load();
  }

  const list = recipes;

  if (building) {
    return (
      <RecipeBuilder
        onCancel={() => setBuilding(false)}
        onDone={() => { setBuilding(false); load(); }}
      />
    );
  }

  return (
    <div className="screen">
      <ScreenHead
        title="Recipes"
        sub={list.length > 0 ? `${list.length} saved` : "the proportions you cook by"}
        onBack={p.onBack}
        action={
          list.length > 0 ? (
            <button className="btn" onClick={() => setBuilding(true)}>New recipe</button>
          ) : null
        }
      />

      {error && <p className="alert" role="alert">{error}</p>}

      {loading ? (
        <div className="rgrid">
          {[0, 1, 2].map((i) => (
            <div className="card" key={i}>
              <div className="skel skel--row" style={{ width: "60%", height: 22 }} />
              <div className="skel skel--row" style={{ width: "40%" }} />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="empty">
          <h3>No recipes yet</h3>
          <p>
            A recipe is ingredients in proportion — no servings to commit to, because you cook
            for however many are eating. Weigh each ingredient raw, say once what the dish comes
            out at cooked, and every batch afterwards starts from it. That one cooked weight is
            what keeps a katori of rajma from counting three times over.
          </p>
          <button className="btn" onClick={() => setBuilding(true)}>Build your first recipe</button>
        </div>
      ) : (
        <div className="rgrid">
          {list.map((r) => {
            const missing = r.ingredients.filter((i) => i.fdc_id === null);
            const optional = r.ingredients.filter((i) => i.optional).length;
            return (
              <div className="card rcard" key={r.id}>
                <div className="rcard__name">{r.name}</div>
                {/* The written batch, not a promise about the next one. The
                    servings count is shown only where the user gave one, and
                    reads as their note rather than as a property of the dish —
                    never write `?? 4` here to make the sentence tidier. */}
                <div className="rcard__meta tnum">
                  comes out at {Math.round(r.yield_g).toLocaleString()} g ·{" "}
                  {plural(r.ingredients.length, "ingredient")}
                  {optional > 0 && `, ${optional} optional`}
                  {r.servings !== null && ` · usually feeds ${r.servings}`}
                </div>
                <div className="rcard__ing">
                  {r.ingredients.slice(0, 4).map((i) => i.description).join(", ")}
                  {r.ingredients.length > 4 && ` +${r.ingredients.length - 4} more`}
                </div>
                {missing.length > 0 && (
                  <div className="card__foot">
                    {plural(missing.length, "ingredient")}{" "}
                    {missing.length > 1 ? "have" : "has"} no composition data, so anything they
                    contribute counts as unmeasured.
                  </div>
                )}
                <div style={{ marginTop: "var(--s3)", display: "flex", gap: "var(--s2)" }}>
                  {/* The primary action on a recipe is to cook it. Logging
                      straight off the written batch is still there in Add
                      food, for a day you followed it exactly. */}
                  <button className="btn" onClick={() => p.onCook(r.id)}>
                    Cook this
                  </button>
                  <button className="btn btn--danger" onClick={() => remove(r.id, r.name)}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
