import { useEffect, useMemo, useState } from "react";
import { getGoals } from "../api";
import { nonVegetarian } from "../lib/vegetarian";

/**
 * Under an ingredient list: the words in it that are not vegetarian, shown only
 * when the profile says "Only vegetarian". Reads the box as it stands, so a
 * corrected word clears its flag as it is typed.
 */
export default function VegFlags({ text }: { text: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    getGoals().then((g) => setOn(g.profile.vegetarian_only), () => setOn(false));
  }, []);

  const flags = useMemo(() => (on ? nonVegetarian(text) : []), [on, text]);
  const sure = flags.filter((f) => f.sure).map((f) => f.word);
  const maybe = flags.filter((f) => !f.sure).map((f) => f.word);
  if (sure.length === 0 && maybe.length === 0) return null;

  return (
    <div role="status" style={{ marginTop: "var(--s3)", display: "grid", gap: "var(--s2)" }}>
      {sure.length > 0 && <p className="alert" style={{ margin: 0 }}>Not vegetarian: {sure.join(", ")}</p>}
      {maybe.length > 0 && <p className="rangenote">May not be vegetarian: {maybe.join(", ")}</p>}
    </div>
  );
}
