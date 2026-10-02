"""Parts and composition: how separately drawn forms are stacked into one drawing of ink.

A drawing is a list of Parts. Each part has a white shape (what it covers) and its own ink. Composing
them back to front, every part first erases the ink behind it inside its shape and then adds its own,
which is how a pen drawing shows one form passing in front of another. Only ink comes out: the white
is nothing at all, so the file can be used as a mask over any colour.
"""
import shapely
from shapely.geometry import MultiPolygon, Point, Polygon

from .strokes import EMPTY, LW, _seed, outline


class Part:
    """One drawable item. shape: the white region it covers (occludes what is behind); may be None.
    ink: its own ink (outline + interior strokes + solid ink). z: back-to-front order (higher = in front).
    welds: list of (other_part_name, (x, y), radius): inside the other part's shape within the radius,
    this part's ink is erased, so the two read as one continuous form at a joint.
    occludes: False for a part whose shape is only a reference for welds and must erase nothing."""

    def __init__(self, name, shape=None, z=0, ink=None, welds=None, occludes=True):
        self.name, self.shape, self.z = name, shape, z
        self.ink = ink if ink is not None else EMPTY
        self.welds = list(welds or [])
        self.occludes = occludes

    def __repr__(self):
        return "Part(%s, z=%s)" % (self.name, self.z)


def make_part(name, shape, z, lw=LW, strokes=(), solid=(), welds=None, seed=None, outline_kw=None):
    """Build a Part from a shape: brush outline + interior strokes (clipped to the shape) + solid ink.

    The strokes are clipped a quarter unit inside the shape so that none pokes out past the outline.
    The seed defaults to one derived from the name, so a part keeps its wobble when others change."""
    seed = _seed(name) if seed is None else seed
    ink = [outline(shape, lw=lw, seed=seed, **(outline_kw or {}))] if shape is not None else []
    if strokes:
        inner = shape.buffer(-0.25) if shape is not None else None
        st = shapely.union_all([g for g in strokes if g is not None and not g.is_empty])
        ink.append(st.intersection(inner) if inner is not None else st)
    ink.extend(g for g in solid if g is not None)
    return Part(name, shape, z, shapely.union_all(ink) if ink else EMPTY, welds)


def compose(parts, min_area=0.35):
    """Back-to-front composition: each part erases what is behind it inside its shape, then adds its ink.

    Welds are applied in both directions: a weld named on either part of a pair erases the ink of each
    part inside the other's shape within the radius. Returns one (Multi)Polygon of ink, cleaned of specks
    smaller than min_area square units."""
    parts = [p for p in parts if p is not None]
    byname = {p.name: p for p in parts}
    pairs = []
    for p in parts:
        for other, c, r in p.welds:
            pairs.append((p.name, other, c, r))
    ink = EMPTY
    for p in sorted(parts, key=lambda q: q.z):
        pink = p.ink
        for a, b, c, r in pairs:
            if p.name not in (a, b):
                continue
            o = byname.get(b if p.name == a else a)
            if o is None or o.shape is None:
                continue
            zone = o.shape.intersection(Point(c).buffer(r, 24))
            if not zone.is_empty:
                pink = pink.difference(zone)
        if p.shape is not None and p.occludes and not ink.is_empty:
            ink = ink.difference(p.shape)
        ink = ink.union(pink) if not ink.is_empty else pink
    return clean(ink, min_area)


def clean(g, min_area=0.35, hole_area=0.6):
    """g as a MultiPolygon without specks of ink smaller than min_area or pinholes smaller than
    hole_area (square units): both are artefacts of the boolean operations, too small to be drawn."""
    polys = []
    for pg in getattr(g, "geoms", [g]):
        if pg.geom_type != "Polygon" or pg.area < min_area:
            continue
        holes = [h for h in pg.interiors if Polygon(h).area > hole_area]
        polys.append(Polygon(pg.exterior, holes))
    return MultiPolygon(polys) if polys else EMPTY
