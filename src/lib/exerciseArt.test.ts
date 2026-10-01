/**
 * The exercise drawings and the muscle table, held to what the app promises
 * about them (D27). Runs in a bare Node process, like exportSheet.test.ts:
 *
 *     node src/lib/exerciseArt.test.ts
 *
 * What it guards: every lift that names a drawing has both frames on disk;
 * every drawing on disk is one a lift uses and is credited; no drawing carries
 * a fixed colour or the white page it was traced on, so dark mode cannot show
 * a white box; and every common lift Rust bundles has a muscle row, so a lift
 * the app offers is never silently missing one.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MUSCLES, allArt, artFor, muscleLine, musclesFor, nameKey } from "./exerciseArt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const ART_DIR = join(ROOT, "src", "assets", "everkinetic");

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

// The lifts Rust offers, read out of the source rather than copied, so a lift
// added there without a muscle row fails here.
const core = readFileSync(join(ROOT, "crates", "core", "src", "activity.rs"), "utf8");
const block = core.slice(core.indexOf("pub const COMMON_EXERCISES"), core.indexOf("];", core.indexOf("pub const COMMON_EXERCISES")));
const common = [...block.matchAll(/\("([^"]+)", Load::/g)].map((m) => m[1]);

console.log("\nthe common lifts");
check("Rust's list was found and is not empty", common.length >= 30, `found ${common.length}`);
const unmapped = common.filter((n) => musclesFor(n) === null);
check("every common lift has a muscle row", unmapped.length === 0, unmapped.join(", "));
const stray = Object.keys(MUSCLES).filter((k) => !common.some((n) => nameKey(n) === k));
check("every muscle row is a common lift", stray.length === 0, stray.join(", "));
const crowded = Object.entries(MUSCLES).filter(([, m]) => m.mostly.length === 0 || m.mostly.length > 3 || m.also.length > 3);
check("no row names more than three of each, or nothing at all", crowded.length === 0, crowded.map(([k]) => k).join(", "));
const noArt = allArt().filter((a) => !common.some((n) => nameKey(n) === nameKey(a.lift)));
check("every drawing is for a common lift", noArt.length === 0, noArt.map((a) => a.lift).join(", "));

console.log("\nlooking a lift up");
check("a name is found whatever its case and spacing", artFor("  bench   PRESS ")?.id === artFor("Bench press")?.id);
check("a lift the user invented has no drawing and no muscles", artFor("Zercher carry") === null && musclesFor("Zercher carry") === null);
check(
  "the muscle line reads as a sentence",
  muscleLine({ mostly: ["quads", "glutes"], also: ["adductors", "hamstrings", "lower back"] }) ===
    "Mostly quads and glutes. Also adductors, hamstrings and lower back.",
  muscleLine({ mostly: ["quads", "glutes"], also: ["adductors", "hamstrings", "lower back"] }),
);
check("a lift with nothing else working says only what does", muscleLine({ mostly: ["quads"], also: [] }) === "Mostly quads.");
// A lift's name is the user's own text. Names an object inherits must not come
// back as muscles: "Constructor" once returned the Object function and blanked
// the app when the muscle line read its list.
check(
  "a lift named after something every object inherits has no muscles",
  ["Constructor", "__proto__", "toString", "hasOwnProperty"].every((n) => musclesFor(n) === null && artFor(n) === null),
);

console.log("\nthe drawings on disk");
const files = readdirSync(ART_DIR).filter((f) => f.endsWith(".svg"));
const credits = readFileSync(join(ART_DIR, "CREDITS.md"), "utf8");
const used = new Set(allArt().flatMap((a) => [`${a.id}-relaxation.svg`, `${a.id}-tension.svg`]));
const missing = [...used].filter((f) => !files.includes(f));
check("every drawing a lift names has both frames", missing.length === 0, missing.join(", "));
const orphans = files.filter((f) => !used.has(f));
check("no drawing ships that no lift uses", orphans.length === 0, orphans.join(", "));
const uncredited = files.filter((f) => !credits.includes(f));
check("every drawing is listed in CREDITS.md", uncredited.length === 0, uncredited.join(", "));
check("the folder carries its licence", readdirSync(ART_DIR).includes("LICENSE.md"));
const unmarked = files.filter((f) => {
  const s = readFileSync(join(ART_DIR, f), "utf8");
  return !s.includes("Greg Priday") || !s.includes("creativecommons.org/licenses/by-sa/3.0");
});
check("every drawing names its artist and licence inside the file", unmarked.length === 0, unmarked.join(", "));
const fixed = files.filter((f) => /fill="#/i.test(readFileSync(join(ART_DIR, f), "utf8")));
check("no drawing has a fixed colour or a white page left in it", fixed.length === 0, fixed.join(", "));
const unscaled = files.filter((f) => {
  const s = readFileSync(join(ART_DIR, f), "utf8");
  return !/viewBox="/.test(s) || /<svg[^>]*\swidth=/.test(s);
});
check("every drawing scales by its viewBox", unscaled.length === 0, unscaled.join(", "));
const misaligned = allArt().filter((a) => {
  const box = (frame: string) => readFileSync(join(ART_DIR, `${a.id}-${frame}.svg`), "utf8").match(/viewBox="([^"]+)"/)?.[1];
  return box("relaxation") !== box("tension");
});
check("both frames of a lift share one canvas, so they line up", misaligned.length === 0, misaligned.map((a) => a.lift).join(", "));
const vagueCaptions = allArt().filter((a) => a.caption !== null && !a.caption.startsWith("Drawn "));
check("every variant's caption says how it is drawn", vagueCaptions.length === 0, vagueCaptions.map((a) => a.lift).join(", "));

console.log(failed === 0 ? `\nall ${held} claims held` : `\n${failed} of ${held + failed} claims FAILED`);
if (failed > 0) process.exit(1);
