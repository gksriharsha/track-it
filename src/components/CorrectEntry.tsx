/**
 * Correcting what a day already recorded.
 *
 * A logged entry keeps the nutrition it had when it was logged, so nothing
 * changes it by accident. That is only honest if a real mistake can still be
 * fixed, which is what this is — the deliberate way in. Every change here is
 * stored as a correction and dated, rather than blended into the original.
 *
 * Three different mistakes get three different remedies, because they are not
 * the same mistake: the amount was wrong, one figure was wrong, or the food
 * itself was wrong and has since been fixed.
 */
import { useCallback, useEffect, useState } from "react";
import {
  correctEntryAmount,
  correctEntryValue,
  getEntrySnapshot,
  listNutrients,
  refreezeEntry,
} from "../api";
import type {
  CorrectableKind,
  EntrySnapshotView,
  NutrientMeta,
  NutrientValue,
} from "../types";

/** The recorded value in words, so the user can see what they are replacing. */
function said(v: NutrientValue | undefined, magnitude: string): string {
  if (!v) return "nothing recorded";
  switch (v.kind) {
    case "measured":
      return `${round(v.amount)} ${magnitude}`;
    case "measured_zero":
    case "assumed_zero":
      return "none";
    case "below_loq":
      return `less than ${round(v.upper)} ${magnitude}`;
    case "label_zero":
      return `a label zero, under ${round(v.upper)} ${magnitude}`;
    case "trace":
      return `a trace, under ${round(v.upper)} ${magnitude}`;
    default:
      return "nobody knew";
  }
}

function round(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(3);
}

/** The plain-language history of these numbers. */
function provenance(s: EntrySnapshotView): string {
  const when = (iso: string) => iso.slice(0, 10);
  if (s.basis === "corrected") {
    return `You corrected this on ${when(s.corrected_at ?? s.frozen_at)}. It was first recorded on ${when(s.frozen_at)}.`;
  }
  if (s.basis === "backfilled") {
    return `Filled in on ${when(s.frozen_at)}, after this entry was logged. What it was worth at the time was never recorded, so these are the best figures available rather than the original ones.`;
  }
  return `Recorded on ${when(s.frozen_at)}, when you logged it. Changing the food since then has not moved these.`;
}

const KINDS: { id: CorrectableKind; label: string }[] = [
  { id: "measured", label: "a number" },
  { id: "label_zero", label: "the pack says 0" },
  { id: "below_loq", label: "less than" },
  { id: "trace", label: "a trace" },
  { id: "unknown", label: "nobody knew" },
];

export default function CorrectEntry({
  entryId,
  onChanged,
}: {
  entryId: string;
  onChanged: () => void;
}) {
  const [snap, setSnap] = useState<EntrySnapshotView | null>(null);
  const [nutrients, setNutrients] = useState<NutrientMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [amount, setAmount] = useState("");
  const [part, setPart] = useState(0);
  const [nutrientId, setNutrientId] = useState<number | null>(null);
  const [kind, setKind] = useState<CorrectableKind>("measured");
  const [figure, setFigure] = useState("");

  const load = useCallback(async () => {
    try {
      const s = await getEntrySnapshot(entryId);
      setSnap(s);
      setAmount(String(s.grams ?? s.units ?? ""));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [entryId]);

  useEffect(() => {
    void load();
    listNutrients().then(setNutrients, () => {});
  }, [load]);

  if (error && !snap) return <p className="breakdown__note">{error}</p>;
  if (!snap) return <p className="breakdown__note">Reading what this day recorded…</p>;

  const counted = snap.units != null;
  const noun = counted ? (snap.unit_noun ?? "unit") : "g";
  const chosen = snap.parts[part];
  // Values are stored on the basis their part is measured in, and a person
  // typing a figure has to be told which. Getting this wrong by a factor of the
  // serving size is the easiest mistake available here.
  const basis = chosen?.servings != null ? "per serving" : "per 100 g";
  const meta = nutrients.find((n) => n.id === nutrientId);
  const current = chosen?.values.find((v) => v.nutrient_id === nutrientId)?.value;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="correct">
      <p className="breakdown__note">{provenance(snap)}</p>

      <div className="correct__block">
        <label className="correct__label" htmlFor={`amt-${entryId}`}>
          How much {counted ? "was taken" : "was eaten"}
        </label>
        <div className="correct__row">
          <input
            id={`amt-${entryId}`}
            className="field num"
            inputMode="decimal"
            value={amount}
            onChange={(ev) => setAmount(ev.target.value)}
          />
          <span className="correct__unit">{noun}</span>
          <button
            type="button"
            className="btn"
            disabled={busy || amount.trim() === ""}
            onClick={() =>
              run(async () => {
                const n = Number(amount);
                if (!Number.isFinite(n) || n <= 0) throw new Error("that needs to be a positive number");
                await correctEntryAmount(entryId, counted ? null : n, counted ? n : null);
              })
            }
          >
            Correct
          </button>
        </div>
        <p className="breakdown__note">
          Everything it was made of is rescaled by the same amount. The figures
          themselves are left exactly as they were recorded.
        </p>
      </div>

      <div className="correct__block">
        <span className="correct__label">Correct one figure</span>
        {snap.parts.length > 1 && (
          <select
            className="field"
            aria-label="Which part"
            value={part}
            onChange={(ev) => setPart(Number(ev.target.value))}
          >
            {snap.parts.map((p, i) => (
              <option key={p.ordinal} value={i}>
                {p.description}
              </option>
            ))}
          </select>
        )}
        <div className="correct__row">
          <select
            className="field"
            aria-label="Which nutrient"
            value={nutrientId ?? ""}
            onChange={(ev) => setNutrientId(ev.target.value === "" ? null : Number(ev.target.value))}
          >
            <option value="">Choose a nutrient…</option>
            {nutrients.map((n) => (
              <option key={n.id} value={n.id}>
                {n.short_name}
              </option>
            ))}
          </select>
        </div>
        {nutrientId != null && meta && (
          <>
            <p className="breakdown__note">
              This entry records <strong>{said(current, meta.magnitude)}</strong> {basis}.
            </p>
            <div className="correct__row">
              <select
                className="field"
                aria-label="What it should say"
                value={kind}
                onChange={(ev) => setKind(ev.target.value as CorrectableKind)}
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
              {kind !== "unknown" && (
                <>
                  <input
                    className="field num"
                    inputMode="decimal"
                    aria-label={`Amount in ${meta.magnitude}`}
                    value={figure}
                    onChange={(ev) => setFigure(ev.target.value)}
                  />
                  <span className="correct__unit">
                    {meta.magnitude} {basis}
                  </span>
                </>
              )}
              <button
                type="button"
                className="btn"
                disabled={busy || (kind !== "unknown" && figure.trim() === "")}
                onClick={() =>
                  run(async () => {
                    const n = kind === "unknown" ? null : Number(figure);
                    if (kind !== "unknown" && (!Number.isFinite(n as number) || (n as number) < 0)) {
                      throw new Error("that needs to be a number");
                    }
                    await correctEntryValue(
                      entryId,
                      chosen.ordinal,
                      nutrientId,
                      kind,
                      kind === "measured" ? n : null,
                      kind === "measured" || kind === "unknown" ? null : n,
                    );
                    setFigure("");
                  })
                }
              >
                Correct
              </button>
            </div>
          </>
        )}
      </div>

      <div className="correct__block">
        <span className="correct__label">Or use the current data</span>
        <p className="breakdown__note">
          If you have since fixed the food or the recipe this came from, this
          works the entry out again from what it says now. Every other day stays
          as it is.
        </p>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => run(() => refreezeEntry(entryId))}
        >
          Work this entry out again
        </button>
      </div>

      {error && <p className="breakdown__note correct__error">{error}</p>}
    </div>
  );
}
