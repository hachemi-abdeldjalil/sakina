"""Cuts the Sakina wordmark (سكينة with the crossed-out note and sound waves) out of logo-source.jpg.

Writes, next to this file:
  wordmark.png        the logo's own colours on a transparent background, for light backgrounds
  wordmark-cream.png  the green ink turned cream (the red slash stays red), for the deep green cover

    python3 store/art/make-wordmark.py
"""
import pathlib
from PIL import Image

here = pathlib.Path(__file__).resolve().parent
src = Image.open(here / "logo-source.jpg").convert("RGB")
BG = (248, 249, 243)            # the paper the logo was drawn on
CREAM = (245, 239, 227)         # --cover-ink in gallery.css
LO, HI = 0.10, 0.80             # paper grain below LO is dropped; HI and above is solid ink

box = (139 - 24, 369 - 24, 884 + 24, 693 + 24)   # the artwork plus a margin
src = src.crop(box)
w, h = src.size
plain = Image.new("RGBA", (w, h))
cream = Image.new("RGBA", (w, h))
sp, pp, cp = src.load(), plain.load(), cream.load()
for y in range(h):
    for x in range(w):
        px = sp[x, y]
        # Colour to alpha: how much darker than the paper the pixel is, relative to black. Ink and the
        # red slash are darker than the paper in every channel; anything lighter is paper grain.
        a = max(max(0, BG[c] - px[c]) / BG[c] for c in range(3))
        a = min(1.0, max(0.0, (a - LO) / (HI - LO)))
        if a == 0:
            continue
        col = tuple(min(255, max(0, round(BG[c] + (px[c] - BG[c]) / a))) for c in range(3))
        A = round(a * 255)
        pp[x, y] = col + (A,)
        red = col[0] - col[1] > 70 and col[0] > 120
        cp[x, y] = (col if red else CREAM) + (A,)
plain.save(here / "wordmark.png")
cream.save(here / "wordmark-cream.png")
print(f"wrote wordmark.png and wordmark-cream.png ({w}x{h})")
