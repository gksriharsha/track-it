import { useRef, useState } from "react";
import { deleteLogEntry, restoreLogEntry, setEntryTags } from "../api";
import type { DayView, EntryBreakdown, LogEntry, Origin } from "../types";
import { rowFigure } from "../lib/energy";
import { stateOf } from "../lib/nutrient";
import {
  densityNote, gapText, portionText, potNote, provenanceText, tagText, vesselText, waterNote,
} from "../lib/entryText";
import CorrectEntry from "./CorrectEntry";
import Info from "./Info";
import Sheet from "./Sheet";
import TagPicker from "./TagPicker";
import { useAnnounce } from "./UndoBar";

/**
 * One logged entry, opened from its row on Today.
 *
 * Everything an entry could tell you used to unfold under its row, in place:
 * the ingredients, the panel, where its values came from, both tag pickers
 * under two headings that both said "Where it came from", and the correction
 * form — 749 px pushed into the middle of the day, with the rows below it
 * shoved off the screen. The day stays still now. The entry comes up over it,
 * as a sheet on a phone and a panel down the right of a desktop window, and
 * Back puts it away.
 *
 * What it holds, top to bottom: how much, what that came to in energy, where
 * it came from on one line, what it was made of, and the two things that can
 * be done to it — correct it, or remove it. The method behind each reading is
 * behind an (i) beside it; the state — "≥", "95% measured", "no data", "pot
 * not weighed", "whole bottle, not weighed", corrected or filled in later — is
 * on the line it qualifies, and stays there whether or not the correction form
 * is open.
 *
 * Open on an entry id in the hash (`entry=<id>`), so the Android back gesture
 * closes it rather than leaving Today, and an (i) opened inside it closes back
 * down to it.
 */
export default function EntrySheet(p: {
  day: DayView | null;
  /** The entry the hash names, or null. */
  id: string | null;
  onClose: () => void;
  /** The day changed: re-read it. */
  onChanged: () => void;
}) {
  const entry = p.id === null ? undefined : p.day?.entries.find((e) => e.id === p.id);
  const breakdown = entry ? p.day?.breakdowns.find((b) => b.entry_id === entry.id) : undefined;
  return (
    <Sheet open={entry !== undefined} onClose={p.onClose} title={entry?.description ?? ""}>
      {/* Keyed, so a sheet moved to another entry starts with nothing of the
          last one's — a half-chosen tag, an open correction form, an error. */}
      {entry && (
        <Body key={entry.id} e={entry} b={breakdown} onClose={p.onClose} onChanged={p.onChanged} />
      )}
    </Sheet>
  );
}

function Body({ e, b, onClose, onChanged }: {
  e: LogEntry;
  b: EntryBreakdown | undefined;
  onClose: () => void;
  onChanged: () => void;
}) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagging, setTagging] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  /**
   * The tags as last chosen here, ahead of the day's reload.
   *
   * Without this, each change reads the other dimension off the entry as the
   * server last returned it — so setting an origin and then a cuisine before
   * the refetch lands would write the new cuisine beside the OLD origin and
   * silently drop the first answer.
   */
  const [tags, setTags] = useState<{ origin: Origin | null; cuisine: string | null }>({
    origin: e.origin, cuisine: e.cuisine,
  });
  /* The latest, for an Undo pressed after this sheet — and perhaps Today —
     has gone: the bar outlives both. */
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  const isSupplement = e.source_kind === "supplement";
  const isWater = e.source_kind === "water";
  const isCustom = e.source_kind === "custom";
  const parts = b?.components ?? [];
  const gap = gapText(e, b);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteLogEntry(e.id);
    } catch (err) {
      // The sheet stays up with the reason in it: nothing was removed.
      setError(String(err));
      setBusy(false);
      return;
    }
    onClose();
    onChanged();
    const id = e.id;
    announce({
      message: `Removed ${e.description}`,
      // The same entry back — its id, its place in the day, and the values
      // frozen when it was first logged — never a second log of the food,
      // which would value it against whatever the food says today.
      undo: async () => {
        await restoreLogEntry(id);
        changedRef.current();
      },
    });
  }

  const amount = [
    portionText(e, b, true),
    potNote(e, b, true),
    waterNote(e),
    densityNote(e),
    vesselText(e) && `weighed in ${vesselText(e)}`,
  ]
    .filter(Boolean)
    .join(", ");
  // Logged as it is, the entry's history is method and sits in the (i). A
  // correction, or values worked out after the fact, is a state of THESE
  // figures, so it is said on the sheet itself — it used to be the first line
  // of the correction form, and went behind the "Correct" button with it.
  const history = b && b.basis !== "logged" ? provenanceText(b) : null;

  return (
    <div className="esheet">
      <p className="esheet__amount tnum">{amount}</p>

      {/* Water's energy is nought and says nothing; a tablet that states none
          has none to show. Everything else reads its own, in three states. */}
      {!isWater && b?.energy && (
        <div className="esheet__energy">
          <span className="tnum">{rowFigure(b.energy)} kcal</span>
          {energyState(b.energy) && <span className="esheet__state">{energyState(b.energy)}</span>}
          <Info title="How an entry's energy is counted">
            <p>
              An entry keeps the values it was frozen with — when it was logged, unless this sheet
              says it was corrected or filled in later — so changing the food or the recipe since
              has not moved them. Correcting the entry is the way to change them on purpose.
            </p>
            <p>
              Where at least four-fifths of it by weight has an energy figure, it reads as a figure,
              with how much was measured beside it. Where less does, it reads “≥”, at least this
              much, and where none of it does, “—”. Neither is counted as zero. The day's figure is
              these added up, entry by entry, by the same rule.
            </p>
          </Info>
        </div>
      )}

      {history && <p className="esheet__history">{history}</p>}

      {/* Neither a supplement nor a bottle is a dish, and neither has a cuisine. */}
      {!isSupplement && !isWater && (
        <div className="esheet__tags">
          <div className="esheet__line">
            <span className={tagText(tags) ? "" : "esheet__state"}>
              {tagText(tags, ", ", false) || "Where it came from is not recorded"}
            </span>
            <button className="link" onClick={() => setTagging((t) => !t)} aria-expanded={tagging}>
              {tagging ? "Done" : tagText(tags) ? "Change" : "Add"}
            </button>
          </div>
          {tagging && (
            <TagPicker
              origin={tags.origin}
              cuisine={tags.cuisine}
              onChange={async (origin, cuisine) => {
                // Held here first so the next change in this sheet builds on
                // this one rather than on whatever the last refetch returned.
                setTags({ origin, cuisine });
                try {
                  await setEntryTags(e.id, origin, cuisine);
                  onChanged();
                } catch (err) {
                  setError(String(err));
                }
              }}
            />
          )}
        </div>
      )}

      {isSupplement && parts.length > 0 && (
        <section className="esheet__part">
          <h3 className="esheet__head">
            What the panel says
            <Info title="How a supplement is counted">
              <p>
                Counted per dose rather than by weight, so it adds to the day's nutrients without
                changing how well your food is measured.
              </p>
            </Info>
          </h3>
          {parts.map((c, i) => (
            <div className="breakdown__row" key={i}>
              <span className={c.has_data ? "" : "no-data"}>{c.description}</span>
            </div>
          ))}
        </section>
      )}

      {isCustom && parts.length > 0 && (
        <section className="esheet__part">
          <h3 className="esheet__head">
            Where its values come from
            {gap && (
              <Info title="Why this food reads as unmeasured">
                <p>
                  Nothing is measured for this food, so it counts towards the day as unmeasured
                  rather than as zero — which is why some of the day's nutrients read “—”.
                </p>
              </Info>
            )}
          </h3>
          {parts.map((c, i) => (
            <div className="breakdown__row" key={i}>
              <span className={c.has_data ? "" : "no-data"}>{c.description}</span>
            </div>
          ))}
        </section>
      )}

      {!isCustom && !isSupplement && parts.length > 0 && (
        <section className="esheet__part">
          <h3 className="esheet__head">
            What went into it, by raw weight
            {gap && (
              <Info title="What “no data” means here">
                <p>
                  An ingredient marked “no data” has no composition figures in the reference data.
                  Whatever it contributes is counted as unmeasured for the day, not as zero — which
                  is why some of the day's nutrients read “—” or “≥”.
                </p>
              </Info>
            )}
          </h3>
          {parts.map((c, i) => (
            <div className="breakdown__row" key={i}>
              <span className={c.has_data ? "" : "no-data"}>
                {c.description}
                {!c.has_data && <span className="breakdown__flag"> (no data)</span>}
              </span>
              <span className="tnum">
                {c.grams === null ? "—" : `${c.grams.toFixed(c.grams < 10 ? 1 : 0)} g`}
              </span>
            </div>
          ))}
        </section>
      )}

      {/* A logged entry keeps the nutrition it had when it was logged. This is
          the deliberate way to fix a mistake in it — see CorrectEntry. Behind a
          press because it is rare, and because three forms open by default
          made every entry look like something to be fixed. */}
      {correcting && (
        <section className="esheet__part">
          <h3 className="esheet__head">Correct this entry</h3>
          <CorrectEntry entryId={e.id} onChanged={onChanged} showProvenance={history === null} />
        </section>
      )}

      {error && <p className="alert" role="alert">{error}</p>}

      <div className="esheet__acts">
        <button className="btn btn--quiet" onClick={() => setCorrecting((c) => !c)} aria-expanded={correcting}>
          {correcting ? "Done correcting" : "Correct"}
        </button>
        <button className="btn btn--danger" onClick={remove} disabled={busy}>Remove</button>
      </div>
    </div>
  );
}

/**
 * The marker after an entry's energy, when it is not simply a figure.
 *
 * Including when it is a figure with a gap under it: up to a fifth of an
 * entry by weight can lack an energy figure and it still reads as one, by the
 * rule every total in the app follows. Twelve grams of ghee with no data in a
 * bowl of dal is that case, and ghee is the densest thing in the bowl — so
 * the share that was measured is said, the way the day's sheet says it.
 */
function energyState(t: NonNullable<EntryBreakdown["energy"]>): string | null {
  const s = stateOf(t);
  if (s === "unknown" || rowFigure(t) === "—") return "no energy figure in it";
  if (s === "partial") return "part of it has no energy figure";
  if (t.coverage !== null && t.coverage < 1) return `${Math.round(t.coverage * 100)}% measured`;
  return null;
}
