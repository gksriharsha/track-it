#!/usr/bin/env python3
"""Face pull (a standing cable face pull with a rope), two frames, drawn for TrackIt with the figure kit.

Usage:
    python3 tools/figures/draw.py face-pull        (running this file does the same)

writes src/assets/figures/face-pull-start.svg and face-pull-halfway.svg, from frames(), which returns
both files as text and writes nothing.

The pose is set in 3D body coordinates and projected, because the halfway position is mostly a lateral
movement (the elbows flare out to the sides) that a flat side view cannot show:
    F  forward (toward the cable column)     U  up, from the floor     L  sideways, + = the near side
The view is turned TH degrees toward the viewer (a slight 3/4 view, as Everkinetic often draws), so the
near side moves back on screen and the far side moves forward:
    screen x = X0 + F cos TH - L sin TH        screen y = FLOOR - U
The body tables, the folded arm, the shorts and the equipment are in face_pull_parts.py.
"""
import math
import sys
from pathlib import Path

import numpy as np
from shapely import affinity

HERE = str(Path(__file__).resolve().parent)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import kit  # noqa: E402
from face_pull_parts import (  # noqa: E402
    FACING, FOLDED_PARTS, PULLEY_R, TABLES, V, equipment, folded_arm, shorts, throat, unit)

LIFT = "Face pull"
SLUG = "face-pull"

# ----------------------------------------------------------------------------- the pose
POSE = dict(
    TH=22.0,              # view turn toward the viewer, degrees
    X0=100.0,             # screen x of the mid-hip point
    FLOOR=250.0,          # floor (soles) y; the soles are shifted onto it exactly
    HIP_U=117.9,          # hip-joint height (legs nearly straight, so they part from the hip, not the knee)
    HIP_HALF=11.5,        # hip joint centres either side of the midline
    SH_HALF=20.0,         # shoulder joint centres either side of the midline
    ANKLE_U=10.0,
    NEAR_ANKLE_F=-14.0,   # staggered stance: near foot back ...
    FAR_ANKLE_F=12.0,     # ... far foot forward (the other way round the legs cross in this 3/4 view)
    FOOT_HALF=11.0,
    PULLEY_F=144.0,       # cable column in front of the man
    PULLEY_U=196.0,       # about mouth height: between face and upper chest
    STRAND=36.0,          # rope strand, junction (cable clip) to the fist centre
    KNOB=6.5,             # rope end (knob) beyond the fist centre
)

# The frames, in the order they are built: the start frame's ground shift is used for halfway too.
#   trunk: lean of hip->neck from vertical (negative = leaning back, away from the cable)
#   head: lean of neck->head centre.  prot: shoulder protraction (+) / retraction (-) along the trunk.
#   fist: (F, U, |L|) of each fist centre; pole: elbow direction hint (F, U, L) for the near arm
#   clip_u: height of the cable clip; None = where the two strands and the cable balance (start)
FRAMES = {
    "start": dict(trunk=-3.0, head=5.0, prot=2.5, fist=(75.0, 202.0, 10.0), pole=(0.0, -1.0, 0.45), clip_u=None),
    # At halfway the clip is held at nose height (U 204) rather than at the balance point (U 207, the eye
    # line), so the near strand slopes down across the cheek instead of running along the eyes.
    "halfway": dict(trunk=-6.0, head=4.0, prot=-2.0, fist=(1.0, 208.0, 31.0), pole=(-0.7, -0.4, 1.0), clip_u=204.0),
}
LABELS = {"start": "Start", "halfway": "Halfway"}
# Per-frame drawing options. At halfway the far arm is behind the torso and head, but in this 3/4 view a
# sliver of the far forearm would show in front of the throat, and the far fist and rope knob would poke
# out in front of the face as a bump that reads as a nose or a hand on the face. They are left out (a
# drawing simplification, as Everkinetic makes); the near strand and the clip carry the rope. The near arm
# is folded (face_pull_parts.folded_arm) and the near strand, which crosses the face, is thinner over it.
FRAME_OPTS = {"start": {},
              "halfway": {"hide": ("far_upper_arm", "far_forearm", "far_hand", "rope_far"),
                          "folded_arm": True, "thin_rope": True}}

BONE = dict(trunk=71.0, neck=20.5, upper_arm=41.0, forearm=33.0, hand=9.0, thigh=54.0, shin=55.0)


def ik3(a, c, l1, l2, pole):
    """3D two-bone solve: middle joint b with |a-b| = l1, |b-c| = l2, on the side `pole` points to."""
    a, c, pole = V(*a), V(*c), V(*pole)
    v = c - a
    d = np.linalg.norm(v)
    u = unit(v)
    if d >= l1 + l2 - 1e-6:
        return a + u * l1, a + u * (l1 + l2)
    x = (d * d + l1 * l1 - l2 * l2) / (2 * d)
    h = math.sqrt(max(l1 * l1 - x * x, 0.0))
    n = unit(pole - np.dot(pole, u) * u)
    return a + u * x + n * h, c


def ik2(a, c, l1, l2, bend):
    """Two-bone solve in the (F, U) plane of a leg; returns the knee (F, U)."""
    b, _ = ik3((a[0], a[1], 0.0), (c[0], c[1], 0.0), l1, l2, (bend[0], bend[1], 0.0))
    return b[:2]


def top_tangent(c, r, t):
    """Upper tangent point (larger U) on a wheel of radius r centred at c, in the (F, U) plane, for a
    straight cable running to t."""
    v = t[:2] - c[:2]
    d = np.linalg.norm(v)
    a = math.acos(min(1.0, r / d))
    base = math.atan2(v[1], v[0])
    pts = [c[:2] + r * np.array([math.cos(base + s * a), math.sin(base + s * a)]) for s in (1, -1)]
    q = max(pts, key=lambda q: q[1])
    return V(q[0], q[1], 0.0)


def pose3d(fr):
    """All joints of one frame in 3D body coordinates (F, U, L)."""
    p = POSE
    f = FRAMES[fr]
    J = {}
    hip = V(0.0, p["HIP_U"], 0.0)
    J["hip_mid"] = hip
    lean = math.radians(f["trunk"])
    up = V(math.sin(lean), math.cos(lean), 0.0)
    fwd = V(math.cos(lean), -math.sin(lean), 0.0)
    J["neck"] = hip + up * BONE["trunk"]
    hl = math.radians(f["head"])
    J["head"] = J["neck"] + V(math.sin(hl), math.cos(hl), 0.0) * BONE["neck"]
    sh = J["neck"] - up * 9.0 + fwd * (-2.5 + f["prot"])
    for side, sgn in (("near", 1.0), ("far", -1.0)):
        # legs: identical in both frames
        hj = V(0.0, p["HIP_U"], sgn * p["HIP_HALF"])
        ank = V(p["NEAR_ANKLE_F"] if side == "near" else p["FAR_ANKLE_F"], p["ANKLE_U"], sgn * p["FOOT_HALF"])
        kn = ik2(hj[:2], ank[:2], BONE["thigh"], BONE["shin"], (1.0, 0.0))
        lat = hj[2] + (ank[2] - hj[2]) * BONE["thigh"] / (BONE["thigh"] + BONE["shin"])
        J[side + "_hipj"] = hj
        J[side + "_knee"] = V(kn[0], kn[1], lat)
        J[side + "_ankle"] = ank
        J[side + "_toe"] = ank + V(25.0, -4.6, 0.0)          # flat shoe, as kit.foot_toe(ankle, 0)
        # arms
        S = sh + V(0.0, 0.0, sgn * p["SH_HALF"])
        F_, U_, L_ = f["fist"]
        H = V(F_, U_, sgn * L_)
        pole = V(*f["pole"]) * V(1.0, 1.0, sgn)
        E, H2 = ik3(S, H, BONE["upper_arm"], BONE["forearm"] + BONE["hand"], pole)
        W = E + (H2 - E) * BONE["forearm"] / (BONE["forearm"] + BONE["hand"])
        J[side + "_shoulder"], J[side + "_elbow"], J[side + "_wrist"], J[side + "_hand"] = S, E, W, H2
    # The rope: the cable pulls the clip along the line from the middle of the fists toward the point where
    # the cable leaves the top of the pulley wheel (or, with clip_u, the clip is held at that height with
    # the strands at their full length).
    pulley = V(p["PULLEY_F"], p["PULLEY_U"], 0.0)
    mid = (J["near_hand"] + J["far_hand"]) / 2
    half = np.linalg.norm(J["near_hand"] - mid)
    if f.get("clip_u") is None:
        reach = math.sqrt(max(p["STRAND"] ** 2 - half ** 2, 1.0))
        target = pulley
        for _ in range(6):
            J["junction"] = mid + unit(target - mid) * reach
            target = top_tangent(pulley, PULLEY_R, J["junction"])
    else:
        du = f["clip_u"] - mid[1]
        J["junction"] = V(mid[0] + math.sqrt(max(p["STRAND"] ** 2 - half ** 2 - du ** 2, 1.0)), f["clip_u"], 0.0)
    for side in ("near", "far"):
        J[side + "_knob"] = J[side + "_hand"] + unit(J[side + "_hand"] - J["junction"]) * p["KNOB"]
    J["pulley"] = pulley
    # A fixed pelvis for the shorts: the trunk axis at the mean of the two frames' leans, so the shorts are
    # identical in both frames although the trunk leans back 3 degrees more at halfway.
    ml = math.radians(sum(fr_["trunk"] for fr_ in FRAMES.values()) / len(FRAMES))
    J["pelvis_top"] = hip + V(math.sin(ml), math.cos(ml), 0.0) * BONE["trunk"]
    return J


def project(J3):
    """The 3D joints on screen, in the turned view described at the top of this file."""
    th = math.radians(POSE["TH"])
    c, s = math.cos(th), math.sin(th)
    out = {}
    for k, v in J3.items():
        out[k] = np.array([POSE["X0"] + v[0] * c - v[2] * s, POSE["FLOOR"] - v[1]])
    return out


def kit_joints(J2):
    """The 2D joint dict the kit's figure() expects. The torso runs from the neck to the MID hip (both on the
    body's midline), and each thigh from its own hip joint (near_hip / far_hip)."""
    J = {"hip": J2["hip_mid"], "near_hip": J2["near_hipj"], "far_hip": J2["far_hipj"],
         "neck": J2["neck"], "head": J2["head"]}
    for side in ("near", "far"):
        for j in ("shoulder", "elbow", "wrist", "hand", "knee", "ankle", "toe"):
            J[side + "_" + j] = J2[side + "_" + j]
    return J


# ----------------------------------------------------------------------------- one frame
def build(fr, ground_dy=None):
    """Every Part of one frame. ground_dy is the vertical shift that puts the soles on the floor; the
    start frame works it out and halfway reuses it, so the feet stand in the same place in both. Returns
    (parts, man, ground_dy), where man is the Parts of the man alone, without the equipment."""
    opts = FRAME_OPTS[fr]
    J2 = project(pose3d(fr))
    J = kit_joints(J2)
    if ground_dy is None:
        ground_dy = POSE["FLOOR"] - kit.sole_points(J, FACING)[:, 1].max()
    J = kit.shift(J, 0, ground_dy)
    J2 = kit.shift(J2, 0, ground_dy)
    hide = tuple(opts.get("hide", ()))
    folded = opts.get("folded_arm", False)
    with kit.tables(**TABLES):
        # the shorts are this lift's own (face_pull_parts.shorts), so the kit's are hidden
        parts = kit.figure(J, FACING, hide=hide + ("shorts", "shorts_far") + (FOLDED_PARTS if folded else ()))
        parts.append(throat(parts, J))
        if folded:
            parts += folded_arm(J)
        parts.append(shorts(J2))
    head_shape = next(p for p in parts if p.name == "head").shape
    parts += equipment(J2, POSE["FLOOR"], head_shape if opts.get("thin_rope") else None,
                       far_rope="rope_far" not in hide)
    man = [p for p in parts if not p.name.startswith(("column", "cable", "rope"))]
    return parts, man, ground_dy


# ----------------------------------------------------------------------------- the canvas
# Padding (viewBox units) round the ink, per side. The app fits the viewBox into each tile with CSS
# 'contain', so the padding decides how big the man is drawn: VB_H is chosen so that the man (crown to
# sole, 228 units) is drawn at the size of Everkinetic's standing man (0118 / 0099 tension, 225 units in a
# 275-unit viewBox) in the 46x54 and 56x64 tiles, and VB_W is kept at or under 0.852 x VB_H (the
# 46x54 tile's aspect) so every tile is height-limited and the man keeps that size in all of them.
VB_H = 272
VB_W = 231
RIGHT_PAD = 7          # room right of the upright's foot plate; the rest of the width goes to the left


def frame_viewbox(inks, man_boxes):
    """The canvas both frames share, (x, y, w, h) in drawing units: VB_W x VB_H, its right edge RIGHT_PAD
    beyond the ink and centred vertically on the man (crown to sole, over both frames)."""
    b = np.array([g.bounds for g in inks])
    x0, x1 = b[:, 0].min(), b[:, 2].max()
    mb = np.array(man_boxes)
    crown, sole = mb[:, 1].min(), mb[:, 3].max()
    right = math.ceil(x1 + RIGHT_PAD)
    left = right - VB_W
    assert left <= x0 - 4, ("too narrow", left, x0)
    top = math.floor((crown + sole) / 2 - VB_H / 2)
    assert top <= b[:, 1].min() - 2 and top + VB_H >= b[:, 3].max() + 2, "too short"
    return (left, top, VB_W, VB_H)


def preview_inks():
    """Both frames drawn, before export: (viewbox, offset, [(frame_label, ink), ...]). The viewbox starts at
    0 0 and offset is the shift that takes the ink onto it, as kit.preview(ink, viewbox, out, offset=offset)
    expects."""
    inks, men, ground_dy = [], [], None
    for fr in FRAMES:
        parts, man, ground_dy = build(fr, ground_dy)
        inks.append(kit.compose(parts))
        men.append(kit.compose(man))
    x, y, w, h = frame_viewbox(inks, [m.bounds for m in men])
    return (0, 0, w, h), (-x, -y), [(LABELS[fr], ink) for fr, ink in zip(FRAMES, inks)]


def frames():
    """The lift's SVG files as [(file_name, svg_text), ...], one per frame, on one shared canvas. Writes
    nothing; the text is the whole file, trailing newline included."""
    vb, (dx, dy), drawn = preview_inks()
    return [("%s-%s.svg" % (SLUG, label.lower()),
             kit.svg_string(affinity.translate(ink, dx, dy), vb, kit.comment_for(LIFT, label)))
            for label, ink in drawn]


if __name__ == "__main__":
    import draw
    sys.exit(draw.main([SLUG]))
