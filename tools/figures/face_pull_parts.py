"""The pieces the face pull draws for itself, on top of the kit's man: its body tables, the throat, the
folded near arm at halfway, the shorts, the rope strands and the cable column.

face_pull.py poses the man and calls these; they are kept here so each file stays a readable length.
Everything is in screen units, y down, with the man facing +x (FACING), as the kit draws him. Like the
kit, this module is imported with tools/figures/ on sys.path, which face_pull.py and draw.py arrange.
"""
import math

import numpy as np
import shapely
import shapely.ops
from shapely.geometry import Point, Polygon

import kit

FACING = 1

# ----------------------------------------------------------------------------- the body
# The kit's default torso, with three local changes:
#   WAIST         the waist taken in 1.5 units each side between t 0.66 and 0.90, so the chest-to-waist
#                 taper reads beside Everkinetic's 0118 instead of a tube from the ribs down;
#   GLUTES        the buttocks trimmed (t 1.02-1.14) so that, in this standing 3/4 view, the shorts follow the
#                 line of the back and thigh (within 1.5 units) instead of standing 5-6 units out behind it;
#   RAISED_CHEST  a gentler fall under the pec (t 0.36-0.54), for arms raised to shoulder height.
# Chest depth (t <= 0.26) and the row at t 0.64 are the kit's, read once, when this module is imported.
KIT_TORSO = list(kit.PROFILES["torso"])
WAIST = [(0.66, 15.1, 13.8), (0.72, 14.5, 13.4), (0.78, 14.3, 13.7), (0.84, 14.2, 14.9), (0.90, 14.1, 16.4)]
GLUTES = [(1.02, 13.0, 16.9), (1.14, 9.0, 14.8)]
# With both arms raised to shoulder height the pectoral is stretched up over the ribs and its lower border
# flattens; the kit's sharp shelf under the pec (19.5 -> 16.8 between t 0.36 and 0.42) would read as a bust
# with the chest in profile at halfway. Same chest depth (21.0 at t 0.26), a gentler fall below it.
RAISED_CHEST = [(0.36, 20.2, 17.4), (0.44, 18.6, 16.4), (0.54, 16.6, 15.4)]
TORSO = ([k for k in KIT_TORSO if k[0] <= 0.26] + RAISED_CHEST + [k for k in KIT_TORSO if 0.54 < k[0] <= 0.64]
         + WAIST + GLUTES)
# The kit's neck runs upward from the base of the neck, so its 'front' half-width column lies on the nape
# and its 'back' column (12.5 at the base, meant as the trapezius slope) lies on the throat. At halfway,
# with the far arm out of the way, that 12.5 would bulge past the top of the chest as a step in the throat.
# Here the throat side is 9.0 at the base, so it runs into the front of the chest in one curve, and the
# sternomastoid stroke sits on the throat (s = -1), running up and back toward the ear.
NECK = [(0.0, 8.8, 9.2), (0.45, 7.6, 7.9), (1.0, 7.4, 7.6)]
NECK_STROKES = [((0.10, -1.0), (0.70, 0.25), 0.10, 1.5, "end")]
# The top of each thigh (t -0.2 to 0.02, the hip and buttock, always under the shorts) is trimmed 1.4-2.4
# units: in this 3/4 view the near thigh's top would push the shorts out behind the line of the back, and
# the far thigh's top would push them out in front of the belly. Below the hem (t > 0.36) the thighs are
# the kit's.
THIGH = [(-0.2, 11.6, 12.0), (0.02, 12.8, 12.8), (0.22, 15.0, 12.9)] + [k for k in kit.PROFILES["thigh"] if k[0] > 0.3]
# Passed to kit.tables() while the man is built, so the kit's own tables are back as they were afterwards.
TABLES = dict(profiles={"torso": TORSO, "neck": NECK, "thigh": THIGH}, muscles={"neck": NECK_STROKES})

# The folded near arm at halfway: the upper arm is foreshortened to 27 of its 41 units on screen, so the
# kit's 12-unit-wide deltoid end would draw a ball over the shoulder. Here it is thinner (0.85), welded
# into the torso so only the part outside the body's silhouette is outlined (the top of the arm runs on
# into the trapezius), and the arm carries two interior strokes only: one deltoid line and one elbow
# crease, both drawn as separate parts. The forearm keeps its angle and its fist position, 0.92 girth, no
# strokes.
FOLDED_PARTS = ("near_upper_arm", "near_forearm")
FOLD_GIRTH = {"near_upper_arm": 0.85, "near_forearm": 0.92}
# A smooth taper from the shoulder to a narrow elbow (the kit's biceps bump at t 0.55 would read as a padded
# sleeve with the arm seen end-on), and small caps where the two bones meet so the elbow comes to a point.
FOLD_TABLES = dict(profiles={"upper_arm": [(-0.02, 11.0, 11.0), (0.2, 10.6, 10.4), (0.5, 9.2, 9.0),
                                           (0.8, 7.6, 7.4), (1.0, 6.4, 6.4)]},
                   caps={"upper_arm": (4.5, 2.6), "forearm": (2.2, 3.0)},
                   muscles={"upper_arm": [], "forearm": []})
SHOULDER_WELD = 15.0
# The deltoid's lower border, drawn as one line: from the edge of the arm (s 1) 40% of the way to the
# elbow, up toward the shoulder and across the arm to t 0.29, s -0.6 (bend > 0 bows it toward the elbow),
# pointed at that upper end.
DELTOID = dict(t0=0.40, s0=1.0, t1=0.29, s1=-0.60, bend=0.14, width=1.9)
# The point of the elbow (olecranon): the outer contours of the two bones meet at a corner OLECRANON units
# beyond the joint, instead of in the round end of two capsules.
OLECRANON = 1.6
# On the outer side of the elbow the forearm's own outline is erased only this far out (the kit erases 13
# all round; 13 is kept on the inner side, the inside of the fold).
ELBOW_WELD = 9.0
# The elbow crease: the forearm's inner contour carried on from where the forearm meets the upper arm (the
# inside of the fold) a few units toward the elbow, tapering out.
CREASE = dict(length=6.0, width=1.7)

# Shorts: their length as a fraction of the thigh; the growth (units) of the pelvis band and the leg tubes
# over the body, the hem flare, and the crotch notch (its apex notch_t of the thigh above the hem; notch_w
# the gap between the two openings at the hem).
SHORTS_LEN = 0.36
SHORTS_GEOM = dict(band_f=0.5, band_b=0.4, tube_f=1.2, tube_b=0.4, hem_f=1.9, hem_b=0.7, notch_t=0.11,
                   notch_w=4.2)

# Where the neck meets the chest: the fillet radius of the rounded corner, the radius of the patch that
# is redrawn, and how far the new stroke runs on past the patch.
THROAT = dict(fillet=4.0, zone=7.0, reach=3.5)

PULLEY_R = 6.5
COL_W = 9.0
# The upright and its foot plate are ruled: width variation 0.04 (the body's brush uses 0.12-0.30), no
# down-edge shading, and one unbroken stroke round each, so the edges run straight with no tapered joins.
POST_OUTLINE = dict(var=0.04, spacing=1e4, shade=0.0, accent=0.2)


def V(*a):
    """A point or vector as a float numpy array."""
    return np.array(a, dtype=float)


def unit(v):
    """The unit vector along v, in any number of dimensions (v itself when it is too short)."""
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def opening(g, r):
    """Morphological opening: removes necks and spurs narrower than 2r."""
    return g.buffer(-r, 16).buffer(r, 16)


def closing(g, r):
    """Morphological closing: fills notches and concave corners narrower than 2r."""
    return g.buffer(r, 16).buffer(-r, 16)


# ----------------------------------------------------------------------------- throat
def throat(parts, J):
    """Where the front of the neck runs into the top of the chest, the neck's and the torso's outlines
    meet at an angle, the two brush ends side by side. This draws that stretch once: a white patch over
    the junction (the union of neck and torso, its concave corner rounded with a fillet) that hides both
    outlines there, and one brush stroke along the patch's outer edge, running on `reach` units past it on
    either side so it overlaps the outlines it joins. The torso's interior strokes inside the patch are
    put back. Returns the patch as a Part."""
    torso, neck = next(p for p in parts if p.name == "torso"), next(p for p in parts if p.name == "neck")
    tb = kit.Bone("torso", J["neck"], J["hip"], FACING)
    xs = torso.shape.exterior.intersection(neck.shape.exterior)
    pts = [np.array(g.coords[0]) for g in getattr(xs, "geoms", [xs]) if not g.is_empty]
    c = max(pts, key=lambda q: np.dot(q - np.asarray(J["neck"], float), tb.ant))
    t = THROAT
    U = closing(torso.shape.union(neck.shape), t["fillet"])
    if U.geom_type != "Polygon":
        U = max(U.geoms, key=lambda g: g.area)
    patch = U.intersection(Point(c).buffer(t["zone"], 48))
    edge = U.exterior.intersection(Point(c).buffer(t["zone"] + t["reach"], 48))
    edge = shapely.ops.linemerge(edge) if edge.geom_type == "MultiLineString" else edge
    if edge.geom_type == "MultiLineString":
        edge = min(edge.geoms, key=lambda g: g.distance(Point(c)))
    line = np.asarray(edge.coords)
    ink = kit.brush(line, kit.LW * 1.05, "both", kit._seed("throat"), var=0.12, smooth=False)
    back = shapely.union_all([s for s in tb.strokes(kit._seed("torso")) if not s.is_empty])
    ink = ink.union(back.intersection(torso.shape.buffer(-0.25)).intersection(patch))
    return kit.Part("throat", patch, 31.5, ink)


# ----------------------------------------------------------------------------- the folded near arm
def folded_arm(J):
    """The near arm as it is drawn at halfway, folded with the elbow out to the side (see FOLD_GIRTH):
    the upper arm and forearm, an invisible weld zone at the elbow, the deltoid line and the elbow crease.
    Call it inside kit.tables(**TABLES), with the near arm hidden from kit.figure(). Returns the Parts."""
    with kit.tables(**FOLD_TABLES):
        arm = kit.figure(J, FACING, girth=FOLD_GIRTH)
        arm = [p for p in arm if p.name in FOLDED_PARTS]
        ua = kit.Bone("upper_arm", J["near_shoulder"], J["near_elbow"], FACING, FOLD_GIRTH["near_upper_arm"])
        fa = kit.Bone("forearm", J["near_elbow"], J["near_wrist"], FACING, FOLD_GIRTH["near_forearm"])
    el = np.asarray(J["near_elbow"], float)
    bis = unit(fa.d + unit(np.asarray(J["near_shoulder"], float) - el))
    sa = 1.0 if np.dot(ua.ant, bis) < 0 else -1.0
    sf = 1.0 if np.dot(fa.ant, bis) < 0 else -1.0
    A, B = ua.at(1.0, sa), fa.at(0.0, sf)
    tip = el - bis * (max(np.linalg.norm(A - el), np.linalg.norm(B - el)) + OLECRANON)
    # The point: the convex hull of both bones near the joint and the tip, so the outer contours run
    # straight and tangent into the tip (the forearm's round end does not curl out beside it).
    shapes = {p.name: p.shape for p in arm}
    disk = Point(el).buffer(8.0, 48)
    point = shapely.union_all([shapes["near_upper_arm"].intersection(disk),
                               shapes["near_forearm"].intersection(disk), Point(tip).buffer(1.0, 24)]).convex_hull
    # The upper arm's shape takes in the point and the forearm's first 12.5 units, so the outer contour of
    # the elbow is one outline. Where the two bones are welded, the forearm's outline is erased on its inner
    # side out to 13 units (the kit's elbow weld: its inner contour ends where it meets the upper arm, the
    # inside of the fold) but on its outer side only out to ELBOW_WELD, so its own ribbon takes over the
    # outer contour inside the merged part and one ribbon runs on past its end.
    uni = closing(shapely.union_all([shapes["near_upper_arm"], point,
                                     shapes["near_forearm"].intersection(Point(el).buffer(12.5, 48))]), 1.0)
    n_in = -fa.ant * sf
    inner = Polygon([el - fa.d * 40, el + fa.d * 40, el + fa.d * 40 + n_in * 40, el - fa.d * 40 + n_in * 40])
    zone = shapely.union_all([uni.intersection(inner).intersection(Point(el).buffer(13.0, 48)),
                              uni.intersection(Point(el).buffer(ELBOW_WELD, 48))])
    for i, p in enumerate(arm):
        if p.name == "near_upper_arm":
            welds = [w for w in p.welds if w[0] != "near_forearm"]
            q = kit.make_part("near_upper_arm", uni, p.z, welds=welds)
            q.welds.append(("torso", tuple(J["near_shoulder"]), SHOULDER_WELD))
            arm[i] = q
        elif p.name == "near_forearm":
            p.welds = [w for w in p.welds if w[0] != "near_upper_arm"] + [("elbow_zone", tuple(el), 40.0)]
    out = arm + [kit.Part("elbow_zone", zone, -100, None, occludes=False)]
    ua_shape = next(p for p in arm if p.name == "near_upper_arm").shape
    fa_shape = next(p for p in arm if p.name == "near_forearm").shape
    # the deltoid line, kept inside the upper arm and off the forearm
    d = DELTOID
    ink = kit.brush(kit.curve(ua.at(d["t0"], d["s0"]), ua.at(d["t1"], d["s1"]), d["bend"]), d["width"], "end",
                    kit._seed("deltoid"))
    ink = ink.intersection(ua_shape.buffer(-0.3)).difference(fa_shape)
    out.append(kit.Part("deltoid_line", None, 50.5, ink))
    # The elbow crease: where the forearm's inner contour crosses the upper arm's top contour (the crossing
    # farther from the elbow joint, inside the bend), the contour is carried on toward the elbow.
    fa_d = unit(np.asarray(J["near_wrist"], float) - el)
    ua_d = unit(np.asarray(J["near_shoulder"], float) - el)
    inside = unit(fa_d + ua_d)
    xs = fa_shape.exterior.intersection(ua_shape.exterior)
    pts = [np.array(g.coords[0]) for g in getattr(xs, "geoms", [xs]) if not g.is_empty]
    pts = [q for q in pts if np.dot(q - el, inside) > 0]
    if pts:
        apex = max(pts, key=lambda q: np.dot(q - el, inside))
        c = CREASE
        line = [apex + fa_d * 0.8, apex - fa_d * c["length"] * 0.5 - inside * 0.3, apex - fa_d * c["length"]]
        cr = kit.brush(line, c["width"], "end", kit._seed("crease")).intersection(fa_shape.buffer(1.0))
        out.append(kit.Part("elbow_crease", None, 51.2, cr))
    return out


# ----------------------------------------------------------------------------- shorts
def shorts(J2):
    """Shorts with two leg openings: a pelvis band, a tube round each thigh ending in a hem square to that
    thigh, and a crotch notch between the openings. Built only from the legs and the fixed pelvis
    (J2["pelvis_top"]), so both frames get the identical shorts. Call it inside kit.tables(**TABLES).
    Returns the Part."""
    L = SHORTS_LEN
    g = SHORTS_GEOM
    pelvis = kit.Bone("torso", J2["pelvis_top"], J2["hip_mid"], FACING)
    band = pelvis.shape(t0=0.80, grow=(g["band_f"], g["band_b"]), cap0=2.2)
    tubes, th = {}, {}
    for side in ("near", "far"):
        b = kit.Bone("thigh", J2[side + "_hipj"], J2[side + "_knee"], FACING)
        body = b.shape(t0=-0.2, t1=L, grow=(g["tube_f"], g["tube_b"]), flat1=True)
        flare = b.shape(t0=L - 0.14, t1=L, grow=(g["hem_f"], g["hem_b"]), flat0=True, flat1=True)
        tubes[side] = opening(shapely.union_all([body, flare]), 0.7)
        th[side] = b
    whole = closing(shapely.union_all([band, tubes["near"], tubes["far"]]), 3.0)
    # The hem line, cut once across both legs: the near opening square to the near thigh from its back edge
    # to its front (inner, in this 3/4 view) corner, up into the crotch notch, down to the far opening's
    # inner corner, and on square to the far thigh. Everything below it is removed.
    nth, fth = th["near"], th["far"]
    nb = nth.at(L, -1.0) - nth.ant * g["hem_b"]
    nf = nth.at(L, 1.0) + nth.ant * g["hem_f"]
    apex = nth.at(L - g["notch_t"], 1.0) + nth.ant * g["hem_f"] * 0.8
    c0 = fth.at(L, 0.0)
    s = (nf[0] + g["notch_w"] - c0[0]) / fth.ant[0]
    fb = c0 + fth.ant * s
    ff = fth.at(L, 1.0) + fth.ant * g["hem_f"]
    dn = V(0.0, 60.0)
    cut = Polygon([nb - nth.ant * 8, nf, apex, fb, ff + fth.ant * 8, ff + fth.ant * 8 + dn, nb - nth.ant * 8 + dn])
    shape = opening(whole.difference(cut), 0.5)
    sd = kit._seed("shorts")
    strokes = [
        # inseam: a short centre seam rising from the crotch
        kit.brush(kit.curve(apex + V(0.2, 0.4), apex + V(1.6, -6.0), 0.08), 1.5, "end", sd + 1),
        # a fold across the front of the near leg and one at the back of the near hem, as the kit draws them
        kit.brush(kit.curve(nth.at(0.06, 0.95), nth.at(0.26, 0.50), 0.1), 1.5, "end", sd + 2),
        kit.brush(kit.curve(nth.at(L - 0.02, -0.92), nth.at(L - 0.13, -0.55), 0.0), 1.4, "start", sd + 3)]
    return kit.make_part("shorts", shape, 44, strokes=strokes)


# ----------------------------------------------------------------------------- rope and cable column
def strand(j, e, widths_fn, name, z):
    """A straight solid rope strand from the clip j to the end e with a knob, width varying along it."""
    j, e = np.asarray(j, float), np.asarray(e, float)
    n = max(int(np.linalg.norm(e - j) / 0.4), 4)
    pts = np.array([j + (e - j) * k / n for k in range(n + 1)])
    w = np.array([widths_fn(p) for p in pts])
    body = kit.ribbon(pts, w)
    knob = Point(e + unit(e - j) * 3.2 * 0.6).buffer(3.2, 24)
    g = body.union(knob)
    return kit.Part(name, g, z, g)


def head_widths(head_shape, inside=2.0, outside=3.0, blend=3.0):
    """Width function for a strand: `inside` over the head, `outside` beyond it, blended over `blend` units."""
    edge = head_shape.boundary

    def fn(p):
        pt = Point(p)
        d = edge.distance(pt)
        k = min(d / blend, 1.0)
        k = 0.5 - 0.5 * k if not head_shape.contains(pt) else 0.5 + 0.5 * k
        k = 0.5 * (1 - math.cos(math.pi * k))     # smooth step
        return outside + (inside - outside) * k
    return fn


def equipment(J2, floor_y, head_shape=None, far_rope=True):
    """The cable column (an upright with a foot plate and the pulley), the cable from the pulley to the
    rope's clip, the near rope strand and the clip, and the far strand when far_rope. With head_shape the
    near strand is drawn thinner where it crosses the head, so it does not black out the face. Returns
    the Parts."""
    pc2 = J2["pulley"]
    col_w, pr = COL_W, PULLEY_R
    col_x = pc2[0] + col_w / 2 + pr * 0.9           # the kit puts the pulley centre at x - (w/2 + 0.9 r)
    col_top = pc2[1] - 34
    col, pc, pr = kit.cable_column(col_x, col_top, floor_y - 4.0, width=col_w,
                                   pulley_y=pc2[1], side=-1, pulley_r=pr)
    # The kit's post carries a groove stroke; at 46 px the two outlines plus the groove read as a heavy
    # dark bar that outweighs the man, so the post is a plain outlined upright, its edges ruled.
    post = kit._sbox(col_x - col_w / 2, col_top, col_x + col_w / 2, floor_y - 4.0)
    col[0] = kit.make_part("column", post, 0, outline_kw=POST_OUTLINE)
    # a low foot plate, so the upright stands on the floor the soles stand on
    base = kit._rounded_rect(col_x - 13.0, floor_y - 5.0, col_x + 13.0, floor_y, 1.6)
    col.append(kit.make_part("column_base", base, 0.3, outline_kw=POST_OUTLINE))
    jn = J2["junction"]
    t0 = kit.pulley_tangent(pc, pr, jn)
    parts = col + kit.cable(t0, jn, width=1.4)
    wfn = head_widths(head_shape) if head_shape is not None else (lambda p: 3.0)
    parts.append(strand(jn, J2["near_knob"], wfn, "rope_near_0", 51.5))
    clip = Point(jn).buffer(3.0 * 0.9, 16)
    parts.append(kit.Part("rope_near_clip", clip, 51.55, clip))
    if far_rope:
        parts += kit.rope(jn, [J2["far_knob"]], z=11.5, name="rope_far", width=3.0)
    return parts
