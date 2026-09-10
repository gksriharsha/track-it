/**
 * Parses a .csv/.xlsx/.xls file of past tracking into rows the backend can
 * write, without ever touching the network or the Tauri bridge — every
 * function here is pure and callable from a plain Node script, which is how
 * this module is proved out (see the throwaway scripts run alongside it).
 *
 * The frontend/backend split is a hard boundary for this feature: reading a
 * binary spreadsheet, matching headers to nutrients, and normalising dates
 * all happen here, in TypeScript, using the already-installed `xlsx`
 * (SheetJS) package. The Rust side receives an already-clean array and does
 * nothing but validate and write it — see `import_log_rows` in lib.rs.
 *
 * The import below names `../types.ts` with its extension, which is the one
 * place in this tree that does. It is not a stray edit: this module and
 * `exportSheet.ts` are the two the committed round-trip proof runs directly,
 * with `node src/lib/exportSheet.test.ts` and nothing else installed, and
 * Node's own TypeScript loader resolves a relative import exactly as ESM does
 * — no extension guessing. `tsconfig.json` already sets
 * `allowImportingTsExtensions`, and Vite resolves it unchanged, so the cost is
 * one visible extension and the gain is a proof that runs with no toolchain.
 */
import * as XLSX from "xlsx";
import { LABEL_NUTRIENTS, MEALS, type Meal } from "../types.ts";

/* ── the public shapes ───────────────────────────────────────────────── */

export interface ParsedRow {
  /** ISO date, or null if this row's date could not be read. */
  logged_on: string | null;
  meal: Meal;
  description: string;
  nutrients: { nutrient_id: number; amount: number }[];
  /** 1-based, counting the header row as row 1 — matches what a person sees
   * if they open the file themselves. */
  sourceRow: number;
}

export interface ParseReport {
  /** Only rows with a non-null date and at least one nutrient value. */
  rows: ParsedRow[];
  /** Column headers nobody could place. */
  unmatchedHeaders: string[];
  /** What each recognised column means. */
  matchedHeaders: { header: string; label: string }[];
  /** sourceRow numbers dropped for an unreadable date. */
  datelessRows: number[];
  /** sourceRow numbers dropped for having zero nutrient values. */
  emptyRows: number[];
  /** sourceRow numbers whose date parsed but landed after today. */
  futureRows: number[];
  /** Count of individual cells that had text but did not parse as a number. */
  unreadableCells: number;
}

/* ── header normalisation ────────────────────────────────────────────── */

/**
 * Lowercase, trim, collapse internal whitespace, and split off a trailing
 * parenthetical as a unit hint — "Sodium (mg)" -> { name: "sodium", unitHint: "mg" }.
 * The parenthetical is optional; a header with none gets `unitHint: null`.
 */
export function normalizeHeader(header: string): { name: string; unitHint: string | null } {
  const folded = header.toLowerCase().trim().replace(/\s+/g, " ");
  const m = folded.match(/^(.*?)\s*\(([^()]*)\)$/);
  if (m && m[1].trim() !== "") {
    return { name: m[1].trim(), unitHint: m[2].trim() };
  }
  return { name: folded, unitHint: null };
}

const DATE_HEADERS = new Set(["date", "day", "logged on", "logged_on", "log date"]);
const MEAL_HEADERS = new Set(["meal", "meal type", "mealtype"]);
const DESCRIPTION_HEADERS = new Set([
  "food",
  "description",
  "notes",
  "name",
  "label",
  "item",
  "meal description",
]);

/**
 * Synonyms for each of the 15 label nutrients, on top of the nutrient's own
 * `LABEL_NUTRIENTS` name (matched separately below, case/whitespace-folded
 * the same way as everything else).
 *
 * Two entries are deliberately narrow: "salt" is NOT a sodium synonym (salt
 * and sodium differ by a factor of ~2.5 — treating them as the same word
 * would be a silent, meaningful error), and "net carbs"/"net carb" are NOT
 * total-carbohydrate synonyms (net carbs is carbs minus fibre, a different
 * number). A column using either word is left unmatched.
 */
const NUTRIENT_SYNONYMS: Record<number, string[]> = {
  1008: ["calories", "energy", "kcal", "cals"], // Energy
  1004: ["fat", "total fat"], // Total fat
  1258: ["saturated fat", "sat fat", "saturates"], // Saturated fat
  1257: ["trans fat", "trans"], // Trans fat
  1253: ["cholesterol", "chol"], // Cholesterol
  1093: ["sodium"], // Sodium
  1005: ["carbs", "carbohydrate", "carbohydrates", "total carb", "total carbs"], // Total carbohydrate
  1079: ["fiber", "fibre", "dietary fiber"], // Dietary fiber
  2000: ["sugar", "sugars", "total sugar", "total sugars"], // Total sugars
  1235: ["added sugar", "added sugars"], // Added sugars
  1003: ["protein"], // Protein
  1114: ["vitamin d", "vit d", "vit. d"], // Vitamin D
  1087: ["calcium"], // Calcium
  1089: ["iron"], // Iron
  1092: ["potassium", "potas", "potas."], // Potassium
};

/** normalized header text -> nutrient id, built once from LABEL_NUTRIENTS'
 * own names plus NUTRIENT_SYNONYMS. */
const NUTRIENT_LOOKUP: Map<string, number> = (() => {
  const map = new Map<string, number>();
  for (const n of LABEL_NUTRIENTS) {
    map.set(normalizeHeader(n.name).name, n.id);
  }
  for (const [idStr, synonyms] of Object.entries(NUTRIENT_SYNONYMS)) {
    const id = Number(idStr);
    for (const s of synonyms) map.set(s, id);
  }
  return map;
})();

const NUTRIENT_BY_ID: Map<number, { id: number; name: string; unit: string }> = new Map(
  LABEL_NUTRIENTS.map((n) => [n.id, n]),
);

/* ── unit-hint conversion ─────────────────────────────────────────────── */

type MassUnit = "g" | "mg" | "ug";

/** g/mg/µg/mcg/ug, folded to one of three canonical tokens; null for anything
 * else (IU, oz, a typo) — the caller must NOT guess a factor for those. */
function canonicalMassUnit(unit: string): MassUnit | null {
  const s = unit.toLowerCase().trim();
  if (s === "g") return "g";
  if (s === "mg") return "mg";
  if (s === "µg" || s === "ug" || s === "mcg") return "ug";
  return null;
}

/** Power-of-ten exponent relative to grams, for converting between mass units. */
const MASS_EXPONENT: Record<MassUnit, number> = { g: 0, mg: -3, ug: -6 };

export function convertMass(amount: number, from: MassUnit, to: MassUnit): number {
  if (from === to) return amount;
  return amount * Math.pow(10, MASS_EXPONENT[from] - MASS_EXPONENT[to]);
}

/* ── header matching ──────────────────────────────────────────────────── */

export type ColumnMatch =
  | { kind: "date"; label: "Date" }
  | { kind: "meal"; label: "Meal" }
  | { kind: "description"; label: "Description" }
  | {
      kind: "nutrient";
      nutrientId: number;
      label: string;
      /** Set when the header's unit hint differs from the nutrient's own
       * unit and both are convertible mass units — the amount from this
       * column must be run through `convertMass` before use. */
      convertFrom: MassUnit | null;
    };

/**
 * What one raw header means, or null if it matches nothing (either the name
 * is unrecognised, or it named a unit hint that cannot be converted to the
 * nutrient's own unit — an unsupported unit is treated exactly like an
 * unrecognised name, never silently applied with no conversion).
 */
export function matchHeader(rawHeader: string): ColumnMatch | null {
  const { name, unitHint } = normalizeHeader(rawHeader);
  if (DATE_HEADERS.has(name)) return { kind: "date", label: "Date" };
  if (MEAL_HEADERS.has(name)) return { kind: "meal", label: "Meal" };
  if (DESCRIPTION_HEADERS.has(name)) return { kind: "description", label: "Description" };

  const nutrientId = NUTRIENT_LOOKUP.get(name);
  if (nutrientId == null) return null;
  const meta = NUTRIENT_BY_ID.get(nutrientId)!;

  if (unitHint == null) {
    return { kind: "nutrient", nutrientId, label: meta.name, convertFrom: null };
  }

  // A hint that simply restates the nutrient's own unit needs no conversion and
  // must not be held to the mass-unit table: Energy's own unit is "kcal", so
  // "Energy (kcal)" and "Calories (kcal)" — far and away the most common way
  // this column is written — were being rejected outright and the whole column
  // dropped for the file.
  if (unitHint.toLowerCase() === meta.unit.toLowerCase()) {
    return { kind: "nutrient", nutrientId, label: meta.name, convertFrom: null };
  }

  const hintUnit = canonicalMassUnit(unitHint);
  const ownUnit = canonicalMassUnit(meta.unit);
  if (hintUnit == null) {
    // Names something we cannot convert (IU, oz, a typo) — never guess.
    return null;
  }
  if (ownUnit == null) {
    // The nutrient's own unit isn't a mass unit (Energy is "kcal"), so a mass
    // hint that differs from it has no defined factor either — same refusal.
    return null;
  }
  if (hintUnit === ownUnit) {
    return { kind: "nutrient", nutrientId, label: meta.name, convertFrom: null };
  }
  return { kind: "nutrient", nutrientId, label: meta.name, convertFrom: hintUnit };
}

/* ── cell parsing ─────────────────────────────────────────────────────── */

export type CellNumberResult =
  | { kind: "blank" }
  | { kind: "value"; amount: number }
  | { kind: "unreadable" };

/**
 * A blank cell (null/undefined/empty-after-trim) is "not tracked that day" —
 * never a zero. Text that parses to a finite, non-negative number is a value.
 * A negative amount is treated as unreadable (a nutrient amount cannot be
 * real below zero), same as text that does not parse as a number at all —
 * both are reported, but neither becomes a nutrient row.
 */
export function parseCellNumber(cell: unknown): CellNumberResult {
  if (cell === null || cell === undefined) return { kind: "blank" };
  const s = String(cell).trim();
  if (s === "") return { kind: "blank" };
  // Thousands separators reach us from CSV text, which carries no cell format
  // to strip. Only a strict 3-digit grouping is unpicked: "1,234" and
  // "1,234.50" are 1234 and 1234.5, while "1,5" — a decimal comma in some
  // locales — deliberately does NOT match and stays unreadable. Guessing there
  // would turn 1.5 into 15, and a flagged cell beats a tenfold error.
  const grouped = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s);
  const n = Number(grouped ? s.replace(/,/g, "") : s);
  if (!Number.isFinite(n)) return { kind: "unreadable" };
  if (n < 0) return { kind: "unreadable" };
  return { kind: "value", amount: n };
}

/**
 * Whether these bytes are a real workbook rather than delimited text — a zip
 * (.xlsx, "PK\u0003\u0004") or a compound binary file (.xls, D0 CF 11 E0).
 * Sniffed from content rather than the file name, which nothing verifies.
 *
 * This decides how the file is read, and it has to, because SheetJS cannot be
 * trusted to interpret a DATE in delimited text. Every mode it offers for CSV
 * is timezone-corrupted at read time: "2024-01-15" becomes a Date at UTC
 * midnight while "3/4/2024" becomes one at LOCAL midnight, so no single getter
 * reads both correctly; asking for display text hands back a re-formatted
 * "1/14/24" west of UTC; and switching `cellDates` off yields a FRACTIONAL
 * serial (45305.708) that is already shifted. An entire import would land a day
 * early across the Americas. Verified across six timezones, Auckland to Phoenix.
 *
 * So text is read with `raw: true`, which turns SheetJS's type inference off
 * entirely and keeps each cell as the characters the file contained — dates
 * then go through this module's own ISO/US parser, which has no timezone in it
 * at all. A real workbook has genuine typed cells and no such ambiguity, so it
 * is read as values, with `cellDates` giving Date objects at local midnight.
 */
function isBinaryWorkbook(buf: ArrayBuffer): boolean {
  const head = new Uint8Array(buf.slice(0, 4));
  if (head.length < 4) return false;
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const cfb = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  return zip || cfb;
}

/* ── date parsing ─────────────────────────────────────────────────────── */

export interface DateParseResult {
  /** ISO YYYY-MM-DD, or null if this cell could not be read as a date. */
  iso: string | null;
  /** True when the parsed date is later than today's local date. */
  future: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local date parts, never `toISOString` — that reads UTC and can shift the
 * date by one depending on timezone, the exact reasoning `todayIso` in
 * src/api.ts already applies. */
function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayLocalIso(): string {
  return localIso(new Date());
}

/** A `Date`'s month/day silently roll over (2024-02-30 becomes March), so a
 * constructed date must be checked against what was actually typed rather
 * than trusted at face value. */
function validCalendarDate(year: number, month1: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month1) || !Number.isInteger(day)) return false;
  if (month1 < 1 || month1 > 12 || day < 1 || day > 31) return false;
  const dt = new Date(year, month1 - 1, day);
  return dt.getFullYear() === year && dt.getMonth() === month1 - 1 && dt.getDate() === day;
}

/**
 * `cellDates: true` (set by `parseSpreadsheet`) makes an Excel date-formatted
 * cell arrive here as a real JS `Date` rather than a serial-number integer —
 * the whole trick to not needing to special-case Excel's date encoding.
 * Everything else is read as a string: ISO first, then US-ordering
 * month/day/year (an irreducible ambiguity without a locale hint — assumed
 * because it's the more common default in English spreadsheet exports; the
 * screen that calls this states the assumption to the user).
 */
export function parseDateCell(cell: unknown): DateParseResult {
  // Only a real workbook reaches here with a Date, and SheetJS builds those at
  // LOCAL midnight — so local getters, never `toISOString`, which would be a
  // day out east of UTC. Text files never produce a Date at all.
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return { iso: null, future: false };
    const iso = localIso(cell);
    return { iso, future: iso > todayLocalIso() };
  }
  if (cell === null || cell === undefined) return { iso: null, future: false };
  const s = String(cell).trim();
  if (s === "") return { iso: null, future: false };

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!validCalendarDate(year, month, day)) return { iso: null, future: false };
    const out = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return { iso: out, future: out > todayLocalIso() };
  }

  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    let year = Number(us[3]);
    if (us[3].length === 2) year = 2000 + year;
    if (!validCalendarDate(year, month, day)) return { iso: null, future: false };
    const out = `${year}-${pad2(month)}-${pad2(day)}`;
    return { iso: out, future: out > todayLocalIso() };
  }

  return { iso: null, future: false };
}

/* ── meal normalisation ───────────────────────────────────────────────── */

/**
 * What a row with no description of its own is called.
 *
 * Shared with `exportSheet.ts` rather than written twice, and that is
 * load-bearing rather than tidy: a description this reader substitutes is a
 * description the writer must produce, or a file this app writes stops being a
 * fixed point of the file this app reads. `import_one_row` in lib.rs makes the
 * same substitution for the same reason.
 */
export const IMPORTED_ENTRY_DESCRIPTION = "Imported entry";

/**
 * Trim/lowercase and accept an exact match against the four meals; anything
 * else — including no meal column at all — defaults to "snack", the least
 * time-specific of the four. Deliberate default, not a fallback that happens
 * to compile.
 */
export function normalizeMeal(cell: unknown): Meal {
  if (cell === null || cell === undefined) return "snack";
  const s = String(cell).trim().toLowerCase();
  return (MEALS as string[]).includes(s) ? (s as Meal) : "snack";
}

/* ── top-level parse ──────────────────────────────────────────────────── */

/**
 * Reads a .csv/.xlsx/.xls file end to end. SheetJS's own reader auto-detects
 * the format from content, so there's no need to branch on file extension,
 * and `cellDates: true` is what turns an Excel date-formatted cell into a
 * real JS `Date` rather than a serial-number integer.
 */
export async function parseSpreadsheet(file: File): Promise<ParseReport> {
  const buf = await file.arrayBuffer();
  // A real workbook is read as VALUES — `cellDates` turns its date cells into
  // Date objects rather than serial numbers. Delimited text is read with
  // `raw: true`, which switches SheetJS's type inference OFF and keeps every
  // cell as the text the file actually contained. See `isBinaryWorkbook`.
  const binary = isBinaryWorkbook(buf);
  const workbook = binary
    ? XLSX.read(buf, { type: "array", cellDates: true })
    : XLSX.read(buf, { type: "array", raw: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const report: ParseReport = {
    rows: [],
    unmatchedHeaders: [],
    matchedHeaders: [],
    datelessRows: [],
    emptyRows: [],
    futureRows: [],
    unreadableCells: 0,
  };
  if (sheet == null) return report;

  // `raw: true` here regardless: it asks for the cell's VALUE rather than its
  // formatted display string, which is what each reader above has already made
  // correct for its own format. `raw: false` would undo both — it re-formats a
  // workbook's date cell into a display string that the US-ordering parser
  // below then reads as the wrong day, and it turns 1234.5 under a `#,##0.00`
  // format into "1,234.50", which parses as NaN and drops a real value.
  //
  // `defval: null` is what makes a genuinely blank cell distinguishable from
  // an absent key.
  const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });
  if (jsonRows.length === 0) return report;

  // Build the column map once, from every header that appears on any row
  // (sheet_to_json only returns keys sheetjs found in its own header row).
  const headers = Object.keys(jsonRows[0]);
  const columnMap = new Map<string, ColumnMatch>();
  const seenUnmatched = new Set<string>();
  for (const header of headers) {
    const match = matchHeader(header);
    if (match == null) {
      if (!seenUnmatched.has(header)) {
        seenUnmatched.add(header);
        report.unmatchedHeaders.push(header);
      }
      continue;
    }
    columnMap.set(header, match);
    report.matchedHeaders.push({ header, label: match.label });
  }

  jsonRows.forEach((raw, i) => {
    // Row 1 is the header row itself, so the first data row is sourceRow 2.
    const sourceRow = i + 2;

    let dateResult: DateParseResult = { iso: null, future: false };
    let mealCell: unknown = null;
    let descriptionCell: unknown = null;
    const nutrients: { nutrient_id: number; amount: number }[] = [];

    for (const [header, match] of columnMap) {
      const cell = raw[header];
      if (match.kind === "date") {
        dateResult = parseDateCell(cell);
      } else if (match.kind === "meal") {
        mealCell = cell;
      } else if (match.kind === "description") {
        descriptionCell = cell;
      } else {
        const parsed = parseCellNumber(cell);
        if (parsed.kind === "unreadable") {
          report.unreadableCells += 1;
        } else if (parsed.kind === "value") {
          const amount =
            match.convertFrom != null
              ? convertMass(parsed.amount, match.convertFrom, canonicalMassUnit(
                  NUTRIENT_BY_ID.get(match.nutrientId)!.unit,
                )!)
              : parsed.amount;
          nutrients.push({ nutrient_id: match.nutrientId, amount });
        }
      }
    }

    if (dateResult.iso == null) {
      report.datelessRows.push(sourceRow);
      return;
    }
    if (dateResult.future) {
      report.futureRows.push(sourceRow);
    }
    if (nutrients.length === 0) {
      report.emptyRows.push(sourceRow);
      return;
    }

    const description = String(descriptionCell ?? "").trim() || IMPORTED_ENTRY_DESCRIPTION;
    report.rows.push({
      logged_on: dateResult.iso,
      meal: normalizeMeal(mealCell),
      description,
      nutrients,
      sourceRow,
    });
  });

  return report;
}
