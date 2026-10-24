"""Draw docs/arch.png: the request path from a phone to the local Harness.

Mermaid in the README gets clipped on GitHub (the diagram is wider than the
column), so the architecture picture is drawn here instead: full control over
layout, the same dark palette as the banner, and it always fits.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

W, H = 1200, 460
BG = (13, 13, 15)
CARD = (26, 26, 29)
LINE = (58, 58, 64)
TEXT = (249, 250, 251)
MUTED = (154, 160, 172)
ACCENT = (59, 130, 246)
OK = (74, 222, 128)
ARROW = (122, 128, 142)

FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"

# Zone edges: 外面 | gap | 网关 | gap | Harness
LEFT = (28, 300)
MID = (430, 716)
RIGHT = (846, 1172)


def layer(size: tuple[int, int] = (W, H)) -> Image.Image:
    return Image.new("RGBA", size, (0, 0, 0, 0))


def box(img: Image.Image, rect, radius=14, fill=CARD, outline=LINE, width=1) -> None:
    tmp = layer()
    ImageDraw.Draw(tmp).rounded_rectangle(rect, radius=radius, fill=fill, outline=outline, width=width)
    img.alpha_composite(tmp)


def text(img: Image.Image, xy, content, font, fill=TEXT) -> None:
    tmp = layer()
    ImageDraw.Draw(tmp).text(xy, content, font=font, fill=fill)
    img.alpha_composite(tmp)


def arrow(img: Image.Image, start, end, color=ARROW + (255,), width=2, head=8) -> None:
    tmp = layer()
    draw = ImageDraw.Draw(tmp)
    draw.line([start, end], fill=color, width=width)
    (x1, y1), (x2, y2) = start, end
    if abs(x2 - x1) >= abs(y2 - y1):
        sign = 1 if x2 > x1 else -1
        draw.polygon([(x2, y2), (x2 - sign * head, y2 - head * 0.75), (x2 - sign * head, y2 + head * 0.75)], fill=color)
    else:
        sign = 1 if y2 > y1 else -1
        draw.polygon([(x2, y2), (x2 - head * 0.75, y2 - sign * head), (x2 + head * 0.75, y2 - sign * head)], fill=color)
    img.alpha_composite(tmp)


def tag(img: Image.Image, center, content, font, color=MUTED) -> None:
    """Arrow label on a solid pill so it never sits on top of a line or border."""
    probe = ImageDraw.Draw(layer())
    left, top, right, bottom = probe.textbbox((0, 0), content, font=font)
    tw, th = right - left, bottom - top
    x = int(center[0] - tw / 2 - 8)
    y = int(center[1] - th / 2 - 5)
    box(img, [x, y, x + tw + 16, y + th + 10], radius=9, fill=BG + (255,), outline=(48, 48, 54))
    text(img, (x + 8 - left, y + 5 - top), content, font, color)


def main() -> None:
    DOCS.mkdir(exist_ok=True)
    img = Image.new("RGBA", (W, H), BG + (255,))

    # Faint glow behind the gateway, matching the banner's accent.
    glow = layer()
    ImageDraw.Draw(glow).ellipse([470, 110, 760, 400], fill=ACCENT + (30,))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(48)))

    f_group = ImageFont.truetype(FONT_BOLD, 17)
    f_card = ImageFont.truetype(FONT_BOLD, 19)
    f_sub = ImageFont.truetype(FONT_REG, 15)
    f_mono = ImageFont.truetype(FONT_REG, 14)
    f_tag = ImageFont.truetype(FONT_REG, 14)

    for x0, x1, label in ((*LEFT, "外面"), (*MID, "本机 · 网关"), (*RIGHT, "本机 · Harness")):
        box(img, [x0, 40, x1, H - 40], radius=20, fill=(19, 19, 22), outline=(44, 44, 49))
        text(img, (x0 + 18, 52), label, f_group, MUTED)

    # ---- left: caller ----
    box(img, [50, 112, 278, 190])
    text(img, (68, 126), "手机 / 异地浏览器", f_card)
    text(img, (68, 154), "扫码或粘贴 token 链接", f_sub, MUTED)

    box(img, [50, 266, 278, 344])
    text(img, (68, 280), "Cloudflare 隧道", f_card)
    text(img, (68, 308), "https://…trycloudflare.com", f_mono, MUTED)

    # ---- middle: gateway ----
    box(img, [446, 116, 700, 340], radius=18, fill=(22, 26, 36), outline=ACCENT + (255,), width=2)
    text(img, (466, 136), "dsh-webim 网关", f_card)
    text(img, (466, 164), "0.0.0.0:3081", f_mono, ACCENT)
    for i, line in enumerate(("token / 口令校验", "HTTP + WS 透传", "入口地址 · 二维码", "隧道生命周期")):
        text(img, (466, 202 + i * 28), "· " + line, f_sub, MUTED)
    dot = layer()
    ImageDraw.Draw(dot).ellipse([666, 142, 679, 155], fill=OK + (255,))
    img.alpha_composite(dot)

    # ---- right: harness ----
    box(img, [866, 96, 1152, 172])
    text(img, (884, 110), "DSH Web 载体", f_card)
    text(img, (884, 138), "127.0.0.1 : 随机端口", f_mono, MUTED)

    box(img, [866, 196, 1152, 272])
    text(img, (884, 210), "设置页 RPC /webim", f_card)
    text(img, (884, 238), "info · setFeatures · tunnel", f_mono, MUTED)

    box(img, [866, 296, 1152, 372])
    text(img, (884, 310), "凭据与状态", f_card)
    text(img, (884, 338), ".credentials.yaml · webim/", f_mono, MUTED)

    # ---- arrows, labels centred in the gaps ----
    arrow(img, (278, 152), (446, 178), color=ACCENT + (255,))
    tag(img, (362, 140), "?token=…", f_tag, ACCENT)

    arrow(img, (278, 304), (446, 268))
    tag(img, (362, 306), "https", f_tag)

    arrow(img, (700, 178), (866, 134))
    tag(img, (783, 132), "HTTP + WS", f_tag)

    arrow(img, (700, 232), (866, 234))
    tag(img, (783, 212), "RPC", f_tag)

    arrow(img, (700, 300), (866, 334), color=OK + (255,))
    tag(img, (783, 340), "铸造 Cookie", f_tag, OK)

    img.convert("RGB").save(DOCS / "arch.png", optimize=True)
    print("wrote", DOCS / "arch.png")


if __name__ == "__main__":
    main()
