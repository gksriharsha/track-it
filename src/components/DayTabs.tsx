/**
 * The two ways of reading one day, as one control.
 *
 * "Nutrients" used to be a destination sitting beside Trends and Days in the
 * navigation, which is what made those three names impossible to tell apart —
 * nothing in "Nutrients" says it holds one day, and nothing in "Days" says it
 * does not. It is not a place. It is the same day the list above it describes,
 * counted a different way, and a switch is what says that.
 *
 * Phone only. On a wide window the nutrient panel runs two columns beside a
 * two-column Today and both earn a destination of their own — see the desktop
 * sidebar, which still lists them separately.
 */
export default function DayTabs({
  current, onDay, onNutrients,
}: {
  current: "day" | "nutrients";
  onDay: () => void;
  onNutrients: () => void;
}) {
  return (
    /* A nav, not a tablist. It looks like a segmented control and it behaves
       like one, but each half is a different screen at a different address —
       `role="tab"` would promise a panel that changes in place, and a screen
       reader would go looking for the tabpanel that never arrives. */
    <nav className="dayviews" aria-label="How to read this day">
      <button
        className="dayviews__tab"
        aria-current={current === "day" ? "page" : undefined}
        onClick={onDay}
      >
        What you had
      </button>
      <button
        className="dayviews__tab"
        aria-current={current === "nutrients" ? "page" : undefined}
        onClick={onNutrients}
      >
        Nutrients
      </button>
    </nav>
  );
}
