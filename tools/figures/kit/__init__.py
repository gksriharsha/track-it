"""TrackIt's figure kit: ink-only, side-view line drawings of a man exercising, in the manner of
Everkinetic's drawings, for the lifts Everkinetic never drew.

Everything here is original geometry (smooth anatomical profiles, brush outlines); nothing is traced.
Each lift has its own module in tools/figures/ that poses the man, adds the equipment and composes the
parts into ink. It exposes LIFT (the display name), SLUG and frames(), which returns one
(file name, SVG text) per frame and writes nothing, and optionally preview_inks(). tools/figures/draw.py
lists the lift modules and writes their files into src/assets/figures/ (FIGURES_DIR).

QUICK START (in a script in tools/figures/, whose folder is on sys.path when the script runs)
    import kit
    J = kit.pose_from_angles(hip=(100, 132), facing=1, arm=(90, 90))      # arms straight forward
    J = kit.ground(J, 250, facing=1)                                      # soles rest on y = 250
    parts = kit.figure(J, facing=1) + kit.floor(40, 170, 250)
    ink = kit.compose(parts)                                              # one shapely (Multi)Polygon
    svg = "x-start.svg"                                                   # a quick look, written here
    vb, off = kit.export_frames([(svg, "Start", ink)], lift="Kettlebell swing")
    kit.preview(ink, vb, "x-start.png", offset=off)                       # large + every app size
    print(kit.verify_svg(svg))                                            # the app's file rules

MODULES (every name below is also on the package itself: kit.figure, kit.PROFILES, kit._seed, ...)
    strokes    vector helpers, Catmull-Rom curves, ribbon, brush, curve, outline; LW, LW_INNER
    parts      Part, make_part, compose, clean
    body       PROFILES, CAPS, MUSCLES, Z, HEAD, tables(), Bone, figure
    pose       BONES, pose_from_angles, ik, set_leg, set_arm, reach, ground, rest_on_floor, shift, rotate
    equipment  kettlebell, cable_column, pulley_tangent, cable, rope, floor, mat
    svg        export_frames, svg_string, path_d, comment_for, read_svg, verify_svg, verify_pair;
               ROOT (the repository), FIGURES_DIR, EK_SVG (src/assets/everkinetic)
    previews   raster, preview, sheet (Pillow is imported only when one of these is called, so writing
               the SVG files needs nothing but numpy and shapely)

COORDINATES AND UNITS
    SVG user units, x to the right, y DOWN. The default man (scale 1) is 228 units from crown to sole,
    head 27.5 (crown to chin), outline 2.1 units wide (Everkinetic: median 2.0-2.2, range 1.5-3.0 on
    the same scale; its shipped viewBoxes are ~160-280 units). export_frames() translates every frame of a
    lift by the same offset so the shared viewBox starts at "0 0" and has integer width/height.

FACING, NEAR AND FAR
    facing=+1: the man faces +x (right); facing=-1: faces left (everything mirrors; pass the same facing
    to every call). The viewer sees his NEAR side; near limbs are drawn in front of the torso and far
    limbs behind it. Joints are named "near_<joint>" / "far_<joint>".

JOINTS (dict of name -> (x, y)), all side-view positions
    head            centre of the skull (cranium), about ear level
    neck            base of the neck, midway between the nape (C7) and the top of the sternum
    hip             hip joint centre (shared; "far_hip" / "near_hip" optionally override a leg's root)
    <side>_shoulder glenohumeral joint (inside the deltoid)
    <side>_elbow, <side>_wrist
    <side>_hand     centre of the fist = the point that holds a handle
    <side>_knee, <side>_ankle
    <side>_toe      tip of the shoe (the foot is drawn from ankle and toe)
    Bone lengths at scale 1 (kit.BONES): hip->neck 71, neck->head 20.5, upper arm 41, forearm 33,
    wrist->fist 9, thigh 54, shin 55, ankle->toe tip ~25.4. Segment shapes stretch to whatever the joints
    say, so keep lengths near these (use ik/set_leg/set_arm/reach rather than free-placing elbows/knees).

BUILDING A POSE
    pose_from_angles(hip, facing, trunk, head, arm=(upper, fore), far_arm, hand, far_hand,
                     leg=(thigh, shin, foot), far_leg, scale, far_shoulder_offset, far_hip_offset) -> J
        Absolute, screen-based degrees, mirrored by facing:
          trunk / head : lean of hip->neck / neck->head from vertical; 0 upright, +90 horizontal forward
                         (a plank facing right is trunk ~ 80-90), negative = leaning back.
          arm, thigh, shin : 0 = pointing straight down, +90 = forward horizontal, 180 = up, -90 = back.
          foot : 0 = flat and pointing forward, +90 = toes straight down (on the toes, as in a plank).
          far_* default to the near values; the far shoulder/hip roots are shifted (back, up) by
          far_shoulder_offset (-3, -1.5) and far_hip_offset (-2, 0) for a hint of depth; set (0, 0)
          to hide the far limb exactly behind the near one.
    ik(a, c, l1, l2, bend) -> (b, c_reached)          two-bone solve; b lies on the side `bend` points to
    set_leg(J, side, ankle, foot=0, facing, bend)     knee by ik (bends forward by default). Use the same
                                                      ankle + foot in every frame -> the foot is identical.
    set_arm(J, side, wrist, facing, bend, hand)       elbow by ik (default bends down/back)
    reach(J, side, point, facing, bend)               puts the fist centre exactly on `point`
    ground(J, floor_y, facing)                        shift so the lowest sole point sits on floor_y
    rest_on_floor(J, floor_y, facing, names)          same, for any parts, e.g. names=["near_forearm",
                                                      "near_foot", "far_foot"] for a forearm plank
    lowest_point(J, facing, names), sole_points(J, facing), shift(J, dx, dy), rotate(J, deg, about)

DRAWING THE MAN
    figure(J, facing=1, girth=None, z=None, detail=1.0, lw=2.1, prefix="", shorts_len=0.42,
           head_tilt=0.0, hide=(), creases=True) -> list[Part]
        girth: multipliers by kind ("torso", "upper_arm", "forearm", "hand", "thigh", "shin", "foot",
               "neck", "head") or by part name ("near_thigh"); a value may be (front, back), e.g.
               {"torso": (1.1, 1.0)} for a deeper chest.
        z: override draw order by part name (higher = in front). Defaults (kit.Z):
               far_upper_arm 10, far_forearm 11, far_hand 12, far_thigh 20, far_shin 21, far_foot 22,
               shorts_far 23, torso 30, neck 31, head 32, near_thigh 40, near_shin 41, near_foot 42,
               shorts 44, near_upper_arm 50, near_forearm 51, near_hand 52.
        hide: part names to omit.  detail: 0 removes interior muscle strokes.  head_tilt: degrees,
        + nods the face down.  creases: short crease on the inside of a bent elbow/knee.
    Parts: head (faceless, jaw/chin profile), neck, torso (chest, back, glutes), shorts (pelvis + near
    leg opening) and shorts_far, <side>_upper_arm (deltoid cap), <side>_forearm, <side>_hand (fist),
    <side>_thigh, <side>_shin (calf), <side>_foot (plain shoe). Elbows, knees, wrists and the neck are
    "welded" (no seam line inside the joint); a foot is drawn over the shin so the shoe collar shows.
    Bone(kind, A, B, facing, girth) gives one segment's outline (.shape), interior strokes (.strokes)
    and any point on it (.at(t, s): t 0..1 from A to B, s -1 back edge .. +1 front edge), for parts a
    lift draws itself.

CHANGING THE BODY FOR ONE LIFT
    PROFILES (half-widths along each bone), CAPS (how round each end is), MUSCLES (interior strokes),
    Z (draw order) and BONES (lengths) are single shared dicts: kit.PROFILES is kit.body.PROFILES, and
    the functions read them each time they run. A lift changes them only inside kit.tables(), which
    puts back what it found when the block ends:
        with kit.tables(profiles={"upper_arm": rows}, caps={...}, muscles={"thigh": []}):
            parts = kit.figure(J, F)                  # only inside the block; restored on exit
    Never change them for the rest of the process (kit.PROFILES["torso"] = rows at import time):
    draw.py draws every lift in one process, so such a change would reach every lift drawn after it,
    and --check would report their files as DIFFERENT.
    Rebinding a name on the package (kit.PROFILES = {...}, kit.HEAD = 30, kit.LW = 3) does NOT reach
    the modules that use it, so it would silently change nothing; pass a value as an argument instead
    (lw=, girth=, z=, hide=, scale=).

EQUIPMENT (each returns a list of Parts; same line weight; z decides what overlaps what)
    kettlebell(handle, angle=0, size=1, z=46)   handle = centre of the handle bar (where the fist goes);
        angle = direction handle->bell in degrees, 0 = bell hangs straight below, +90 = bell toward -x.
        Default z 46 sits in front of the legs/shorts and behind the near arm; between the legs use ~35.
    cable_column(x, y_top, y_floor, width=12, pulley_y=None, side=-1, pulley_r=6.5, z=0)
        -> (parts, pulley_centre, pulley_r); side -1 puts the pulley on the post's left face.
    pulley_tangent(centre, r, target, side=+1)  where a straight cable toward target leaves the wheel
    cable(p0, p1, width=1.3, z=5)               thin solid line
    rope(junction, ends, width=3, knob_r=3.2, z=47, style="solid"|"outline")  two strands + end knobs;
        ends are the knob positions (put the fists just short of them)
    floor(x0, x1, y, width=2.1)                 brush floor line whose top edge sits at y
    mat(x0, x1, y, thick=4)                     a low outlined slab whose top is at y

COMPOSING AND EXPORTING
    compose(parts) -> ink: back to front by z, each part erases what is behind it inside its shape,
        then adds its own ink (brush outline + interior strokes). Only ink comes out; white is nothing.
    Part / make_part(name, shape, z, strokes=[...], solid=[...], welds=[(other, (x, y), r)]) for
        custom items; brush(points, width, taper) and curve(a, b, bend) build extra strokes.
    export_frames([(svg_path, frame_label, ink), ...], lift, pad=8) -> (viewbox, offset)
        writes every frame of one lift with ONE shared integer viewBox and the required comment
        "<!-- {lift}, {frame}: drawn for TrackIt in the manner of Everkinetic's drawings. Original work,
        not adapted from them. -->"; one <path fill="currentColor" fill-rule="evenodd">, 2 decimals.
    svg_string(ink, viewbox, comment) and comment_for(lift, frame), for a lift that sizes its own
        canvas; path_d(ink); read_svg(path) -> (rings, viewbox), for the kit's files and Everkinetic's.

PREVIEW, SHEET, VERIFY
    raster(ink_or_svg_path, viewbox, (W, H), ss=4, offset) -> Pillow image, contain + centred like the
        app's CSS mask (black on white, drawn big and LANCZOS-downsampled)
    preview(ink, viewbox, out_png, offset=off)  large + 120x140, 56x64, 46x54, 40x46 at 2x + 46x54 at 1x
    sheet(own=[(label, svg_path or (ink, vb[, off]))], ek=[("0118", "relaxation"), ...], out, title)
        -> rows: large, each app size @2x, 46x54 @1x. Everkinetic's drawings come from the app's own
        files in EK_SVG (exact app viewBox); ek_source="png" with ek_png=<folder> reads raster images
        instead, for an Everkinetic lift the app does not ship.
    verify_svg(path) -> {ok, problems, path, viewbox, bytes}: the file rules the app's drawings follow
        (viewBox and no fixed size, the comment at the top, currentColor paths only, no strokes, white,
        masks or images, at most 2 decimals).
    verify_pair([paths]) -> {ok, viewboxes}: all frames share the identical viewBox string.
"""
# Everything is re-exported on the package, so a lift script needs only `import kit`. The tables come
# across as the same objects (kit.PROFILES is kit.body.PROFILES), which is what lets a lift change them.
from .body import (  # noqa: F401
    CAPS, HEAD, MUSCLES, PROFILES, Z, Bone, _crease, _foot, _head, _profile_at, figure, tables)
from .equipment import (  # noqa: F401
    _rounded_rect, _sbox, cable, cable_column, floor, kettlebell, mat, pulley_tangent, rope)
from .parts import Part, clean, compose, make_part  # noqa: F401
from .pose import (  # noqa: F401
    BONES, foot_toe, ground, ik, lowest_point, pose_from_angles, reach, rest_on_floor, rotate, set_arm, set_leg,
    shift, sole_points)
from .previews import APP_SIZES, _box_transform, _font, preview, raster, raster_png, sheet  # noqa: F401
from .strokes import (  # noqa: F401
    EMPTY, LW, LW_INNER, _ant, _curvature, _noise, _perp, _resample, _rot, _seed, _tangents, _unit, _v, brush,
    catmull_rom, curve, limb_dir, outline, ribbon, smooth_shape, up_dir)
from .svg import (  # noqa: F401
    EK_SVG, FIGURES_DIR, ROOT, _NUM, _fmt, _ring_d, comment_for, export_frames, parse_path_d, path_d, read_svg,
    shared_viewbox, svg_string, verify_pair, verify_svg)
