import { useEffect, useMemo, useState } from "react";
import { getGoals, listAllergens } from "../api";
import { findAllergens, group } from "../lib/allergens";
import { nonVegetarian } from "../lib/vegetarian";

/**
 * Above an ingredient list: a chip for each of the user's allergens it names,
 * and for what is not vegetarian when the profile says "Only vegetarian".
 * Filled when the list names it, outlined when it only may. An allergen chip
 * opens to the words the pack printed for it. Reads the box as it stands, so
 * a corrected word clears its chip as it is typed.
 */
export default function IngredientFlags({ text }: { text: string }) {
  const [vegOnly, setVegOnly] = useState(false);
  const [allergens, setAllergens] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    getGoals().then((g) => setVegOnly(g.profile.vegetarian_only), () => setVegOnly(false));
    listAllergens().then(setAllergens, () => setAllergens([]));
  }, []);

  const chips = useMemo(() => [
    ...group(findAllergens(text, allergens)).map((a) => ({
      label: a.sure ? a.allergen : `${a.allergen} · may contain`,
      more: a.words.join(", "),
      cls: a.sure ? "flagchip--sure" : "flagchip--maybe",
    })),
    // "471 (mono- and diglycerides)" is the number on the chip and its name when opened.
    ...(vegOnly ? nonVegetarian(text) : []).map((f) => ({
      label: `${f.word.replace(/ \(.*\)$/, "")} · ${f.sure ? "not veg" : "may not be veg"}`,
      more: f.word.match(/ \((.*)\)$/)?.[1] ?? "",
      cls: f.sure ? "flagchip--sure" : "flagchip--maybe flagchip--quiet",
    })),
  ], [text, allergens, vegOnly]);
  if (chips.length === 0) return null;

  return (
    <div role="status" className="chips" style={{ marginBottom: "var(--s3)" }}>
      {chips.map((c) =>
        c.more ? (
          <button key={c.label} type="button" className={`flagchip ${c.cls}`} aria-expanded={open === c.label}
            onClick={() => setOpen(open === c.label ? null : c.label)}>
            {open === c.label ? `${c.label} · ${c.more}` : c.label}
          </button>
        ) : (
          <span key={c.label} className={`flagchip ${c.cls}`}>{c.label}</span>
        ),
      )}
    </div>
  );
}
