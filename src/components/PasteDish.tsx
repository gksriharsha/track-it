import { useMemo, useState } from "react";
import { importLogRows } from "../api";
import type { Meal, Origin } from "../types";
import { LABEL_NUTRIENTS } from "../types";
import type { PastedNutrient } from "../lib/pastedDish";
import { DISH_PROMPT, parsePastedDishes } from "../lib/pastedDish";
import TagPicker from "./TagPicker";
import Info from "./Info";

/**
 * A dish someone else cooked, logged from an assistant's estimate.
 *
 * Ordered-in food has no pack and is not worth a recipe, so the user asks an
 * assistant for the figures and pastes the JSON reply here. It is written the
 * way a spreadsheet row is (`import_log_rows`): a one-off food that never
 * joins search or Your foods, and an entry frozen at once like any other —
 * counted as one portion, so the day never shows a weight nobody measured.
 *
 * Where it came from and its cuisine are the user's own answers (D15), so
 * both start unset and nothing from the reply fills them in. Having chosen
 * Restaurant food, the only question left is which kind: ordered in, or
 * eaten out.
 */
export default function PasteDish(p: {
  date: string;
  meal: Meal;
  onLogged: () => void;
}) {
  const [raw, setRaw] = useState("");
  const parsed = useMemo(() => parsePastedDishes(raw), [raw]);
  const dishes = parsed.ok ? parsed.dishes : [];
  /** Names as edited, by position; the reply's own name until touched. */
  const [names, setNames] = useState<Record<number, string>>({});
  /** The user's own answers, unset until given. */
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [cuisine, setCuisine] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function copyPrompt() {
    setError(null);
    if (await copyText(DISH_PROMPT)) setCopied(true);
    else setError("Couldn’t reach the clipboard.");
  }

  async function add() {
    setSaving(true);
    setError(null);
    try {
      const summary = await importLogRows(
        dishes.map((d, i) => ({
          logged_on: p.date,
          meal: p.meal,
          description: (names[i] ?? d.name).trim() || d.name,
          nutrients: d.nutrients.map((n) => ({ nutrient_id: n.nutrient_id, amount: n.amount })),
          source_row: i + 1,
          origin,
          cuisine,
          grams: d.grams,
          piece_noun: "portion",
        })),
      );
      if (summary.failed.length > 0) {
        setError(summary.failed.map((f) => f.reason).join(" "));
        // Some may have landed; the day has to show those either way.
        if (summary.imported > 0) p.onLogged();
        return;
      }
      setRaw("");
      setNames({});
      setOrigin(null);
      setCuisine(null);
      p.onLogged();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="paste">
      <div className="paste__head">
        <button className="link" onClick={copyPrompt}>{copied ? "Prompt copied" : "Copy the prompt"}</button>
        <Info title="Logging a dish from an estimate">
          <p>
            Copy the prompt, add the dish to it in any AI assistant, and paste the JSON it gives
            back here. The figures are its estimate for the whole portion; a nutrient it leaves out
            stays unknown rather than counting as zero.
          </p>
          <p>
            The dish is logged once, as one portion, and kept out of search, so restaurant dishes
            don’t crowd your own foods.
          </p>
        </Info>
      </div>

      <textarea
        className={`field paste__text${dishes.length > 0 ? " is-read" : ""}`}
        value={raw}
        onChange={(e) => { setRaw(e.target.value); setNames({}); setError(null); }}
        placeholder={'{"name": "Paneer tikka", "calories": 540, …}'}
        aria-label="The dish's nutrition, as JSON"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={5}
      />

      {!parsed.ok && parsed.error !== "" && <p className="paste__note">{parsed.error}</p>}
      {parsed.ok && parsed.skipped.length > 0 && (
        <p className="paste__note">Left out: {parsed.skipped.join(", ")}, the sum of the others</p>
      )}

      {dishes.map((d, i) => (
        <div className="paste__dish" key={i}>
          <input className="field" value={names[i] ?? d.name} aria-label="Dish name"
            onChange={(e) => setNames({ ...names, [i]: e.target.value })} />
          <p className="paste__line tnum">
            {[d.grams !== null ? `about\u00a0${Math.round(d.grams).toLocaleString()}\u00a0g` : null,
              ...d.nutrients.map(figure)]
              .filter(Boolean).join(" · ")}
          </p>
          {d.ignored.length > 0 && <p className="paste__note">Left out: {d.ignored.join(", ")}</p>}
        </div>
      ))}

      {dishes.length > 0 && (
        <TagPicker origin={origin} cuisine={cuisine} origins={RESTAURANT}
          onChange={(o, c) => { setOrigin(o); setCuisine(c); }} />
      )}

      {error && <p className="alert" role="alert">{error}</p>}

      <div className="commit">
        <button className="btn" style={{ marginLeft: "auto" }} onClick={add}
          disabled={saving || dishes.length === 0}>
          {saving ? "Adding…" : `Add to ${p.meal}`}
        </button>
      </div>
    </div>
  );
}

/** A restaurant's dish was either brought to the door or eaten there. */
const RESTAURANT: Origin[] = ["ordered_in", "eaten_out"];

/** The label's long names, cut to what fits a line: "Total carbohydrate" is carbs. */
const SHORT: Record<number, string> = {
  1004: "fat", 1258: "sat fat", 1257: "trans fat", 1005: "carbs", 1079: "fiber", 2000: "sugars",
  1235: "added sugars", 1114: "vitamin D",
};

/**
 * "32 g protein", "780 kcal", "1,350 mg sodium". Held together with no-break
 * spaces, so a line wraps between figures and never inside one ("4 / g fiber").
 */
function figure(n: PastedNutrient): string {
  const amount = (n.amount >= 10 ? Math.round(n.amount) : Math.round(n.amount * 10) / 10).toLocaleString();
  if (n.nutrient_id === 1008) return `${amount}\u00a0kcal`;
  const unit = LABEL_NUTRIENTS.find((l) => l.id === n.nutrient_id)?.unit ?? "";
  return `${amount}\u00a0${unit}\u00a0${(SHORT[n.nutrient_id] ?? n.label.toLowerCase()).replace(/ /g, "\u00a0")}`;
}

/**
 * Put text on the clipboard, from the tap that asked for it.
 *
 * Android's WebView refuses the Clipboard API outright ("Write permission
 * denied"), even inside a tap, while the old copy command still reaches the
 * system clipboard from a selected, off-screen field. So the API first, where
 * a browser or the Mac grants it, and the copy command after. Focus goes back
 * where it was, so the keyboard does not spring up or move.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const was = document.activeElement as HTMLElement | null;
    const box = document.createElement("textarea");
    box.value = text;
    box.readOnly = true;
    box.setAttribute("aria-hidden", "true");
    box.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;";
    document.body.appendChild(box);
    box.select();
    box.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    box.remove();
    was?.focus?.();
    return ok;
  }
}
