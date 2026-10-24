"""Compose docs/banner.png from the generated icon (no external deps but Pillow).

The banner is deliberately text-light: the repo README already renders the title
as Markdown, so this image only needs to look like the project at a glance.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
ICON = ROOT / "dsh-image-gen" / "image-016095e5.png"

W, H = 1280, 340
BG = (11, 11, 13)
ACCENT = (59, 130, 246)
ACCENT_SOFT = (34, 211, 238)
TEXT = (249, 250, 251)
MUTED = (154, 160, 172)
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"


def vertical_gradient(size: tuple[int, int]) -> Image.Image:
    """Very dark vertical wash so the banner does not look flat."""
    img = Image.new("RGB", size, BG)
    draw = ImageDraw.Draw(img)
    w, h = size
    for y in range(h):
        t = y / max(1, h - 1)
        shade = int(9 + 10 * (1 - t) ** 2)
        draw.line([(0, y), (w, y)], fill=(shade, shade, shade + 2))
    return img


def add_grid(img: Image.Image, step: int = 32, alpha: int = 7) -> None:
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for x in range(0, img.width, step):
        draw.line([(x, 0), (x, img.height)], fill=(255, 255, 255, alpha))
    for y in range(0, img.height, step):
        draw.line([(0, y), (img.width, y)], fill=(255, 255, 255, alpha))
    img.alpha_composite(layer)


def add_glow(img: Image.Image, center: tuple[int, int], radius: int, color: tuple[int, int, int], peak: int = 90) -> None:
    """Radial glow, painted on its own layer so it can be blurred softly."""
    glow = Image.new("RGBA", (radius * 2, radius * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    for r in range(radius, 0, -2):
        t = r / radius
        a = int(peak * (1 - t) ** 2.4)
        draw.ellipse(
            [radius - r, radius - r, radius + r, radius + r],
            fill=(color[0], color[1], color[2], a),
        )
    glow = glow.filter(ImageFilter.GaussianBlur(radius * 0.16))
    img.alpha_composite(glow, (center[0] - radius, center[1] - radius))


def rounded(img: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], radius=radius, fill=255)
    out = img.copy()
    out.putalpha(mask)
    return out


def main() -> None:
    DOCS.mkdir(exist_ok=True)
    canvas = vertical_gradient((W, H)).convert("RGBA")
    add_grid(canvas)
    add_glow(canvas, (int(W * 0.82), H // 2), 300, ACCENT, peak=76)
    add_glow(canvas, (int(W * 0.93), int(H * 0.28)), 190, ACCENT_SOFT, peak=40)

    # Icon, floated to the right with a hairline ring so it reads on the dark bg.
    icon_size = 208
    icon = Image.open(ICON).convert("RGBA").resize((icon_size, icon_size), Image.LANCZOS)
    icon = rounded(icon, int(icon_size * 0.23))
    ring = Image.new("RGBA", (icon_size + 8, icon_size + 8), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle(
        [0, 0, icon_size + 7, icon_size + 7], radius=int(icon_size * 0.25), outline=(255, 255, 255, 30), width=2
    )
    icon_x, icon_y = W - icon_size - 96, (H - icon_size) // 2
    canvas.alpha_composite(icon, (icon_x, icon_y))
    canvas.alpha_composite(ring, (icon_x - 4, icon_y - 4))

    # A thin blue arc pair echoing the icon, drawn behind the text block.
    arc = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    arc_draw = ImageDraw.Draw(arc)
    cx, cy = icon_x + icon_size // 2, icon_y + icon_size // 2
    for i, r in enumerate((130, 168, 206)):
        box = [cx - r, cy - r, cx + r, cy + r]
        arc_draw.arc(box, start=-78, end=-16, fill=(59, 130, 246, 120 - i * 34), width=3)
    canvas.alpha_composite(arc.filter(ImageFilter.GaussianBlur(0.4)))

    # Text and chips are painted on their own layer and blended, never written
    # straight onto the canvas: direct RGBA fills replace pixels instead of
    # compositing, which turns translucent white into solid white.
    text_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(text_layer)
    title_font = ImageFont.truetype(FONT_BOLD, 78)
    sub_font = ImageFont.truetype(FONT_REG, 27)
    chip_font = ImageFont.truetype(FONT_REG, 21)

    x = 76
    draw.text((x, 96), "dsh-webim", font=title_font, fill=TEXT)
    draw.text((x + 2, 196), "把本地 DeepSeek Harness 带到手机、平板与异地浏览器", font=sub_font, fill=MUTED)

    # Chips: version + license, sized to their text so the row stays balanced.
    chip_y = 250
    chip_x = x + 2
    for label, color in (("v1.5.1", ACCENT), ("MIT", MUTED), ("零依赖插件", MUTED)):
        tw = draw.textbbox((0, 0), label, font=chip_font)[2]
        pad = 14
        box = [chip_x, chip_y, chip_x + tw + pad * 2, chip_y + 34]
        draw.rounded_rectangle(box, radius=17, fill=(255, 255, 255, 14), outline=(255, 255, 255, 34), width=1)
        draw.text((chip_x + pad, chip_y + 5), label, font=chip_font, fill=color)
        chip_x += tw + pad * 2 + 10

    canvas.alpha_composite(text_layer)

    # Bottom hairline keeps the banner from bleeding into the page background.
    rule = Image.new("RGBA", (W, 1), (255, 255, 255, 20))
    canvas.alpha_composite(rule, (0, H - 1))

    canvas.convert("RGB").save(DOCS / "banner.png", optimize=True)

    # Icon exports used by the README header and as the package icon.
    src = Image.open(ICON).convert("RGBA")
    src.save(DOCS / "icon.png", optimize=True)
    src.resize((256, 256), Image.LANCZOS).save(DOCS / "icon-256.png", optimize=True)
    src.resize((64, 64), Image.LANCZOS).save(DOCS / "icon-64.png", optimize=True)
    print("wrote", DOCS / "banner.png")


if __name__ == "__main__":
    main()
