import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.environ.setdefault("HF_HOME", r"D:\web-manga-ocr\server\hf-cache")

import importlib.util

import numpy as np
from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location("srv", r"D:\web-manga-ocr\server\server.py")
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

IMG = sys.argv[1] if len(sys.argv) > 1 else r"D:\web-manga-ocr\debug-crops\fail1.jpg"
TAG = os.path.splitext(os.path.basename(IMG))[0]

_im = Image.open(IMG).convert("RGB")

from mokuro.manga_page_ocr import MangaPageOcr

print("loading models (cpu)...")
mpocr = MangaPageOcr(force_cpu=True, detector_input_size=2048)
result = mpocr(IMG)


def _quads(b):
    return [[[float(x), float(y)] for x, y in q] for q in
            (qq.tolist() if hasattr(qq, "tolist") else qq for qq in b["lines_coords"])]


# mirror the server's rescue trim: retry on trimmed content only when the
# full-frame pass struggles and there is real dead space to reclaim
_x, _y, _w, _h = srv.trim_margins(_im)
if "notrim" not in sys.argv and _w * _h < 0.9 * _im.width * _im.height:
    _g = np.asarray(_im.convert("L"))
    _nf = sum(
        1 for b in result["blocks"]
        if srv.refine_block_lines(_g, [float(v) for v in b["box"]], _quads(b), bool(b["vertical"]))[0] is None
    )
    if _nf >= 2:
        print(f"trim: pass A {_nf} refine failures -> ({_x},{_y}) {_w}x{_h}")
        IMG = rf"D:\web-manga-ocr\debug-crops\{TAG}_trimmed_tmp.png"
        _im.crop((_x, _y, _x + _w, _y + _h)).save(IMG)
        result = mpocr(IMG)
print("img", result["img_width"], "x", result["img_height"])

gray = np.asarray(Image.open(IMG).convert("L"))
im = Image.open(IMG).convert("RGB")
d_raw = ImageDraw.Draw(im)
im2 = Image.open(IMG).convert("RGB")
d_ref = ImageDraw.Draw(im2)
clean = Image.open(IMG).convert("RGB")

for i, b in enumerate(result["blocks"]):
    box = [float(v) for v in b["box"]]
    quads = [[[float(x), float(y)] for x, y in q] for q in
             (qq.tolist() if hasattr(qq, "tolist") else qq for qq in b["lines_coords"])]
    print(f"\nblock {i} vertical={b['vertical']} box={[int(v) for v in box]}")
    for t, q in zip(b["lines"], quads):
        xs = [p[0] for p in q]
        ys = [p[1] for p in q]
        print(f"  line {t[:14]!r:20} bbox=[{int(min(xs))},{int(min(ys))},{int(max(xs))},{int(max(ys))}]")
    refined, why = srv.refine_block_lines(gray, box, quads, bool(b["vertical"]))
    print(f"  refine -> {why}")

    d_raw.rectangle(box, outline=(0, 220, 0), width=3)
    for q in quads:
        xs = [p[0] for p in q]
        ys = [p[1] for p in q]
        d_raw.rectangle([min(xs), min(ys), max(xs), max(ys)], outline=(255, 0, 0), width=2)
    d_ref.rectangle(box, outline=(0, 220, 0), width=3)
    if refined:
        for t, r in zip(b["lines"], refined):
            if r is None:
                print(f"  DROPPED dup {t[:14]!r}")
                continue
            d_ref.rectangle(r, outline=(0, 80, 255), width=2)
            x1, y1, x2, y2 = r
            crop = clean.crop((max(0, x1 - 4), max(0, y1 - 4), x2 + 4, y2 + 4))
            newt = mpocr.mocr(crop)
            print(f"  refined box {[int(v) for v in r]} old={t[:14]!r} reocr={newt!r}")
    else:
        for q in quads:
            xs = [p[0] for p in q]
            ys = [p[1] for p in q]
            d_ref.rectangle([min(xs), min(ys), max(xs), max(ys)], outline=(255, 140, 0), width=2)

im.save(rf"D:\web-manga-ocr\debug-crops\{TAG}_raw.png")
im2.save(rf"D:\web-manga-ocr\debug-crops\{TAG}_refined.png")
print(f"\nsaved {TAG}_raw.png (detector output) and {TAG}_refined.png (blue=refined, orange=fallback)")
