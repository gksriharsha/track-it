/**
 * Part of a bottle, by eye, held to what the backend will log. Runs in a bare
 * Node process, like the other tests here:
 *
 *     node src/lib/bottleShare.test.ts
 *
 * What it guards: a share of a calibrated bottle comes to that share of its
 * label, one weighed empty but never told its volume reads at the density of
 * water, and one never weighed empty has no share at all, which is the
 * backend's own refusal. The words say the fractions people say, and every
 * stop a tap lands on is a value the slider can hold.
 */
import { STEP_PCT, STOPS, shareMl, shareOf } from "./bottleShare.ts";
import { describeVolume } from "../types.ts";
import type { Bottle } from "../types.ts";

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
const is = (claim: string, got: string, want: string) => check(claim, got === want, `got "${got}", wanted "${want}"`);

const bottle = (empty_g: number | null, volume_ml: number | null): Bottle => ({
  id: "b", name: "Steel flask", full_g: 1284, empty_g, volume_ml, last_used_at: null,
});

// 294 g empty, 1,284 g full, sold as a litre: it holds 990 g, which is its litre.
const steel = bottle(294, 1000);
is("half a calibrated bottle is half its label", describeVolume(shareMl(steel, 0.5) ?? -1), "500 ml");
is("all of it is the whole label", describeVolume(shareMl(steel, 1) ?? -1), "1.0 L");
is("a twentieth is a twentieth", describeVolume(shareMl(steel, 0.05) ?? -1), "50 ml");

// Weighed empty but never told what its maker calls it: grams of water, at its density.
const unnamed = bottle(294, null);
const ml = shareMl(unnamed, 0.5);
check("weighed empty without a label reads at the density of water", ml !== null && ml > 495 && ml < 496,
  `got ${ml}`);

check("never weighed empty, no share of it is known", shareMl(bottle(null, null), 0.5) === null);
check("a bottle that weighs no more full than empty holds nothing",
  shareMl({ ...steel, empty_g: 1284 }, 0.5) === null);

is("a quarter", shareOf(0.25, "Steel flask"), "A quarter of Steel flask");
is("half", shareOf(0.5, "Steel flask"), "Half of Steel flask");
is("three quarters", shareOf(0.75, "Steel flask"), "Three quarters of Steel flask");
is("the whole of it", shareOf(1, "Steel flask"), "All of Steel flask");
is("anything else as a percentage", shareOf(0.4, "Steel flask"), "40% of Steel flask");
is("a share off the slider's float still reads cleanly", shareOf(0.35000000000000003, "Steel flask"),
  "35% of Steel flask");

check("every stop is a value the slider can hold",
  STOPS.every((s) => s.pct % STEP_PCT === 0 && s.pct > 0 && s.pct <= 100));
check("the last stop is the whole bottle", STOPS[STOPS.length - 1]?.pct === 100);

console.log(failed === 0 ? `\nall ${held} claims held` : `\n${failed} of ${held + failed} claims FAILED`);
if (failed > 0) throw new Error(`${failed} claim(s) failed`);
