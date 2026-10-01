/**
 * The exercise drawings and the muscle table, held to what the app promises
 * about them (D27). Runs in a bare Node process, like exportSheet.test.ts:
 *
 *     node src/lib/exerciseArt.test.ts
 *
 * What it guards: every lift that names a drawing has both frames on disk;
 * every drawing on disk is one a lift uses and is credited; no drawing carries
 * a fixed colour or the white page it was traced on, so dark mode cannot show
 * a white box; the few drawn for TrackIt keep the same file rules, live apart
 * from Priday's and never carry his name; and every common lift Rust bundles
 * has a muscle row and a drawing, so a lift the app offers is never silently
 * missing either.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MUSCLES, allArt, areaFor, artFor, creditFor, framesOf, muscleLine, musclesFor, nameKey } from "./exerciseArt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const ART_DIR = join(ROOT, "src", "assets", "everkinetic");
const OWN_DIR = join(ROOT, "src", "assets", "figures");

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

const unfiled = common.filter((n) => areaFor(n) === null);
check("every common lift is filed under a part of the body", unfiled.length === 0, unfiled.join(", "));
check(
  "a lift is filed where a lifter would look for it",
  areaFor("Hip thrust") === "legs" && areaFor("Face pull") === "shoulders" && areaFor("Pull-up") === "back" &&
    areaFor("Crunch") === "core" && areaFor("Biceps curl") === "arms" && areaFor("Bench press") === "chest",
);

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
const ek = allArt().filter((a) => a.by === undefined);
const own = allArt().filter((a) => a.by === "trackit");
const files = readdirSync(ART_DIR).filter((f) => f.endsWith(".svg"));
const credits = readFileSync(join(ART_DIR, "CREDITS.md"), "utf8");
const used = new Set(ek.flatMap((a) => [`${a.id}-relaxation.svg`, `${a.id}-tension.svg`]));
const missing = [...used].filter((f) => !files.includes(f));
check("every drawing a lift names has both frames", missing.length === 0, missing.join(", "));
const orphans = files.filter((f) => !used.has(f));
check("no drawing ships that no lift uses", orphans.length === 0, orphans.join(", "));
const unstarted = ek.filter((a) => a.start !== "relaxation" && a.start !== "tension");
check("every Everkinetic drawing says which frame it starts on", unstarted.length === 0, unstarted.map((a) => a.lift).join(", "));
const paths = allArt().map((a) => framesOf(a));
check(
  "every frame path points into the folder of whoever drew it",
  allArt().every((a, i) => {
    const dir = a.by === "trackit" ? "figures/" : "everkinetic/";
    return paths[i].start.startsWith(dir) && (paths[i].halfway === null || paths[i].halfway!.startsWith(dir));
  }),
);
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
const misaligned = ek.filter((a) => {
  const box = (frame: string) => readFileSync(join(ART_DIR, `${a.id}-${frame}.svg`), "utf8").match(/viewBox="([^"]+)"/)?.[1];
  return box("relaxation") !== box("tension");
});
check("both frames of a lift share one canvas, so they line up", misaligned.length === 0, misaligned.map((a) => a.lift).join(", "));
const vagueCaptions = allArt().filter((a) => a.caption !== null && !a.caption.startsWith("Drawn "));
check("every variant's caption says how it is drawn", vagueCaptions.length === 0, vagueCaptions.map((a) => a.lift).join(", "));

console.log("\nthe drawings made for TrackIt");
const ownFiles = readdirSync(OWN_DIR).filter((f) => f.endsWith(".svg"));
const ownUsed = new Set(own.flatMap((a) => {
  const f = framesOf(a);
  return [f.start, f.halfway].filter((x): x is string => x !== null).map((x) => x.slice("figures/".length));
}));
const ownMissing = [...ownUsed].filter((f) => !ownFiles.includes(f));
check("every frame a TrackIt drawing names is on disk", ownMissing.length === 0, ownMissing.join(", "));
const ownOrphans = ownFiles.filter((f) => !ownUsed.has(f));
check("no TrackIt drawing ships that no lift uses", ownOrphans.length === 0, ownOrphans.join(", "));
check("none claims an Everkinetic frame name", own.every((a) => a.start === undefined));
const ownText = (f: string) => readFileSync(join(OWN_DIR, f), "utf8");
const misCredited = ownFiles.filter((f) => !ownText(f).includes("drawn for TrackIt") || ownText(f).includes("Priday"));
check("each says inside the file that it was drawn for TrackIt, and never names Priday", misCredited.length === 0, misCredited.join(", "));
// The same promises the Everkinetic files keep, stated for a file made rather
// than traced: ink only, so the mask shows lines and never a white box.
const notInkOnly = ownFiles.filter((f) => {
  const s = ownText(f);
  const fills = [...s.matchAll(/fill="([^"]*)"/g)].map((m) => m[1]);
  return fills.length === 0 || fills.some((c) => c !== "currentColor") || /stroke|<(mask|filter|image|text|clipPath)\b/.test(s);
});
check("each is ink alone: currentColor fills, no strokes, masks, images or text", notInkOnly.length === 0, notInkOnly.join(", "));
const ownUnscaled = ownFiles.filter((f) => !/viewBox="/.test(ownText(f)) || /<svg[^>]*\s(width|height)=/.test(ownText(f)));
check("each scales by its viewBox", ownUnscaled.length === 0, ownUnscaled.join(", "));
const ownMisaligned = own.filter((a) => {
  const f = framesOf(a);
  if (f.halfway === null) return false;
  const box = (p: string) => ownText(p.slice("figures/".length)).match(/viewBox="([^"]+)"/)?.[1];
  return box(f.start) !== box(f.halfway);
});
check("both frames of each share one canvas", ownMisaligned.length === 0, ownMisaligned.map((a) => a.lift).join(", "));
check("the folder says whose they are", readdirSync(OWN_DIR).includes("README.md"));
check("the close-up credits TrackIt for its own and Priday for his", own.every((a) => creditFor(a) === "Drawn for TrackIt.") && ek.every((a) => creditFor(a).includes("Greg Priday")));

console.log("\nevery common lift");
const bare = common.filter((n) => artFor(n) === null);
check("has a drawing, so the barbell tile is only ever for a lift the user named", bare.length === 0, bare.join(", "));

console.log(failed === 0 ? `\nall ${held} claims held` : `\n${failed} of ${held + failed} claims FAILED`);
if (failed > 0) process.exit(1);
