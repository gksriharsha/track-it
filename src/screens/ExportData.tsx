import { useCallback, useEffect, useMemo, useState } from "react";
import { exportLog, saveExportedFile, shiftIso, todayIso } from "../api";
import { buildExportFile } from "../lib/exportSheet";
import type { ExportKind } from "../lib/exportSheet";
import type { ExportLog } from "../types";
import ScreenHead from "../components/ScreenHead";

interface Props {
  onBack: () => void;
}

type Preset = "7" | "30" | "month" | "custom";

/** What the file writes, and what it does not. Two kinds, and the difference
 * is not cosmetic: a csv is one sheet, so it can only carry one of the three. */
const KINDS: { id: ExportKind; label: string }[] = [
  { id: "xlsx", label: "Spreadsheet (.xlsx)" },
  { id: "csv", label: "CSV" },
];

/**
 * Take the log away as a file.
 *
 * The screen has one job beyond the button: saying what the file will contain
 * BEFORE it is written, so a gap in it is known rather than discovered in a
 * spreadsheet a month later. Three of those statements are the ones that
 * matter — how many figures were left blank and why, that the kitchen behind
 * the log is not in here, and that importing this file back onto this device
 * adds a second copy of every entry rather than replacing anything.
 *
 * There is no progress bar and nothing that fills. An export is one action with
 * two outcomes, and the button's own label carries both.
 */
export default function ExportData({ onBack }: Props) {
  const today = todayIso();
  const [preset, setPreset] = useState<Preset>("30");
  const month = today.slice(0, 7);
  const [customFrom, setCustomFrom] = useState(shiftIso(today, -29));
  const [customTo, setCustomTo] = useState(today);
  const [kind, setKind] = useState<ExportKind>("xlsx");

  const [log, setLog] = useState<ExportLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Null before a save, a name after one that wrote something, and the empty
   * string after one that wrote nothing. Three states, because "nothing was
   * written" has to be sayable without claiming which of its causes it was. */
  const [saved, setSaved] = useState<string | null>(null);

  // The same four presets and the same `range` shape History uses, rather than
  // a second vocabulary for the same idea.
  const range = useMemo(() => {
    if (preset === "7") return { from: shiftIso(today, -6), to: today };
    if (preset === "30") return { from: shiftIso(today, -29), to: today };
    if (preset === "month") return { from: `${month}-01`, to: lastDayOf(month) };
    return { from: customFrom, to: customTo };
  }, [preset, month, customFrom, customTo, today]);

  const load = useCallback(async () => {
    setLoading(true);
    setSaved(null);
    try {
      setLog(await exportLog(range.from, range.to));
      setError(null);
    } catch (e) {
      setLog(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!log) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      // The file is built here and handed over as bytes. The backend never
      // decides a column and this screen never decides a number — see the
      // header of `exportSheet.ts`.
      const file = buildExportFile(log, kind);
      const where = await saveExportedFile(file.name, file.kind, file.dataBase64);
      setSaved(where ?? "");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const entries = log ? log.rows.length + log.doses.length + log.water.length : 0;
  const nothingToWrite = !!log && entries === 0;

  return (
    <div className="screen">
      <ScreenHead
        title="Export your log"
        sub="a spreadsheet of what you logged, saved wherever you choose to put it"
        onBack={onBack}
      />

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {/* ── Which days ───────────────────────────────────────── */}
      <section className="card">
        <div className="card__head">
          <h2>Which days</h2>
        </div>
        <div className="chips">
          {(["7", "30", "month", "custom"] as Preset[]).map((p) => (
            <button
              key={p}
              className="chip"
              aria-pressed={preset === p}
              onClick={() => setPreset(p)}
            >
              {presetLabel(p, month)}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="exp-dates">
            <label className="exp-date">
              <span className="group__name">From</span>
              <input
                className="field"
                type="date"
                value={customFrom}
                max={today}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </label>
            <label className="exp-date">
              <span className="group__name">To</span>
              <input
                className="field"
                type="date"
                value={customTo}
                max={today}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </label>
          </div>
        )}
      </section>

      {/* ── Which file ───────────────────────────────────────── */}
      <section className="card">
        <div className="card__head">
          <h2>Which file</h2>
        </div>
        <div className="chips">
          {KINDS.map((k) => (
            <button
              key={k.id}
              className="chip"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <p className="exp-note">
          {kind === "csv"
            ? "A csv holds one sheet, so it carries the food and leaves out the supplements and the water."
            : "Three sheets: the food, then the supplements and the water behind it. Only the first sheet is the one this app reads back."}
        </p>
      </section>

      {/* ── What is in the file ──────────────────────────────── */}
      <section className="card">
        <div className="card__head">
          <h2>What is in the file</h2>
          <span className="card__note">
            {range.from} to {range.to}
          </span>
        </div>

        {loading ? (
          <p className="exp-note">Reading the log…</p>
        ) : nothingToWrite ? (
          <p className="exp-note">Nothing was logged in this period, so there is nothing to write.</p>
        ) : (
          log && (
            <div className="exp-what">
              {/* Plain sans throughout this block, including the figures.
                  Newsreader is the app's one typographic signal and it marks an
                  aggregate worth dwelling on; a serif numeral inside a 13px
                  sentence about a file is not that, and spending the signal
                  here would cheapen it where it is doing real work. */}
              <p className="exp-what__line">
                {count(log.rows.length, "food entry", "food entries")} across{" "}
                {count(log.days, "day", "days")}.
                {aside(log.doses.length, log.water.length, kind)}
              </p>

              {/* The fifteen columns are the importer's own vocabulary, which
                  is what makes the file readable back. It is also a real limit
                  on what the file records, and one worth saying: a supplement
                  panel can list nutrients no nutrition label prints, and those
                  have no column here. */}
              <p className="exp-what__line">
                Each row carries the fifteen figures a nutrition label prints — energy, the
                macronutrients, sodium, vitamin D, calcium, iron and potassium. Anything else a
                pack or a panel told this app is not in the file.
              </p>

              {log.blanks > 0 && (
                <p className="exp-what__line">
                  {log.blanks.toLocaleString()} cells will be left
                  blank, because those entries were not exactly known for that nutrient. A blank
                  is not a zero, on the way out or on the way back in.
                </p>
              )}

              {log.rows_without_values > 0 && (
                <p className="exp-what__line">
                  {log.rows_without_values === 1
                    ? "One row names what was eaten with no figures at all. It is written down anyway; read back in, it is reported and nothing is added."
                    : `${log.rows_without_values.toLocaleString()} rows name what was eaten with no figures at all. They are written down anyway; read back in, they are reported and nothing is added.`}
                </p>
              )}

              {log.unexportable > 0 && (
                <p className="exp-what__line">
                  {log.unexportable}{" "}
                  {log.unexportable === 1 ? "entry has" : "entries have"} no stored nutrition, so{" "}
                  {log.unexportable === 1 ? "it is" : "they are"} left out. Reopening the day they
                  are on records what the app can still work out for them.
                </p>
              )}

              <p className="exp-what__line">
                This is the log. Your recipes, your own foods, your supplements, your vessels and
                your bottles are not in it, and there is no separate export for them yet.
              </p>

              {/* The one warning on this screen, and it is about what happens
                  next rather than about the file. The importer's duplicate
                  guard only recognises days that already carry an IMPORT, so a
                  first-generation export re-imported here passes it silently
                  and doubles every day it covers. */}
              <p className="exp-what__line">
                Reading this file back in on this device adds a second copy of every entry in it —
                it does not replace what is already here. It is for keeping, and for a device that
                does not have this log.
              </p>
            </div>
          )
        )}
      </section>

      <div className="commit">
        <button className="btn" onClick={save} disabled={loading || saving || nothingToWrite}>
          {saving ? "Saving…" : "Save the file"}
        </button>
        {saved !== null && (
          <span className="exp-done">
            {saved === "" ? "Nothing was written." : `Saved as ${saved}`}
          </span>
        )}
      </div>

      {/* Said here rather than in the subtitle, where it would be a caption
          nobody reads: on Android the picker lists Drive and every other
          document provider on the phone beside its own storage, so where this
          file ends up is a choice being made in the next tap. */}
      <p className="exp-note">
        The next step is your device's own save panel. Wherever you point it — this device, or a
        cloud account it offers you — is where the file goes.
      </p>
    </div>
  );
}

/** "1 day", "30 days" — the plural decided once rather than at every call. */
function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * What rides along behind the log, or nothing at all.
 *
 * Written as a whole clause rather than assembled from two counts because
 * neither zero is worth a sentence: "0 supplement doses and 2 bottles" reads as
 * a form with an empty field in it, and a period with no doses and no bottles
 * should say nothing about either.
 */
function aside(doses: number, water: number, kind: ExportKind): string {
  const parts = [
    doses > 0 ? count(doses, "supplement dose", "supplement doses") : null,
    water > 0 ? count(water, "bottle", "bottles") : null,
  ].filter((x): x is string => x !== null);
  if (parts.length === 0) return "";
  const both = parts.join(" and ");
  return kind === "csv"
    ? ` ${both} were logged too, and a csv leaves them out.`
    : ` ${both}, on their own sheets.`;
}

function presetLabel(p: Preset, month: string): string {
  if (p === "7") return "Last 7 days";
  if (p === "30") return "Last 30 days";
  if (p === "month") return monthName(month);
  return "Pick the days";
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Day 0 of the next month is the last day of this one, which avoids a table
 * of month lengths and a leap-year rule — the same trick History uses. */
function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m, 0);
  return todayIso(d);
}
