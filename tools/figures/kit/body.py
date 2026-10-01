"""The man: body profiles, interior muscle marks, draw order, and figure(), which builds him from joints.

Each limb segment is a Bone from one joint to the next. Its outline comes from a profile: half-widths
in front of and behind the bone at stations along it, so a thigh swells at the quadriceps and narrows
to the knee whatever angle it is at. The tables are plain module-level dicts, read each time a Bone is
built, so a lift can override an entry with tables() and every figure built inside that block uses it.
"""
import contextlib
import copy
import math

import numpy as np
import shapely

from .parts import make_part
from .strokes import LW, _ant, _perp, _rot, _seed, _unit, _v, brush, curve, smooth_shape

HEAD = 27.5         # crown-to-chin at scale 1

# Half-widths (front = anterior, back = posterior) along each bone, t: 0 at proximal joint, 1 at distal.
PROFILES = {
    "torso": [(-0.06, 8.0, 9.0), (0.04, 12.0, 14.0), (0.14, 18.0, 17.5), (0.26, 21.0, 18.2), (0.36, 19.5, 17.4),
              (0.42, 16.8, 16.6), (0.52, 16.0, 15.6), (0.64, 15.8, 14.4), (0.78, 15.8, 15.2), (0.90, 15.0, 19.0),
              (1.02, 13.0, 21.4), (1.14, 9.0, 18.0)],
    "upper_arm": [(-0.02, 12.0, 11.8), (0.16, 11.8, 11.4), (0.34, 9.2, 10.2), (0.55, 10.2, 9.2), (0.8, 8.2, 7.8),
                  (1.0, 7.0, 7.0)],
    "forearm": [(0.0, 7.4, 7.6), (0.18, 8.8, 8.0), (0.45, 7.0, 6.4), (0.78, 5.2, 5.0), (1.0, 4.6, 4.6)],
    "hand": [(0.0, 4.6, 4.4), (0.4, 5.9, 5.4), (0.85, 6.5, 5.9), (1.15, 6.0, 5.6)],
    "thigh": [(-0.2, 13.0, 15.0), (0.02, 13.6, 14.6), (0.22, 15.0, 13.6), (0.48, 14.0, 12.4), (0.72, 11.6, 10.4),
              (0.90, 9.2, 8.6), (1.0, 8.6, 7.8)],
    "shin": [(0.0, 8.6, 7.8), (0.08, 7.8, 9.0), (0.22, 7.2, 12.0), (0.38, 6.8, 11.0), (0.62, 5.6, 6.8),
             (0.85, 4.8, 4.8), (1.0, 5.0, 4.6)],
    "neck": [(0.0, 8.8, 12.5), (0.45, 7.6, 9.0), (1.0, 7.4, 8.2)],
}
# How far each bone's outline is rounded out beyond its first and last stations (proximal, distal), units.
CAPS = {"torso": (4, 7), "upper_arm": (7.5, 6), "forearm": (4, 3), "hand": (3, 5.0), "thigh": (4, 6.5),
        "shin": (5, 3), "neck": (3, 3)}

# Interior muscle strokes per bone: ((t0, s0), (t1, s1), bend, width, taper); s in -1..1 (back..front edge).
# Most start on the contour, thick, and run obliquely inward to a point ('end'), as Everkinetic's do.
MUSCLES = {
    "torso": [((0.40, 1.0), (0.31, 0.30), -0.25, 2.2, "end"),         # lower border of the pec
              ((0.17, -1.0), (0.42, -0.50), 0.12, 2.0, "end"),        # lat / scapula edge
              ((0.04, -0.95), (0.20, -0.55), -0.10, 1.6, "end"),      # trapezius
              ((0.05, 0.95), (0.12, 0.35), 0.08, 1.5, "end"),         # clavicle
              ((0.52, 1.0), (0.56, 0.52), 0.10, 1.7, "end"),          # abs
              ((0.66, 1.0), (0.69, 0.58), 0.10, 1.6, "end"),
              ((0.45, 0.62), (0.50, 0.28), 0.10, 1.4, "both"),        # serratus
              ((0.30, -0.20), (0.40, 0.05), 0.15, 1.3, "both"),       # ribcage
              ((0.62, -1.0), (0.70, -0.62), -0.10, 1.6, "end")],      # lower back
    "upper_arm": [((0.04, 1.0), (0.42, 0.18), 0.22, 2.0, "end"),      # front border of the deltoid
                  ((0.06, -1.0), (0.40, -0.25), -0.20, 1.8, "end"),   # rear border of the deltoid
                  ((0.50, -1.0), (0.74, -0.45), 0.08, 1.5, "end"),    # triceps
                  ((0.55, 1.0), (0.82, 0.55), 0.06, 1.4, "end")],     # biceps
    "forearm": [((0.04, 1.0), (0.46, 0.30), 0.10, 1.7, "end"),        # brachioradialis
                ((0.10, -1.0), (0.34, -0.55), -0.05, 1.4, "end")],
    "thigh": [((0.32, 1.0), (0.62, 0.35), 0.10, 1.9, "end"),          # rectus / vastus lateralis
              ((0.70, 1.0), (0.90, 0.50), 0.18, 1.7, "end"),          # teardrop above the knee
              ((0.48, -1.0), (0.76, -0.45), -0.08, 1.6, "end")],      # hamstring
    "shin": [((0.10, -1.0), (0.46, -0.42), -0.15, 1.9, "end"),        # calf head
             ((0.30, 1.0), (0.62, 0.55), 0.05, 1.4, "end"),           # tibia edge
             ((0.0, 1.0), (0.09, 0.45), 0.1, 1.4, "end")],            # below the kneecap
    "hand": [((0.40, 1.0), (0.85, 0.35), 0.12, 1.4, "end"),           # thumb against the fist
             ((0.92, -1.0), (1.02, -0.40), 0.1, 1.2, "end")],         # curled fingers
    "neck": [((0.10, 1.0), (0.70, 0.25), 0.10, 1.5, "end")],          # sternomastoid
}

# Default z (back to front). Override per part with figure(..., z={"near_hand": 60}).
Z = {"far_upper_arm": 10, "far_forearm": 11, "far_hand": 12,
     "far_thigh": 20, "far_shin": 21, "far_foot": 22, "shorts_far": 23,
     "torso": 30, "neck": 31, "head": 32,
     "near_thigh": 40, "near_shin": 41, "near_foot": 42, "shorts": 44,
     "near_upper_arm": 50, "near_forearm": 51, "near_hand": 52}


@contextlib.contextmanager
def tables(profiles=None, caps=None, muscles=None):
    """Override PROFILES / CAPS / MUSCLES entries (by kind) while the parts of one lift are built.

    The tables are changed in place and restored, entry for entry, when the block ends, so a lift's
    own body shape never leaks into another figure built later in the same process."""
    saved = (copy.deepcopy(PROFILES), copy.deepcopy(CAPS), copy.deepcopy(MUSCLES))
    try:
        PROFILES.update(profiles or {})
        CAPS.update(caps or {})
        MUSCLES.update(muscles or {})
        yield
    finally:
        for tab, old in zip((PROFILES, CAPS, MUSCLES), saved):
            tab.clear()
            tab.update(old)


def _profile_at(prof, t, scale=1.0):
    """Front and back half-widths of a profile at station t, interpolated linearly between its rows."""
    ts = [p[0] for p in prof]
    f = np.interp(t, ts, [p[1] for p in prof]) * scale
    b = np.interp(t, ts, [p[2] for p in prof]) * scale
    return f, b


class Bone:
    """A bone from A to B with a profile; local (t, s) -> world points.

    t runs from 0 at A to 1 at B (a profile may reach a little past either end); s runs from -1 on the
    back edge to +1 on the front edge. The profile is copied from PROFILES when the bone is made, scaled
    by girth, which is a number or a (front, back) pair."""

    def __init__(self, kind, A, B, facing, girth=1.0):
        self.kind, self.A, self.B = kind, _v(A), _v(B)
        self.d = _unit(self.B - self.A)
        self.L = max(np.linalg.norm(self.B - self.A), 1e-6)
        self.ant = _ant(self.d, facing)
        gf, gb = (girth, girth) if np.isscalar(girth) else girth
        self.prof = [(t, f * gf, b * gb) for t, f, b in PROFILES[kind]]

    def at(self, t, s):
        """The world point at station t, s of the way from the axis to the front (s > 0) or back edge."""
        f, b = _profile_at(self.prof, t)
        off = s * (f if s >= 0 else b)
        return self.A + self.d * (t * self.L) + self.ant * off

    def shape(self, t0=None, t1=None, cap0=None, cap1=None, grow=(0.0, 0.0), flat0=False, flat1=False):
        """The bone's outline as a smooth polygon, optionally only from t0 to t1.

        cap0 / cap1 override how far each end is rounded out (CAPS); flat0 / flat1 square an end off
        instead; grow adds (front, back) units to the half-widths, e.g. for clothing over the limb."""
        prof = self.prof
        ts = [p[0] for p in prof]
        t0 = ts[0] if t0 is None else t0
        t1 = ts[-1] if t1 is None else t1
        c0, c1 = CAPS[self.kind]
        c0 = c0 if cap0 is None else cap0
        c1 = c1 if cap1 is None else cap1
        knots = [t0] + [t for t in ts if t0 < t < t1] + [t1]
        loc = lambda x, y: self.A + self.d * x + self.ant * y
        fr, bk = [], []
        for t in knots:
            f, b = _profile_at(prof, t)
            fr.append((t * self.L, f + grow[0]))
            bk.append((t * self.L, -(b + grow[1])))
        pts = list(fr)
        # cap at the distal end (front -> back)
        x1, yf1 = fr[-1]
        yb1 = bk[-1][1]
        if flat1:
            pts += [(x1, yf1 + (yb1 - yf1) * q) for q in (0.25, 0.5, 0.75)]
        else:
            mid, r = (yf1 + yb1) / 2, (yf1 - yb1) / 2
            pts += [(x1 + c1 * math.sin(p), mid + r * math.cos(p)) for p in (math.pi / 4, math.pi / 2, 3 * math.pi / 4)]
        pts += bk[::-1]
        x0, yf0 = fr[0]
        yb0 = bk[0][1]
        if flat0:
            pts += [(x0, yb0 + (yf0 - yb0) * q) for q in (0.25, 0.5, 0.75)]
        else:
            mid, r = (yf0 + yb0) / 2, (yf0 - yb0) / 2
            pts += [(x0 - c0 * math.sin(p), mid - r * math.cos(p)) for p in (math.pi / 4, math.pi / 2, 3 * math.pi / 4)]
        return smooth_shape([loc(x, y) for x, y in pts])

    def strokes(self, seed, detail=1.0, scale=1.0):
        """The bone's interior muscle strokes from MUSCLES (none when detail is 0); thinner below detail 1."""
        out = []
        for i, ((t0, s0), (t1, s1), bend, w, taper) in enumerate(MUSCLES.get(self.kind, [])):
            if detail <= 0:
                break
            a, b = self.at(t0, s0), self.at(t1, s1)
            out.append(brush(curve(a, b, bend), 1.15 * w * scale * min(detail, 1.0) ** 0.5, taper, seed + i))
        return out


def _head(C, U, facing, h, tilt=0.0):
    """Faceless head: rounded cranium, flat-ish face, chin and jaw line. C = cranium centre, U = up.

    Returns (shape, strokes, F, U): F is the direction the face looks and U the head's up, after tilt
    (degrees, + nods the face down)."""
    U = _rot(_unit(U), facing * tilt)
    F = _ant(-U, facing)
    ctrl = [(0.00, 0.50), (0.27, 0.45), (0.40, 0.29), (0.43, 0.12), (0.44, -0.04), (0.42, -0.20),
            (0.41, -0.35), (0.31, -0.47), (0.12, -0.43), (-0.06, -0.35), (-0.20, -0.24), (-0.36, -0.12),
            (-0.44, 0.08), (-0.34, 0.36)]
    pts = [C + F * (f * h) + U * (u * h) for f, u in ctrl]
    shape = smooth_shape(pts)
    return shape, [], F, U


def _foot(ankle, toe, facing, scale=1.0):
    """Plain shoe from the ankle joint to the toe tip. Returns shape, sole frame (s, d), strokes.

    s runs along the sole toward the toe and d at right angles to it, toward the ground, so the shoe
    keeps its shape at any foot angle."""
    ankle, toe = _v(ankle), _v(toe)
    D = np.linalg.norm(toe - ankle)
    hb = 4.5 * scale
    ell = math.sqrt(max(D * D - hb * hb, 1.0))
    g = math.degrees(math.atan2(hb, ell))
    s = _rot(_unit(toe - ankle), -facing * g)
    d = facing * _perp(s)
    k = ell / 25.0
    S = scale
    ctrl = [(-6.0 * S, -5.0 * S), (-8.8 * S, 0.5 * S), (-9.2 * S, 5.5 * S), (-7.4 * S, 8.8 * S),
            (4.0 * k, 9.2 * S), (15.0 * k, 9.0 * S), (21.5 * k, 8.2 * S), (24.5 * k, 5.2 * S),
            (23.0 * k, 1.6 * S), (15.0 * k, -1.4 * S), (7.0 * k, -4.6 * S), (3.0 * S, -7.6 * S),
            (-2.5 * S, -7.8 * S)]
    loc = lambda x, y: ankle + s * x + d * y
    shape = smooth_shape([loc(x, y) for x, y in ctrl])
    sole = brush([loc(-8.6 * S, 6.2 * S), loc(6 * k, 6.6 * S), loc(21 * k, 6.0 * S)], 1.4, "both", _seed("sole"))
    return shape, (s, d), [sole]


def _crease(b1, b2, joint, seed, min_angle=35.0):
    """Short crease on the inner side of a bend between bones b1 (proximal) and b2 (distal).

    None when the joint bends less than min_angle degrees, where a real arm or leg shows no fold."""
    ang = math.degrees(math.acos(np.clip(np.dot(b1.d, b2.d), -1, 1)))
    if ang < min_angle:
        return None
    bis = _unit(-b1.d + b2.d)
    f1, bb1 = _profile_at(b1.prof, 1.0)
    side = 1 if np.dot(bis, b1.ant) > 0 else -1
    hw = f1 if side > 0 else bb1
    start = _v(joint) + bis * hw * 0.98
    end = _v(joint) + bis * hw * 0.35
    return brush([start, end], 1.6, "end", seed)


def figure(J, facing=1, girth=None, z=None, detail=1.0, lw=LW, prefix="", shorts_len=0.42, head_tilt=0.0,
           hide=(), creases=True):
    """Build the man from joints J (see pose_from_angles for names). Returns a list of Parts.

    girth: multipliers by kind ('torso', 'upper_arm', 'forearm', 'hand', 'thigh', 'shin', 'foot', 'neck', 'head')
    or by part name ('near_thigh'); a value may be a (front, back) pair.  z: overrides of Z by part name.
    hide: part names to leave out (e.g. 'far_upper_arm' when a hold hides it).  detail: 0 = no muscle strokes.
    prefix is put before every part name, so two men can be composed into one drawing. The far limbs are
    drawn only when their joints are in J."""
    girth = dict(girth or {})
    zz = dict(Z)
    zz.update(z or {})
    gk = lambda name, kind: girth.get(name, girth.get(kind, 1.0))
    parts = []
    P = lambda n: prefix + n
    sc = lambda g: g if np.isscalar(g) else float(np.mean(g))

    def add(name, shape, strokes=(), welds=(), solid=()):
        if name in hide:
            return
        parts.append(make_part(P(name), shape, zz[name], lw=lw, strokes=[s for s in strokes if s is not None],
                               welds=[(P(o), c, r) for o, c, r in welds], solid=solid))

    # torso, neck, head
    torso = Bone("torso", J["neck"], J["hip"], facing, gk("torso", "torso"))
    U = _unit(_v(J["head"]) - _v(J["neck"]))
    hh = HEAD * sc(gk("head", "head"))
    hs, hstrokes, F, Uh = _head(_v(J["head"]), U, facing, hh, head_tilt)
    neck_top = _v(J["head"]) + Uh * (-0.22 * hh) + F * (-0.12 * hh)
    neck = Bone("neck", J["neck"], neck_top, facing, gk("neck", "neck"))
    add("torso", torso.shape(), torso.strokes(_seed(P("torso")), detail),
        welds=[("neck", J["neck"], 16)])
    add("neck", neck.shape(cap0=2, cap1=3), neck.strokes(_seed(P("neck")), detail),
        welds=[("torso", J["neck"], 16)])
    add("head", hs, hstrokes if detail > 0 else [])

    for side in ("far", "near"):
        n = lambda k: side + "_" + k
        if n("shoulder") in J and n("elbow") in J:
            ua = Bone("upper_arm", J[n("shoulder")], J[n("elbow")], facing, gk(n("upper_arm"), "upper_arm"))
            fa = Bone("forearm", J[n("elbow")], J[n("wrist")], facing, gk(n("forearm"), "forearm"))
            ha = Bone("hand", J[n("wrist")], J[n("hand")], facing, gk(n("hand"), "hand"))
            sd = _seed(P(n("arm")))
            cr = [_crease(ua, fa, J[n("elbow")], sd)] if creases and detail > 0 else []
            add(n("upper_arm"), ua.shape(), ua.strokes(sd, detail), welds=[(n("forearm"), J[n("elbow")], 13)])
            add(n("forearm"), fa.shape(), fa.strokes(sd + 7, detail) + cr,
                welds=[(n("upper_arm"), J[n("elbow")], 13), (n("hand"), J[n("wrist")], 7)])
            add(n("hand"), ha.shape(), ha.strokes(sd + 9, detail), welds=[(n("forearm"), J[n("wrist")], 7)])
        if n("knee") in J:
            hip = J.get(n("hip"), J["hip"])
            th = Bone("thigh", hip, J[n("knee")], facing, gk(n("thigh"), "thigh"))
            sh = Bone("shin", J[n("knee")], J[n("ankle")], facing, gk(n("shin"), "shin"))
            fs, _, fst = _foot(J[n("ankle")], J[n("toe")], facing, sc(gk(n("foot"), "foot")))
            sd = _seed(P(n("leg")))
            cr = [_crease(th, sh, J[n("knee")], sd)] if creases and detail > 0 else []
            add(n("thigh"), th.shape(), th.strokes(sd, detail), welds=[(n("shin"), J[n("knee")], 15)])
            add(n("shin"), sh.shape(), sh.strokes(sd + 5, detail) + cr, welds=[(n("thigh"), J[n("knee")], 15)])
            add(n("foot"), fs, fst if detail > 0 else [])
            # shorts: pelvis band (near side only) + loose leg opening down to shorts_len of the thigh
            leg = th.shape(t0=-0.2, t1=shorts_len, grow=(1.2, 1.5), cap1=1.6)
            flare = th.shape(t0=shorts_len - 0.16, t1=shorts_len, grow=(2.1, 2.5), flat0=True, cap1=1.6)
            leg = shapely.union_all([leg, flare]).buffer(2, 16).buffer(-2, 16)
            folds = []
            if side == "near":
                band = torso.shape(t0=0.80, grow=(0.4, 0.6), cap0=2.2)
                sh_shape = shapely.union_all([band, leg]).buffer(3, 24).buffer(-3, 24)
                if detail > 0:
                    folds = [brush(curve(th.at(0.08, 0.95), th.at(0.30, 0.55), 0.1), 1.5, "end", sd + 11),
                             brush(curve(th.at(shorts_len - 0.02, -0.9), th.at(shorts_len - 0.14, -0.55), 0.0),
                                   1.4, "start", sd + 12)]
                add("shorts", sh_shape, folds)
            else:
                add("shorts_far", leg.buffer(-0.8))
    return parts
