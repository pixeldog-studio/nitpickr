"""shrink_exports.py design/exports/<id>: rewrites the committed exports as 256-colour PNG previews (about 3x
smaller). Run after verify.mjs, which diffs the full-colour exports first. Needs pillow."""
import os
import sys

from PIL import Image

root = sys.argv[1]
before = after = 0
for name in sorted(os.listdir(root)):
    if not name.endswith(".png"):
        continue
    path = os.path.join(root, name)
    before += os.path.getsize(path)
    im = Image.open(path).convert("RGB")
    im.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)
    after += os.path.getsize(path)
print(f"{root}: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")
