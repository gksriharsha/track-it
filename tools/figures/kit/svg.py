"""Writing the drawings as SVG files, reading SVG files back, and checking a file against the app's rules.

A drawing is written as a single <path fill="currentColor" fill-rule="evenodd">, coordinates rounded
to two decimals, with the attribution comment at the top. The app uses each file as a CSS mask over its
own ink colour, which is why the file may hold nothing but ink: no strokes, no white, no images.
"""
import math
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from shapely import affinity

from .strokes import _v

ROOT = Path(__file__).resolve().parents[3]                      # the repository
FIGURES_DIR = ROOT / "src" / "assets" / "figures"               # where the app's own drawings are written
EK_SVG = ROOT / "src" / "assets" / "everkinetic"                # the app's Everkinetic drawings, for comparison

# --------------------------------------------------------------------------- export


def _fmt(v):
    """A coordinate with at most two decimals and no redundant characters ("0.5" -> ".5", "2.00" -> "2")."""
    s = ("%.2f" % v).rstrip("0").rstrip(".")
    if s.startswith("0."):
        s = s[1:]
    elif s.startswith("-0."):
        s = "-" + s[2:]
    return "0" if s in ("", "-0", "-") else s


def _ring_d(coords):
    """Path data for one closed ring: an absolute moveto, then relative linetos, then z.

    The coordinates are rounded to hundredths first and each step is the difference of rounded
    points, so the rounding error never accumulates along the ring; points that round onto the
    previous one are dropped."""
    c = np.round(_v(coords)[:-1] * 100).astype(np.int64)
    if len(c) < 3:
        return ""
    keep = [0]
    for i in range(1, len(c)):
        if (c[i] != c[keep[-1]]).any():
            keep.append(i)
    c = c[keep]
    out = ["M" + _fmt(c[0][0] / 100) + " " + _fmt(c[0][1] / 100)]
    parts = []
    for i in range(1, len(c)):
        dx, dy = (c[i] - c[i - 1]) / 100
        a, b = _fmt(dx), _fmt(dy)
        sep = "" if b.startswith("-") else " "
        parts.append(a + sep + b)
    body = ""
    for p in parts:
        body += ("" if (p.startswith("-") or not body) else " ") + p
    return out[0] + "l" + body + "z"


def path_d(ink, tol=0.08):
    """SVG path data (absolute M, relative l, 2 decimals) for an ink (Multi)Polygon, simplified by tol
    units first (well under a device pixel at every size the app shows)."""
    g = ink.simplify(tol, preserve_topology=True)
    ds = []
    for pg in getattr(g, "geoms", [g]):
        if pg.is_empty or pg.geom_type != "Polygon":
            continue
        ds.append(_ring_d(pg.exterior.coords))
        ds.extend(_ring_d(r.coords) for r in pg.interiors)
    return "".join(d for d in ds if d)


def svg_string(ink, viewbox, comment, tol=0.08):
    """The whole SVG file for one frame: the viewBox, the comment, and the ink as one even-odd path."""
    vb = " ".join(_fmt(v) for v in viewbox)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s"><!-- %s --><path fill="currentColor" '
            'fill-rule="evenodd" d="%s"/></svg>\n' % (vb, comment, path_d(ink, tol)))


def comment_for(lift, frame):
    """The attribution comment every drawing carries, saying it is original work and not Everkinetic's."""
    return ("%s, %s: drawn for TrackIt in the manner of Everkinetic's drawings. Original work, not adapted "
            "from them." % (lift, frame))


def shared_viewbox(inks, pad=4.0):
    """Integer viewBox (x, y, w, h) covering every ink geometry, with padding."""
    b = np.array([g.bounds for g in inks if not g.is_empty])
    x0, y0 = math.floor(b[:, 0].min() - pad), math.floor(b[:, 1].min() - pad)
    x1, y1 = math.ceil(b[:, 2].max() + pad), math.ceil(b[:, 3].max() + pad)
    return (x0, y0, x1 - x0, y1 - y0)


def export_frames(frames, lift, pad=8.0, origin_zero=True, tol=0.08):
    """frames: list of (svg_path, frame_label, ink). All frames get one shared viewBox; with origin_zero the
    geometry is translated (identically for every frame) so the viewBox starts at 0 0. Returns
    (viewbox, offset) where offset is the (dx, dy) applied; use preview(ink, viewbox, offset=offset).

    One viewBox for every frame of a lift is what keeps the frames lined up when the app swaps them."""
    x, y, w, h = shared_viewbox([f[2] for f in frames], pad)
    off = (-x, -y) if origin_zero else (0, 0)
    vb = (0, 0, w, h) if origin_zero else (x, y, w, h)
    for path, label, ink in frames:
        g = affinity.translate(ink, off[0], off[1])
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w") as f:
            f.write(svg_string(g, vb, comment_for(lift, label), tol))
    return vb, off

# --------------------------------------------------------------------------- reading SVG files back


_NUM = re.compile(r"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_COMMAND = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)")
_ARC_NUM = re.compile(r"[\s,]*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)")
_ARC_FLAG = re.compile(r"[\s,]*([01])")


def _arc_args(args):
    """The arguments of an arc command, in groups of seven, read one at a time: each of the two flags is
    a single digit that may be written without a separator ("0 01-7.05-10.31" is large-arc 0, sweep 1,
    x -7.05, y -10.31), which a plain number pattern would misread as the number 1."""
    out, pos = [], 0
    while True:
        group = []
        for pattern in (_ARC_NUM, _ARC_NUM, _ARC_NUM, _ARC_FLAG, _ARC_FLAG, _ARC_NUM, _ARC_NUM):
            m = pattern.match(args, pos)
            if not m:
                return out
            group.append(float(m.group(1)))
            pos = m.end()
        out.append(group)


def _arc_points(p0, rx, ry, phi, large, sweep, p1):
    """Points along an elliptical arc from p0 to p1 (p0 itself left out), about every 11 degrees, by the
    endpoint-to-centre conversion in the SVG specification's implementation notes."""
    rx, ry = abs(rx), abs(ry)
    if rx < 1e-9 or ry < 1e-9 or np.allclose(p0, p1):
        return [p1.copy()]
    a = math.radians(phi)
    c, s = math.cos(a), math.sin(a)
    dx, dy = (p0 - p1) / 2
    x1, y1 = c * dx + s * dy, -s * dx + c * dy
    lam = (x1 / rx) ** 2 + (y1 / ry) ** 2
    if lam > 1:                                       # radii too small to reach: scaled up, as the spec says
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = (rx * ry) ** 2 - (rx * y1) ** 2 - (ry * x1) ** 2
    den = (rx * y1) ** 2 + (ry * x1) ** 2
    k = math.sqrt(max(num / den, 0.0)) * (-1.0 if bool(large) == bool(sweep) else 1.0)
    cx1, cy1 = k * rx * y1 / ry, -k * ry * x1 / rx
    mx, my = (p0 + p1) / 2
    cx, cy = c * cx1 - s * cy1 + mx, s * cx1 + c * cy1 + my
    t1 = math.atan2((y1 - cy1) / ry, (x1 - cx1) / rx)
    dt = math.atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx) - t1
    if sweep and dt < 0:
        dt += 2 * math.pi
    elif not sweep and dt > 0:
        dt -= 2 * math.pi
    n = max(2, int(math.ceil(abs(dt) / (math.pi / 16))))
    t = t1 + dt * np.arange(1, n + 1) / n
    pts = np.column_stack([cx + rx * c * np.cos(t) - ry * s * np.sin(t), cy + rx * s * np.cos(t) + ry * c * np.sin(t)])
    pts[-1] = p1
    return list(pts)


def _bezier(points, n):
    """n points along a quadratic or cubic Bezier curve (its first control point left out)."""
    P = [np.asarray(p, float) for p in points]
    t = (np.arange(1, n + 1) / n)[:, None]
    if len(P) == 3:
        return list((1 - t) ** 2 * P[0] + 2 * (1 - t) * t * P[1] + t ** 2 * P[2])
    return list((1 - t) ** 3 * P[0] + 3 * (1 - t) ** 2 * t * P[1] + 3 * (1 - t) * t ** 2 * P[2] + t ** 3 * P[3])


def parse_path_d(d, segments=8):
    """Parse SVG path data into a list of rings (arrays of absolute points), curves and arcs flattened
    into straight steps (segments per Bezier curve), so the kit's own files and the app's Everkinetic
    drawings can be rasterised the same way. A drawing command that follows a z starts its ring at the
    point the z returned to."""
    rings, cur, pos, start = [], [], np.zeros(2), np.zeros(2)
    ctrl, prev = None, ""                             # last Bezier control point, and the command it came from
    for cmd, args in _COMMAND.findall(d):
        C, rel = cmd.upper(), cmd.islower()
        if C == "Z":
            if cur:
                rings.append(np.array(cur))
            cur, pos, prev = [], start.copy(), C
            continue
        if C == "A":
            for rx, ry, phi, large, sweep, x, y in _arc_args(args):
                end = pos + (x, y) if rel else np.array([x, y])
                cur = cur or [pos.copy()]
                cur.extend(_arc_points(pos, rx, ry, phi, large, sweep, end))
                pos = end
            prev = C
            continue
        nums = [float(n) for n in _NUM.findall(args)]
        if C in "HV":
            for n in nums:
                cur = cur or [pos.copy()]
                if C == "H":
                    pos = np.array([pos[0] + n if rel else n, pos[1]])
                else:
                    pos = np.array([pos[0], pos[1] + n if rel else n])
                cur.append(pos.copy())
            prev = C
            continue
        size = {"M": 2, "L": 2, "T": 2, "S": 4, "Q": 4, "C": 6}[C]
        groups = np.array(nums[:len(nums) // size * size]).reshape(-1, size)
        for i, g in enumerate(groups):
            pts = [pos + g[k:k + 2] if rel else g[k:k + 2].copy() for k in range(0, size, 2)]
            if C == "M" and i == 0:
                if cur:
                    rings.append(np.array(cur))
                pos = pts[0]
                start = pos.copy()
                cur = [pos.copy()]
                prev = C
                continue
            cur = cur or [pos.copy()]
            if C in "ML":
                cur.append(pts[0].copy())
            elif C in "CS":
                c1 = (2 * pos - ctrl if prev in ("C", "S") else pos) if C == "S" else pts[0]
                c2, end = pts[-2], pts[-1]
                cur.extend(_bezier([pos, c1, c2, end], segments))
                ctrl = c2
            else:
                c1 = (2 * pos - ctrl if prev in ("Q", "T") else pos) if C == "T" else pts[0]
                cur.extend(_bezier([pos, c1, pts[-1]], segments))
                ctrl = c1
            pos, prev = pts[-1], C
    if cur:
        rings.append(np.array(cur))
    return rings


def read_svg(path):
    """Return (rings, viewbox) for an SVG file: every <path> in it, as rings of absolute points."""
    root = ET.parse(path).getroot()
    vb = tuple(float(v) for v in root.get("viewBox").replace(",", " ").split())
    rings = []
    for el in root.iter():
        if el.tag.endswith("path"):
            rings += parse_path_d(el.get("d", ""))
    return rings, vb

# --------------------------------------------------------------------------- the file rules


def verify_svg(path):
    """Check a drawing against the rules every exercise drawing in the app follows. Returns a dict with
    ok (bool), problems (a sorted list of what is wrong), path, viewbox and bytes.

    The rules: an <svg> root with a viewBox and no fixed size; the attribution comment at the top; only
    paths (or groups) filled with currentColor, with no strokes, styles, transforms or opacity, and no
    white; coordinates with at most two decimals."""
    problems = []
    txt = open(path).read()
    res = {"path": path, "bytes": len(txt.encode())}
    try:
        root = ET.fromstring(txt)
    except ET.ParseError as e:
        return {"ok": False, "problems": ["XML parse error: %s" % e], **res}
    if not root.tag.endswith("svg"):
        problems.append("root is not <svg>")
    if root.get("width") is not None or root.get("height") is not None:
        problems.append("root has width/height")
    vb = root.get("viewBox")
    if not vb or len(vb.replace(",", " ").split()) != 4:
        problems.append("missing or malformed viewBox")
    res["viewbox"] = vb
    m = re.search(r"<!--(.*?)-->", txt, re.S)
    if not m or not re.match(r"\s*.+?, .+?: drawn for TrackIt in the manner of Everkinetic's drawings\. Original work, "
                             r"not adapted from them\.\s*$", m.group(1)):
        problems.append("missing or wrong attribution comment")
    if txt.find("<!--") > txt.find("<path"):
        problems.append("comment is not at the top")
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if el is root:
            continue
        if tag not in ("path", "g"):
            problems.append("forbidden element <%s>" % tag)
        if tag == "path" and el.get("fill") != "currentColor":
            problems.append("path without fill=currentColor")
        if tag == "g" and el.get("fill") not in (None, "currentColor"):
            problems.append("<g> with a non-currentColor fill")
        for k in el.attrib:
            if k.startswith("stroke") or k in ("style", "opacity", "fill-opacity", "transform", "class", "color"):
                problems.append("forbidden attribute %s on <%s>" % (k, tag))
        if tag == "path":
            for n in _NUM.findall(el.get("d", "")):
                if "." in n and len(n.split(".")[1].split("e")[0]) > 2:
                    problems.append("coordinate with more than 2 decimals: %s" % n)
                    break
    for bad in ("<mask", "<filter", "<image", "<text", "<clipPath", "<style", "<use", "white", "#fff", "stroke="):
        if bad in txt:
            problems.append("forbidden content %r" % bad)
    res["problems"] = sorted(set(problems))
    res["ok"] = not problems
    return res


def verify_pair(paths):
    """All frames of one lift must share the identical viewBox string, or they would not line up."""
    vbs = [ET.parse(p).getroot().get("viewBox") for p in paths]
    return {"ok": len(set(vbs)) == 1, "viewboxes": vbs}
