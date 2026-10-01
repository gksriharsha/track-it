"""Equipment: kettlebell, cable column with pulley, cable, rope attachment, floor line and mat.

Each item is a list of Parts drawn with the same brush and line weight as the man, so it sits in the
drawing as one more drawn form; its z decides what it passes in front of and behind.
"""
import math

import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import LineString, Point
from shapely.geometry import box as _sbox

from .parts import Part, make_part
from .strokes import LW, _seed, _unit, _v, brush, curve, ribbon


def _rounded_rect(x0, y0, x1, y1, r):
    """A rectangle from (x0, y0) to (x1, y1) with its corners rounded to radius r (square when r is 0)."""
    return _sbox(x0 + r, y0 + r, x1 - r, y1 - r).buffer(r, 16) if r > 0 else _sbox(x0, y0, x1, y1)


def kettlebell(handle, angle=0.0, size=1.0, z=46, name="kettlebell", lw=LW):
    """Kettlebell gripped at `handle` (centre of the handle bar). angle: direction from the handle to the
    bell, degrees, 0 = bell hangs straight below, +90 = bell to the left (-x), -90 = to the right (+x).
    Real proportions: ball ~27 units across (about a 16 kg bell on the 228-unit man)."""
    s = size
    ball = Point(0, 21.5 * s).buffer(13.5 * s, 48).intersection(_sbox(-30, -30, 30, 33.8 * s))
    outer = _rounded_rect(-12 * s, -2.3 * s, 12 * s, 16 * s, 7.5 * s)
    inner = _rounded_rect(-7.6 * s, 2.3 * s, 7.6 * s, 22 * s, 3.8 * s)
    bell = shapely.union_all([ball, outer.difference(inner)]).buffer(0.6).buffer(-0.6)
    rim = brush(curve((-9.5 * s, 28 * s), (-12.0 * s, 17 * s), -0.15), 1.5, "both", _seed(name))
    base = brush([(-7.5 * s, 31.2 * s), (7.5 * s, 31.2 * s)], 1.3, "both", _seed(name) + 1)
    rot = lambda g: affinity.translate(affinity.rotate(g, angle, origin=(0, 0)), handle[0], handle[1])
    shape = rot(bell)
    return [make_part(name, shape, z, lw=lw, strokes=[rot(rim), rot(base)])]


def cable_column(x, y_top, y_floor, width=12.0, pulley_y=None, side=-1, pulley_r=6.5, z=0, name="column",
                 lw=LW):
    """Cable column upright (an outlined post from y_top to y_floor centred on x) with a pulley wheel on
    side (-1 = left face, +1 = right face) at pulley_y. Returns (parts, pulley_centre, pulley_r);
    pulley_centre is None when there is no pulley."""
    post = _sbox(x - width / 2, y_top, x + width / 2, y_floor)
    groove = brush([(x + side * width * 0.18, y_top + 6), (x + side * width * 0.18, y_floor - 6)], 1.2, "both",
                   _seed(name) + 3, var=0.05)
    parts = [make_part(name, post, z, lw=lw, strokes=[groove], outline_kw=dict(var=0.12))]
    centre = None
    if pulley_y is not None:
        centre = np.array([x + side * (width / 2 + pulley_r * 0.9), pulley_y])
        bracket = _sbox(min(x, centre[0]), pulley_y - 3.2, max(x, centre[0]), pulley_y + 3.2)
        wheel = Point(centre).buffer(pulley_r, 40)
        hub = Point(centre).buffer(1.6, 16)
        parts.append(make_part(name + "_bracket", bracket, z + 0.1, lw=lw * 0.9))
        parts.append(make_part(name + "_pulley", wheel, z + 0.2, lw=lw, solid=[hub]))
    return parts, centre, pulley_r


def pulley_tangent(centre, r, target, side=1):
    """Point on a pulley wheel where a straight cable toward target leaves it (side picks which tangent)."""
    c, t = _v(centre), _v(target)
    v = t - c
    dlen = np.linalg.norm(v)
    if dlen <= r:
        return c
    a = math.acos(r / dlen)
    base = math.atan2(v[1], v[0])
    ang = base + side * a
    return c + r * np.array([math.cos(ang), math.sin(ang)])


def cable(p0, p1, width=1.3, z=5, name="cable"):
    """Thin straight cable (solid ink), occludes nothing."""
    ink = ribbon(np.array([p0, p1], float), np.array([width, width]))
    return [Part(name, None, z, ink)]


def rope(junction, ends, width=3.0, knob_r=3.2, z=47, name="rope", style="solid", lw=LW):
    """Rope attachment: strands from the junction (where the cable clips on) to each end, with a knob at
    each end. ends: list of (x, y). style 'solid' = black strands (best at small sizes); 'outline' =
    white strands with brush outlines like the drawn equipment."""
    j = _v(junction)
    parts = []
    clip = Point(j).buffer(width * 0.9, 16)
    for i, e in enumerate(ends):
        e = _v(e)
        strand = LineString([j, e]).buffer(width / 2, 8)
        knob = Point(e + _unit(e - j) * knob_r * 0.6).buffer(knob_r, 24)
        if style == "solid":
            parts.append(Part("%s_%d" % (name, i), strand.union(knob), z + i * 0.01, strand.union(knob)))
        else:
            sh = strand.buffer(0.8).union(knob)
            parts.append(make_part("%s_%d" % (name, i), sh, z + i * 0.01, lw=lw * 0.8))
    parts.append(Part(name + "_clip", clip, z + 0.05, clip))
    return parts


def floor(x0, x1, y, width=LW, z=-10, name="floor"):
    """A brush floor line from x0 to x1 at height y (top of the line sits at y)."""
    pts = np.array([[x0, y + width / 2], [(x0 + x1) / 2, y + width / 2], [x1, y + width / 2]])
    return [Part(name, None, z, brush(pts, width, "both", _seed(name), var=0.18, smooth=False, step=0.8))]


def mat(x0, x1, y, thick=4.0, z=-9, name="mat", lw=LW):
    """A low exercise mat (outlined slab) whose top is at y."""
    sh = _rounded_rect(x0, y, x1, y + thick, min(2.0, thick / 2))
    return [make_part(name, sh, z, lw=lw * 0.9, outline_kw=dict(var=0.15))]
