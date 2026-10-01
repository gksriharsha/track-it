"""Posing the man: joint positions from angles, two-bone IK for arms and legs, and putting him on a floor.

A pose is a plain dict of joint name -> (x, y). Every function here that changes a pose returns a new
dict and leaves the one it was given alone, so a lift can derive its frames from one base pose without
them drifting apart.
"""
import math

import numpy as np

from .body import _foot, figure
from .strokes import LW, _ant, _perp, _rot, _unit, _v, limb_dir, up_dir

BONES = dict(trunk=71.0, neck=20.5, shoulder_drop=9.0, shoulder_fwd=-2.5, upper_arm=41.0, forearm=33.0,
             hand=9.0, thigh=54.0, shin=55.0, foot_len=25.0, toe_h=4.6)


def foot_toe(ankle, foot_angle, facing=1, scale=1.0):
    """Toe-tip position for a foot angle: 0 = flat and pointing forward, +90 = toes straight down."""
    a = math.radians(foot_angle)
    s = np.array([facing * math.cos(a), math.sin(a)])
    d = facing * _perp(s)
    return _v(ankle) + s * BONES["foot_len"] * scale + d * BONES["toe_h"] * scale


def pose_from_angles(hip=(100.0, 132.0), facing=1, trunk=0.0, head=6.0, arm=(0.0, 5.0), far_arm=None,
                     hand=None, far_hand=None, leg=(0.0, 0.0, 0.0), far_leg=None, scale=1.0,
                     far_shoulder_offset=(-3.0, -1.5), far_hip_offset=(-2.0, 0.0)):
    """Joints from angles in degrees (absolute, screen-based, mirrored by facing).

    trunk: lean of hip->neck from vertical (+ forward).  head: lean of neck->head centre from vertical.
    arm=(upper, forearm): 0 = hanging down, 90 = pointing forward, 180 = straight up, negative = behind.
    hand: hand angle (default = forearm angle).  leg=(thigh, shin, foot): thigh/shin 0 = down, + forward;
    foot 0 = flat pointing forward, + = toes down.  far_* default to the near values.
    far_*_offset: the far shoulder/hip root is shifted by (back, up) units for a hint of depth."""
    B = {k: v * scale for k, v in BONES.items()}
    far_arm = arm if far_arm is None else far_arm
    far_leg = leg if far_leg is None else far_leg
    J = {"hip": _v(hip)}
    J["neck"] = J["hip"] + up_dir(trunk, facing) * B["trunk"]
    J["head"] = J["neck"] + up_dir(head, facing) * B["neck"]
    tdown = -up_dir(trunk, facing)
    tant = _ant(tdown, facing)
    sh = J["neck"] + tdown * B["shoulder_drop"] + tant * B["shoulder_fwd"]
    for side, (ua, fa), hd, off in (("near", arm, hand, (0, 0)), ("far", far_arm, far_hand, far_shoulder_offset)):
        root = sh + np.array([facing * off[0], off[1]])
        J[side + "_shoulder"] = root
        J[side + "_elbow"] = root + limb_dir(ua, facing) * B["upper_arm"]
        J[side + "_wrist"] = J[side + "_elbow"] + limb_dir(fa, facing) * B["forearm"]
        J[side + "_hand"] = J[side + "_wrist"] + limb_dir(fa if hd is None else hd, facing) * B["hand"]
    for side, (th, sn, ft), off in (("near", leg, (0, 0)), ("far", far_leg, far_hip_offset)):
        root = J["hip"] + np.array([facing * off[0], off[1]])
        if side == "far":
            J["far_hip"] = root
        J[side + "_knee"] = root + limb_dir(th, facing) * B["thigh"]
        J[side + "_ankle"] = J[side + "_knee"] + limb_dir(sn, facing) * B["shin"]
        J[side + "_toe"] = foot_toe(J[side + "_ankle"], ft, facing, scale)
    return J


def ik(a, c, l1, l2, bend):
    """Two-bone inverse kinematics. Returns (b, c_reached): the middle joint b with |a-b| = l1 and
    |b-c| = l2, on the side of the line a->c that the screen vector `bend` points toward. If c is out of
    reach the chain is straight toward c and c_reached is where it ends."""
    a, c, bend = _v(a), _v(c), _v(bend)
    v = c - a
    d = np.linalg.norm(v)
    u = _unit(v)
    if d >= l1 + l2 - 1e-6:
        return a + u * l1, a + u * (l1 + l2)
    d = max(d, abs(l1 - l2) + 1e-3)
    x = (d * d + l1 * l1 - l2 * l2) / (2 * d)
    h = math.sqrt(max(l1 * l1 - x * x, 0.0))
    n = _perp(u)
    if np.dot(n, bend) < 0:
        n = -n
    return a + u * x + n * h, c


def set_leg(J, side, ankle, foot=0.0, facing=1, bend=None, scale=1.0):
    """Place a leg by its ankle (knee solved by ik, bending toward `bend`, default forward) and a foot angle
    (0 = flat, + = toes down). Keep `ankle` and `foot` identical across frames to keep the foot still."""
    J = dict(J)
    hip = J.get(side + "_hip", J["hip"])
    bend = (facing, 0.0) if bend is None else bend
    knee, ank = ik(hip, ankle, BONES["thigh"] * scale, BONES["shin"] * scale, bend)
    J[side + "_knee"], J[side + "_ankle"] = knee, _v(ankle)
    J[side + "_toe"] = foot_toe(ankle, foot, facing, scale)
    return J


def set_arm(J, side, wrist, facing=1, bend=None, hand=None, scale=1.0):
    """Place an arm by its wrist (elbow solved by ik, bending toward `bend`, default down and slightly back).
    hand: hand angle in limb degrees (default: continue the forearm). The fist centre lands 9 units beyond
    the wrist; to put the fist on a handle, aim the wrist 9 units short of it."""
    J = dict(J)
    bend = (-0.35 * facing, 1.0) if bend is None else bend
    elbow, _ = ik(J[side + "_shoulder"], wrist, BONES["upper_arm"] * scale, BONES["forearm"] * scale, bend)
    J[side + "_elbow"], J[side + "_wrist"] = elbow, _v(wrist)
    d = limb_dir(hand, facing) if hand is not None else _unit(_v(wrist) - elbow)
    J[side + "_hand"] = _v(wrist) + d * BONES["hand"] * scale
    return J


def reach(J, side, point, facing=1, bend=None, scale=1.0):
    """Put the fist centre (side + '_hand') exactly on `point` (e.g. a kettlebell handle or a rope end),
    solving the elbow with ik; the hand continues the forearm. The wrist is corrected a few times
    because where the fist lands depends on the elbow, which depends on the wrist."""
    p = _v(point)
    wrist = p - _unit(p - _v(J[side + "_shoulder"])) * BONES["hand"] * scale
    for _ in range(4):
        J2 = set_arm(J, side, wrist, facing, bend, None, scale)
        wrist = wrist + (p - J2[side + "_hand"])
    return set_arm(J, side, wrist, facing, bend, None, scale)


def sole_points(J, facing=1, sides=("near", "far")):
    """World points along the bottom edge of the drawn soles, heel to toe, outline included: the points
    that must touch the floor when the man stands on it."""
    pts = []
    for side in sides:
        if side + "_ankle" not in J:
            continue
        _, (s, d), _ = _foot(J[side + "_ankle"], J[side + "_toe"], facing)
        A = _v(J[side + "_ankle"])
        D = np.linalg.norm(_v(J[side + "_toe"]) - A)
        k = math.sqrt(max(D * D - 4.6 ** 2, 1)) / 25.0
        pts += [A + s * x + d * y for x, y in ((-8.0, 9.9), (4 * k, 10.3), (15 * k, 10.1), (22 * k, 9.1), (25 * k, 5))]
    return np.array(pts)


def ground(J, floor_y, facing=1, sides=("near", "far")):
    """Shift all joints vertically so the lowest sole point rests on floor_y."""
    dy = floor_y - sole_points(J, facing, sides)[:, 1].max()
    return shift(J, 0, dy)


def lowest_point(J, facing=1, names=None, **figure_kw):
    """Largest y (lowest on screen) over the shapes of the named figure parts (default: all), e.g.
    names=['near_forearm', 'near_foot'] for a plank. Use: J = shift(J, 0, floor_y - lowest_point(J, ...))."""
    parts = figure(J, facing, detail=0, **figure_kw)
    ys = [p.shape.bounds[3] for p in parts if p.shape is not None and (names is None or p.name in names)]
    return max(ys) + LW / 2


def rest_on_floor(J, floor_y, facing=1, names=None, **figure_kw):
    """Shift joints vertically so the lowest of the named parts (outline included) touches floor_y."""
    return shift(J, 0, floor_y - lowest_point(J, facing, names, **figure_kw))


def shift(J, dx, dy):
    """Every joint moved by (dx, dy)."""
    return {k: _v(v) + np.array([dx, dy]) for k, v in J.items()}


def rotate(J, deg, about):
    """Rotate every joint by deg (clockwise on screen, y down) about a point."""
    c = _v(about)
    return {k: c + _rot(_v(v) - c, deg) for k, v in J.items()}
