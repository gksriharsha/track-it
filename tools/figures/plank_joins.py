"""Strokes laid across the places where two of the plank's parts meet, so the outline runs on as one
line there: the back of the neck into the skull, the chest into the throat, and the knee.

Each part draws its own outline, and where two parts overlap the outlines cut each other into small
steps and notches. These strokes follow the union of the two shapes instead, and the parts' own contour
ink is erased where a stroke replaces it.
"""
import numpy as np
import shapely
from shapely import ops
from shapely.geometry import LineString, Point

import kit
from plank_parts import FACING, LW, pen

FILLET_NAPE = 5.0       # radius that rounds the trapezius -> neck corner of the torso and neck union
FILLET_THROAT = 2.5     # the same at the chest -> throat corner
NAPE_FROM = 14.0        # how far back from the neck joint (units, along x) the redrawn nape begins
SIL_TRIM = 4.0          # the nape's erasing band stops this far short of its free end, so the strokes overlap
KNEE_HALF = 7.0         # the knee strokes reach this far along the shin either side of the knee joint


def join_nape(head, sil_pts, sil_w, smooth=1.6, span=5.0):
    """One stroke from the trapezius along the back of the neck into the skull and round the head: the
    back-of-neck path (ending at the head's edge) followed by the head's line from the nape on, with the
    corner at the junction rounded by a short moving average (span units either side), so there is no seam."""
    hp, hw = head.line
    hp, hw = hp[::-1], hw[::-1]                         # nape ... round the head ... gap end
    outside = np.array([not head.shape.contains(Point(p)) for p in sil_pts])
    cut = int(np.argmin(outside)) if not outside.all() else len(sil_pts)
    sp, sw = sil_pts[:cut], sil_w[:cut]
    pts = np.vstack([sp, hp])
    w = np.concatenate([sw, hw])
    j = len(sp)
    step = float(np.mean(np.linalg.norm(np.diff(pts, axis=0), axis=1)))
    h = max(1, int(round(smooth / step)))
    m = int(round(span / step))
    sm = pts.copy()
    for i in range(max(h, j - m), min(len(pts) - h, j + m)):
        wgt = 1.0 - abs(i - j) / (m + 1)
        sm[i] = (1 - wgt) * pts[i] + wgt * pts[i - h:i + h + 1].mean(axis=0)
    return kit.ribbon(sm, w)


def silhouette_run(ring_pts, keep):
    """The ring points of the longest cyclic run of True in keep, in order."""
    n = len(keep)
    if keep.all():
        return ring_pts
    start = int(np.argmin(keep))                      # a False index, so runs do not wrap at the seam
    best, cur = [], []
    for k in range(1, n + 1):
        i = (start + k) % n
        if keep[i]:
            cur.append(i)
        else:
            best, cur = (cur if len(cur) > len(best) else best), []
    best = cur if len(cur) > len(best) else best
    return ring_pts[best]


def silhouette_strokes(J, parts):
    """Redraw the outer silhouette at the trapezius -> neck and chest -> throat junctions as one stroke
    each, along the union of torso and neck closed by a small radius (a fillet), and erase the two parts'
    own contour ink there. The nape's stroke becomes part of the head's line (join_nape); the throat's
    sits just in front of the neck, so the head and the arm still occlude it."""
    by = {p.name: p for p in parts}
    torso, neck, head, arm = by["torso"], by["neck"], by["head"], by["near_upper_arm"]
    nx, ny = J["neck"]
    hx = J["head"][0]
    out, band_all = [], []
    for name, r in (("nape", FILLET_NAPE), ("throat", FILLET_THROAT)):
        U = shapely.union_all([torso.shape, neck.shape]).buffer(r, 32).buffer(-r, 32)
        ring, _ = kit._resample(np.asarray(U.exterior.coords), 0.4)
        deep_head = np.array([head.shape.buffer(-1.6).contains(Point(p)) for p in ring])
        deep_arm = np.array([arm.shape.buffer(-1.6).contains(Point(p)) for p in ring])
        if name == "nape":
            z = (ring[:, 0] > nx - NAPE_FROM) & (ring[:, 0] < hx) & (ring[:, 1] < ny - 2)
        else:
            z = (ring[:, 0] > nx - 6.0) & (ring[:, 0] < hx) & (ring[:, 1] > ny + 1)
        pts = silhouette_run(ring, z & ~deep_head & ~deep_arm)
        if len(pts) < 4:
            continue
        if pts[0][0] > pts[-1][0]:
            pts = pts[::-1]                                # from the body end toward the head
        line = LineString(pts)
        # the band that removes the parts' own contour stops short of the free (trapezius) end, so the new
        # stroke overlaps the torso's contour there instead of leaving a gap
        trim = SIL_TRIM if name == "nape" else 0.0
        band_all.append(ops.substring(line, trim, line.length).buffer(1.55, 16, cap_style="flat"))
        if name == "nape":
            # joined to the head's own line, so the neck flows into the skull without a seam
            s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
            w = LW * (1 + 0.22 * kit._noise(s, kit._seed("sil_nape"))) * (0.75 + 0.25 * np.sqrt(np.clip(s / 1.2, 0, 1)))
            head.ink = join_nape(head, pts, w)
            continue
        # throat: stop at the head's edge and run 1.2 units straight on, under the head's own line (following
        # the union's ring inside the head can double back and leave a hairline)
        outside = np.array([not head.shape.contains(Point(p)) for p in pts])
        if not outside.all():
            c = int(np.argmin(outside))
            pts = np.vstack([pts[:c], pts[c - 1] + kit._unit(pts[c - 1] - pts[c - 4]) * 1.2])
        out.append(kit.Part("sil_" + name, None, kit.Z["neck"] + 0.5,
                            pen(pts, LW * 1.08, kit._seed("sil_" + name), taper=(1.2, 1.2), ends=(0.75, 0.75))))
    # and nothing of the torso's or neck's contour survives right beside the head, which draws its own line
    band = shapely.union_all(band_all + [head.shape.buffer(1.0, 16)])
    for p in (torso, neck):
        p.ink = p.ink.difference(band)
    return out


def knee_strokes(J, parts):
    """The kit's knee weld leaves a shallow V on the inner edge of the straight leg's top and bottom
    contours (each part's outline is cut along the other's rounded end). Lay one stroke along each contour
    across the knee, on the union of thigh and shin: the outer edges coincide, so the stroke only fills
    the V."""
    by = {p.name: p for p in parts}
    th, sh = by["near_thigh"], by["near_shin"]
    U = shapely.union_all([th.shape, sh.shape])
    ring, _ = kit._resample(np.asarray(U.exterior.coords), 0.4)
    knee = np.asarray(J["near_knee"], float)
    out = []
    for side in (-1, 1):                               # -1: the back (top) contour, +1: the front (floor side)
        d = ring - knee
        near = np.linalg.norm(d, axis=1) < 16
        on_side = (d @ kit._ant(np.asarray(J["near_ankle"]) - knee, FACING)) * side > 3
        along = np.abs(d @ kit._unit(np.asarray(J["near_ankle"]) - knee)) < KNEE_HALF
        pts = silhouette_run(ring, near & on_side & along)
        if len(pts) < 6:
            continue
        w = LW * (1.1 if side > 0 else 1.0)
        out.append(kit.Part("knee_%s" % ("front" if side > 0 else "back"), None, sh.z + 0.6,
                            pen(pts, w, kit._seed("knee%d" % side), taper=(2.0, 2.0), ends=(0.7, 0.7))))
    return out
