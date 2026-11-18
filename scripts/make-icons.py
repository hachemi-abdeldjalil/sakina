# Draws the Sakina icon (rounded green square, music note with a slash) at 4 sizes.
from PIL import Image, ImageDraw
import os
here = os.path.dirname(os.path.abspath(__file__))
dst = os.path.join(here, '..', 'static', 'icons')
S = 512
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([16, 16, S - 16, S - 16], radius=110, fill=(31, 122, 90))
d.rounded_rectangle([16, 16, S - 16, S // 2], radius=110, fill=(39, 140, 104))
d.rectangle([16, S // 2 - 110, S - 16, S // 2], fill=(31, 122, 90))
white = (245, 250, 247)
# eighth note: head + stem + flag
d.ellipse([150, 300, 260, 385], fill=white)
d.rectangle([236, 130, 262, 345], fill=white)
d.polygon([(262, 130), (350, 175), (350, 225), (262, 185)], fill=white)
# slash
d.line([(130, 400), (390, 120)], fill=(31, 122, 90), width=46)
d.line([(130, 400), (390, 120)], fill=white, width=22)
for n in (16, 32, 48, 128):
    img.resize((n, n), Image.LANCZOS).save(os.path.join(dst, f'icon{n}.png'))
print('icons written')
