"""align.py shot.png pen.png shot.ax.json [W H]: per accessibility element, the best (dx, dy) in @3x px that maps
the Pen export onto the capture, and the residual. Done when every element has |dx|,|dy| <= 1 (rules/design-fidelity.md).
Adapted from ai-plant-scanner design/tools/pen-baseline/align.py for any device size (default 402x874 pt).
Needs numpy and pillow."""
import sys, json, numpy as np
from PIL import Image
A = np.array(Image.open(sys.argv[1]).convert('L')).astype(float)
B = np.array(Image.open(sys.argv[2]).convert('L')).astype(float)
els = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else []
W, H = (float(sys.argv[4]), float(sys.argv[5])) if len(sys.argv) > 5 else (402.0, 874.0)
R = 6
worst = 0
for e in els:
    f = e['frame']
    if f['width'] >= W - 1 and f['height'] >= H - 50: continue
    if min(f['y'] + f['height'], H) - max(f['y'], 0) < 4: continue
    if min(f['x'] + f['width'], W) - max(f['x'], 0) < 4: continue
    x0 = max(int(f['x'] * 3) - R, R); y0 = max(int(f['y'] * 3) - R, R)
    x1 = min(int((f['x'] + f['width']) * 3) + R, A.shape[1] - R); y1 = min(int((f['y'] + f['height']) * 3) + R, A.shape[0] - R)
    if x1 <= x0 or y1 <= y0: continue
    a = A[y0:y1, x0:x1]; best = None
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            b = B[y0 - dy:y1 - dy, x0 - dx:x1 - dx]; err = np.abs(a - b).mean()
            if best is None or err < best[0]: best = (err, dx, dy)
    base = np.abs(a - B[y0:y1, x0:x1]).mean()
    if best[0] > 0.9 * base or base < 1.0: best = (base, 0, 0)
    worst = max(worst, abs(best[1]), abs(best[2]))
    flag = '' if abs(best[1]) <= 1 and abs(best[2]) <= 1 else '  <-- out of tolerance'
    print(f"{(e.get('AXLabel') or '')[:38]!r:42} dx={best[1]:+d} dy={best[2]:+d}  err0={base:5.2f} best={best[0]:5.2f}{flag}")
print(f"worst shift: {worst} px @3x")
