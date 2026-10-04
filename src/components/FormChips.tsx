import { useEffect, useState } from "react";
import { getFoodForms } from "../api";
import { formLabel } from "../lib/foodForms";
import type { FoodFamily, FoodForm } from "../types";

interface Props {
  /** The reference food on the line: one of the forms, pressed. */
  fdcId: number;
  /** Its family where the hit that put it there already carried it, so nothing is asked. */
  known?: FoodFamily | null;
  onForm: (form: FoodForm, family: FoodFamily) => void;
  small?: boolean;
  className?: string;
}

/**
 * The other forms of an ingredient already on a line — canned rather than
 * dry, frozen rather than fresh — as chips, the one on the line pressed.
 *
 * An ingredient picker puts a food in on its uncooked form, and search shows
 * it as one row; this is where a line that went in some other way is told
 * so, beside the line, without searching again. Nothing at all is drawn for
 * a food in one form, while its forms are read, or if reading them fails:
 * the chips were not asked for, so their absence says nothing.
 */
export default function FormChips({ fdcId, known, onForm, small, className }: Props) {
  const [family, setFamily] = useState<FoodFamily | null>(
    known && known.forms.some((f) => f.fdc_id === fdcId) ? known : null,
  );
  const holds = family !== null && family.forms.some((f) => f.fdc_id === fdcId);

  useEffect(() => {
    // A switch to another form of the same food needs nothing new.
    if (holds) return;
    let live = true;
    getFoodForms(fdcId)
      .then((f) => { if (live) setFamily(f); })
      .catch(() => { /* the line stands without its chips */ });
    return () => { live = false; };
    // Keyed on the food alone: `holds` follows from it and the family read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fdcId]);

  if (!holds || family.forms.length < 2) return null;
  return (
    <div className={`chips${className ? ` ${className}` : ""}`} role="group" aria-label="Form">
      {family.forms.map((f) => (
        <button type="button" key={f.fdc_id} className={`chip${small ? " chip--sm" : ""}`}
          aria-pressed={f.fdc_id === fdcId} onClick={() => onForm(f, family)}>
          {formLabel(f)}
        </button>
      ))}
    </div>
  );
}
