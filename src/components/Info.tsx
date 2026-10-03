import type { ReactNode } from "react";
import { useHashSheetValue } from "../lib/hashSheet";
import Sheet from "./Sheet";

/**
 * The note in the margin: a small (i) beside a figure, and behind it the
 * working.
 *
 * The page keeps the state of a figure — "≥", "—", "about", "pot not weighed"
 * — because that is what a person needs at the moment of reading it. How the
 * figure was arrived at is method, and method printed as standing prose under
 * every figure is what made the app read as bloated: nearly half the words on
 * its phone screens were explanation. Nothing honest is deleted to make room;
 * it is moved one tap away, here, and the tap is always next to the thing it
 * explains.
 *
 * Its own hash param, so Back closes it — and so it can open over an entry's
 * sheet and close back down to it. Keyed by the title, which is also what the
 * button is named after, so two of them on one screen need two titles or an
 * `id` each.
 */
export default function Info(p: {
  /** What it is about, as the sheet's heading: "How the day's energy is counted". */
  title: string;
  children: ReactNode;
  /** When two (i)s on one screen would share a title. */
  id?: string;
}) {
  const sheet = useHashSheetValue("info");
  const key = p.id ?? slug(p.title);
  return (
    <>
      <button
        type="button"
        className="info"
        aria-label={`About ${p.title}`}
        aria-haspopup="dialog"
        onClick={(e) => {
          // A row that opens its own sheet must not open it too: the (i) is a
          // question about the row, not a press on it.
          e.stopPropagation();
          sheet.show(key);
        }}
      >
        <svg className="info__glyph" viewBox="0 0 22 22" aria-hidden>
          <circle cx="11" cy="11" r="9.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="11" cy="7" r="1.15" fill="currentColor" />
          <path d="M11 10v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>
      <Sheet open={sheet.value === key} onClose={sheet.hide} title={p.title}>
        <div className="info__body">{p.children}</div>
      </Sheet>
    </>
  );
}

/** "Coverage, and what — means" → "coverage-and-what-means". */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "info";
}
