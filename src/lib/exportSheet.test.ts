/**
 * The round-trip proof: a file this app writes is a file this app reads back.
 *
 * Run it with `pnpm test`, which is `node src/lib/exportSheet.test.ts` and
 * nothing else. That is deliberate. This repository has stayed free of a test
 * runner, and the whole claim being checked here — that `buildExportFile` and
 * `parseSpreadsheet` are inverses — needs only the two modules, `xlsx`, and a
 * Node that reads TypeScript, which every Node since 23.6 does. So there is no
 * new dependency, no config, and no build step between the source and the
 * proof; the price is the little harness below instead of `describe`/`it`, and
 * the two `.ts` extensions the imports carry (see the header of
 * `spreadsheet.ts`).
 *
 * `node:test` and `node:assert` are deliberately NOT imported. This file sits
 * under `src`, so `pnpm build`'s `tsc` typechecks it, and `@types/node` is not
 * installed — importing them would trade a checked test for an unchecked one.
 *
 * What is being defended here is subtler than "the numbers come back". Three of
 * these claims exist because the obvious version of this test passes while the
 * property it advertises does not hold: a blank description comes back as
 * "Imported entry", a row with no values at all does not come back as a row at
 * all, and a blank cell must come back absent rather than as a zero. A
 * deep-equality check over a tidy fixture would sail past all three.
 */
import * as XLSX from "xlsx";
import { buildExportFile, logHeaders, nutrientHeaders } from "./exportSheet.ts";
import { IMPORTED_ENTRY_DESCRIPTION, matchHeader, parseSpreadsheet } from "./spreadsheet.ts";
import type { ParsedRow } from "./spreadsheet.ts";
import { LABEL_NUTRIENTS } from "../types.ts";
import type { ExportLog, ExportLogRow, ExportNutrient } from "../types.ts";

/* ── the harness ──────────────────────────────────────────────────────── */

const failed: string[] = [];
let held = 0;

function check(claim: string, ok: boolean, detail?: string): void {
  if (ok) {
    held += 1;
    console.log(`  ok   ${claim}`);
    return;
  }
  failed.push(claim);
  console.log(`  FAIL ${claim}${detail ? `\n         ${detail}` : ""}`);
}

/** Structural equality by serialisation, which is enough here: everything
 * compared is plain data that crossed an IPC boundary as JSON. */
function same(claim: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(claim, a === b, a === b ? undefined : `got      ${a}\n         expected ${b}`);
}

/* ── the fixture ──────────────────────────────────────────────────────── */

const ids = LABEL_NUTRIENTS.map((n) => n.id);

function nutrients(pairs: [number, number][]): ExportNutrient[] {
  // Emitted in the label's own column order, which is the order the backend
  // emits and the order the parser reads them back in.
  return ids
    .filter((id) => pairs.some(([p]) => p === id))
    .map((id) => ({ nutrient_id: id, amount: pairs.find(([p]) => p === id)![1] }));
}

/** Every one of the fifteen, at three decimals, so a lost or reordered column
 * is visible rather than merely plausible. */
const everything = nutrients(ids.map((id, i) => [id, 1.5 + i]));

const FULLY_KNOWN: ExportLogRow = {
  logged_on: "2026-01-05",
  meal: "breakfast",
  description: "Idli with sambar",
  nutrients: everything,
};

const PARTLY_KNOWN: ExportLogRow = {
  logged_on: "2026-01-05",
  meal: "lunch",
  description: "Leftover dal",
  // Twelve blanks, three figures — the ordinary case for a transcribed pack.
  nutrients: nutrients([
    [1008, 412],
    [1003, 18.25],
    [1093, 640],
  ]),
};

const AWKWARD_TEXT: ExportLogRow = {
  logged_on: "2026-01-06",
  // A comma and a double quote, which is where a naive csv writer loses a
  // column boundary, plus a date in early January, where a day/month swap
  // would still parse and land on the wrong day.
  meal: "dinner",
  description: 'Chana masala, "extra hot"',
  nutrients: nutrients([[1008, 501]]),
};

const NO_DESCRIPTION: ExportLogRow = {
  logged_on: "2026-01-06",
  meal: "snack",
  description: "",
  nutrients: nutrients([[1087, 120]]),
};

const NOTHING_KNOWN: ExportLogRow = {
  logged_on: "2026-01-07",
  meal: "snack",
  description: "Unlabelled biscuit",
  nutrients: [],
};

const LOG: ExportLog = {
  from: "2026-01-05",
  to: "2026-01-07",
  days: 3,
  rows: [FULLY_KNOWN, PARTLY_KNOWN, AWKWARD_TEXT, NO_DESCRIPTION, NOTHING_KNOWN],
  doses: [
    {
      logged_on: "2026-01-05",
      meal: "breakfast",
      description: "Calcium tablets",
      units: 2,
      nutrients: nutrients([[1087, 1000]]),
    },
  ],
  water: [
    {
      logged_on: "2026-01-05",
      description: "Steel bottle",
      ml: 500,
      measured: true,
    },
  ],
  blanks: 0,
  rows_without_values: 1,
  unexportable: 0,
};

/** What each written row should come back as. Row 1 of the file is the header,
 * so the first data row is `sourceRow` 2 — and `NOTHING_KNOWN` is absent
 * because a row with no values is not a row the importer will write. */
const EXPECTED: ParsedRow[] = [
  { ...FULLY_KNOWN, meal: "breakfast", sourceRow: 2 },
  { ...PARTLY_KNOWN, meal: "lunch", sourceRow: 3 },
  { ...AWKWARD_TEXT, meal: "dinner", sourceRow: 4 },
  { ...NO_DESCRIPTION, description: IMPORTED_ENTRY_DESCRIPTION, meal: "snack", sourceRow: 5 },
];

/* ── helpers ──────────────────────────────────────────────────────────── */

function bytesOf(dataBase64: string): Uint8Array {
  const raw = atob(dataBase64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function reread(dataBase64: string, name: string) {
  return parseSpreadsheet(new File([bytesOf(dataBase64)], name));
}

/* ── every header this writer emits is one that reader recognises ─────── */

console.log("\nheaders");

for (const header of ["Date", "Meal", "Description"]) {
  const m = matchHeader(header);
  check(`“${header}” is a column the importer places`, m != null && m.kind !== "nutrient");
}

nutrientHeaders().forEach((header, i) => {
  const m = matchHeader(header);
  if (m == null || m.kind !== "nutrient") {
    check(`“${header}” matches a nutrient`, false, "matched nothing at all");
    return;
  }
  check(
    `“${header}” is nutrient ${ids[i]}, with no unit conversion`,
    m.nutrientId === ids[i] && m.convertFrom === null,
    `matched ${m.nutrientId} with convertFrom ${String(m.convertFrom)}`,
  );
});

check(
  "the header row is the three placing columns and then the fifteen nutrients",
  logHeaders().length === 18,
  `it has ${logHeaders().length} columns`,
);

/* ── the spreadsheet round trip ───────────────────────────────────────── */

console.log("\nan xlsx this app writes");

const xlsx = buildExportFile(LOG, "xlsx");
check(
  "is named for the period it covers",
  xlsx.name === "TrackIt log 2026-01-05 to 2026-01-07.xlsx",
  xlsx.name,
);

const fromXlsx = await reread(xlsx.dataBase64, xlsx.name);
same("has no header the importer cannot place", fromXlsx.unmatchedHeaders, []);
same("has no row whose date could not be read", fromXlsx.datelessRows, []);
same("has no row that parsed to a date after today", fromXlsx.futureRows, []);
check("has no cell that had text but no number", fromXlsx.unreadableCells === 0);
same("comes back as the rows it was written from", fromXlsx.rows, EXPECTED);
same(
  "reports the row that had no values, rather than writing it",
  fromXlsx.emptyRows,
  [6],
);

/* ── a blank cell is not a zero ───────────────────────────────────────── */

console.log("\nblanks and absences");

const partlyBack = fromXlsx.rows[1];
check(
  "a nutrient left blank comes back absent from the row",
  partlyBack.nutrients.every((n) => n.nutrient_id !== 1235),
  JSON.stringify(partlyBack.nutrients),
);
check(
  "and specifically not as a zero",
  !partlyBack.nutrients.some((n) => n.nutrient_id === 1235 && n.amount === 0),
);
check(
  "a row with three figures comes back with three",
  partlyBack.nutrients.length === 3,
  `it has ${partlyBack.nutrients.length}`,
);
check(
  "a description the writer left empty is the one the reader would have given it",
  fromXlsx.rows[3].description === IMPORTED_ENTRY_DESCRIPTION,
  fromXlsx.rows[3].description,
);

/* ── the sheets behind the log ────────────────────────────────────────── */

console.log("\nsheet order");

const book = XLSX.read(bytesOf(xlsx.dataBase64), { type: "array" });
same("the log is sheet one, and the other two sit behind it", book.SheetNames, [
  "Log",
  "Supplements",
  "Water",
]);
check(
  "the supplement sheet carries the dose, in units and not in grams",
  XLSX.utils.sheet_to_csv(book.Sheets.Supplements).includes("Calcium tablets,2"),
);
check(
  "the water sheet says whether the bottle was weighed empty",
  XLSX.utils.sheet_to_csv(book.Sheets.Water).includes("Steel bottle,500,yes"),
);

/* ── the csv round trip ───────────────────────────────────────────────── */

console.log("\na csv this app writes");

const csv = buildExportFile(LOG, "csv");
const csvText = new TextDecoder().decode(bytesOf(csv.dataBase64));
const fromCsv = await reread(csv.dataBase64, csv.name);
same("has no header the importer cannot place", fromCsv.unmatchedHeaders, []);
same("has no row whose date could not be read", fromCsv.datelessRows, []);
check("has no cell that had text but no number", fromCsv.unreadableCells === 0);
same("comes back as the rows it was written from", fromCsv.rows, EXPECTED);
check(
  "keeps a description carrying a comma and a quote intact",
  fromCsv.rows[2].description === AWKWARD_TEXT.description,
  fromCsv.rows[2].description,
);
// A csv is one sheet by definition, so the supplements and the water are
// simply not in it. Counted in lines rather than searched for by name: the
// nutrient headers themselves contain the word "Calcium", which is exactly the
// kind of coincidence that makes a substring check pass for the wrong reason.
check(
  "is the log sheet and nothing else — one header and five rows",
  csvText.trim().split("\n").length === 6,
  `it has ${csvText.trim().split("\n").length} lines`,
);
check("carries no dose", !csvText.includes("Calcium tablets"));
check("carries no bottle", !csvText.includes("Steel bottle"));

/* ── generation two is exact ──────────────────────────────────────────── */

console.log("\nre-exporting a file this app read");

// The rounding in Rust costs sub-milli precision once. From the second
// generation the cycle is exact, and this is what that means: feed the parsed
// rows back through the writer and the bytes are the same bytes.
const again = buildExportFile(
  {
    ...LOG,
    rows: fromXlsx.rows.map((r) => ({
      logged_on: r.logged_on as string,
      meal: r.meal,
      description: r.description,
      nutrients: r.nutrients.map((n) => ({ nutrient_id: n.nutrient_id, amount: n.amount })),
    })),
    // The row with no values was reported rather than written, so it is not
    // among the rows coming back — and adding it again would make this a test
    // of the fixture rather than of the cycle.
    rows_without_values: 0,
  },
  "csv",
);
const againText = new TextDecoder().decode(bytesOf(again.dataBase64));
check(
  "produces the same csv, minus the row that carried nothing",
  againText === csvText.split("\n").filter((line) => !line.startsWith("2026-01-07")).join("\n"),
  againText,
);

/* ── the drift guard ──────────────────────────────────────────────────── */

console.log("\na nutrient with no column");

let threw = "";
try {
  buildExportFile(
    { ...LOG, rows: [{ ...FULLY_KNOWN, nutrients: [{ nutrient_id: 1178, amount: 1000 }] }] },
    "csv",
  );
} catch (e) {
  threw = e instanceof Error ? e.message : String(e);
}
check(
  "is refused outright rather than dropped from the file",
  threw.includes("no column in this file"),
  threw || "nothing was thrown",
);

/* ── the verdict ──────────────────────────────────────────────────────── */

if (failed.length > 0) {
  console.log(`\n${failed.length} claim(s) did not hold:`);
  for (const f of failed) console.log(`  - ${f}`);
  throw new Error(`${failed.length} of ${held + failed.length} export claims failed`);
}
console.log(`\nall ${held} claims held`);
