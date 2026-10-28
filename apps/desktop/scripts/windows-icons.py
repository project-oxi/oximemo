#!/usr/bin/env python3
"""Render the Windows app icon (icons/icon.ico) and tray icon.

The macOS artwork (app-icon.png) is a full-bleed square: macOS frames it,
Windows does not, so a plain downscale shows a hard-cornered black slab and
the ring smears to grey at 16-24 px. Each size here is drawn from the same
geometry at that size instead: a rounded tile, the octagon ring and the
inner square, with stroke and gap held to whole pixels at small sizes.

    python3 apps/desktop/scripts/windows-icons.py   (needs Pillow)
"""

import io
import math
import struct
from pathlib import Path

from PIL import Image, ImageDraw

ICONS = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
# Every size Windows asks an .ico for (taskbar, Start, Explorer views, DPI steps).
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SS = 16  # supersampling factor

TILE = (0, 0, 0, 255)
INK = (255, 255, 255, 255)

# Proportions measured from app-icon.png (1024 px): octagon apothem 361,
# ring 84, inner square 255, all relative to the full canvas.
APOTHEM = 361 / 1024
RING = 84 / 1024
SQUARE_HALF = 127.5 / 1024


def octagon(cx, cy, apothem):
    # Flat edges face the axes, like the source artwork.
    r = apothem / math.cos(math.pi / 8)
    return [
        (cx + r * math.cos(math.pi / 8 + k * math.pi / 4), cy + r * math.sin(math.pi / 8 + k * math.pi / 4))
        for k in range(8)
    ]


def render(size):
    # Small sizes fill the canvas (every pixel counts); larger ones keep a
    # thin margin so the tile reads as an object, like other Windows apps.
    margin = 0 if size <= 32 else round(size / 32)
    tile = size - 2 * margin
    radius = tile * 0.22

    # Content scales with the tile; below 32 px the strokes snap to whole
    # pixels so the ring stays white instead of a grey blur.
    apothem = APOTHEM * tile
    ring = RING * tile
    half = SQUARE_HALF * tile
    if size <= 32:
        ring = max(2.0, round(ring))
        apothem = round(apothem)
        gap = max(2.0, round(apothem - ring - half))
        half = max(1.5, apothem - ring - gap)

    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = margin * SS
    d.rounded_rectangle([m, m, big - m - 1, big - m - 1], radius=radius * SS, fill=TILE)
    c = big / 2
    d.polygon(octagon(c, c, apothem * SS), fill=INK)
    d.polygon(octagon(c, c, (apothem - ring) * SS), fill=TILE)
    h = half * SS
    d.rounded_rectangle([c - h, c - h, c + h, c + h], radius=h * 0.08, fill=INK)
    return img.resize((size, size), Image.BOX)


def write_ico(path, images):
    # PNG-compressed entries (Vista+); Pillow's own ICO writer resamples
    # every entry from one image, which is what this script exists to avoid.
    blobs = []
    for im in images:
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        blobs.append(buf.getvalue())
    out = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    for im, blob in zip(images, blobs):
        w = im.width if im.width < 256 else 0
        out += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    for blob in blobs:
        out += blob
    path.write_bytes(bytes(out))


if __name__ == "__main__":
    write_ico(ICONS / "icon.ico", [render(s) for s in SIZES])
    # Tray: Windows shows it at 16 px (100 %) to 32 px (200 %); the tile
    # stays visible on both light and dark taskbars.
    render(32).save(ICONS / "tray-windows.png", optimize=True)
    print("wrote", ICONS / "icon.ico", "and tray-windows.png")
