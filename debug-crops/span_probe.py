import sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
gray = np.asarray(Image.open(r"D:\manga-yomi\debug-crops\fail1.jpg").convert("L"))
# block 0 padded region from repro: ex1=108, ey1=194 (box [121,206,539,847], pad 13/21)
ex1, ey1, ex2, ey2 = 108, 185, 552, 868
reg = gray[ey1:ey2, ex1:ex2]
lo, hi = int(reg.min()), int(reg.max())
ink = reg < (lo + hi) / 2
if ink.mean() > 0.5: ink = ~ink
full_rows = ink.mean(axis=1) > 0.8
full_cols = ink.mean(axis=0) > 0.8
ink[full_rows, :] = False
ink[:, full_cols] = False
b0, b1 = 356 - ex1, 424 - ex1   # column 2 band
span = ink[:, b0:b1].mean(axis=1)
st = max(float(span.max()) * 0.1, 0.02)
print("span.max", round(float(span.max()), 3), "threshold", round(st, 3))
for y in range(620 - ey1, 700 - ey1):
    v = float(span[y])
    mark = "*" if v >= st else " "
    print(ey1 + y, round(v, 3), mark, "#" * int(v * 60))
# where is comma ink? check wider slice to the right
span_w = ink[:, b0:b1 + 24].mean(axis=1)
on = np.flatnonzero(span_w >= max(float(span_w.max()) * 0.1, 0.02))
print("widened-band span extent:", ey1 + int(on[0]), ey1 + int(on[-1]) + 1)
