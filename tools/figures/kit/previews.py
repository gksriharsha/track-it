"""Preview images: a drawing rasterised the way the app shows it, at every tile size, and comparison sheets.

The app fits each drawing into its tile with CSS mask "contain", centred, so a preview does the same:
the viewBox is scaled to fit the box, drawn at a few times the size and downsampled, black on white.
Pillow is imported only inside these functions, so writing the SVG files needs only numpy and shapely.
"""
import os

import numpy as np

from .strokes import _v
from .svg import EK_SVG, read_svg

APP_SIZES = [(120, 140), (56, 64), (46, 54), (40, 46)]     # the app's drawing tiles, CSS pixels (w, h)


def _box_transform(vb, W, H):
    """Scale and offset that fit the viewBox vb into a W x H box, 'contain' and centred."""
    x, y, w, h = vb
    s = min(W / w, H / h)
    return s, (W - w * s) / 2 - x * s, (H - h * s) / 2 - y * s


def raster(item, viewbox=None, size=(400, 400), ss=4, offset=(0, 0)):
    """Rasterise ink (shapely geometry, or a path to an SVG file) into a W x H box, black on white,
    'contain' + centred exactly like the app's CSS mask. offset is added to geometry coordinates.

    The rings are filled even-odd: each ring flips the pixels inside it. That is the rule the kit's
    files declare. The app's Everkinetic drawings are filled nonzero, but their holes are separate rings
    nested inside the outlines they cut, so even-odd gives the same picture to within a few edge pixels."""
    from PIL import Image, ImageDraw
    W, H = size
    if isinstance(item, (str, os.PathLike)):
        rings, vb = read_svg(item)
        viewbox = viewbox or vb
    else:
        rings = []
        for pg in getattr(item, "geoms", [item]):
            if pg.is_empty:
                continue
            rings.append(_v(pg.exterior.coords) + offset)
            rings += [_v(r.coords) + offset for r in pg.interiors]
        if viewbox is None:
            x0, y0, x1, y1 = item.bounds
            viewbox = (x0 + offset[0] - 4, y0 + offset[1] - 4, x1 - x0 + 8, y1 - y0 + 8)
    s, ox, oy = _box_transform(viewbox, W, H)
    acc = np.zeros((H * ss, W * ss), dtype=bool)
    for r in rings:
        if len(r) < 3:
            continue
        lay = Image.new("1", (W * ss, H * ss), 0)
        pts = [((px * s + ox) * ss, (py * s + oy) * ss) for px, py in r]
        ImageDraw.Draw(lay).polygon(pts, fill=1)
        acc ^= np.asarray(lay, dtype=bool)
    img = Image.fromarray(np.where(acc, 0, 255).astype(np.uint8))
    return img.resize((W, H), Image.LANCZOS) if ss > 1 else img


def raster_png(path, size, ss=1):
    """A PNG (e.g. one of Everkinetic's own raster images) fitted 'contain' + centred into size, black
    on white. ss is accepted so it can stand in for raster() and is not used."""
    from PIL import Image
    W, H = size
    im = Image.open(path).convert("L")
    s = min(W / im.width, H / im.height)
    w, h = max(1, round(im.width * s)), max(1, round(im.height * s))
    out = Image.new("L", (W, H), 255)
    out.paste(im.resize((w, h), Image.LANCZOS), ((W - w) // 2, (H - h) // 2))
    return out


def preview(ink, viewbox, out_png, large=420, offset=(0, 0), dpr=2):
    """Save a preview: the frame large, plus every app size at device pixel ratio dpr (and 46x54 at 1x),
    side by side on a grey ground, so a line that only fails at the smallest tile is easy to see."""
    from PIL import Image
    x, y, w, h = viewbox
    big = raster(ink, viewbox, (int(large * w / h), large), 3, offset)
    tiles = [raster(ink, viewbox, (W * dpr, H * dpr), 4, offset) for W, H in APP_SIZES]
    tiles += [raster(ink, viewbox, (W, H), 4, offset) for W, H in APP_SIZES[2:3]]
    Wt = big.width + sum(t.width for t in tiles) + 20 * (len(tiles) + 2)
    sheet_im = Image.new("L", (Wt, large + 40), 225)
    sheet_im.paste(big, (20, 20))
    xx = big.width + 40
    for t in tiles:
        sheet_im.paste(t, (xx, 20))
        xx += t.width + 20
    sheet_im.save(out_png)
    return out_png


def _font(size):
    """A plain sans-serif label font if the system has one, else Pillow's built-in bitmap font."""
    from PIL import ImageFont
    for f in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc",
              "/Library/Fonts/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size)
            except OSError:
                pass
    return ImageFont.load_default()


def sheet(own, ek=(), out="sheet.png", large=300, dpr=2, ek_source="svg", title=None, ek_dir=None, ek_png=None):
    """Comparison sheet: the kit's drawings beside Everkinetic's, at the sizes the app shows them.

    own: list of (label, item) where item is an SVG path from this kit or (ink, viewbox) or
    (ink, viewbox, offset). ek: list of (id, frame) e.g. ("0118", "relaxation").
    Rows: large; then each app size at dpr (device pixels, what a 2x screen shows); then 46x54 at 1x.
    ek_source 'svg' draws the app's shipped file <ek_dir>/<id>-<frame>.svg (default: the app's
    src/assets/everkinetic), exactly the viewBox the app masks with; 'png' draws <ek_png>/<id>-<frame>.png,
    for a lift the app does not ship, from a folder of Everkinetic's raster images the caller names."""
    from PIL import Image, ImageDraw
    cols = []
    for label, item in own:
        if isinstance(item, (str, os.PathLike)):
            _, vb = read_svg(item)
            fn = lambda sz, ss, item=item: raster(item, None, sz, ss)
        else:
            ink, vb = item[0], item[1]
            off = item[2] if len(item) > 2 else (0, 0)
            fn = lambda sz, ss, ink=ink, vb=vb, off=off: raster(ink, vb, sz, ss, off)
        cols.append((label, vb[2] / vb[3], fn))
    for ek_id, frame in ek:
        if ek_source == "png":
            if ek_png is None:
                raise ValueError("ek_source='png' needs ek_png, the folder that holds Everkinetic's PNGs")
            p = os.path.join(ek_png, "%s-%s.png" % (ek_id, frame))
            im = Image.open(p)
            fn = lambda sz, ss, p=p: raster_png(p, sz)
            aspect = im.width / im.height
        else:
            p = os.path.join(ek_dir or EK_SVG, "%s-%s.svg" % (ek_id, frame))
            _, vb = read_svg(p)
            fn = lambda sz, ss, p=p: raster(p, None, sz, ss)
            aspect = vb[2] / vb[3]
        cols.append(("EK %s %s" % (ek_id, frame[:5]), aspect, fn))
    rows = [("large", None)] + [("%dx%d @%dx" % (W, H, dpr), (W * dpr, H * dpr)) for W, H in APP_SIZES]
    rows += [("46x54 @1x", (46, 54))]
    big = lambda a: (min(int(large * a), int(large * 1.6)), large)
    colw = [max(big(a)[0], max(r[1][0] for r in rows[1:]), 120) for _, a, _ in cols]
    rowh = [large] + [r[1][1] for r in rows[1:]]
    M, top, left = 14, 30 if title is None else 60, 110
    W = left + sum(colw) + M * (len(cols) + 1)
    H = top + 22 + sum(rowh) + M * (len(rows) + 1)
    S = Image.new("RGB", (W, H), (236, 236, 232))
    d = ImageDraw.Draw(S)
    f, fb = _font(13), _font(20)
    if title:
        d.text((M, 16), title, fill=(0, 0, 0), font=fb)
    x = left + M
    for (label, a, fn), cw in zip(cols, colw):
        d.text((x, top), label, fill=(30, 30, 30), font=f)
        y = top + 22 + M
        for (rname, sz), rh in zip(rows, rowh):
            sz = big(a) if sz is None else sz
            im = fn(sz, 4 if sz[1] < 200 else 3).convert("RGB")
            S.paste(im, (x, y))
            y += rh + M
        x += cw + M
    y = top + 22 + M
    for (rname, sz), rh in zip(rows, rowh):
        d.text((M, y + 4), rname, fill=(60, 60, 60), font=f)
        y += rh + M
    S.save(out)
    return out
