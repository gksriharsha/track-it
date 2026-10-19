import { useEffect, useMemo, useState } from "react";
import { getGoals, listAllergens } from "../api";
import { describe, findAllergens } from "../lib/allergens";
import { nonVegetarian } from "../lib/vegetarian";

/**
 * Under an ingredient list: the user's allergens in it, and what is not
 * vegetarian when the profile says "Only vegetarian". Reads the box as it
 * stands, so a corrected word clears its flag as it is typed.
 */
export default function IngredientFlags({ text }: { text: string }) {
  const [vegOnly, setVegOnly] = useState(false);
  const [allergens, setAllergens] = useState<string[]>([]);
  useEffect(() => {
    getGoals().then((g) => setVegOnly(g.profile.vegetarian_only), () => setVegOnly(false));
    listAllergens().then(setAllergens, () => setAllergens([]));
  }, []);

  const { has, mayHave, notVeg, mayNotVeg } = useMemo(() => {
    const hits = findAllergens(text, allergens);
    const sure = hits.filter((h) => h.sure);
    const veg = vegOnly ? nonVegetarian(text) : [];
    return {
      has: describe(sure),
      // An allergen already named for sure is not named again as a maybe.
      mayHave: describe(hits.filter((h) => !h.sure && !sure.some((s) => s.allergen === h.allergen))),
      notVeg: veg.filter((f) => f.sure).map((f) => f.word).join(", "),
      mayNotVeg: veg.filter((f) => !f.sure).map((f) => f.word).join(", "),
    };
  }, [text, allergens, vegOnly]);
  if (!has && !mayHave && !notVeg && !mayNotVeg) return null;

  return (
    <div role="status" style={{ marginTop: "var(--s3)", display: "grid", gap: "var(--s2)" }}>
      {has && <p className="alert" style={{ margin: 0 }}>Your allergens: {has}</p>}
      {notVeg && <p className="alert" style={{ margin: 0 }}>Not vegetarian: {notVeg}</p>}
      {mayHave && <p className="rangenote">May contain your allergens: {mayHave}</p>}
      {mayNotVeg && <p className="rangenote">May not be vegetarian: {mayNotVeg}</p>}
    </div>
  );
}
