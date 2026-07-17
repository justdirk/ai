#!/usr/bin/env python3
# Generates dirk.it raster branding for bolt into ./public at Docker build time.
# Reads a pre-rasterized mark PNG (/tmp/mark512.png, produced by rsvg-convert
# from public/favicon.svg) and emits favicon.ico, apple-touch icons and the
# social share preview. Pure Pillow so the build needs no cairo/cffi.
from PIL import Image, ImageDraw, ImageFont
import os

PUB = "public"
mark = Image.open("/tmp/mark512.png").convert("RGBA")

# apple-touch-icon 180x180 on opaque tile
apple = Image.new("RGBA", (180, 180), (21, 24, 35, 255))
apple.alpha_composite(mark.resize((180, 180), Image.LANCZOS))
apple_rgb = apple.convert("RGB")
apple_rgb.save(os.path.join(PUB, "apple-touch-icon.png"), "PNG")
apple_rgb.save(os.path.join(PUB, "apple-touch-icon-precomposed.png"), "PNG")

# multi-size favicon.ico
mark.resize((256, 256), Image.LANCZOS).save(
    os.path.join(PUB, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)]
)

# social share card 1200x630
W, H = 1200, 630
card = Image.new("RGB", (W, H), (15, 17, 23))
d = ImageDraw.Draw(card)
d.rounded_rectangle([40, 40, W - 40, H - 40], radius=28, outline=(44, 49, 64), width=3)
_m = mark.resize((190, 190), Image.LANCZOS)
card.paste(_m, (90, 150), _m)


def font(sz):
    for p in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            pass
    return ImageFont.load_default()


fb, ft, fs = font(120), font(40), font(30)
x, y = 320, 185
d.text((x, y), "dirk", font=fb, fill=(232, 234, 240))
wd = d.textlength("dirk", font=fb)
d.text((x + wd, y), ".", font=fb, fill=(110, 168, 254))
wdot = d.textlength(".", font=fb)
d.text((x + wd + wdot, y), "it", font=fb, fill=(232, 234, 240))
d.text((322, 335), "Build apps in plain language.", font=ft, fill=(154, 161, 178))
d.text((322, 395), "Describe it, watch it build live, deploy to a link.", font=fs, fill=(120, 127, 145))
card.save(os.path.join(PUB, "social_preview_index.jpg"), "JPEG", quality=82, optimize=True)

print("dirk.it raster assets generated into", PUB)
