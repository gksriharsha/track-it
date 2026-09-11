import { useState } from "react";
import DayTabs from "../components/DayTabs";
import NutrientRow from "../components/NutrientRow";
import type { DayView, NutrientTotal, TargetBasis } from "../types";
import { read } from "../lib/nutrient";
import ScreenHead from "../components/ScreenHead";

type Filter = "all" | "measured" | "unknown";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "measured", label: "Measured" },
  { id: "unknown", label: "Not measured" },
];

/**
 * The full panel, on its own screen rather than crowding the dashboard.
 *
 * Grouped, and split into a core tier and a "limited data" tier so a blank
 * reads as a known gap in the source data rather than as a personal deficiency.
 */
export default function Nutrients({
  day,
  loading,
  label,
  onDay,
}: {
  day: DayView | null;
  loading: boolean;
  label: string;
  /** Back to the list this panel counts. See DayTabs — on a phone they are one screen. */
  onDay: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const totals = day?.totals ?? [];

  const keep = (t: NutrientTotal) => {
    const s = read(t).state;
    if (filter === "measured") return s === "measured";
    if (filter === "unknown") return s !== "measured";
    return true;
  };

  const core = groupBy(totals.filter((t) => t.tier === "core" && keep(t)));
  const extended = totals.filter((t) => t.tier === "extended" && keep(t));
  const logged = totals.some((t) => t.total.items_total > 0);

  if (loading) {
    return (
      <div className="screen">
        <div className="card">
          {Array.from({ length: 10 }, (_, i) => (
            <div className="skel skel--row" key={i} style={{ width: `${95 - i * 5}%` }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      {/* Phone only: this panel and Today's list are two readings of one day,
          and the switch is what says so. */}
      <DayTabs current="nutrients" onDay={onDay} onNutrients={() => {}} />

      {/* The day is the title, exactly as it is on Today — these are two
          readings of one day and the heading should not change between them.
          It used to read "Nutrients" over a switch whose selected half already
          said Nutrients, with the date demoted to a caption; which day you are
          reading is the thing the heading has to carry. */}
      <ScreenHead
        title={label}
        action={
          <div className="chips">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className="chip"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      />

      {!logged && (
        <div className="empty">
          <h3>Nothing logged for {label.toLowerCase()}</h3>
          <p>Every nutrient is listed below so you can see what is tracked, but there is
            nothing to total yet.</p>
        </div>
      )}

      <section className="card">
        {/* The core tier is wrapped so it alone can flow into two columns on a
            wide window — see `.panel`. The "Limited data" tier below stays one
            column: it opens with a paragraph explaining what the blanks mean,
            and a paragraph split down a 540px column reads as two paragraphs. */}
        <div className="panel">
          {core.map(([group, rows]) => (
            <div className="group" key={group}>
              <div className="group__name">{group}</div>
              <div className="rows">
                {rows.map((t) => <NutrientRow key={t.id} t={t} />)}
              </div>
            </div>
          ))}
        </div>
        {core.length === 0 && (
          <p style={{ color: "var(--ink-3)", fontSize: 14, margin: "var(--s3) 0" }}>
            Nothing in this filter.
          </p>
        )}

        {extended.length > 0 && (
          <div className="tier">
            <h3>Limited data</h3>
            <p>
              Poorly covered by the bundled USDA datasets — iodine, chromium, biotin and
              molybdenum are largely or entirely absent from SR Legacy, and added sugars and
              trans fat are absent from FNDDS. A blank here reflects the source data, not
              your intake.
            </p>
            <div className="rows">
              {extended.map((t) => <NutrientRow key={t.id} t={t} />)}
            </div>
          </div>
        )}
      </section>

      <p style={{ color: "var(--ink-3)", fontSize: 12, textAlign: "center" }}>
        {basisNote(totals)} “—” means no data, not zero.
      </p>
    </div>
  );
}

/**
 * What the percentages on this screen are against, said once at the foot
 * instead of on all forty-seven rows.
 *
 * A day can legitimately mix bases — an RDA for most nutrients, the Daily Value
 * for the limits, and the user's own figure wherever they set one — so this
 * describes the mixture rather than asserting a single system.
 */
function basisNote(totals: NutrientTotal[]): string {
  const bases = new Set(
    totals.map((t) => t.target_basis).filter((b): b is TargetBasis => b !== null),
  );
  if (bases.size === 0) return "Nothing here has a reference figure to compare against.";
  const personal = bases.has("rda") || bases.has("ai");
  if (personal && bases.has("user_set")) {
    return "Percentages are of your own targets where you set them, and of the DRIs for your profile otherwise.";
  }
  if (personal) return "Percentages are of the DRIs for your profile.";
  if (bases.has("user_set")) {
    return "Percentages are of your own targets where you set them, and of the FDA Daily Value otherwise.";
  }
  return "Percentages are of the FDA Daily Value — one adult column, not a figure for you.";
}

function groupBy(totals: NutrientTotal[]): [string, NutrientTotal[]][] {
  const out: [string, NutrientTotal[]][] = [];
  for (const t of totals) {
    const last = out[out.length - 1];
    if (last && last[0] === t.group) last[1].push(t);
    else out.push([t.group, [t]]);
  }
  return out;
}
