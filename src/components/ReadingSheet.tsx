import { useEffect, useRef, useState } from "react";
import { addContainerEvent, previewContainerEvent, todayIso } from "../api";
import { KEYS, pasted, press, readingOf } from "../lib/amount";
import type { Key, Readout } from "../lib/amount";
import { useMedia } from "../lib/desktop";
import { amount as fmt, cups, howRead, readingUnit, shortDate } from "../lib/pantry";
import type { Container, ContainerEventKind, ContainerStretch, ContainerUnit, ReadBy } from "../types";
import { Dots } from "./Amount";
import Glyph from "./Glyph";
import Sheet from "./Sheet";

/** Just what the sheet needs to know about the container it records. */
export interface SheetTarget {
  id: string;
  name: string;
  description: string;
  read_by: ReadBy;
  cup_ml: number;
}

interface Props {
  target: SheetTarget;
  /**
   * Shut the sheet. Its owner holds it in the hash as `reading=<container id>`,
   * so this is a step back, and the ×, the scrim and Escape all take it.
   */
  onClose: () => void;
  /** Saved: the container as it now reads. The owner closes the sheet. */
  onSaved: (c: Container) => void;
}

const KINDS: { id: ContainerEventKind; label: string; save: string }[] = [
  { id: "reading", label: "Reading", save: "Save reading" },
  { id: "poured_in", label: "Poured in", save: "Save pack" },
  { id: "emptied", label: "Finished", save: "Mark finished" },
];

/** The units each kind of record is typed in. A pack says kg or L; a reading says cups. */
const UNITS: Record<ContainerEventKind, ContainerUnit[]> = {
  reading: ["g", "ml", "cup"],
  poured_in: ["g", "kg", "ml", "l"],
  emptied: ["g", "ml", "cup"],
};

const UNIT_LABEL: Record<ContainerUnit, string> = { g: "g", kg: "kg", ml: "ml", l: "L", cup: "cup" };

/**
 * Record what happened to a container: a reading, a pack poured in, or the
 * container finished.
 *
 * The figure sits in the same window a portion is weighed in, the scale's own
 * display, with its unit chosen beside it: g on the scale (container
 * included), ml or cups off the marks. Before anything is saved, the line
 * under the window says what this record would close, worked out by the same
 * arithmetic that will store it.
 */
export default function ReadingSheet({ target, onClose, onSaved }: Props) {
  const [kind, setKind] = useState<ContainerEventKind>("reading");
  const [r, setR] = useState<Readout>({ digits: "", from: "typed" });
  const [unit, setUnit] = useState<ContainerUnit>(readingUnit(target.read_by));
  const [spilled, setSpilled] = useState(false);
  const [preview, setPreview] = useState<ContainerStretch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [focused, setFocused] = useState(false);
  // The keypad wherever there is no fine pointer to type with, as Food does.
  const keypad = !useMedia("(hover: hover) and (pointer: fine)");
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const value = readingOf(r.digits);
  const save = KINDS.find((k) => k.id === kind)!.save;

  // What this record would close, from the backend's own arithmetic.
  useEffect(() => {
    const mine = ++seq.current;
    if (kind === "poured_in" || (kind === "reading" && value === null)) { setPreview(null); return; }
    const t = setTimeout(() => {
      previewContainerEvent(target.id, kind, value, value !== null ? unit : null, spilled)
        .then((p) => { if (mine === seq.current) setPreview(p); })
        .catch(() => { if (mine === seq.current) setPreview(null); });
    }, 160);
    return () => clearTimeout(t);
  }, [target.id, kind, value, unit, spilled]);

  function pickKind(k: ContainerEventKind) {
    setKind(k);
    setError(null);
    if (!UNITS[k].includes(unit)) setUnit(readingUnit(target.read_by));
    if (k !== "reading") setSpilled(false);
  }

  const key = (k: Key) => { setError(null); setR((x) => press(x, k)); };

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key === "," ? "." : e.key === "Backspace" || e.key === "Delete" ? "del" : e.key;
    if ((KEYS as readonly string[]).includes(k)) {
      e.preventDefault();
      key(k as Key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const d = pasted(e.clipboardData.getData("text"));
    if (d !== null) setR({ digits: d, from: "typed" });
  }

  async function commit() {
    setError(null);
    if (saving) return;
    if (kind !== "emptied" && value === null) {
      return setError(kind === "reading" ? "Type what it reads." : "Type the amount on the pack.");
    }
    setSaving(true);
    try {
      const c = await addContainerEvent(
        target.id, kind, todayIso(), value, value !== null ? unit : null, kind === "reading" && spilled,
      );
      // Still "Saving…" after it has saved. The owner closes the sheet by going
      // back a step, which lands a moment later rather than at once, and a Save
      // live again in that moment could record the same reading twice.
      onSaved(c);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={target.name}
      initialFocus={() => (keypad ? null : inputRef.current)}
    >
      <div className="rsheet">
        <p className="rsheet__sub">{target.description}. {howRead(target.read_by)}.</p>

        <div className="chips" role="group" aria-label="What happened">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className="chip" aria-pressed={kind === k.id} onClick={() => pickKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>

        <div className={`readout${focused ? " is-focused" : ""}`}>
          <div className="readout__win">
            <Dots text={r.digits === "" ? "0" : r.digits} faint={r.digits === ""} />
            {focused && <span className="readout__caret" aria-hidden />}
            <span className="readout__u" aria-hidden>{UNIT_LABEL[unit]}</span>
            <input
              ref={inputRef}
              className="readout__input"
              value={r.digits}
              onChange={() => undefined}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              inputMode={keypad ? "none" : "decimal"}
              enterKeyHint="done"
              autoComplete="off"
              aria-label={kind === "reading" ? "What it reads" : kind === "poured_in" ? "The amount on the pack" : "What is left, if any"}
            />
          </div>
          <div className="chips readout__units" role="group" aria-label="Unit">
            {UNITS[kind].map((u) => (
              <button key={u} type="button" className="chip" aria-pressed={unit === u} onClick={() => setUnit(u)}>
                {UNIT_LABEL[u]}
              </button>
            ))}
          </div>
        </div>

        <p className="rsheet__note" aria-live="polite">
          {note(kind, unit, preview, target, value)}
        </p>

        {kind === "reading" && (
          <label className="rsheet__switch">
            <input type="checkbox" checked={spilled} onChange={(e) => setSpilled(e.target.checked)} />
            <span>Something spilled since the last reading</span>
          </label>
        )}

        {error && <p className="alert" role="alert">{error}</p>}

        {keypad && (
          <div className="keypad">
            {KEYS.map((k) => (
              <button type="button" key={k} className="keypad__key" onClick={() => key(k)}
                aria-label={k === "del" ? "Delete" : k === "." ? "Decimal point" : undefined}>
                {k === "del" ? <Glyph name="del" size={24} /> : k}
              </button>
            ))}
          </div>
        )}

        <button className="btn rsheet__save" onClick={commit} disabled={saving}>
          {saving ? "Saving…" : save}
        </button>
      </div>
    </Sheet>
  );
}

/** The line under the window: what this record would close, or what it means. */
function note(
  kind: ContainerEventKind,
  unit: ContainerUnit,
  p: ContainerStretch | null,
  target: SheetTarget,
  typed: number | null,
): string {
  if (kind === "poured_in") return "The amount on the pack's label.";
  if (kind === "emptied" && typed === null && !p) return "Used to the end. Read what's left first if you threw some out.";
  if (kind === "reading" && !p) return unit === "g" ? "Weigh it as it is, container and all." : "Read the marks on its side.";
  if (!p) return "";
  const since = `since ${shortDate(p.from_on)}`;
  switch (p.status) {
    case "spilled":
      return `What went ${since} is left out because of the spill.`;
    case "inconsistent":
      return "That's more than was in it. Check the figure, or record the pack you added.";
    case "awaiting_tare":
      return "Saved as read. What was used waits for the container's empty weight.";
    case "awaiting_density":
      return p.used_ml !== null
        ? `${fmt(p.used_ml)} ml used ${since}. Grams wait for its weight per ml.`
        : "Saved as read. Grams wait for its weight per ml.";
    default: {
      const inMl = (unit === "ml" || unit === "cup") && p.used_ml !== null;
      const usedAny = inMl ? p.used_ml! : p.used_g;
      if (usedAny === null) return "";
      if (usedAny === 0) return `Nothing used ${since}.`;
      if (inMl) return `${fmt(p.used_ml!)} ml used ${since}, ${cups(p.used_ml!, target.cup_ml)}.`;
      return `${fmt(usedAny)} g used ${since}.`;
    }
  }
}
