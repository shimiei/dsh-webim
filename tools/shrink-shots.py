"""Downscale the captured panel shots to README-friendly sizes.

The captures are taken at 2x/3x device pixels so text stays crisp; GitHub never
shows them that wide, so they are resized and re-encoded to keep the repo small.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "shots"
TARGETS = {"settings-mobile.png": 760, "default": 1200}


def main() -> None:
    for file in sorted(SHOTS.glob("*.png")):
        width = TARGETS.get(file.name, TARGETS["default"])
        with Image.open(file) as img:
            img = img.convert("RGB")
            if img.width > width:
                height = round(img.height * width / img.width)
                img = img.resize((width, height), Image.LANCZOS)
            img.save(file, optimize=True)
        print(f"{file.name}: {img.width}x{img.height} {file.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
