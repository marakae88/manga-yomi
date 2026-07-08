import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

IMG = r"D:\web-manga-ocr\debug-crops\fail3.png"
gray = np.asarray(Image.open(IMG).convert("L"))

# block 0 padded region, mirroring refine_block_lines
x1, y1, x2, y2 = 797, 80, 866, 297
pad_x = max(2, (x2 - x1) // 30)
pad_y = max(2, (y2 - y1) // 30)
ex1, ey1 = x1 - pad_x, y1 - pad_y
ex2, ey2 = x2 + pad_x, y2 + pad_y
reg = gray[ey1:ey2, ex1:ex2]
lo, hi = int(reg.min()), int(reg.max())
print("region", reg.shape, "lo/hi", lo, hi)
ink = reg < (lo + hi) / 2
if ink.mean() > 0.5:
    ink = ~ink
full_rows = ink.mean(axis=1) > 0.8
full_cols = ink.mean(axis=0) > 0.8
ink[full_rows, :] = False
ink[:, full_cols] = False

profile = ink.mean(axis=0)
pm = profile.max()
print("profile.max", round(float(pm), 4))
for i, v in enumerate(profile):
    bar = "#" * int(v / pm * 60)
    print(f"x={ex1 + i:4d} {v:6.3f} {bar}")
