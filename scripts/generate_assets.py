#!/usr/bin/env python3
"""
Generate the app's launcher/splash assets.

Replaces the old root-level `generate_assets.js`, which wrote a 1x1 yellow pixel
into every asset slot. Those placeholders were later scaled up to full size but
never actually replaced, so the shipped icon read "Adaptive" and the splash read
"Splash".

This draws a real mark: a cocktail glass in the app's charcoal on the amber
brand color. Pure stdlib (zlib + struct) so it runs anywhere without Pillow.

    python3 scripts/generate_assets.py

Outputs, per Expo's asset requirements:
  assets/icon.png            1024x1024  iOS/web app icon, full bleed
  assets/adaptive-icon.png   1024x1024  Android foreground, art inside the
                                        center 66% safe zone (the launcher masks
                                        the rest into a circle/squircle)
  assets/splash.png          1284x2778  splash, mark centered
  assets/favicon.png         196x196    web favicon

This is brand-neutral placeholder art, not a designed identity — good enough to
ship a closed alpha without an embarrassing home-screen icon. Replace with real
artwork before any public release.
"""

import struct
import zlib

AMBER = (255, 193, 7)
CHARCOAL = (33, 33, 33)

SS = 3  # supersampling factor for antialiasing


def write_png(path, width, height, pixels):
    """pixels: list of rows, each a list of (r, g, b) tuples."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0 (None)
        for r, g, b in row:
            raw += bytes((r, g, b))

    def chunk(tag, data):
        payload = tag + data
        return (
            struct.pack(">I", len(data))
            + payload
            + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as fh:
        fh.write(png)


def blend(bg, fg, alpha):
    return tuple(round(b + (f - b) * alpha) for b, f in zip(bg, fg))


def glass_coverage(x, y, cx, cy, scale):
    """
    Signed coverage of a martini/cocktail glass mark at supersampled point
    (x, y), centered on (cx, cy). `scale` is the mark's half-height in pixels.
    Returns True when the point is inside the mark.
    """
    u = (x - cx) / scale
    v = (y - cy) / scale

    # Bowl: inverted triangle spanning v in [-0.75, 0.05], narrowing to a point.
    if -0.75 <= v <= 0.05:
        half_width = 0.78 * (0.05 - v) / 0.8
        if abs(u) <= half_width:
            return True

    # Liquid line (a gap just inside the top of the bowl) is omitted: at favicon
    # sizes it closes up anyway, and a solid bowl reads more cleanly.

    # Stem
    if 0.05 <= v <= 0.62 and abs(u) <= 0.062:
        return True

    # Foot
    if 0.62 <= v <= 0.72 and abs(u) <= 0.40:
        return True

    # No olive/garnish: at icon scale a pick crossing the bowl edge fuses into
    # the silhouette and reads as a rendering artifact rather than a garnish.
    # The plain glass is more legible, especially at favicon size.

    return False


def render(width, height, bg, fg, mark_half_height, cx=None, cy=None):
    cx = width / 2 if cx is None else cx
    cy = height / 2 if cy is None else cy

    rows = []
    for py in range(height):
        row = []
        for px in range(width):
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    if glass_coverage(x, y, cx, cy, mark_half_height):
                        hits += 1
            row.append(blend(bg, fg, hits / (SS * SS)) if hits else bg)
        rows.append(row)
    return rows


def main():
    # iOS / web icon — full bleed, mark at ~62% of the canvas.
    print("icon.png (1024x1024)...")
    write_png("assets/icon.png", 1024, 1024, render(1024, 1024, AMBER, CHARCOAL, 1024 * 0.31))

    # Android adaptive foreground. The launcher crops to the center ~66%, so the
    # mark must sit well inside that safe zone or it gets clipped. The previous
    # adaptive-icon.png was byte-identical to icon.png, i.e. full-bleed art that
    # the circular mask would cut into.
    print("adaptive-icon.png (1024x1024, safe zone)...")
    write_png(
        "assets/adaptive-icon.png",
        1024,
        1024,
        render(1024, 1024, AMBER, CHARCOAL, 1024 * 0.19),
    )

    # Splash — mark centered, sized modestly since `resizeMode: contain`.
    print("splash.png (1284x2778)...")
    write_png("assets/splash.png", 1284, 2778, render(1284, 2778, AMBER, CHARCOAL, 1284 * 0.20))

    # Favicon — 48x48 was too small; 196 is the practical minimum for crisp tabs.
    print("favicon.png (196x196)...")
    write_png("assets/favicon.png", 196, 196, render(196, 196, AMBER, CHARCOAL, 196 * 0.31))

    print("done")


if __name__ == "__main__":
    main()
