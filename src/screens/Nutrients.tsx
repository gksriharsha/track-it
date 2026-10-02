import { useState } from "react";
import NutrientRow from "../components/NutrientRow";
import type { DayView, NutrientTotal, TargetBasis } from "../types";
import { read } from "../lib/nutrient";
import { rangeFor, referenceFor } from "../lib/reference";
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
 *
 * A destination on a desktop only now (the sidebar's Nutrients, ⌘2, ⌘K). On a
 * phone the same day's nutrients open as a sheet from the energy line on Today
 * — see `DaySheet`, which reads this screen's grouping and its notes rather
 * than a copy of them. The switch that used to sit at the top of both screens
 * went with that: one day had two addresses, and a sheet gives it one.
 *
 * And it reads the day the way the sheet does. Until it did, the desktop's
 * daily screen still drew a sodium over its Daily Value in the ceiling's red
 * and put "of your target" under energy — a verdict on one day, and a
 * published or estimated figure turned into a commitment — while the sheet
 * beside it, for the same day, promised neither. Each row names what it is
 * read against (`lib/reference.ts`), and nothing on a single day is over.
 */
export default function Nutrients({
  day,
  loading,
  label,
}: {
  day: DayView | null;
  loading: boolean;
  label: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const totals = day?.totals ?? [];
  const energy = day?.energy_target ?? null;
  const ranges = day?.macro_ranges ?? [];

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
                {rows.map((t) => (
                  <NutrientRow key={t.id} t={t} verdict={false}
                    reference={referenceFor(t, energy)} aside={rangeFor(t, ranges)} />
                ))}
              </div>
            </div>
          ))}
        </div>
        {core.length === 0 && (
          <p className="t-sm" style={{ color: "var(--ink-3)", margin: "var(--s3) 0" }}>
            Nothing in this filter.
          </p>
        )}

        {extended.length > 0 && (
          <div className="tier">
            <h3>Limited data</h3>
            <p>{LIMITED_DATA}</p>
            <div className="rows">
              {extended.map((t) => (
                <NutrientRow key={t.id} t={t} verdict={false} reference={referenceFor(t, energy)} />
              ))}
            </div>
          </div>
        )}
      </section>

      <p className="t-cap" style={{ color: "var(--ink-3)", textAlign: "center" }}>
        {basisNote(totals)} “—” means no data, not zero.
      </p>
    </div>
  );
}

/**
 * Why the "Limited data" tier is mostly blanks: the source data, not the day.
 * One sentence, shared with the day's sheet, so the two cannot drift.
 */
export const LIMITED_DATA =
  "Poorly covered by the bundled USDA datasets — iodine, chromium, biotin and " +
  "molybdenum are largely or entirely absent from SR Legacy, and added sugars and " +
  "trans fat are absent from FNDDS. A blank here reflects the source data, not " +
  "your intake.";

/**
 * What the figures beside each amount are, said once instead of on all
 * forty-seven rows.
 *
 * A day can legitimately mix bases — an RDA for most nutrients, the Daily Value
 * for the limits, and the user's own figure wherever they set one — so this
 * describes the mixture rather than asserting a single system.
 *
 * It said "Percentages are of…" until the percentages went: the rows print an
 * amount beside a reference figure now, and a note about percentages under a
 * panel with none in it described a screen that no longer existed.
 */
export function basisNote(totals: NutrientTotal[]): string {
  const bases = new Set(
    totals.map((t) => t.target_basis).filter((b): b is TargetBasis => b !== null),
  );
  if (bases.size === 0) return "Nothing here has a reference figure to compare against.";
  const personal = bases.has("rda") || bases.has("ai");
  // The DRI pass never sets a limit — `targets::resolve` takes those from the
  // Daily Value — so a profile's panel is nearly always a mixture, and a note
  // that said "the DRIs" over a sodium row reading "Daily Value 2,300 mg" was
  // contradicted by the row under it.
  const dv = bases.has("daily_value")
    ? ", with the FDA Daily Value for the limits and for anything the DRIs do not cover"
    : "";
  if (personal && bases.has("user_set")) {
    return `The figures beside each amount are your own where you set one, and the DRIs for your profile otherwise${dv}.`;
  }
  if (personal) return `The figures beside each amount are the DRIs for your profile${dv}.`;
  if (bases.has("user_set")) {
    return "The figures beside each amount are your own where you set one, and the FDA Daily Value otherwise.";
  }
  return "The figures beside each amount are the FDA Daily Value — one adult column, not a figure for you.";
}

/**
 * Consecutive totals of one group, in the order the backend lists them — which
 * is display order, so a group never appears twice.
 */
export function groupBy(totals: NutrientTotal[]): [string, NutrientTotal[]][] {
  const out: [string, NutrientTotal[]][] = [];
  for (const t of totals) {
    const last = out[out.length - 1];
    if (last && last[0] === t.group) last[1].push(t);
    else out.push([t.group, [t]]);
  }
  return out;
}
