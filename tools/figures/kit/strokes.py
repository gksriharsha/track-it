"""Vector helpers, smooth curves and brush strokes: the primitives every drawn line is made of.

Nothing here is drawn as an SVG stroke. A line is a filled polygon (a "ribbon") whose width varies along
its length, so the finished file can be pure ink that the app uses as a CSS mask. The width of every
stroke wobbles a little, following a seeded noise, so the same input always gives the same ink.
"""
import math
import zlib

import numpy as np
import shapely
from shapely.geometry import Point, Polygon

LW = 2.1            # outline width, units
LW_INNER = 2.0      # max width of interior muscle strokes
EMPTY = Polygon()

# --------------------------------------------------------------------------- small vector helpers


def _v(p):
    """The point or vector p as a float numpy array."""
    return np.asarray(p, dtype=float)


def _unit(v):
    """The unit vector along v, or straight down (0, 1) when v is too short to have a direction."""
    v = _v(v)
    n = math.hypot(v[0], v[1])
    return v / n if n > 1e-9 else np.array([0.0, 1.0])


def _perp(v):
    """v rotated a quarter turn clockwise on screen (y points down), so east becomes south."""
    return np.array([-v[1], v[0]])


def _ant(d, facing):
    """Anterior normal of a bone running along d (for the standing pose this points where the man faces)."""
    return -facing * _perp(_unit(d))


def _rot(v, deg):
    """v rotated by deg degrees, clockwise on screen because y points down."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([v[0] * c - v[1] * s, v[0] * s + v[1] * c])


def _seed(name):
    """A stable random seed for a part name, so a part's wobble is the same on every run and every machine."""
    return zlib.crc32(name.encode()) & 0xFFFFFFFF


def limb_dir(angle, facing=1):
    """Unit vector for a limb angle: 0 = straight down, +90 = forward (toward facing), 180 = up, -90 = back."""
    a = math.radians(angle)
    return np.array([facing * math.sin(a), math.cos(a)])


def up_dir(angle, facing=1):
    """Unit vector for trunk/head lean: 0 = straight up, +90 = horizontal forward, -20 = leaning back."""
    a = math.radians(angle)
    return np.array([facing * math.sin(a), -math.cos(a)])

# --------------------------------------------------------------------------- curves and strokes


def catmull_rom(points, closed=True, n=10, alpha=0.5):
    """Centripetal Catmull-Rom spline through the points, n samples per span; returns an (M, 2) array.

    The centripetal form (alpha 0.5) never overshoots into loops or cusps between unevenly spaced
    control points, which matters for body profiles whose knots bunch up at the joints."""
    P = _v(points)
    if not closed:
        P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    m = len(P)
    out = []
    rng = range(m) if closed else range(1, m - 2)
    for i in rng:
        p0, p1, p2, p3 = P[(i - 1) % m], P[i % m], P[(i + 1) % m], P[(i + 2) % m]
        t0 = 0.0
        t1 = t0 + max(np.linalg.norm(p1 - p0), 1e-6) ** alpha
        t2 = t1 + max(np.linalg.norm(p2 - p1), 1e-6) ** alpha
        t3 = t2 + max(np.linalg.norm(p3 - p2), 1e-6) ** alpha
        t = np.linspace(t1, t2, n, endpoint=False)[:, None]
        a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
        a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
        a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
        b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
        b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
        out.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    if not closed:
        out.append(P[-2][None, :])
    return np.vstack(out)


def smooth_shape(points, n=10):
    """A closed, smooth shapely Polygon through the control points.

    If the spline crosses itself, the largest valid piece is kept, so a slightly wrong control point
    gives a slightly wrong shape rather than an invalid geometry."""
    pts = catmull_rom(points, closed=True, n=n)
    g = shapely.make_valid(Polygon(pts))
    if g.geom_type != "Polygon":
        polys = [x for x in getattr(g, "geoms", [g]) if x.geom_type == "Polygon"]
        g = max(polys, key=lambda x: x.area)
    return g


def _resample(pts, step=0.6, closed=False):
    """Evenly spaced points (about step apart) along a polyline, with the arc length at each one."""
    P = _v(pts)
    if closed:
        P = np.vstack([P, P[:1]])
    seg = np.hypot(*np.diff(P, axis=0).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    if s[-1] < 1e-6:
        return P[:1], np.array([0.0])
    k = max(2, int(math.ceil(s[-1] / step)) + 1)
    u = np.linspace(0, s[-1], k)
    return np.column_stack([np.interp(u, s, P[:, 0]), np.interp(u, s, P[:, 1])]), u


def _tangents(P, closed=False):
    """Unit tangents at each point of a polyline (central differences)."""
    if closed:
        t = np.roll(P, -1, axis=0) - np.roll(P, 1, axis=0)
    else:
        t = np.gradient(P, axis=0)
    n = np.hypot(t[:, 0], t[:, 1])[:, None]
    return t / np.maximum(n, 1e-9)


def ribbon(pts, widths, closed=False):
    """Variable-width stroke along a polyline as a polygon (union of quads, robust at tight bends).

    Each segment becomes its own quadrilateral and the quads are unioned, rather than offsetting the
    two sides as one outline, because one offset outline folds over itself where the line turns tighter
    than half its width. An open ribbon gets round end caps."""
    P = _v(pts)
    w = np.asarray(widths, float)
    if len(P) < 2:
        return EMPTY
    T = _tangents(P, closed)
    N = np.column_stack([-T[:, 1], T[:, 0]])
    L = P + N * (w[:, None] / 2)
    R = P - N * (w[:, None] / 2)
    idx = np.arange(len(P) - 1)
    if closed:
        idx = np.arange(len(P))
    j = (idx + 1) % len(P)
    quads = np.stack([L[idx], L[j], R[j], R[idx], L[idx]], axis=1)
    keep = np.hypot(*(P[j] - P[idx]).T) > 1e-6
    polys = shapely.polygons(quads[keep])
    bad = ~shapely.is_valid(polys)
    if bad.any():
        polys[bad] = shapely.make_valid(polys[bad])
    ends = [Point(P[0]).buffer(w[0] / 2, 8), Point(P[-1]).buffer(w[-1] / 2, 8)] if not closed else []
    return shapely.union_all(list(polys) + ends)


def _noise(s, seed, scales=((17.0, 0.5), (44.0, 0.4), (7.0, 0.22))):
    """Smooth seeded noise in -1..1 along arc length s: three sine waves of different wavelengths
    (units) and random phases, which reads as a hand's pressure changing rather than as jitter."""
    rng = np.random.default_rng(seed)
    out = np.zeros_like(s, dtype=float)
    for wl, amp in scales:
        out += amp * np.sin(2 * np.pi * s / wl + rng.uniform(0, 2 * np.pi))
    return out / sum(a for _, a in scales)


def brush(pts, width=LW_INNER, taper="both", seed=1, var=0.15, closed=False, step=0.5, smooth=True):
    """A brush stroke along points (smoothed with Catmull-Rom unless smooth=False).

    taper: 'both' (pointed ends), 'start' (thin at start), 'end' (thick start, pointed end), 'none'.
    var is how far the width wobbles (a fraction of width), following the seeded noise."""
    P = _v(pts)
    if smooth and len(P) > 2:
        P = catmull_rom(P, closed=closed, n=8)
    P, s = _resample(P, step, closed=False)
    if s[-1] < 1e-6:
        return EMPTY
    u = s / s[-1]
    if taper == "both":
        prof = np.sin(np.pi * np.clip(u, 0, 1)) ** 0.65
        prof = 0.12 + 0.88 * prof
    elif taper == "end":
        prof = 0.15 + 0.85 * (1 - u) ** 0.7 * np.clip(u / 0.12, 0, 1) ** 0.3
    elif taper == "start":
        prof = 0.15 + 0.85 * u ** 0.7 * np.clip((1 - u) / 0.12, 0, 1) ** 0.3
    else:
        prof = np.ones_like(u)
    w = width * prof * (1 + var * _noise(s, seed))
    return ribbon(P, w)


def curve(a, b, bend=0.0, n=9):
    """Quadratic curve from a to b whose middle is pushed sideways by bend * |b-a| (left of travel, y-down)."""
    a, b = _v(a), _v(b)
    m = (a + b) / 2 + _perp(_unit(b - a)) * bend * np.linalg.norm(b - a)
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 2 * a + 2 * (1 - t) * t * m + t ** 2 * b


def _curvature(P, closed=True, span=4):
    """Signed turning per unit length, smoothed over +-span samples (positive = turning left, numerically)."""
    a = np.roll(P, span, axis=0) if closed else np.vstack([np.repeat(P[:1], span, 0), P[:-span]])
    b = np.roll(P, -span, axis=0) if closed else np.vstack([P[span:], np.repeat(P[-1:], span, 0)])
    v1, v2 = P - a, b - P
    cross = v1[:, 0] * v2[:, 1] - v1[:, 1] * v2[:, 0]
    dot = (v1 * v2).sum(1)
    ang = np.arctan2(cross, dot)
    L = np.hypot(*v1.T) + np.hypot(*v2.T)
    return ang / np.maximum(L, 1e-6) * 2


def outline(poly, lw=LW, seed=1, var=0.30, spacing=60.0, shade=0.12, accent=0.40, step=0.55):
    """Brush outline for a polygon, drawn the way a pen would go round it.

    Each ring is cut into a few strokes (~spacing units long) with tapered, slightly overlapping or gapped
    ends; the width wobbles by +-var, thickens on down-facing edges (shade, the way a drawing is heavier
    on the side away from the light) and in concave turns where forms meet (accent), and thins a little
    over convex bulges. A ring shorter than 45 units is drawn as one closed stroke."""
    if poly is None or poly.is_empty:
        return EMPTY
    rng = np.random.default_rng(seed)
    out = []
    polys = getattr(poly, "geoms", [poly])
    for pg in polys:
        if pg.geom_type != "Polygon":
            continue
        for ri, ring in enumerate([pg.exterior] + list(pg.interiors)):
            C = _v(ring.coords)[:-1]
            if len(C) < 3:
                continue
            P, s = _resample(C, step, closed=True)
            P, s = P[:-1], s[:-1]
            per = s[-1] + np.linalg.norm(P[0] - P[-1])
            T = _tangents(P, closed=True)
            area = 0.5 * np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1])
            out_n = np.sign(area) * np.column_stack([T[:, 1], -T[:, 0]])
            if ri > 0:
                out_n = -out_n
            # outward normal in y-down: positive y component = down-facing edge
            kap = _curvature(P, True, 5) * np.sign(area) * (1 if ri == 0 else -1)  # >0 convex, <0 concave
            acc = np.clip(-kap * 6.0, -0.35, 1.0)
            acc = np.where(acc > 0, accent * acc, 0.4 * accent * acc)
            base = lw * (1 + var * _noise(s, seed + ri)) * (1 + shade * out_n[:, 1]) * (1 + acc)
            nb = int(round(per / spacing))
            if nb < 2 or per < 45:
                out.append(ribbon(P, base, closed=True))
                continue
            start = rng.uniform(0, per)
            cuts = (start + per * (np.arange(nb) + rng.uniform(-0.18, 0.18, nb)) / nb) % per
            cuts.sort()
            for k in range(nb):
                c0, c1 = cuts[k], cuts[(k + 1) % nb]
                if c1 <= c0:
                    c1 += per
                ov0, ov1 = rng.uniform(-0.9, 1.6), rng.uniform(-0.9, 1.6)
                a0, a1 = c0 - ov0, c1 + ov1
                u = np.arange(a0, a1, step)
                if len(u) < 3:
                    continue
                uu = u % per
                ss = np.concatenate([s, [per]])
                PP = np.vstack([P, P[:1]])
                pts = np.column_stack([np.interp(uu, ss, PP[:, 0]), np.interp(uu, ss, PP[:, 1])])
                bw = np.interp(uu, ss, np.concatenate([base, base[:1]]))
                d0, d1 = u - a0, a1 - u
                tl0, tl1 = rng.uniform(3, 7), rng.uniform(3, 7)
                tap = np.minimum(np.clip(d0 / tl0, 0, 1), np.clip(d1 / tl1, 0, 1))
                tap = 0.3 + 0.7 * np.sqrt(tap)
                out.append(ribbon(pts, bw * tap))
    return shapely.union_all(out) if out else EMPTY
