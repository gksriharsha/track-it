/**
 * The rough energy figure on the day's Activity card, held to what D26 says
 * about it. Runs in a bare Node process, like the other tests here:
 *
 *     node src/lib/activityEnergy.test.ts
 *
 * What it guards: the arithmetic is the published MET method less resting;
 * every kind has a figure for every effort and harder is never less; a figure
 * is rounded so it never looks exact; a strength session with no time is
 * counted from its sets and says so; and with no weight on file there is no
 * figure at all, rather than one made up from an average body.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MET, MINUTES_PER_SET, dayEnergy, energyUsed, kcalText } from "./activityEnergy.ts";
import type { ActivityKind, Session, SessionSet } from "./activity.ts";

// The kinds the app logs, read out of activity.ts's own type rather than copied,
// so a kind added there without a MET fails here. (activity.ts itself cannot be
// imported in bare Node: it reaches the Tauri bridge.)
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "activity.ts"), "utf8");
const union = source.slice(source.indexOf("export type ActivityKind"), source.indexOf(";", source.indexOf("export type ActivityKind")));
const kinds = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1] as ActivityKind);

let failed = 0;
let held = 0;
function check(claim: string, ok: boolean, detail?: string): void {
  if (ok) {
    held += 1;
    console.log(`  ok   ${claim}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${claim}${detail ? `\n         ${detail}` : ""}`);
  }
}

function session(over: Partial<Session>): Session {
  return {
    id: "s", logged_on: "2026-10-01", kind: "walk", label: null, minutes: 30, effort: "moderate",
    note: null, corrected_at: null, sets: [], ...over,
  };
}
function sets(n: number): SessionSet[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `x${i}`, position: i, exercise_id: "e", exercise_name: "Squat", load: "weight" as const,
    reps: 5, load_kg: 60, seconds: null,
  }));
}

console.log("\nthe table");
check("the kinds were found in activity.ts", kinds.length === 9, kinds.join(", "));
check("every kind the app logs has a MET for every effort", kinds.every((k) => MET[k] && MET[k].light > 0 && MET[k].moderate > 0 && MET[k].vigorous > 0));
const inverted = kinds.filter((k) => !(MET[k].light <= MET[k].moderate && MET[k].moderate <= MET[k].vigorous));
check("a harder effort never uses less", inverted.length === 0, inverted.join(", "));
const sitting = kinds.filter((k) => MET[k].light <= 1);
check("every activity uses more than sitting still", sitting.length === 0, sitting.join(", "));

console.log("\none session");
// A 70 kg walk at 3.8 MET (Compendium 17190) for 30 minutes: (3.8 - 1) x 70 x 0.5 = 98, so about 100.
const walk = energyUsed(session({}), 70);
check("a moderate half-hour walk at 70 kg is about 100 kcal above resting", walk?.kcal === 100, JSON.stringify(walk));
check("it is counted from the minutes logged", walk?.fromSets === false);
check("twice the weight is about twice the figure", energyUsed(session({}), 140)?.kcal === 200);
check("a figure is a whole number of tens", [5, 7, 12, 33, 61].every((m) => (energyUsed(session({ minutes: m }), 63.4)!.kcal % 10) === 0));
check("a very short, easy activity still reads as about 10, never 0", energyUsed(session({ kind: "yoga", effort: "light", minutes: 1 }), 50)?.kcal === 10);

console.log("\nstrength");
const timed = energyUsed(session({ kind: "strength", effort: null, minutes: 45, sets: sets(12) }), 80);
check("a strength session with its time is counted from that time", timed?.fromSets === false);
const untimed = energyUsed(session({ kind: "strength", effort: null, minutes: null, sets: sets(10) }), 80);
const expected = Math.round(((MET.strength.moderate - 1) * 80 * ((10 * MINUTES_PER_SET) / 60)) / 10) * 10;
check("with no time it is counted from its sets, and says so", untimed?.fromSets === true && untimed.kcal === expected, JSON.stringify(untimed));
check("with no time and no sets there is no figure", energyUsed(session({ kind: "strength", effort: null, minutes: null, sets: [] }), 80) === null);

console.log("\nno weight, no figure");
check("no weight on file gives no figure, not an average body's", energyUsed(session({}), null) === null && dayEnergy([session({})], null) === null);
check("a nonsense weight gives none either", [0, -5, Number.NaN, Number.POSITIVE_INFINITY].every((w) => energyUsed(session({}), w) === null));
check("a session with no minutes gives none", energyUsed(session({ minutes: null }), 70) === null);

console.log("\nthe day");
const tiny = session({ kind: "yoga", effort: "light", minutes: 8 }); // 1.3 x 70 x 8/60 = 12.1
const three = dayEnergy([tiny, tiny, tiny], 70);
check("the day is summed before rounding: three 12s read as 40, not 30", three?.kcal === 40, JSON.stringify(three));
check("a day with nothing to go on has no figure", dayEnergy([session({ minutes: null })], 70) === null);
check("a day says when any of it was counted from sets",
  dayEnergy([session({}), session({ kind: "strength", effort: null, minutes: null, sets: sets(4) })], 70)?.fromSets === true);

console.log("\nthe words");
check("it reads as an approximation, with the unit kept on the line", kcalText(1250) === "about 1,250 kcal", kcalText(1250));

console.log(failed === 0 ? `\nall ${held} claims held` : `\n${failed} of ${held + failed} claims FAILED`);
if (failed > 0) throw new Error(`${failed} of ${held + failed} claims failed`);
