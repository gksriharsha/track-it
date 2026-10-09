/**
 * The label form's lines follow the pack. Runs in a bare Node process:
 *
 *     node src/lib/printedOrder.test.ts
 */
import { inPrintedOrder } from "./printedOrder.ts";

let failures = 0;
function same(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failures++;
  console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}
const id = (n: number) => n;

// The US spine, as the form lists it with nothing read.
const SPINE = [1008, 1004, 1258, 1257, 1253, 1093, 1005, 1079, 2000, 1235, 1003];

same("no order leaves the lines as they were", inPrintedOrder(SPINE, id, null), SPINE);
same("an empty order leaves them too", inPrintedOrder(SPINE, id, []), SPINE);

// An Indian pack: energy, protein, carbohydrate, sugars, fat, sodium.
same(
  "what the pack printed comes first, in its order; the rest keep theirs",
  inPrintedOrder(SPINE, id, [1008, 1003, 1005, 2000, 1004, 1093]),
  [1008, 1003, 1005, 2000, 1004, 1093, 1258, 1257, 1253, 1079, 1235],
);
same(
  "a read nutrient the form has no line for changes nothing",
  inPrintedOrder([1008, 1004], id, [1162, 1004]),
  [1004, 1008],
);
same(
  "a nutrient read twice keeps its first place",
  inPrintedOrder([1003, 1008], id, [1008, 1003, 1008]),
  [1008, 1003],
);
same(
  "objects are ordered by the id they carry",
  inPrintedOrder([{ n: 1004 }, { n: 1008 }], (x) => x.n, [1008]).map((x) => x.n),
  [1008, 1004],
);

// Thrown rather than process.exit: these tests are typechecked with the app,
// which has no Node typings (see node.d.ts).
if (failures > 0) throw new Error(`${failures} printed-order claim(s) failed`);
console.log("printedOrder: all checks passed");
