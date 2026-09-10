/**
 * Turns an `ExportLog` into the bytes of a spreadsheet the person keeps — and,
 * decisively, one this app can read straight back in.
 *
 * That last property is why this module exists at all rather than the bytes
 * being written in Rust. Every column here is named out of `LABEL_NUTRIENTS`,
 * which is the same list `matchHeader` in `spreadsheet.ts` builds its own
 * lookup from, so a header this writer emits is a header that reader
 * recognises by construction and not by two lists happening to agree. The
 * backend decided every NUMBER, out of what each entry was frozen with; this
 * decides every COLUMN. Neither half can drift into the other's job.
 *
 * Pure, and it stays pure: no bridge import and no Tauri import, exactly as
 * `spreadsheet.ts`'s own header promises, which is what lets
 * `exportSheet.test.ts` run the whole round trip in a bare Node process with
 * nothing installed.
 */
import * as XLSX from "xlsx";
import { IMPORTED_ENTRY_DESCRIPTION } from "./spreadsheet.ts";
import { LABEL_NUTRIENTS } from "../types.ts";
import type {
  ExportDoseRow,
  ExportLog,
  ExportLogRow,
  ExportNutrient,
  ExportWaterRow,
} from "../types.ts";

/* ── the public shapes ───────────────────────────────────────────────── */

export type ExportKind = "xlsx" | "csv";

export interface SheetFile {
  /** What the save panel is offered as a name, extension included. */
  name: string;
  kind: ExportKind;
  /** Bare RFC 4648 base64, no data-URL prefix — the convention every other
   * byte payload in this app already uses (see `saveFoodPhoto`). */
  dataBase64: string;
}

/**
 * Sheet names, and the ORDER is load-bearing.
 *
 * `parseSpreadsheet` reads `workbook.SheetNames[0]` and nothing else, so the
 * log has to be first and the other two are invisible to it. That is not a
 * limitation being worked around; it is what keeps a dose from being read back
 * as a 100 g food and a bottle from being given a meal it cannot have.
 */
const LOG_SHEET = "Log";
const DOSE_SHEET = "Supplements";
const WATER_SHEET = "Water";

/* ── headers ──────────────────────────────────────────────────────────── */

/**
 * Micrograms as `mcg`, everything else unchanged.
 *
 * Not cosmetic. It keeps every header pure ASCII, so a csv needs no byte-order
 * mark, nothing has to strip one on the way back, and Excel does not render
 * `Âµg` where a µ was meant. `canonicalMassUnit` folds `mcg` and `µg` to the
 * same token, so the column still matches with no conversion applied — and it
 * is also how a pack prints it.
 */
function asciiUnit(unit: string): string {
  return unit === "µg" ? "mcg" : unit;
}

/**
 * The fifteen nutrient columns, in the label's own printing order.
 *
 * Exported for the round-trip proof, which puts every one of these through
 * `matchHeader` and asserts that none of them needs a unit conversion. That
 * test is the thing standing between this file and a column the importer
 * silently drops.
 */
export function nutrientHeaders(): string[] {
  return LABEL_NUTRIENTS.map((n) => `${n.name} (${asciiUnit(n.unit)})`);
}

/** The log sheet's header row: the three columns that place a row, then the
 * nutrients. */
export function logHeaders(): string[] {
  return ["Date", "Meal", "Description", ...nutrientHeaders()];
}

/* ── rows ─────────────────────────────────────────────────────────────── */

const COLUMN_IDS: number[] = LABEL_NUTRIENTS.map((n) => n.id);
const NAMEABLE: Set<number> = new Set(COLUMN_IDS);

/**
 * One row's nutrient cells, in column order, with `null` for a blank.
 *
 * `null` rather than `""` or `0`: `XLSX.utils.aoa_to_sheet` emits no cell at
 * all for it, and `sheet_to_json({ defval: null })` hands the blank straight
 * back — which is how "not tracked" survives a whole round trip instead of
 * becoming a confident zero somewhere in the middle of it.
 *
 * An id no column can be named for throws rather than being dropped. It means
 * the backend's `EXPORT_NUTRIENTS` and `LABEL_NUTRIENTS` have parted company,
 * and a nutrient quietly missing from every export is a far worse outcome than
 * a refused one.
 */
function nutrientCells(nutrients: ExportNutrient[]): (number | null)[] {
  const byId = new Map<number, number>();
  for (const n of nutrients) {
    if (!NAMEABLE.has(n.nutrient_id)) {
      throw new Error(
        `Nutrient ${n.nutrient_id} has no column in this file. The export and the importer no longer agree on which nutrients a row carries.`,
      );
    }
    byId.set(n.nutrient_id, n.amount);
  }
  return COLUMN_IDS.map((id) => (byId.has(id) ? (byId.get(id) as number) : null));
}

/**
 * The description a row is written with.
 *
 * A blank one is written as the very words the reader would substitute for it,
 * which is the only way the file is a fixed point: `parseSpreadsheet` and
 * `import_one_row` both turn an empty description into
 * `IMPORTED_ENTRY_DESCRIPTION`, so writing the empty string would mean a file
 * that came back subtly different from the one that went out. This is not
 * inventing a name for something — it is writing down the name the reader is
 * going to give it anyway.
 */
function description(raw: string): string {
  return raw.trim() || IMPORTED_ENTRY_DESCRIPTION;
}

/** Capitalised for a person reading the file; `normalizeMeal` lowercases
 * whatever it is given, so the round trip is unaffected. */
function meal(raw: string): string {
  return raw.length === 0 ? raw : raw[0].toUpperCase() + raw.slice(1);
}

function logAoa(rows: ExportLogRow[]): unknown[][] {
  return [
    logHeaders(),
    ...rows.map((r) => [
      // A text cell, never a date-typed one. The long comment on
      // `isBinaryWorkbook` records what typed date cells cost on the way in;
      // there is no reason to re-enter that minefield on the way out when this
      // side controls the writer, and `parseDateCell`'s ISO branch has no
      // timezone anywhere in it.
      r.logged_on,
      meal(r.meal),
      description(r.description),
      ...nutrientCells(r.nutrients),
    ]),
  ];
}

function doseAoa(doses: ExportDoseRow[]): unknown[][] {
  return [
    ["Date", "Meal", "Supplement", "Units", ...nutrientHeaders()],
    ...doses.map((d) => [
      d.logged_on,
      meal(d.meal),
      description(d.description),
      d.units,
      ...nutrientCells(d.nutrients),
    ]),
  ];
}

function waterAoa(water: ExportWaterRow[]): unknown[][] {
  return [
    // "Bottle weighed empty" rather than a bare "Measured": the column is
    // saying where the conversion from grams came from, and one word on its own
    // would read as a judgement of the figure instead.
    ["Date", "Bottle", "Water (ml)", "Bottle weighed empty"],
    ...water.map((w) => [w.logged_on, description(w.description), w.ml, w.measured ? "yes" : "no"]),
  ];
}

/* ── bytes ────────────────────────────────────────────────────────────── */

/**
 * Base64 in 8 KB chunks.
 *
 * One `String.fromCharCode(...bytes)` over a few hundred kilobytes exceeds the
 * argument limit and throws, which would turn a large export into an error
 * nobody could act on.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 8 * 1024;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/**
 * `TrackIt log 2026-08-11 to 2026-09-09.xlsx`.
 *
 * Spaces and ASCII hyphens only. This string becomes `EXTRA_TITLE` in the
 * Android picker and the pre-filled name in the Mac save panel, and both are
 * happier without punctuation; Rust sweeps it again before either sees it.
 */
export function exportFileName(from: string, to: string, kind: ExportKind): string {
  const period = from === to ? from : `${from} to ${to}`;
  return `TrackIt log ${period}.${kind}`;
}

/**
 * The whole file, ready to hand to `saveExportedFile`.
 *
 * A csv is one sheet by definition, so it carries the log and leaves the
 * supplements and the water out. That is stated on the screen rather than
 * discovered afterwards.
 */
export function buildExportFile(log: ExportLog, kind: ExportKind): SheetFile {
  const logSheet = XLSX.utils.aoa_to_sheet(logAoa(log.rows));
  const name = exportFileName(log.from, log.to, kind);

  if (kind === "csv") {
    const text = XLSX.utils.sheet_to_csv(logSheet);
    return { name, kind, dataBase64: toBase64(new TextEncoder().encode(text)) };
  }

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, logSheet, LOG_SHEET);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(doseAoa(log.doses)), DOSE_SHEET);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(waterAoa(log.water)), WATER_SHEET);

  // `type: "array"` yields an ArrayBuffer, not a Uint8Array, whatever the name
  // suggests. Handing the buffer itself to `toBase64` reads its `length` as
  // undefined and produces an empty file with no error anywhere.
  const buffer = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return { name, kind, dataBase64: toBase64(new Uint8Array(buffer)) };
}
