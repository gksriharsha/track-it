#!/usr/bin/env python3
"""The kettlebell swing (the two-handed Russian swing), drawn for TrackIt in two frames with the figure kit.

Usage:
    python3 tools/figures/draw.py kettlebell-swing        (running this file does the same)

writes src/assets/figures/kettlebell-swing-start.svg and kettlebell-swing-halfway.svg, from frames(),
which returns both files as text and writes nothing.

A side view: the man faces the viewer's right (facing +1) in both frames, like Everkinetic's 0118 hinge.
Angles follow the kit: absolute screen degrees, 0 = limb straight down or trunk upright, + = toward the
man's front; the trunk angle is the lean of hip->neck from vertical.

START, the hike (the bottom of the swing, the bell travelling back between the legs)
    shin   -4   knee 4 deg ahead of the ankle: shins near vertical
    thigh  +22  knee flexion 26 deg (soft knees: a hinge, not a squat); hip joint 16 behind the ankle
    trunk  +50  back flat, 40 deg above horizontal; hips pushed back behind the heels
    head   +47  (+2 nod) in line with the spine, the gaze a little ahead on the floor
    arms   straight (elbow 0), upper arm along the ribs: shoulder->fist 40 deg BEHIND vertical (10 off the
           shoulder-hip line), so the fists sit 22 below the hip joint, just under the shorts hem, high
           between the thighs (forearms against the inner thighs, hidden by the near thigh), and the bell
           continues that line behind the upper-to-mid thigh, its centre about 15 above the knee, its base
           pointing back. Arms nearer vertical (-27 to -30) hide the bell behind the leg or drop it to knee
           height, which reads as a low hike.
HALFWAY, the float (the top of the swing)
    legs   straight (the knee about 1.5 deg short of locked), the feet exactly where they were
    trunk  0 (vertical, not leaning back); head +5
    arms   straight forward at +78 (fists at chest-to-shoulder height); the bell continues the line of the
           arms, its flat base pointing forward
"""
import math
import sys
from pathlib import Path

import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import MultiPolygon, Point, Polygon

HERE = str(Path(__file__).resolve().parent)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import kit  # noqa: E402

LIFT = "Kettlebell swing"
SLUG = "kettlebell-swing"
F = 1                     # facing right, both frames
B = kit.BONES

# Feet: flat, and identical in both frames (the same ankle and foot angle give a bit-identical shoe).
FEET = {"near": ((100.0, 240.0), 0.0), "far": ((100.0, 240.0), 0.0)}
# The far leg exactly behind the near one: a side-on swing stance. Offsetting it by 1.5-3 units, as the kit
# does by default for depth, reads as a sketchy double outline.
FAR_HIP = (0.0, 0.0)

POSE = {
    "start": dict(shin=-4.0, thigh=22.0, trunk=50.0, head=47.0, arm=-40.0, head_tilt=2.0),
    "halfway": dict(hip_dx=-1.5, trunk=0.0, head=5.0, arm=78.0, head_tilt=0.0),
}
# Canvas, on Everkinetic's scale. 0118 and 0099 tension put a 225-unit standing man in a 275-tall viewBox
# with the crown 31 below the top and the soles 19 above the bottom, so the man is drawn the same size and
# stands on the same line as his neighbours in a list of tiles.
PAD_TOP, PAD_BOTTOM = 31, 19
TILE_ASPECT = 46 / 54   # narrowest app tile (w/h); a canvas no wider than this is fitted by its height
SIDE_MIN = 8            # at least this much clear space beside either frame's ink
START_WEIGHT = 2.0      # the picker and the resting ledger show only the start frame, so it is centred first
KB_SIZE = 1.1           # a 20-24 kg bell; the same size in both frames
SHORTS = 0.32           # shorts length as a fraction of the thigh (the kit's 0.42 reads boxy)

# A rounder seat. With the kit's default torso profile the hinge read as a square box of shorts: the lumbar
# hollow ended in a corner where the glutes began. Only the glute end of the profile changes.
TORSO = kit.PROFILES["torso"][:8] + [
    (0.78, 15.8, 15.8), (0.88, 15.2, 18.8), (0.98, 13.8, 20.8), (1.07, 11.6, 20.4), (1.15, 8.6, 16.5)]
# Three more torso strokes, so the standing side view is not a plain slab of ribcage with less interior ink
# than Everkinetic's: a long lat border, an oblique at the front of the waist, and serratus. The kit's lower
# abs stroke (t 0.66 on the front edge) is left out, because the oblique runs over its inner end and the two
# closed a small white sliver against the front of the waist in the float.
TORSO_STROKES = [m for m in kit.MUSCLES["torso"] if m[0] != (0.66, 1.0)] + [
    ((0.30, -1.0), (0.60, -0.20), 0.16, 1.8, "end"),
    ((0.58, 1.0), (0.71, 0.48), -0.10, 1.7, "end"),
    ((0.37, 1.0), (0.43, 0.62), 0.12, 1.5, "end")]
# In the hike the near upper arm lies along the belly, leaving only a narrow strip of belly below it, and
# strokes that start on the front of the waist would cross that strip as a ladder of tiny white pockets, so
# there are none there. On the back, which faces up in the hike, the long lat border and the ribcage dash run
# parallel to the scapula edge and to each other and read as shirt wrinkles; the hike keeps the trapezius
# and the lower back only, as Everkinetic's 0118 hinge does. The kit's scapula edge (a long stroke from
# t 0.17 to 0.42) also runs parallel to the back, so it is replaced by a short curved hint of the shoulder
# blade that cuts across the back instead.
LAT_BORDER, RIBCAGE, SCAPULA = (0.30, -1.0), (0.30, -0.20), (0.17, -1.0)
TORSO_STROKES_HIKE = [m for m in TORSO_STROKES if not (m[0][1] > 0.9 and 0.45 <= m[0][0] <= 0.75)
                      and m[0] not in (LAT_BORDER, RIBCAGE, SCAPULA)] + [
    ((0.20, -1.0), (0.27, -0.50), 0.28, 1.8, "end")]
# A smaller deltoid. The kit's upper arm starts 12 units wide each side of the shoulder with a 7.5-unit round
# cap, which in the float (the arm raised forward) reads as a puffed sleeve over the whole top of the chest.
# Here the shoulder end starts 0.02 down the bone, narrower on the underside, with a 2.5-unit cap, so the end
# of the arm makes no ball over the chest.
UPPER_ARM = [(0.02, 9.4, 7.6), (0.16, 10.4, 9.4), (0.34, 9.0, 9.6), (0.55, 10.0, 9.0), (0.8, 8.2, 7.8),
             (1.0, 7.0, 7.0)]
UPPER_ARM_CAP = (2.5, 6)
# In the float the rear border of the deltoid (an arc from the armpit into the chest) and the rounded back
# end of the arm together would draw a closed ball: a puffed sleeve. The float drops that stroke, and welds
# the back end of the arm into the torso (its outline is erased inside the torso within FLOAT_WELD_R of a
# point just behind the shoulder joint), so the arm's top line runs on from the shoulder and its underside
# opens into the armpit.
REAR_DELTOID = (0.06, -1.0)
UPPER_ARM_STROKES_FLOAT = [m for m in kit.MUSCLES["upper_arm"] if m[0] != REAR_DELTOID]
FLOAT_WELD_AT, FLOAT_WELD_R = (-0.12, -0.3), 9.0      # (t, s) on the near upper arm bone; radius in units
# In the hike the near upper arm lies along the ribs, nearly parallel to the back, so every stroke along it
# (the borders of the deltoid, the triceps) adds another line parallel to the back, and at 46 px the trunk
# reads as a ribbed tube. The hike keeps only the arm's outline.
UPPER_ARM_STROKES_HIKE = []
# The hamstring stroke on the back of the thigh starts right at the fist and runs down beside the thigh's own
# back contour, doubling the line out of the knot of hand and handle, so the hike leaves it out. The fist is
# mostly hidden by the shorts and the thigh, so its thumb and finger strokes are left out too.
THIGH_STROKES_HIKE = [m for m in kit.MUSCLES["thigh"] if m[0] != (0.48, -1.0)]
HAND_STROKES_HIKE = []

HIKE_HOLE_FILL = 6.0   # white holes below this area (square units) next to the hike's fist are closed
ISLAND_MAX = 2.0       # separate ink specks below this area (square units) are dropped; real strokes are > 6
JOIN_CLOSE, JOIN_OPEN, JOIN_RADIUS = 1.2, 0.7, 4.0   # smoothing at the neck's junctions (units)

# --------------------------------------------------------------------------- ink helpers for this lift


def smooth_open_close(ink, centres, r_close=1.0, r_open=0.6, radius=3.5):
    """Closing (fills notches and stair-steps narrower than 2*r_close) followed by opening (removes spikes
    thinner than 2*r_open) of the ink, kept only inside discs of `radius` around the centres. Both are
    computed on the whole ink, so the edge of a disc cuts through geometry that is unchanged there and
    leaves no seam."""
    g = ink.buffer(r_close, 24).buffer(-r_close, 24)
    g = g.buffer(-r_open, 24).buffer(r_open, 24)
    D = shapely.union_all([Point(c).buffer(radius, 48) for c in centres])
    return shapely.union_all([ink.difference(D), g.intersection(D)])


def tapered_weld(part, other_shape, centre, r, length=3.5, steps=32, max_erode=1.0):
    """Like a kit weld (erase part's ink inside other_shape within r of centre), but the lines the cut
    leaves are tapered to a point over `length` units outside the disc instead of ending square: in each of
    `steps` thin rings beyond r the ink is replaced by the part's ink eroded by a decreasing amount."""
    disc = lambda rr: Point(centre).buffer(rr, 64)
    ink = part.ink
    zone = other_shape.intersection(disc(r))
    band = other_shape.intersection(disc(r + length)).difference(zone)
    keep = ink.difference(zone).difference(band)
    pieces = [keep]
    dl = length / steps
    for k in range(steps):
        ring = other_shape.intersection(disc(r + (k + 1) * dl)).difference(disc(r + k * dl))
        e = max_erode * (1.0 - (k + 0.5) / steps)
        pieces.append(ink.buffer(-e, 16).intersection(ring))
    part.ink = shapely.union_all([p for p in pieces if not p.is_empty])
    return part


def junctions(parts, a, b):
    """Points where the outlines (shape boundaries) of the parts named a and b cross."""
    by = {p.name: p for p in parts}
    if a not in by or b not in by or by[a].shape is None or by[b].shape is None:
        return []
    x = by[a].shape.exterior.intersection(by[b].shape.exterior)
    return [(g.x, g.y) for g in getattr(x, "geoms", [x]) if g.geom_type == "Point"]


def fill_small_holes(ink, max_area, near=None):
    """Fill enclosed white holes smaller than max_area (optionally only those within (x, y, r) of a point)."""
    out = []
    for pg in getattr(ink, "geoms", [ink]):
        holes = []
        for r in pg.interiors:
            h = Polygon(r)
            fill = h.area < max_area
            if fill and near is not None:
                fill = any(h.distance(Point(x, y)) <= rr for x, y, rr in near)
            if not fill:
                holes.append(r)
        out.append(Polygon(pg.exterior, holes))
    return MultiPolygon(out)


def kettlebell(handle, angle=0.0, size=1.0, z=46, name="kettlebell", lw=kit.LW, rim_in=3.2,
               rim_arc=(148.0, 198.0), base_y=30.2):
    """kit.kettlebell with its two highlights moved clear of the outline.

    The kit's rim highlight converges onto the edge of the ball, where it half-merges with the outline and
    leaves a chain of hairline pinholes. Here the rim runs at a constant radius (the ball's radius less
    rim_in) over rim_arc degrees (screen angles about the ball's centre, y down; 180 is the side toward -x
    before rotation). The highlight along the flat base sits at base_y, which leaves a clear gap of about
    2 units above the base outline, where the kit's 31.2 leaves a hairline white sliver. The rest is as in
    the kit."""
    s = size
    ball = Point(0, 21.5 * s).buffer(13.5 * s, 48).intersection(kit._sbox(-30, -30, 30, 33.8 * s))
    outer = kit._rounded_rect(-12 * s, -2.3 * s, 12 * s, 16 * s, 7.5 * s)
    inner = kit._rounded_rect(-7.6 * s, 2.3 * s, 7.6 * s, 22 * s, 3.8 * s)
    bell = shapely.union_all([ball, outer.difference(inner)]).buffer(0.6).buffer(-0.6)
    r = 13.5 * s - rim_in
    th = np.radians(np.linspace(rim_arc[0], rim_arc[1], 11))
    pts = np.column_stack([r * np.cos(th), 21.5 * s + r * np.sin(th)])
    rim = kit.brush(pts, 1.5, "both", kit._seed(name))
    base = kit.brush([(-7.5 * s, base_y * s), (7.5 * s, base_y * s)], 1.3, "both", kit._seed(name) + 1)
    rot = lambda g: affinity.translate(affinity.rotate(g, angle, origin=(0, 0)), handle[0], handle[1])
    return [kit.make_part(name, rot(bell), z, lw=lw, strokes=[rot(rim), rot(base)])]

# --------------------------------------------------------------------------- the pose


def kb_angle(direction_deg):
    """The kettlebell angle for a bell that points along limb direction `direction_deg` (kit limb
    convention, + = forward). The bell is turned with shapely's rotate, under which a positive angle moves
    it from straight below toward -x on screen, so for a man facing +1 the angle is minus the limb angle."""
    return -F * direction_deg


def leg_hip(ankle, shin, thigh):
    """The hip position for the near leg, given the shin and thigh angles, with the ankle fixed."""
    knee = np.array(ankle) - kit.limb_dir(shin, F) * B["shin"]
    return knee - kit.limb_dir(thigh, F) * B["thigh"]


def plant_feet(J):
    """Put both feet on FEET, so the shoes are identical in both frames."""
    for side, (ankle, foot) in FEET.items():
        J = kit.set_leg(J, side, ankle, foot, F)
    return J


def pose_start(p):
    """The hike: (joints, handle, kettlebell angle).

    Both arms are straight and parallel. The far shoulder sits 3 behind and 1.5 above the near one, so the
    far fist lands that far from the near fist: on the same handle, hidden behind the near fist in a side
    view. Reaching the far fist onto exactly the same point would bend its elbow down, and its contour
    would show under the near forearm."""
    hip = leg_hip(FEET["near"][0], p["shin"], p["thigh"])
    J = kit.pose_from_angles(hip=hip, facing=F, trunk=p["trunk"], head=p["head"], far_hip_offset=FAR_HIP,
                             arm=(p["arm"], p["arm"]), far_arm=(p["arm"], p["arm"]))
    J = plant_feet(J)
    handle = J["near_hand"].copy()
    return J, handle, kb_angle(p["arm"])


def pose_halfway(p):
    """The float: (joints, handle, kettlebell angle). The knees are straight to within about 1.5 degrees,
    and the far fist is on the handle by the same parallel arm as in the hike."""
    ankle = np.array(FEET["near"][0])
    hip = ankle + np.array([F * p["hip_dx"], -(B["thigh"] + B["shin"] - 0.02)])
    J = kit.pose_from_angles(hip=hip, facing=F, trunk=p["trunk"], head=p["head"], far_hip_offset=FAR_HIP,
                             arm=(p["arm"], p["arm"]), far_arm=(p["arm"], p["arm"]))
    J = plant_feet(J)
    handle = J["near_hand"].copy()
    return J, handle, kb_angle(p["arm"])


def check(JA, hA, JB, hB):
    """The two frames must be one man: the same bone lengths, the feet in the same place, both fists on
    the handle."""
    for k in ("near_ankle", "near_toe", "far_ankle", "far_toe"):
        assert np.allclose(JA[k], JB[k]), k
    for J, h in ((JA, hA), (JB, hB)):
        assert np.linalg.norm(np.array(J["near_hand"]) - h) < 0.01
        assert np.linalg.norm(np.array(J["far_hand"]) - h) < 4.0
    bones = [("hip", "neck"), ("neck", "head")]
    for s in ("near", "far"):
        bones += [(s + "_shoulder", s + "_elbow"), (s + "_elbow", s + "_wrist"), (s + "_wrist", s + "_hand"),
                  (s + "_hip" if s + "_hip" in JA else "hip", s + "_knee"), (s + "_knee", s + "_ankle"),
                  (s + "_ankle", s + "_toe")]
    for a, b in bones:
        la, lb = (float(np.linalg.norm(np.array(J[a]) - np.array(J[b]))) for J in (JA, JB))
        assert abs(la - lb) <= 0.02 * max(la, lb), (a, b, la, lb)

# --------------------------------------------------------------------------- drawing


def build_figure(J, frame, **kw):
    """kit.figure with this lift's own body tables (the seat, the deltoid, the strokes for each frame).

    The tables are overridden only inside kit.tables(), so nothing of this lift's body shape is left in
    the kit for another lift drawn later in the same process."""
    muscles = {"torso": TORSO_STROKES, "upper_arm": UPPER_ARM_STROKES_FLOAT}
    if frame == "start":
        muscles = {"torso": TORSO_STROKES_HIKE, "upper_arm": UPPER_ARM_STROKES_HIKE, "thigh": THIGH_STROKES_HIKE,
                   "hand": HAND_STROKES_HIKE}
    with kit.tables(profiles={"torso": TORSO, "upper_arm": UPPER_ARM}, caps={"upper_arm": UPPER_ARM_CAP},
                    muscles=muscles):
        parts = kit.figure(J, F, **kw)
        if frame == "halfway":
            b = kit.Bone("upper_arm", J["near_shoulder"], J["near_elbow"], F)
            c = tuple(b.at(*FLOAT_WELD_AT))
            by = {p.name: p for p in parts}
            # a weld whose cut lines taper to a point, where a plain kit weld leaves them ending square
            tapered_weld(by["near_upper_arm"], by["torso"].shape, c, FLOAT_WELD_R)
    return parts


def draw_start(J, handle, ang, p):
    """The hike's parts. The arms pass between the thighs: the forearms and fists behind the near thigh and
    in front of the torso; the bell between the legs, behind the near leg and the near buttock and in front
    of the far leg. The near forearm also passes behind the near hip (z just under the torso's 30): where it
    showed in the gap between the elbow, the waistband and the belly it made two tiny outlined slivers."""
    z = {"near_forearm": 29.6, "near_hand": 36, "far_upper_arm": 24, "far_forearm": 24.5, "far_hand": 25}
    parts = build_figure(J, "start", z=z, head_tilt=p["head_tilt"], shorts_len=SHORTS)
    parts += kettlebell(handle, ang, size=KB_SIZE, z=29)
    return parts


def draw_halfway(J, handle, ang, p):
    """The float's parts: the bell in front of the legs and behind the near arm, the kit's usual place."""
    parts = build_figure(J, "halfway", head_tilt=p["head_tilt"], shorts_len=SHORTS)
    parts += kettlebell(handle, ang, size=KB_SIZE, z=46)
    return parts


def finish(parts, J, frame):
    """Compose one frame's parts into ink, then clean the composition's known artefacts."""
    ink = kit.compose(parts)
    ink = kit.clean(shapely.MultiPolygon([g for g in ink.geoms if g.area >= ISLAND_MAX]))
    # The neck is welded to the torso and the head by erasing outline inside a radius; where the outlines
    # cross at the nape and the throat the two brush lines meet in a stair-step or a sawtooth. A small
    # closing and opening at exactly those crossings rounds them off.
    centres = junctions(parts, "neck", "torso") + junctions(parts, "neck", "head")
    ink = kit.clean(smooth_open_close(ink, centres, r_close=JOIN_CLOSE, r_open=JOIN_OPEN, radius=JOIN_RADIUS))
    if frame == "start":
        # In the hike the fist covers nearly all of the handle's window, and what is left of it shows as
        # two white pinholes inside the knot of fist and handle. They are closed.
        h = J["near_hand"]
        ink = fill_small_holes(ink, HIKE_HOLE_FILL, near=[(h[0], h[1], 9.0)])
    return ink


def canvas(inks):
    """One integer viewBox for every frame, on Everkinetic's scale (see PAD_TOP). Returns (viewbox, offset).

    Height: the crown-to-sole extent plus PAD_TOP and PAD_BOTTOM. Width: as wide as the narrowest tile
    allows without the width becoming the fitted dimension, so the man is drawn at the same size as 0118's.
    Horizontal centre: the ink centroids of the frames, the start frame weighted START_WEIGHT, then pushed
    only as far as needed to keep SIDE_MIN clear beside every frame."""
    b = np.array([g.bounds for g in inks])
    y0 = math.floor(b[:, 1].min() - PAD_TOP)
    H = math.ceil(b[:, 3].max() + PAD_BOTTOM) - y0
    W = math.floor(H * TILE_ASPECT - 0.5)
    lo, hi = b[:, 0].min() - SIDE_MIN, b[:, 2].max() + SIDE_MIN
    W = max(W, math.ceil(hi - lo))
    w = np.array([START_WEIGHT] + [1.0] * (len(inks) - 1))
    cx = float(np.dot(w, [g.centroid.x for g in inks]) / w.sum())
    x0 = cx - W / 2
    x0 = min(max(x0, hi - W), lo)       # keep both edges clear
    x0 = math.floor(x0)
    return (0, 0, W, H), (-x0, -y0)


def preview_inks():
    """(viewbox, offset, [(frame label, ink), ...]) for kit.preview: the ink is in the kit's coordinates,
    before the offset that puts the shared viewBox at 0 0."""
    p_start, p_half = POSE["start"], POSE["halfway"]
    JA, hA, aA = pose_start(p_start)
    JB, hB, aB = pose_halfway(p_half)
    check(JA, hA, JB, hB)
    PA = draw_start(JA, hA, aA, p_start)
    PB = draw_halfway(JB, hB, aB, p_half)
    fa = [p for p in PA if p.name == "near_foot"][0].shape
    fb = [p for p in PB if p.name == "near_foot"][0].shape
    assert fa.equals(fb), "the near foot moved between the frames"
    inks = [("Start", finish(PA, JA, "start")), ("Halfway", finish(PB, JB, "halfway"))]
    vb, off = canvas([ink for _, ink in inks])
    return vb, off, inks


def frames():
    """[(file name, svg text), ...] for both frames, sharing one viewBox. Writes nothing."""
    vb, off, inks = preview_inks()
    out = []
    for label, ink in inks:
        g = affinity.translate(ink, off[0], off[1])
        out.append(("%s-%s.svg" % (SLUG, label.lower()), kit.svg_string(g, vb, kit.comment_for(LIFT, label))))
    return out


if __name__ == "__main__":
    import draw
    sys.exit(draw.main([SLUG]))
