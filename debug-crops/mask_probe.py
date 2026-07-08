"""Does the detector's text segmentation mask separate columns that raw-ink
profiling can't? For each block: run refine_block_lines twice; once on the
real grayscale (production behavior), once on the inverted mask_refined as a
fake grayscale; and compare. Saves per-block side-by-side crops."""

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

IMG = sys.argv[1] if len(sys.argv) > 1 else r"D:\web-manga-ocr\debug-crops\fail4.png"
TAG = os.path.splitext(os.path.basename(IMG))[0]

from mokuro.manga_page_ocr import MangaPageOcr
from mokuro.utils import imread

print("loading models (cpu)...")
mpocr = MangaPageOcr(force_cpu=True, detector_input_size=2048)

img = imread(IMG)  # BGR, same as MangaPageOcr.__call__
mask, mask_refined, blk_list = mpocr.text_detector(img, refine_mode=1, keep_undetected_mask=True)
print("mask", mask.shape, mask.dtype, "max", mask.max(),
      "| mask_refined", mask_refined.shape, mask_refined.dtype, "max", mask_refined.max())

gray = np.asarray(Image.open(IMG).convert("L"))
# mask_refined: text pixels white (255) on black. Invert -> text dark, so it
# drops into refine_block_lines unchanged as a fake grayscale.
fake_gray = 255 - mask_refined
Image.fromarray(mask_refined).save(rf"D:\web-manga-ocr\debug-crops\{TAG}_mask.png")

for i, blk in enumerate(blk_list):
    box = [float(v) for v in blk.xyxy]
    quads = [[[float(x), float(y)] for x, y in q] for q in blk.lines_array()]
    vert = bool(blk.vertical)
    print(f"\nblock {i} vertical={vert} box={[int(v) for v in box]} nlines={len(quads)}")

    r_ink, why_ink = srv.refine_block_lines(gray, box, quads, vert)
    r_msk, why_msk = srv.refine_block_lines(fake_gray, box, quads, vert)
    n_ink = sum(1 for r in (r_ink or []) if r is not None)
    n_msk = sum(1 for r in (r_msk or []) if r is not None)
    print(f"  raw ink : {'OK ' + str(n_ink) + ' lines' if r_ink else 'FAIL'} ({why_ink})")
    print(f"  mask    : {'OK ' + str(n_msk) + ' lines' if r_msk else 'FAIL'} ({why_msk})")
    if r_msk:
        for r in r_msk:
            if r is None:
                print("    dup dropped")
                continue
            x1, y1, x2, y2 = (int(v) for v in r)
            crop = Image.open(IMG).convert("RGB").crop(
                (max(0, x1 - 4), max(0, y1 - 4), x2 + 4, y2 + 4))
            print(f"    mask box {[x1, y1, x2, y2]} reocr={mpocr.mocr(crop)!r}")

    # phantom-block signal: how much of the block does the model call text?
    bx1, by1, bx2, by2 = (int(round(v)) for v in box)
    cover = (mask_refined[by1:by2, bx1:bx2] > 127).mean()
    print(f"  mask coverage inside block: {cover:.3f}")

    # side-by-side crop: original | mask, with refined boxes drawn
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    pad = 8
    cx1, cy1 = max(0, x1 - pad), max(0, y1 - pad)
    cx2, cy2 = min(gray.shape[1], x2 + pad), min(gray.shape[0], y2 + pad)
    left = Image.open(IMG).convert("RGB").crop((cx1, cy1, cx2, cy2))
    right = Image.fromarray(mask_refined[cy1:cy2, cx1:cx2]).convert("RGB")
    for src, res, col in ((left, r_ink, (255, 140, 0)), (right, r_msk, (0, 80, 255))):
        d = ImageDraw.Draw(src)
        for r in res or []:
            if r is not None:
                d.rectangle([r[0] - cx1, r[1] - cy1, r[2] - cx1, r[3] - cy1],
                            outline=col, width=2)
    combo = Image.new("RGB", (left.width * 2 + 4, left.height), (255, 0, 255))
    combo.paste(left, (0, 0))
    combo.paste(right, (left.width + 4, 0))
    combo.save(rf"D:\web-manga-ocr\debug-crops\{TAG}_blk{i}_maskcmp.png")

print(f"\nsaved {TAG}_mask.png and per-block {TAG}_blk*_maskcmp.png "
      "(orange=raw-ink refine, blue=mask refine)")
