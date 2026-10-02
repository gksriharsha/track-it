"""The parts of the plank that the lift draws itself instead of taking the kit's: the torso, neck, head,
upper arm, shoe and shorts, plus extra muscle marks on the kit's own forearm, thigh and shin.

Each is built from the kit's primitives (Bone, brush, ribbon, make_part) so it reads as the same hand.
The drawing's measurements are collected at the top; plank.py imports the ones it also needs. Bones
made here read kit.PROFILES when they are built, so the parts must be built while plank.py has its own
profiles in the kit's tables.
"""
import math

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon

import kit

FACING = 1                  # the man faces +x (right)
LW = kit.LW                 # outline width
MARK_W = 1.45               # every interior mark is drawn this many times the kit's nominal width
HEAD_TILT = -6.0            # the kit's head_tilt (+ nods the face down): the gaze lifts to just ahead of the fists
NECK_GIRTH = (1.0, 0.68)    # the neck's girth (front, back); in this pose its front is the nape, its back the throat
HEAD_GAP = 3.5              # units left open in the head's inner line, just below the nape
HEAD_THIN = 2.0             # the head's line width where it lies over the neck and under the jaw

# The top silhouette, as (u, delta): u is measured along the leg axis from the hip (+ toward the feet)
# and delta is how far the contour sits below the straight back line. From the shoulder blades to the
# waistband, then from the hem (thigh t 0.42 = u 22.68) to the top of the calf; the shorts' top edge
# meets the thigh's contour at the hem with LEG_DELTA's first value.
BACK_DELTA = [(-41.0, 0.30), (-32.0, 0.50), (-23.0, 0.60), (-14.2, 0.45)]
LEG_DELTA = [(22.68, 0.45), (32.4, 0.35), (39.0, 0.40), (48.6, 0.55), (54.0, 0.60), (58.4, 0.35)]

# The shorts: the waistband at t_waist of the way from neck to hip and the hem at t_hem of the thigh;
# the top edge top_grow above the torso's contour at the waist and on the back line at the glute
# (top_glute); the bottom edge bottom_grow below the body at the waist; the waistband and the hem bowed
# toward the feet by bow_waist and bow_hem; a sag of sag units at the crotch (centred at u sag_u, sag_w
# wide); the hem stops hem_gap units short of the underside.
SHORTS = dict(t_waist=0.80, t_hem=0.42, top_grow=0.40, top_glute=0.0, bottom_grow=0.45,
              bow_waist=1.2, bow_hem=0.8, sag=1.4, sag_u=4.0, sag_w=9.0, hem_gap=3.0)

# --------------------------------------------------------------------------- strokes


def pen(pts, w, seed, taper=(3.0, 3.0), ends=(0.3, 0.3), var=0.22, step=0.45):
    """A brush stroke through pts (used as given, already dense) of nominal width w, a number or a list
    of widths spread evenly along the stroke, with its own end tapers (units) down to ends * w."""
    P = np.asarray(pts, float)
    P, s = kit._resample(P, step)
    L = s[-1]
    t0 = np.clip(s / max(taper[0], 1e-6), 0, 1) if taper[0] > 0 else np.ones_like(s)
    t1 = np.clip((L - s) / max(taper[1], 1e-6), 0, 1) if taper[1] > 0 else np.ones_like(s)
    prof = np.minimum(ends[0] + (1 - ends[0]) * np.sqrt(t0), ends[1] + (1 - ends[1]) * np.sqrt(t1))
    ww = w if np.isscalar(w) else np.interp(s / L, np.linspace(0, 1, len(w)), w)
    return kit.ribbon(P, ww * prof * (1 + var * kit._noise(s, seed)))


def mark(bone, ts_pts, w, taper, seed):
    """An interior muscle mark through (t, s) points of a bone, tapered the kit's way ('end': thick at
    the start, pointed at the end), at the kit's 1.15 x nominal width times MARK_W."""
    pts = [bone.at(t, s) for t, s in ts_pts]
    return kit.brush(pts, 1.15 * w * MARK_W, taper, seed)


def outline_gapped(poly, gaps, lw, seed, var=0.28, shade=0.12, accent=0.35, taper=3.0):
    """Brush outline of a polygon in the kit's manner (width wobble, heavier on down-facing edges and in
    concave turns), drawn as open strokes with tapered ends that leave a gap of `length` units centred on
    each (point, length) in gaps: where a form runs into the one behind it instead of being closed off."""
    C = np.asarray(poly.exterior.coords)
    R, s = kit._resample(C, 0.45)
    R, s = R[:-1], s[:-1]
    n = len(R)
    step = (s[-1] + np.linalg.norm(R[0] - R[-1])) / n
    T = kit._tangents(R, closed=True)
    area = 0.5 * np.sum(R[:, 0] * np.roll(R[:, 1], -1) - np.roll(R[:, 0], -1) * R[:, 1])
    out_n = np.sign(area) * np.column_stack([T[:, 1], -T[:, 0]])
    kap = kit._curvature(R, True, 5) * np.sign(area)
    acc = np.clip(-kap * 6.0, -0.35, 1.0)
    acc = np.where(acc > 0, accent * acc, 0.4 * accent * acc)
    w = lw * (1 + var * kit._noise(s, seed)) * (1 + shade * out_n[:, 1]) * (1 + acc)
    off = np.zeros(n, bool)
    for p, length in gaps:
        i = int(np.argmin(np.linalg.norm(R - np.asarray(p), axis=1)))
        h = int(round(length / 2 / step))
        off[[(i + j) % n for j in range(-h, h + 1)]] = True
    if not off.any():
        return kit.ribbon(R, w, closed=True)
    start = int(np.argmax(off))
    runs, cur = [], []
    for k in range(1, n + 1):
        i = (start + k) % n
        if off[i]:
            if cur:
                runs.append(cur)
            cur = []
        else:
            cur.append(i)
    if cur:
        runs.append(cur)
    ink = []
    for run in runs:
        if len(run) < 3:
            continue
        L = (len(run) - 1) * step
        d0 = np.arange(len(run)) * step
        tap = np.minimum(np.clip(d0 / taper, 0, 1), np.clip((L - d0) / taper, 0, 1))
        ink.append(kit.ribbon(R[run], w[run] * (0.3 + 0.7 * np.sqrt(tap))))
    return shapely.union_all(ink)

# --------------------------------------------------------------------------- torso and neck


TORSO_MARKS = [  # (t, s) points (s: +1 front edge = toward the floor, -1 back edge), width, taper
    ([(0.288, 0.86), (0.40, 0.55), (0.52, 0.30), (0.72, 0.10)], 2.2, "end"),          # lat, armpit -> waist
    ([(0.410, 0.62), (0.400, 0.76), (0.382, 0.90)], 1.3, "both"),                     # serratus, three
    ([(0.456, 0.57), (0.446, 0.71), (0.428, 0.86)], 1.3, "both"),
    ([(0.502, 0.52), (0.492, 0.66), (0.474, 0.81)], 1.25, "both"),
    ([(0.565, 1.00), (0.625, 0.78), (0.680, 0.58), (0.715, 0.45)], 2.1, "end"),      # external oblique
    ([(0.46, -0.80), (0.60, -0.81), (0.74, -0.75)], 1.9, "both"),                     # erector
    ([(0.42, -1.00), (0.36, -0.72), (0.31, -0.45)], 2.1, "end"),                      # scapula / teres
]


def torso_part(J):
    """The torso on the solved back profile, with the plank's own marks instead of the kit's."""
    bone = kit.Bone("torso", J["neck"], J["hip"], FACING)
    seed = kit._seed("plank_torso")
    strokes = [mark(bone, pts, w, tp, seed + i) for i, (pts, w, tp) in enumerate(TORSO_MARKS)]
    return kit.make_part("torso", bone.shape(), kit.Z["torso"], strokes=strokes,
                         welds=[("neck", J["neck"], 16)])


def neck_part(J):
    """The kit's neck geometry (the same top point under the skull, caps and weld), narrowed on the
    throat side and without the kit's stroke, which would land on the nape in this pose."""
    hh = kit.HEAD
    U = kit._unit(np.asarray(J["head"]) - np.asarray(J["neck"]))
    _, _, F, Uh = kit._head(np.asarray(J["head"], float), U, FACING, hh, HEAD_TILT)
    top = np.asarray(J["head"]) + Uh * (-0.22 * hh) + F * (-0.12 * hh)
    bone = kit.Bone("neck", J["neck"], top, FACING, NECK_GIRTH)
    return kit.make_part("neck", bone.shape(cap0=2, cap1=3), kit.Z["neck"], welds=[("torso", J["neck"], 16)])

# --------------------------------------------------------------------------- upper arm


# A narrower tube than the kit's, 16-17 units deep at mid-arm.
ARM_PROFILE = [(-0.02, 9.6, 9.4), (0.16, 9.4, 9.2), (0.34, 9.0, 8.8), (0.50, 8.9, 8.2), (0.65, 8.6, 7.9),
               (0.80, 7.9, 7.4), (1.0, 7.0, 7.0)]
# The deltoid cap, in arm-local units (x down the bone from the shoulder joint, y toward the front,
# which here is toward the head).
DELTOID = [(-6.2, -0.5), (-5.8, 4.5), (-4.2, 8.6), (-1.4, 11.4), (2.0, 12.2), (5.5, 11.6), (9.0, 10.4),
           (12.0, 9.4), (13.6, 5.0), (14.6, -1.0), (14.6, -6.0), (13.9, -8.7), (12.0, -9.9), (9.0, -11.0),
           (5.5, -11.9), (2.0, -12.4), (-1.6, -11.8), (-4.4, -8.9), (-5.9, -4.8)]
ARM_MARKS = [  # arm-local points, width, taper
    ([(13.4, -9.3), (15.4, -7.4), (17.4, -5.7)], 1.9, "end"),         # deltoid ends in a point on the back face
    ([(21.0, -2.2), (28.0, -1.0), (35.5, 0.2)], 1.55, "both"),        # biceps / triceps separation
    ([(23.5, -8.6), (26.8, -5.8), (29.2, -4.2)], 1.4, "end"),         # triceps
]
# Where the deltoid's top outline is left open (arm-local point, length): it runs into the scapula
# there rather than closing off like a lid.
ARM_GAPS = [((-5.0, -6.5), 3.0)]


def arm_local(J):
    """Arm-local (x, y) -> world point, for the near upper arm."""
    A = np.asarray(J["near_shoulder"], float)
    d = kit._unit(np.asarray(J["near_elbow"]) - A)
    ant = kit._ant(d, FACING)
    return lambda x, y: A + d * x + ant * y


def upper_arm_part(J):
    """The upper arm: the narrow tube with the deltoid cap, an outline open where it meets the scapula,
    and the deltoid, biceps/triceps and triceps marks clipped inside it."""
    bone = kit.Bone("upper_arm", J["near_shoulder"], J["near_elbow"], FACING)
    loc = arm_local(J)
    delt = kit.smooth_shape([loc(x, y) for x, y in DELTOID])
    shape = shapely.union_all([bone.shape(), delt]).buffer(0.4, 16).buffer(-0.4, 16)
    seed = kit._seed("plank_arm")
    strokes = [kit.brush([loc(x, y) for x, y in pts], 1.15 * w * MARK_W, tp, seed + i)
               for i, (pts, w, tp) in enumerate(ARM_MARKS)]
    gaps = [(loc(x, y), length) for (x, y), length in ARM_GAPS]
    inner = shape.buffer(-0.25)
    ink = shapely.union_all([outline_gapped(shape, gaps, LW, seed)] +
                            [g.intersection(inner) for g in strokes])
    return kit.Part("near_upper_arm", shape, kit.Z["near_upper_arm"], ink,
                    welds=[("near_forearm", J["near_elbow"], 13)])

# --------------------------------------------------------------------------- head


def head_part(J, neck_shape):
    """The kit's head shape with its own outline: about HEAD_THIN units wide where it lies over the neck
    and under the jaw, and open for HEAD_GAP units on the neck side of the nape, the point where the
    back-of-neck line meets the skull. The line is kept on the part (part.line, from the gap's end
    round the head to the nape) so the back-of-neck stroke can be joined to it (plank_joins)."""
    hh = kit.HEAD
    U = kit._unit(np.asarray(J["head"]) - np.asarray(J["neck"]))
    shape, _, F, Uh = kit._head(np.asarray(J["head"], float), U, FACING, hh, HEAD_TILT)
    C = np.asarray(J["head"], float)
    ring = np.asarray(shape.exterior.coords)[:-1]
    R, s = kit._resample(np.vstack([ring, ring[:1]]), 0.4)
    R, s = R[:-1], s[:-1]
    per = s[-1] + np.linalg.norm(R[0] - R[-1])
    over_neck = np.array([neck_shape.buffer(0.3).contains(Point(p)) for p in R])
    u_loc = (R - C) @ Uh / hh
    jaw = u_loc < -0.30
    # the nape: of the ring points where the outline enters or leaves the neck, the one nearer the crown
    idx = np.where(over_neck & ~np.roll(over_neck, 1))[0]
    idx2 = np.where(over_neck & ~np.roll(over_neck, -1))[0]
    ends = list(idx) + list(idx2)
    nape = max(ends, key=lambda i: u_loc[i])
    into = 1 if over_neck[(nape + 1) % len(R)] else -1        # ring direction that runs into the neck
    seed = kit._seed("plank_head")
    w = LW * (1 + 0.25 * kit._noise(s, seed))
    T = kit._tangents(R, closed=True)
    area = 0.5 * np.sum(R[:, 0] * np.roll(R[:, 1], -1) - np.roll(R[:, 0], -1) * R[:, 1])
    out_n = np.sign(area) * np.column_stack([T[:, 1], -T[:, 0]])
    w = w * (1 + 0.10 * np.clip(out_n[:, 1], 0, 1))
    thin = over_neck | jaw
    # blend into the thin width over about 3 units, so the width never steps
    kn = max(3, int(round(3.0 / (per / len(R)))))
    wt = np.convolve(np.concatenate([thin[-kn:], thin, thin[:kn]]).astype(float), np.ones(2 * kn + 1) / (2 * kn + 1),
                     mode="same")[kn:-kn]
    w = w * (1 - wt) + np.minimum(w, HEAD_THIN) * wt
    # an open line: start just past the gap (inside the neck side) and run the other way round to the nape
    n = len(R)
    k = int(round(HEAD_GAP / (per / n)))
    order = [(nape + into * (k + i)) % n for i in range(n - k + 1)]
    pts, ww = R[order], w[order]
    ss = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    tap = 0.35 + 0.65 * np.sqrt(np.clip(ss / 3.0, 0, 1))
    part = kit.Part("head", shape, kit.Z["head"], kit.ribbon(pts, ww * tap))
    part.line = (pts, ww * tap)
    return part

# --------------------------------------------------------------------------- shoe


def foot_frame(J):
    """The kit's sole frame for the shoe: the ankle, s along the sole toward the toe, d toward the ground,
    and k, how much the sole is stretched to reach the toe joint."""
    ankle, toe = np.asarray(J["near_ankle"], float), np.asarray(J["near_toe"], float)
    D = np.linalg.norm(toe - ankle)
    hb = 4.5
    ell = math.sqrt(max(D * D - hb * hb, 1.0))
    g = math.degrees(math.atan2(hb, ell))
    s = kit._rot(kit._unit(toe - ankle), -FACING * g)
    d = FACING * kit._perp(s)
    return ankle, s, d, ell / 25.0


# A shoe on tucked toes, in sole-frame units (x along the sole, y toward the ground): the mid-foot is
# filled out (to about 17 deep) and the toe box is about 2.5 units longer along the floor than the kit's.
FOOT = [(-6.0, -5.0), (-8.8, 0.5), (-9.2, 5.5), (-7.4, 8.8),                  # collar, heel
        (4.0, 9.3), (14.0, 9.5), (19.5, 9.2),                                 # sole down to the ball
        (23.4, 7.4), (25.4, 3.6), (25.9, -2.0),                               # the ball rolls onto the floor
        (25.8, -7.6), (24.5, -10.9), (21.9, -11.1),                           # toe box flat on the floor, tip
        (19.8, -8.4), (16.8, -5.8), (11.0, -5.6),                             # top of the toes, the bend
        (5.0, -6.6), (2.0, -7.9), (-2.5, -7.8)]                               # instep, ankle front


def foot_shape(J):
    """The shoe's outline and its sole-frame mapping. As in the kit's shoe, the points ahead of the ankle
    (x > 3) are stretched by k so the toe reaches the toe joint, and the heel keeps its size."""
    A, s, d, k = foot_frame(J)
    loc = lambda x, y: A + s * (x * k if x > 3 else x) + d * y
    return kit.smooth_shape([loc(x, y) for x, y in FOOT]), loc


def foot_part(J):
    """The shoe, with the line of the sole and the bend of the toes."""
    shape, loc = foot_shape(J)
    sole = kit.brush([loc(-8.4, 6.0), loc(4, 6.6), loc(14, 6.7), loc(19, 6.0)], 1.4, "both", kit._seed("sole"))
    bend = kit.brush([loc(17.4, -5.6), loc(19.9, -3.2), loc(21.6, -0.8)], 1.5, "end", kit._seed("toe"))
    return kit.make_part("near_foot", shape, kit.Z["near_foot"], strokes=[sole, bend])

# --------------------------------------------------------------------------- shorts


def shorts_span(J, body):
    """Where the shorts lie along the body: (u of the waistband, u of the hem, top_delta), where
    top_delta(u) is how far the shorts' top edge sits below the back line. The torso and thigh profiles
    are solved to sit just under this same edge, so the two agree."""
    S = SHORTS
    neck, hip = np.asarray(J["neck"]), np.asarray(J["hip"])
    u_w = body.uw(neck + (hip - neck) * S["t_waist"])[0]
    u_h = S["t_hem"] * kit.BONES["thigh"]
    d_w = float(np.interp(u_w, *zip(*BACK_DELTA)))
    top_delta = lambda u: float(np.interp(u, [u_w, -3.0, u_h], [d_w - S["top_grow"], S["top_glute"],
                                                                LEG_DELTA[0][1]]))
    return u_w, u_h, top_delta


def fold_rows(u_h, top, bw):
    """The shorts' folds as ((u, w) start on a contour, (u, w) pointed end, bend, width, taper), in the
    body frame: two from the crotch toward the glute, one under the hem's top."""
    cu = SHORTS["sag_u"]
    return [((cu + 0.5, bw(cu + 0.5) + 0.2), (cu - 10.0, bw(cu) + 14.5), -0.10, 1.9, "end"),
            ((cu + 4.0, bw(cu + 4.0) + 1.6), (cu - 2.5, bw(cu) + 10.0), -0.10, 1.7, "both"),
            ((u_h - 3.5, top(u_h - 3.5) - 0.2), (u_h - 12.0, top(u_h) - 9.0), 0.06, 1.7, "end")]


def shorts_part(J, body, torso_shape, thigh_shape):
    """The shorts, which cover the hip. Their top and bottom edges are long brush strokes that run on
    into the body's contours; the waistband and the hem lie across the body axis, bowed toward the feet,
    the waistband tapered at both ends and the hem stopping short of the underside; folds at the crotch."""
    S = SHORTS
    u_w, u_h, dlt = shorts_span(J, body)
    us = np.linspace(u_w - 6, u_h + 8, 141)
    # the body's underside (the most negative w of torso and thigh together) at each u
    both = shapely.union_all([torso_shape, thigh_shape])
    under = []
    for u in us:
        seg = LineString([body.pt(u, -40), body.pt(u, 40)]).intersection(both)
        ws = [body.uw(c)[1] for g in getattr(seg, "geoms", [seg]) for c in g.coords] if not seg.is_empty else [0]
        under.append(min(ws))
    under = np.array(under)
    top = lambda u: body.line_w(u) - dlt(u)
    # bottom edge: straight from (underside - grow) at the waist to the thigh's underside at the hem, never
    # above the body, plus a sag at the crotch; blended into the thigh's contour over the last 6 units
    uw0 = float(np.interp(u_w, us, under)) - S["bottom_grow"]
    uh0 = float(np.interp(u_h, us, under))
    lin = uw0 + (uh0 - uw0) * (us - u_w) / (u_h - u_w)
    sag = S["sag"] * np.exp(-((us - S["sag_u"]) / S["sag_w"]) ** 2)
    bot = np.minimum(lin, under - 0.3) - sag
    blend = np.clip((us - (u_h - 6)) / 6, 0, 1) ** 2
    bot = bot * (1 - blend) + under * blend
    bot = np.convolve(np.pad(bot, 4, mode="edge"), np.ones(9) / 9, mode="valid")
    bot = np.where(us > u_h, under, bot)
    bw = lambda u: float(np.interp(u, us, bot))

    def end_curve(u0, bow, n=24):
        wt, wb = top(u0), bw(u0)
        ws = np.linspace(wt, wb, n)
        q = (ws - (wt + wb) / 2) / ((wt - wb) / 2)
        return [(u0 + bow * (1 - qq * qq), w) for qq, w in zip(q, ws)]
    waist = end_curve(u_w, S["bow_waist"])
    hem = end_curve(u_h, S["bow_hem"])
    uu = np.linspace(u_w, u_h, 60)
    poly = [body.pt(u, top(u)) for u in uu] + [body.pt(u, w) for u, w in hem[1:-1]] + \
           [body.pt(u, bw(u)) for u in uu[::-1]] + [body.pt(u, w) for u, w in waist[::-1][1:-1]]
    shape = shapely.make_valid(Polygon(poly)).buffer(0)
    seed = kit._seed("plank_shorts")
    # the long edges run past both ends into the torso's and thigh's contours, tapered
    ut = np.linspace(u_w - 1.6, u_h + 3.5, 90)
    top_pts = [body.pt(u, top(u) if u <= u_h else body.line_w(u) - float(np.interp(u, *zip(*LEG_DELTA))))
               for u in ut]
    ub = np.linspace(u_w - 1.6, u_h + 3.5, 90)
    bot_pts = [body.pt(u, bw(u)) for u in ub]
    ink = [pen(top_pts, LW, seed, taper=(2.5, 3.5), ends=(0.45, 0.4)),
           pen(bot_pts, LW * 1.1, seed + 1, taper=(2.5, 3.5), ends=(0.45, 0.4))]
    # the waistband, tapered to about 1.2 at both ends
    ink.append(pen([body.pt(u, w) for u, w in waist], [1.25, 2.0, 2.15, 2.0, 1.25], seed + 2, taper=(0, 0)))
    # the hem, from the top edge, tapering out hem_gap short of the underside
    hem_pts = [(u, w) for u, w in hem if w > bw(u_h) + S["hem_gap"]]
    ink.append(pen([body.pt(u, w) for u, w in hem_pts], 2.0, seed + 3, taper=(0.0, 5.0), ends=(1.0, 0.12)))
    for i, (a, b, bend, wd, tp) in enumerate(fold_rows(u_h, top, bw)):
        ink.append(kit.brush(kit.curve(body.pt(*a), body.pt(*b), bend), 1.15 * wd * MARK_W, tp, seed + 10 + i)
                   .intersection(shape.buffer(-0.3)))
    ink = shapely.union_all(ink)
    return kit.Part("shorts", shape, kit.Z["shorts"], ink)

# --------------------------------------------------------------------------- marks on the kit's limbs


# ((t0, s0), (t1, s1), bend, width, taper) on the kit's own limbs, beside their own marks; front = toward
# the floor
EXTRA = {
    "near_thigh": ("thigh", [((0.53, 0.05), (0.88, 0.28), 0.05, 1.5, "both"),      # vastus lateralis groove
                             ((0.82, -1.0), (0.96, -0.50), 0.10, 1.5, "end")]),    # hamstring tendon
    "near_shin": ("shin", [((0.50, -1.0), (0.74, -0.38), 0.10, 1.6, "end"),        # soleus
                           ((0.16, 0.10), (0.46, 0.18), 0.05, 1.3, "both"),        # peroneal line
                           ((0.20, -0.72), (0.40, -0.58), 0.06, 1.3, "both")]),    # split of the calf heads
    "near_forearm": ("forearm", [((0.55, 1.0), (0.84, 0.50), 0.05, 1.4, "end")]),  # flexors toward the wrist
}
BONE_OF = {"near_thigh": ("hip", "near_knee"), "near_shin": ("near_knee", "near_ankle"),
           "near_forearm": ("near_elbow", "near_wrist")}


def extra_parts(J, parts):
    """The EXTRA marks, each limb's as a part of its own just in front of that limb, clipped inside it."""
    shapes = {p.name: p for p in parts}
    out = []
    for name, (kind, rows) in EXTRA.items():
        a, b = BONE_OF[name]
        bone = kit.Bone(kind, J[a], J[b], FACING)
        seed = kit._seed("plank_" + kind)
        ink = [kit.brush(kit.curve(bone.at(t0, s0), bone.at(t1, s1), bend), 1.15 * w * MARK_W, tp, seed + i)
               for i, ((t0, s0), (t1, s1), bend, w, tp) in enumerate(rows)]
        ink = shapely.union_all(ink).intersection(shapes[name].shape.buffer(-0.25))
        out.append(kit.Part("extra_" + kind, None, shapes[name].z + 0.5, ink))
    return out
