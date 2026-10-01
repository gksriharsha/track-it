#!/usr/bin/env python3
"""Draw the exercise figures TrackIt makes for itself, for the lifts Everkinetic never drew.

Usage:
    python3 tools/figures/draw.py                  every lift, into src/assets/figures/
    python3 tools/figures/draw.py plank            only the lifts named, by slug
    python3 tools/figures/draw.py --check          draw in memory and compare with the files; write nothing
    python3 tools/figures/draw.py --preview DIR    also write a PNG preview of every frame into DIR

The SVGs in src/assets/figures/ are TrackIt's own drawings: original line art of a man doing a face
pull, a kettlebell swing and a forearm plank, made to sit beside Greg Priday's Everkinetic drawings in
src/assets/everkinetic/ with the same line weight, proportions and scale. Nothing in them is traced or
adapted from his, so they carry neither his name nor his licence. Each lift's module here poses the
man with the figure kit in kit/ (whose docstring is the kit's manual) and adds the equipment; this
script alone writes their files.

The rules every file keeps, which src/lib/exerciseArt.test.ts also checks: ink only (currentColor
paths; no strokes, white, masks or images), because the app uses each file as a CSS mask over its own
ink colour; a viewBox and no fixed size; one canvas shared by every frame of a lift, with the feet in
the same place, so the frames line up when the app swaps them. Each also opens with a comment saying
it is original work, not Everkinetic's.

The files are generated. To change a drawing, change the code and run this again; an SVG edited by
hand is overwritten by the next run. --check must pass before committing a change to either the code or
the files: it prints one line per file (same, DIFFERENT or missing) and exits 1 unless every file is the
same. The output is exact to the byte only with the numpy and shapely (GEOS) versions the files were
made with, on the same kind of machine (MADE_WITH below); anything else can move a point by a hundredth
of a unit, which --check reports as DIFFERENT although the drawing looks the same.

--preview writes <slug>-<frame>.png for every frame: the frame large, beside the app's tile sizes
(120x140, 56x64, 46x54 and 40x46 at 2x, then 46x54 at 1x), fitted into each the way the app's CSS mask
fits it, so a line that fails only in the smallest tile is easy to see. It only ever writes inside
src/assets/figures/, and with --preview inside DIR.

Requirements: python3 with numpy and shapely 2; Pillow as well for --preview.
"""
import argparse
import importlib.util
import platform
import sys
from pathlib import Path

import numpy
import shapely

HERE = str(Path(__file__).resolve().parent)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import kit  # noqa: E402

# The lift modules, in the order they are drawn. Each exposes LIFT (its display name), SLUG, frames()
# -> [(file name, SVG text), ...], which writes nothing, and preview_inks() -> (viewbox, offset,
# [(frame label, ink), ...]). A new lift is added here by hand: the folder is never scanned, so a
# helper module or an unfinished lift is never run by accident.
LIFTS = ("face_pull", "kettlebell_swing", "plank")

# What the files in src/assets/figures/ were made with; --check names it when a file differs.
MADE_WITH = {"numpy": "1.26.3", "shapely": "2.1.2", "GEOS": "3.13.1", "machine": "macOS arm64"}


def load(slugs):
    """The lift modules to draw, in LIFTS order: every one, or those whose SLUG is in slugs."""
    mods = [importlib.import_module(name) for name in LIFTS]
    known = [m.SLUG for m in mods]
    unknown = [s for s in slugs if s not in known]
    if unknown:
        raise SystemExit("unknown lift %s; the lifts are %s" % (", ".join(unknown), ", ".join(known)))
    return [m for m in mods if not slugs or m.SLUG in slugs]


def target(name):
    """The path a frame is written to. A name that is not a plain .svg file name is refused, so nothing
    a lift returns can be written outside src/assets/figures/."""
    if Path(name).name != name or not name.endswith(".svg"):
        raise SystemExit("refusing to write %r: a frame must be a plain .svg file name" % name)
    return kit.FIGURES_DIR / name


def check(mods):
    """Compare every frame, drawn in memory, with its file, byte for byte. True when all are the same."""
    ok = True
    for mod in mods:
        for name, text in mod.frames():
            path = target(name)
            if not path.exists():
                state = "missing"
            else:
                state = "same" if path.read_bytes() == text.encode("utf-8") else "DIFFERENT"
            ok = ok and state == "same"
            print("%-9s %s" % (state, path.relative_to(kit.ROOT)))
    here = {"numpy": numpy.__version__, "shapely": shapely.__version__, "GEOS": shapely.geos_version_string,
            "machine": "%s %s" % (platform.system().replace("Darwin", "macOS"), platform.machine())}
    if not ok and here != MADE_WITH:
        print("note: the files were made with %s; this is %s" % (MADE_WITH, here), file=sys.stderr)
    return ok


def write(mods):
    """Write every frame whose file is missing or differs, then check each lift's files against the
    app's rules. True when every file keeps them."""
    kit.FIGURES_DIR.mkdir(parents=True, exist_ok=True)
    ok = True
    for mod in mods:
        paths = []
        for name, text in mod.frames():
            path = target(name)
            data = text.encode("utf-8")
            changed = not path.exists() or path.read_bytes() != data
            if changed:
                path.write_bytes(data)              # bytes, so the line end is "\n" on every platform
            print("%-9s %s" % ("wrote" if changed else "unchanged", path.relative_to(kit.ROOT)))
            paths.append(path)
        problems = ["%s: %s" % (p.name, x) for p in paths for x in kit.verify_svg(p)["problems"]]
        if not kit.verify_pair(paths)["ok"]:
            problems.append("%s: the frames do not share one viewBox" % mod.SLUG)
        for x in problems:
            print("problem   %s" % x, file=sys.stderr)
        ok = ok and not problems
    return ok


def preview(mods, out_dir):
    """Write a PNG preview of every frame into out_dir, named like its SVG."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for mod in mods:
        viewbox, offset, inks = mod.preview_inks()
        for label, ink in inks:
            png = out_dir / ("%s-%s.png" % (mod.SLUG, label.lower()))
            kit.preview(ink, viewbox, png, offset=offset)
            print("preview   %s" % png)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("lifts", nargs="*", metavar="LIFT", help="lift slugs to draw (default: every lift)")
    parser.add_argument("--check", action="store_true", help="compare with the files instead of writing them")
    parser.add_argument("--preview", metavar="DIR", type=Path, help="also write PNG previews into DIR")
    args = parser.parse_args(argv)
    mods = load(args.lifts)
    if args.preview is not None and importlib.util.find_spec("PIL") is None:
        raise SystemExit("--preview needs Pillow (python3 -m pip install Pillow)")
    ok = check(mods) if args.check else write(mods)
    if args.preview is not None:
        preview(mods, args.preview)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
