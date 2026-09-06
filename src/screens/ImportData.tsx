import { useRef, useState } from "react";
import { datesWithExistingImports, importLogRows } from "../api";
import { parseSpreadsheet } from "../lib/spreadsheet";
import type { ParseReport } from "../lib/spreadsheet";
import { LABEL_NUTRIENTS } from "../types";
import type { ImportRowInput, ImportSummary } from "../types";
import { fmtAmount } from "../lib/nutrient";
import ScreenHead from "../components/ScreenHead";

interface Props {
  onDone: () => void;
  onBack: () => void;
}

/** How many preview rows to show — enough to catch a wrong read, not a second spreadsheet. */
const PREVIEW_ROWS = 10;
/** How many nutrient columns the preview table carries, so a wide file still fits. */
const PREVIEW_NUTRIENTS = 5;

/**
 * Import a spreadsheet of past days.
 *
 * The whole point of everything above the "Import" button is to make a wrong
 * read visible before it is committed — a swapped day/month, a header the
 * parser could not place, a date that already carries an import from a
 * previous run. Nothing here re-derives what `parseSpreadsheet` decided;
 * this screen only shows its report and, once the user has looked at it,
 * hands the surviving rows to the backend.
 */
export default function ImportData(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * Which pick the screen is currently showing. Every await below re-checks it
   * before setting state, so a slow parse, overlap check or import belonging to
   * a file the user has already moved on from is dropped rather than landing on
   * the screen for a different file. Bumped by `reset`, which every new pick
   * runs first.
   */
  const pickId = useRef(0);

  const [fileName, setFileName] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [report, setReport] = useState<ParseReport | null>(null);

  const [checkingOverlap, setCheckingOverlap] = useState(false);
  /** Null until checked (or the check itself failed — see the catch below). */
  const [existingDates, setExistingDates] = useState<string[] | null>(null);
  const [ackOverlap, setAckOverlap] = useState(false);

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  function reset() {
    pickId.current += 1;
    setFileName(null);
    setParsing(false);
    setParseError(null);
    setReport(null);
    setCheckingOverlap(false);
    setExistingDates(null);
    setAckOverlap(false);
    setImporting(false);
    setImportError(null);
    setSummary(null);
  }

  async function pick(file: File) {
    reset();
    const mine = pickId.current;
    setFileName(file.name);
    setParsing(true);
    let r: ParseReport;
    try {
      r = await parseSpreadsheet(file);
      if (pickId.current !== mine) return;
      setReport(r);
    } catch (e) {
      if (pickId.current !== mine) return;
      setParseError(msg(e));
      setParsing(false);
      return;
    }
    setParsing(false);

    if (r.rows.length === 0) return;
    setCheckingOverlap(true);
    try {
      const dates = Array.from(new Set(r.rows.map((row) => row.logged_on as string))).sort();
      const found = await datesWithExistingImports(dates);
      if (pickId.current !== mine) return;
      setExistingDates(found);
    } catch {
      if (pickId.current !== mine) return;
      // This check is a warning, not a gate. Failing open — proceeding as if
      // nothing overlaps — is the safer wrong answer: it never blocks a
      // legitimate import over a transient IPC error, it just means a real
      // overlap goes unflagged this one time.
      setExistingDates(null);
    } finally {
      if (pickId.current === mine) setCheckingOverlap(false);
    }
  }

  async function doImport() {
    if (!report) return;
    const mine = pickId.current;
    setImporting(true);
    setImportError(null);
    try {
      const rows: ImportRowInput[] = report.rows.map((r) => ({
        logged_on: r.logged_on as string,
        meal: r.meal,
        description: r.description,
        nutrients: r.nutrients,
        source_row: r.sourceRow,
      }));
      const result = await importLogRows(rows);
      if (pickId.current !== mine) return;
      setSummary(result);
    } catch (e) {
      if (pickId.current !== mine) return;
      setImportError(msg(e));
    } finally {
      if (pickId.current === mine) setImporting(false);
    }
  }

  const overlapBlocking = existingDates !== null && existingDates.length > 0 && !ackOverlap;
  const canImport =
    !!report && report.rows.length > 0 && !checkingOverlap && !importing && !overlapBlocking;

  const nutrientCols = report ? presentNutrientIds(report).slice(0, PREVIEW_NUTRIENTS) : [];

  return (
    <div className="screen">
      <ScreenHead
        title="Import a tracking file"
        sub="bring in days you already logged elsewhere"
        onBack={p.onBack}
      />

      {/* ── Pick a file ──────────────────────────────────────── */}
      <section className="card">
        <div className="card__head">
          <h2>Pick a file</h2>
          {fileName && !parsing && !checkingOverlap && !importing && (
            <button className="link card__note" onClick={reset}>
              choose a different file
            </button>
          )}
        </div>

        {!fileName || parseError ? (
          <button
            className="imp-drop"
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={parsing}
          >
            <span className="imp-drop__take">{parsing ? "Reading…" : "Choose a .csv or .xlsx file"}</span>
            <span className="imp-drop__hint">
              One row per day (or per meal) you already tracked — a date, and whatever macros or
              other nutrients you have for it.
            </span>
          </button>
        ) : (
          <p className="imp-assume" style={{ margin: 0 }}>
            Reading <strong>{fileName}</strong>
            {parsing ? "…" : ""}
          </p>
        )}

        <p className="imp-assume">
          Dates written as <span className="num">3/4/2024</span> are read as{" "}
          <strong>March 4</strong>, not April 3 — spreadsheet exports from the US write the month
          first. An ISO date like <span className="num">2024-03-04</span> has no such ambiguity
          and is read as written.
        </p>

        <input
          ref={fileInput}
          className="imp-file"
          type="file"
          accept=".csv,.xlsx,.xls"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void pick(f);
          }}
        />

        {parseError && (
          <p className="alert" role="alert" style={{ marginTop: "var(--s3)" }}>
            {parseError}
          </p>
        )}
      </section>

      {report && (
        <>
          {/* ── What this file gives ──────────────────────────── */}
          <section className="card">
            <div className="card__head">
              <h2>What this file gives</h2>
            </div>

            <div className="imp-stats">
              <Stat v={report.rows.length} k={`row${report.rows.length === 1 ? "" : "s"} will import`} />
              <Stat
                v={report.datelessRows.length}
                k={`skipped — no readable date`}
              />
              <Stat v={report.emptyRows.length} k={`skipped — no data on the row`} />
            </div>

            {report.unreadableCells > 0 && (
              <p className="imp-note">
                {report.unreadableCells} cell{report.unreadableCells === 1 ? "" : "s"} had text
                that did not read as a number and {report.unreadableCells === 1 ? "was" : "were"}{" "}
                left out rather than guessed at.
              </p>
            )}

            {report.matchedHeaders.length > 0 && (
              <>
                <div className="group__name" style={{ marginTop: "var(--s4)" }}>
                  Columns understood
                </div>
                <div className="imp-chips">
                  {report.matchedHeaders.map((m) => (
                    <span className="imp-chip imp-chip--ok" key={m.header}>
                      {m.label}
                    </span>
                  ))}
                </div>
              </>
            )}

            {report.unmatchedHeaders.length > 0 && (
              <>
                <div className="group__name" style={{ marginTop: "var(--s4)" }}>
                  Columns not understood
                </div>
                <div className="imp-chips">
                  {report.unmatchedHeaders.map((h) => {
                    const note = unmatchedNote(h);
                    return (
                      <span className="imp-chip imp-chip--miss" key={h}>
                        {h}
                        {note && <span className="imp-chip__note">{note}</span>}
                      </span>
                    );
                  })}
                </div>
                <p className="imp-note">
                  Nothing under these columns was imported — a guessed match would be wrong in a
                  way that is invisible later.
                </p>
              </>
            )}
          </section>

          {report.futureRows.length > 0 && (
            <p className="alert" role="alert">
              {report.futureRows.length} row{report.futureRows.length === 1 ? "" : "s"} parsed to
              a date after today. That is usually a day/month swap, not a real future log —
              check row{report.futureRows.length === 1 ? "" : "s"}{" "}
              {report.futureRows.join(", ")} in the file before importing.
            </p>
          )}

          {checkingOverlap && (
            <p className="imp-note">Checking whether any of these dates were already imported…</p>
          )}

          {existingDates !== null && existingDates.length > 0 && (
            <section className="card">
              <p className="alert" role="alert" style={{ margin: 0 }}>
                {existingDates.length} of these dates already have imported data — importing
                again adds to them rather than replacing them.
              </p>
              <label className="checkline" style={{ borderTop: "none", paddingTop: "var(--s3)" }}>
                <input
                  type="checkbox"
                  checked={ackOverlap}
                  onChange={(e) => setAckOverlap(e.target.checked)}
                />
                <span>
                  <strong>Import anyway.</strong>
                  <span className="checkline__sub">
                    {existingDates.slice(0, 8).join(", ")}
                    {existingDates.length > 8 ? `, and ${existingDates.length - 8} more` : ""}
                  </span>
                </span>
              </label>
            </section>
          )}

          {report.rows.length === 0 ? (
            <div className="empty">
              <h3>Nothing to import</h3>
              <p>
                Every row either had no date this could read, or had a date but no nutrient
                values under it. Fix the file and choose it again — there is nothing to send yet.
              </p>
            </div>
          ) : !summary ? (
            <>
              {/* ── Preview ────────────────────────────────────── */}
              <section className="card">
                <div className="card__head">
                  <h2>Preview</h2>
                  <span className="card__note">
                    first {Math.min(PREVIEW_ROWS, report.rows.length)} of {report.rows.length}
                  </span>
                </div>
                <div className="imp-table-wrap">
                  <table className="imp-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Date</th>
                        <th>Meal</th>
                        <th>Description</th>
                        {nutrientCols.map((id) => {
                          const n = LABEL_NUTRIENTS.find((x) => x.id === id)!;
                          return (
                            <th className="num" key={id}>
                              {n.name} ({n.unit})
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {report.rows.slice(0, PREVIEW_ROWS).map((r) => (
                        <tr key={r.sourceRow}>
                          <td className="num">{r.sourceRow}</td>
                          <td className="num">{r.logged_on}</td>
                          <td>{capitalize(r.meal)}</td>
                          <td>{r.description}</td>
                          {nutrientCols.map((id) => {
                            const hit = r.nutrients.find((n) => n.nutrient_id === id);
                            const meta = LABEL_NUTRIENTS.find((x) => x.id === id)!;
                            return (
                              <td className="num" key={id}>
                                {hit ? fmtAmount(hit.amount, meta.unit) : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {importError && (
                <p className="alert" role="alert">
                  {importError}
                </p>
              )}

              <div className="commit">
                <button className="btn" onClick={doImport} disabled={!canImport}>
                  {importing
                    ? "Importing…"
                    : `Import ${report.rows.length} row${report.rows.length === 1 ? "" : "s"}`}
                </button>
                {importing && (
                  <span className="screen__sub">
                    This can take a moment for a large file — leave this screen open.
                  </span>
                )}
              </div>
            </>
          ) : (
            /* ── Result ─────────────────────────────────────────── */
            <section className="card">
              <div className="card__head">
                <h2>Import finished</h2>
              </div>
              <p style={{ margin: 0 }}>
                {summary.imported} row{summary.imported === 1 ? "" : "s"} imported.
                {summary.failed.length > 0 &&
                  ` ${summary.failed.length} row${summary.failed.length === 1 ? "" : "s"} could not be — see below.`}
              </p>

              {summary.failed.length > 0 && (
                <div className="imp-fails">
                  {summary.failed.map((f) => (
                    <div className="imp-fail" key={f.row}>
                      <span className="imp-fail__row num">Row {f.row}</span>
                      <span>{f.reason}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="commit">
                <button className="btn" onClick={p.onDone}>
                  Done
                </button>
                <button className="btn btn--quiet" onClick={reset}>
                  Import another file
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ v, k }: { v: number; k: string }) {
  return (
    <div>
      <div className="imp-stat__v num">{v}</div>
      <div className="imp-stat__k">{k}</div>
    </div>
  );
}

/** The nutrient ids present anywhere in the parsed rows, in the label's own display order. */
function presentNutrientIds(report: ParseReport): number[] {
  const ids = new Set<number>();
  for (const r of report.rows) for (const n of r.nutrients) ids.add(n.nutrient_id);
  return LABEL_NUTRIENTS.filter((n) => ids.has(n.id)).map((n) => n.id);
}

/**
 * Why a specific unmatched header might have been left alone on purpose,
 * for the two real cases the contract calls out by name. Everything else
 * gets no note — it is simply a column this file did not recognise.
 */
function unmatchedNote(header: string): string | null {
  const h = header.toLowerCase();
  if (/\bnet\s*carbs?\b/.test(h)) {
    return "net carbs is total carbohydrate minus fibre — a different number from total carbohydrate";
  }
  if (/\(iu\)/.test(h) || /\bunits\b/.test(h)) {
    return "IU is not a unit this can convert to grams";
  }
  if (/\bsalt\b/.test(h)) {
    return "salt and sodium differ by about 2.5×, so this was not guessed at";
  }
  const paren = h.match(/\(([^)]+)\)/);
  if (paren && !/^(g|mg|µg|mcg|ug)$/.test(paren[1].trim())) {
    return `the unit in parentheses ("${paren[1].trim()}") is not one this can convert`;
  }
  return null;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function msg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "That file could not be read.";
}
