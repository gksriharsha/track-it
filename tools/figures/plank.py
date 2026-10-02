#!/usr/bin/env python3
"""Draw the forearm plank for TrackIt: one held frame, side view, facing right (+x), like
Everkinetic's 0113.

Usage:
    python3 tools/figures/draw.py plank        (running this file does the same)

writes src/assets/figures/plank-held.svg, from frames(), which returns the file's name and text and
writes nothing.

The pose. The upper arm is vertical, with the elbow under the shoulder. The forearm lies on the floor
at 88 degrees, a hair under horizontal, so that both the elbow and the fist rest on it, and the fist
sits on its little-finger side. The trunk's lean is solved (it comes to about 84.4 degrees) so that the
toes and the forearm touch the same floor. The legs continue the shoulder-to-hip line exactly, so
shoulder, hip, knee and ankle are collinear: the one straight line a plank is held for. The ankle is
at right angles to the shin, on tucked toes. The neck and head lean 12 degrees above the trunk line
and the face is turned 6 degrees up from that, so the gaze lands on the floor just ahead of the fists.
The far arm and leg are not drawn: in a true side view they sit exactly behind the near ones.

The drawing. The kit draws the forearm, fist, thigh and shin; plank_parts.py and plank_joins.py draw
the rest from the same kit primitives, so it reads as the same hand:
  torso       the kit's shape, but the back profile from the shoulder blades to the glutes is solved
              against one straight line tangent to the shoulder blades and the calf, so the back reads
              flat. Its own muscle marks (the lat from the armpit to the waist, three serratus slips
              under it, the external oblique ending short of the waistband, the erector under the back
              contour, one edge of the scapula) follow the muscles and never cross.
  thigh, shin the back profile is solved against the same line, 0.35-0.6 units under it over the
              hamstrings and the knee.
  shorts      their top and bottom edges are long brush strokes that run on into the body's contours;
              the waistband and the hem lie across the body axis (so 8 degrees off vertical on screen),
              bowed toward the feet, the waistband tapered to about 1.2 at both ends and the hem stopping
              3 units short of the underside; a slight sag at the crotch, two folds from the crotch
              toward the glute and one under the hem.
  upper arm   a narrower tube with a deltoid cap whose back edge ends in a point on the arm's back face,
              carried a few units down the arm; its top outline is left open where it runs into the
              scapula; one biceps/triceps separation and a triceps mark.
  head        the kit's head shape with its own outline: about 2 units wide on the neck side and under
              the jaw, a 3.5-unit gap in the inner line below the nape, and the back-of-neck line joined
              to the skull's line as one stroke.
  neck        the kit's neck geometry, narrowed on the throat side, with no stroke of its own.
  foot        a shoe on tucked toes: the mid-foot filled out, the toe box longer along the floor.
  junctions   the trapezius-to-neck and chest-to-throat silhouettes are redrawn as single strokes along
              the filleted union of torso and neck, so no step shows where one part meets the next; the
              knee's two contours get one stroke each across the weld, so the V notches it leaves fill.
  marks       the kit's lower forearm mark starts inside the floor contour instead of notching it, and
              the thigh's marks start 5 or more units past the hem, so none reads as the hem bending
              away. Every interior mark is drawn at 1.45 times the kit's nominal width, which brings the
              interior ink to Everkinetic's level (0.14 of the silhouette) and the spread of line widths
              to 0113's (75th percentile 2.5 units).
The viewBox is sized so that the man is drawn at 0113's size in the app's tiles (EK_FILL).
"""
import math
import sys
from pathlib import Path

import numpy as np
from shapely import affinity
from shapely.geometry import box

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import kit  # noqa: E402
from plank_joins import knee_strokes, silhouette_strokes  # noqa: E402
from plank_parts import (  # noqa: E402
    ARM_PROFILE, BACK_DELTA, FACING, HEAD_TILT, LEG_DELTA, LW, MARK_W, extra_parts, foot_part, foot_shape,
    head_part, neck_part, shorts_part, shorts_span, torso_part, upper_arm_part)

LIFT = "Plank"
SLUG = "plank"
FRAME = "Held"

FLOOR = 200.0       # y of the floor
FOREARM = 88.0      # the forearm's angle (90 would be horizontal), and the fist's
HEAD_DEV = -12.0    # the neck -> head lean, against the trunk's

# Everkinetic's 0113 (its "tension" frame, which the app shows for the side plank) fills 0.8552 of its
# 277-unit viewBox width with the body, head to feet. Both drawings are limited by their width in every
# tile, so matching that fill matches the size on screen. SCALE > 1 draws this man that much larger.
EK_FILL = 0.8552
SCALE = 1.01
PAD_Y = 8           # units of space above and below the ink

# --------------------------------------------------------------------------- the pose


def build(T):
    """The joints for trunk lean T. The legs continue the shoulder -> hip line exactly, so shoulder, hip,
    knee and ankle are collinear, and the foot is at right angles to the shin."""
    J0 = kit.pose_from_angles(hip=(100, 120), facing=FACING, trunk=T, head=T + HEAD_DEV)
    v = np.asarray(J0["hip"]) - np.asarray(J0["near_shoulder"])
    a = math.degrees(math.atan2(FACING * v[0], v[1]))
    return kit.pose_from_angles(hip=(100, 120), facing=FACING, trunk=T, head=T + HEAD_DEV,
                                arm=(0.0, FOREARM), hand=FOREARM, leg=(a, a, -a),
                                far_shoulder_offset=(0.0, 0.0), far_hip_offset=(0.0, 0.0))


def contact_low(J, which):
    """The lowest y (outline included) of the forearm and fist ("arm"), or of the shoe ("foot")."""
    if which == "arm":
        shapes = [kit.Bone("forearm", J["near_elbow"], J["near_wrist"], FACING).shape(),
                  kit.Bone("hand", J["near_wrist"], J["near_hand"], FACING).shape()]
    else:
        shapes = [foot_shape(J)[0]]
    return max(s.bounds[3] for s in shapes) + LW / 2


def solve():
    """The joints with the trunk lean bisected until the toes and the forearm reach the same floor, then
    shifted so both rest on FLOOR."""
    f = lambda T: contact_low(build(T), "foot") - contact_low(build(T), "arm")
    lo, hi = 60.0, 95.0
    if not f(lo) > 0 > f(hi):
        raise ValueError("no trunk lean between %g and %g puts the toes and the forearm on one floor" % (lo, hi))
    for _ in range(40):
        m = (lo + hi) / 2
        lo, hi = (m, hi) if f(m) > 0 else (lo, m)
    J = build((lo + hi) / 2)
    return kit.shift(J, 0, FLOOR - max(contact_low(J, "arm"), contact_low(J, "foot")))

# --------------------------------------------------------------------------- the straight back


class Body:
    """The body frame: origin at the hip, e_u along the leg axis toward the feet, e_n its normal toward
    the back (up). The back line is the upper common tangent of the shoulder blades and the calf, as
    the kit's own profiles draw them; the plank's torso and legs are then solved against it."""

    def __init__(self, J):
        self.J = J
        self.origin = np.asarray(J["hip"], float)
        self.eu = kit._unit(np.asarray(J["near_knee"]) - self.origin)
        n = np.array([-self.eu[1], self.eu[0]])
        self.en = n if n[1] < 0 else -n
        torso = kit.Bone("torso", J["neck"], J["hip"], FACING)
        shin = kit.Bone("shin", J["near_knee"], J["near_ankle"], FACING)
        A = [torso.at(t, -1) for t in np.linspace(0.05, 0.40, 36)]
        B = [shin.at(t, -1) for t in np.linspace(0.05, 0.45, 41)]
        pts = np.array(A + B)
        best = None
        for p in A:
            for q in B:
                e = kit._unit(q - p)
                nn = np.array([-e[1], e[0]])
                nn = nn if nn[1] < 0 else -nn
                h = float(((pts - p) @ nn).max())        # > 0: some point pokes above this line
                if best is None or h < best[0]:
                    best = (h, p, e, nn)
        _, self.L0, self.Le, self.Ln = best              # the upper common tangent (a hull edge, h = 0)

    def uw(self, p):
        """A world point in the body frame, (u, w)."""
        d = np.asarray(p, float) - self.origin
        return float(d @ self.eu), float(d @ self.en)

    def pt(self, u, w):
        """The world point at body-frame (u, w)."""
        return self.origin + self.eu * u + self.en * w

    def line_w(self, u):
        """The height w of the back line above the leg axis at u."""
        # points on the line: L0 + Le * k; find k with (point - O) . eu = u
        k = (u - (self.L0 - self.origin) @ self.eu) / (self.Le @ self.eu)
        return float((self.L0 + self.Le * k - self.origin) @ self.en)


def back_profile(kind, A, B, body, deltas, knots, base):
    """Profile rows for a bone A -> B: the rows of `base` (a kit profile) outside the knots, and at each
    knot t the back half-width solved so the back edge sits delta(u) below the back line, delta
    interpolated from deltas [(u, delta), ...]. The front half-width keeps the base's."""
    bone = kit.Bone(kind, A, B, FACING)
    us = [u for u, _ in deltas]
    ds = [d for _, d in deltas]
    lo, hi = min(knots), max(knots)
    rows = {round(t, 4): (t, f, b) for t, f, b in base if not lo <= t <= hi}
    for t in knots:
        axis = bone.A + bone.d * t * bone.L
        u, w_axis = body.uw(axis)
        want = body.line_w(u) - float(np.interp(u, us, ds))
        back_dir = -bone.ant                                    # unit, toward the back
        b = (want - w_axis) / float(back_dir @ body.en)
        f = float(np.interp(t, [r[0] for r in base], [r[1] for r in base]))
        rows[round(t, 4)] = (t, f, b)
    return [rows[k] for k in sorted(rows)]

# --------------------------------------------------------------------------- the parts


def parts_for(J, body):
    """Every part of the frame. The solved profiles and the plank's marks go into the kit's tables only
    while the parts are built (kit.tables puts back what it found), so nothing of the plank's body
    reaches another lift drawn in the same process; the kit's own rows they start from are read first."""
    u_w, u_h, sh_top = shorts_span(J, body)
    # torso: on the line up to the waistband, then hidden 1 unit under the shorts' top edge
    t_del = BACK_DELTA + [(u, sh_top(u) + 1.0) for u in np.linspace(u_w + 3.5, 12.0, 6)]
    torso_rows = back_profile("torso", J["neck"], J["hip"], body, t_del,
                              [0.42, 0.47, 0.52, 0.58, 0.64, 0.70, 0.76, 0.80, 0.86, 0.92, 0.98, 1.04, 1.14],
                              kit.PROFILES["torso"])
    # thigh: hidden under the shorts, exactly on the shorts' top edge at the hem, then on the line
    th_del = [(u, sh_top(u) + 1.0 * float(np.clip((u_h - u) / 6.0, 0, 1))) for u in np.linspace(-8, u_h, 9)]
    th_del += LEG_DELTA[1:]
    thigh_base = [(-0.12, 13.2, 14.8)] + [r for r in kit.PROFILES["thigh"] if r[0] > -0.1]
    thigh_rows = back_profile("thigh", J["hip"], J["near_knee"], body, th_del,
                              [-0.12, 0.02, 0.12, 0.22, 0.32, 0.42, 0.48, 0.60, 0.72, 0.82, 0.90, 1.0], thigh_base)
    shin_rows = back_profile("shin", J["near_knee"], J["near_ankle"], body, LEG_DELTA, [0.0, 0.08],
                             kit.PROFILES["shin"])
    # the forearm's lower mark starts inside the floor contour instead of notching it
    fore = [((0.04, 1.0), (0.46, 0.30), 0.10, 1.7, "end"), ((0.10, -0.66), (0.34, -0.42), -0.05, 1.4, "both")]
    # the kit's rectus and hamstring marks would start at or under the hem and read as the hem bending
    # away, so they start 5 or more units past it
    km = kit.MUSCLES["thigh"]
    thigh_m = [((0.55, 1.0), (0.76, 0.38), 0.10, 1.9, "end"), km[1], ((0.56, -1.0), (0.80, -0.45), -0.08, 1.6, "end")]
    sc = lambda rows: [(a, b, bend, w * MARK_W, tp) for a, b, bend, w, tp in rows]
    profiles = {"torso": torso_rows, "thigh": thigh_rows, "shin": shin_rows, "upper_arm": ARM_PROFILE}
    muscles = {"forearm": sc(fore), "thigh": sc(thigh_m), "shin": sc(kit.MUSCLES["shin"]),
               "hand": sc(kit.MUSCLES["hand"])}
    # the far limbs sit exactly behind the near ones; the plank draws the rest of these itself
    hide = ("far_upper_arm", "far_forearm", "far_hand", "far_thigh", "far_shin", "far_foot", "shorts_far",
            "torso", "neck", "head", "shorts", "near_upper_arm", "near_foot")
    with kit.tables(profiles=profiles, muscles=muscles):
        parts = kit.figure(J, FACING, detail=1.0, lw=LW, head_tilt=HEAD_TILT, hide=hide)
        torso = torso_part(J)
        neck = neck_part(J)
        head = head_part(J, neck.shape)
        arm = upper_arm_part(J)
        parts += [torso, neck, head, arm, foot_part(J)]
        by = {p.name: p for p in parts}
        parts.append(shorts_part(J, body, torso.shape, by["near_thigh"].shape))
        parts += extra_parts(J, parts)
        parts += silhouette_strokes(J, parts)
        parts += knee_strokes(J, parts)
    return parts

# --------------------------------------------------------------------------- export


def drawing():
    """The frame's ink, and the viewBox (0 0 W H) and offset it is exported with. The width is set so
    the body (heel to the front of the head, leaving out the forearm and fist on the floor) fills
    EK_FILL * SCALE of it, like 0113's, and the ink box is centred."""
    J = solve()
    ink = kit.compose(parts_for(J, Body(J))).buffer(-0.05, 8).buffer(0.05, 8)    # opening: no zero-width spikes
    x0, y0, x1, y1 = ink.bounds
    above = ink.intersection(box(x0 - 1, y0 - 1, x1 + 1, J["near_wrist"][1] - 12))
    body_w = above.bounds[2] - x0
    W = int(round(body_w / (EK_FILL * SCALE)))
    H = int(math.ceil((y1 - y0) + 2 * PAD_Y))
    off = ((W - (x1 - x0)) / 2 - x0, (H - (y1 - y0)) / 2 - y0)
    return ink, (0, 0, W, H), off


def frames():
    """[(file name, SVG text)] for every frame of the lift; writes nothing."""
    ink, vb, off = drawing()
    g = affinity.translate(ink, off[0], off[1])
    return [("%s-%s.svg" % (SLUG, FRAME.lower()), kit.svg_string(g, vb, kit.comment_for(LIFT, FRAME)))]


def preview_inks():
    """(viewBox, offset, [(frame label, ink)]) for kit.preview: the ink is untranslated, offset moves it
    into the viewBox."""
    ink, vb, off = drawing()
    return vb, off, [(FRAME, ink)]


if __name__ == "__main__":
    import draw
    sys.exit(draw.main([SLUG]))
