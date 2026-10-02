#!/usr/bin/env python3
"""Turn Everkinetic's exercise drawings into the line art TrackIt ships.

Usage:
    git clone --depth 1 https://github.com/everkinetic/data.git /tmp/everkinetic
    python3 tools/everkinetic/prepare.py /tmp/everkinetic

Reads the ids listed in `src/lib/exerciseArt.json` (which lift each drawing is
for, the app's own data and not part of the drawings), skipping the entries
marked `"by": "trackit"`, which are not Everkinetic's, and for each of their
two frames writes `src/assets/everkinetic/<id>-<frame>.svg`, then rewrites
CREDITS.md beside them. Run it again whenever that file changes; it only ever
writes inside src/assets/everkinetic/, and never touches LICENSE.md there.

What it changes, and why (the licence asks that changes be stated, and
CREDITS.md repeats this):

  * The white "paper" layer is removed. Each source SVG is a two-colour trace
    of a drawing: one white group underneath (the page, and everything inside
    the outlines) and one dark group on top (the lines). Because it is a trace
    of a flat image there are no hidden lines for the white to cover, so
    dropping it leaves exactly the drawing, on a transparent ground that sits
    on any card in either theme.
  * The dark lines are filled with `currentColor` instead of a fixed grey, so
    the app colours them from its own tokens.
  * A comment naming the artist, the source and the licence is written into
    each file, so a drawing copied out of the app still says what it is.
  * The fixed width and height are dropped and the viewBox kept, so the
    drawing scales to whatever box it is given.

Nothing else is touched: no path is simplified, redrawn or rounded. The source
paths use arc commands, whose flags a naive number-rounder would corrupt, and
the drawing is the artist's, not ours to retouch.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src" / "assets" / "everkinetic"
LIFTS = ROOT / "src" / "lib" / "exerciseArt.json"

WHITE = {"#fff", "#ffffff"}
GROUP = re.compile(r'<g fill="([^"]+)">(.*?)</g>', re.S)
SVG_OPEN = re.compile(r"<svg\b[^>]*>")


NOTICE = (
    "<!-- {title}: drawing by Greg Priday for Everkinetic (everkinetic.com), from "
    "https://github.com/everkinetic/data (commit {commit}). Licensed CC BY-SA 3.0, "
    "https://creativecommons.org/licenses/by-sa/3.0/ . Adapted by TrackIt: white background "
    "removed, lines recoloured with currentColor, fixed size dropped. This adaptation is "
    "released under the same licence. -->"
)


def clean(svg: str, name: str) -> str:
    opening = SVG_OPEN.search(svg)
    if not opening:
        raise SystemExit(f"{name}: no <svg> element")
    view = re.search(r'viewBox="([^"]+)"', opening.group(0))
    if not view:
        raise SystemExit(f"{name}: no viewBox to scale by")
    groups = GROUP.findall(svg)
    if not groups:
        raise SystemExit(f"{name}: expected filled groups, found none")
    lines = [body for fill, body in groups if fill.lower() not in WHITE]
    if not lines:
        raise SystemExit(f"{name}: nothing left once the white layer is removed")
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view.group(1)}">'
        f'<g fill="currentColor">{"".join(lines)}</g></svg>\n'
    )


def with_notice(svg: str, title: str, commit: str) -> str:
    """The credit and licence inside the file itself.

    The app ships these drawings as loose assets, and a file copied out of the
    APK or the built site would otherwise travel with no word of who drew it or
    on what terms. CC BY-SA asks for the licence to go with every copy.
    """
    head, rest = svg.split(">", 1)
    return f"{head}>{NOTICE.format(title=title.replace('--', '-'), commit=commit)}{rest}"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    svg_dir = src / "dist" / "svg"
    catalogue = {e["id"]: e for e in json.loads((src / "dist" / "exercises.json").read_text())}
    lifts = json.loads(LIFTS.read_text())
    commit = subprocess.run(
        ["git", "-C", str(src), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.svg"):
        old.unlink()

    rows = []
    # Entries with a "by" are drawings made for TrackIt, in src/assets/figures/;
    # they are not Everkinetic's and must never be prepared or credited as such.
    ids = sorted({l["id"] for l in lifts if l["id"] and "by" not in l})
    for ek in ids:
        entry = catalogue.get(ek)
        if entry is None:
            raise SystemExit(f"{ek}: not in the Everkinetic catalogue")
        for frame in ("relaxation", "tension"):
            source = svg_dir / f"{ek}-{frame}.svg"
            if not source.exists():
                raise SystemExit(f"{ek}: missing {frame} frame")
            drawing = clean(source.read_text(), source.name)
            (OUT / f"{ek}-{frame}.svg").write_text(with_notice(drawing, entry["title"].strip(), commit))
        rows.append(f"| {ek} | {entry['title'].strip()} | `{ek}-relaxation.svg`, `{ek}-tension.svg` |")

    (OUT / "CREDITS.md").write_text(
        "# Exercise drawings\n\n"
        "The drawings in this folder are by **Greg Priday** for **Everkinetic** "
        "(everkinetic.com, 2010), from the open-data copy at "
        f"https://github.com/everkinetic/data (commit `{commit}`).\n\n"
        "They are licensed under the **Creative Commons Attribution-ShareAlike 3.0** "
        "licence (https://creativecommons.org/licenses/by-sa/3.0/), the licence the "
        "artist published them under on everkinetic.com in 2010; see LICENSE.md in this "
        "folder. The everkinetic/data repository labels its copy CC BY-SA 4.0. That label "
        "was added by the repository, not by the artist, so this folder follows the artist's "
        "own 3.0 grant.\n\n"
        "**Changes made by TrackIt** (tools/everkinetic/prepare.py): the white background "
        "layer is removed, the line colour is replaced with `currentColor` so the app can "
        "theme it, and the fixed size is dropped in favour of the original viewBox. No line "
        "is redrawn. These modified files are released under the same CC BY-SA licence. "
        "The licence covers only this folder; it does not extend to the rest of TrackIt.\n\n"
        "| Everkinetic id | Exercise | Files |\n|---|---|---|\n" + "\n".join(rows) + "\n"
    )
    print(f"wrote {len(ids) * 2} drawings for {len(ids)} exercises to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
