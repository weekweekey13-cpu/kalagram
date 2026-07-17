from pathlib import Path
from PIL import Image, ImageEnhance

src = Path(
    r"C:\Users\user\.grok\sessions\C%3A%5CUsers%5Cuser%5C.grok%5Cbin\019f717f-0494-7df3-bc05-e59f7bcf9ea9\images\1.jpg"
)
out_dir = Path(__file__).resolve().parents[1] / "static" / "icons"
out_dir.mkdir(parents=True, exist_ok=True)

img = Image.open(src).convert("RGBA")
w, h = img.size
side = min(w, h)
left = (w - side) // 2
top = (h - side) // 2
img = img.crop((left, top, left + side, top + side))
img = ImageEnhance.Contrast(img).enhance(1.08)
img = ImageEnhance.Color(img).enhance(1.12)

master = img.resize((1024, 1024), Image.Resampling.LANCZOS)
master.save(out_dir / "icon-1024.png", "PNG", optimize=True)

sizes = {
    180: "icon-180.png",
    167: "icon-167.png",
    152: "icon-152.png",
    120: "icon-120.png",
    192: "icon-192.png",
    512: "icon-512.png",
}
for s, name in sizes.items():
    master.resize((s, s), Image.Resampling.LANCZOS).save(out_dir / name, "PNG", optimize=True)
    print("wrote", name)

master.resize((32, 32), Image.Resampling.LANCZOS).save(out_dir / "favicon-32.png", "PNG")
master.resize((48, 48), Image.Resampling.LANCZOS).save(out_dir / "favicon-48.png", "PNG")
print("ok", out_dir)
