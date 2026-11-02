"""Contact sheet: python3 scripts/sheet.py out.png crop(x,y,w,h|none) img1 img2 ..."""
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
crop = sys.argv[2]
files = sys.argv[3:]
imgs = []
for f in files:
    im = Image.open(f).convert('RGB')
    if crop != 'none':
        x, y, w, h = map(int, crop.split(','))
        im = im.crop((x, y, x + w, y + h))
    imgs.append((f.split('/')[-1].replace('.png', ''), im))
cols = 4 if len(imgs) > 4 else len(imgs)
rows = (len(imgs) + cols - 1) // cols
w, h = imgs[0][1].size
scale = min(1.0, 1600 / (w * cols))
tw, th = int(w * scale), int(h * scale)
sheet = Image.new('RGB', (tw * cols, th * rows), (0, 0, 0))
d = ImageDraw.Draw(sheet)
for i, (name, im) in enumerate(imgs):
    im = im.resize((tw, th))
    x, y = (i % cols) * tw, (i // cols) * th
    sheet.paste(im, (x, y))
    d.rectangle([x, y, x + len(name) * 7 + 6, y + 14], fill=(0, 0, 0))
    d.text((x + 3, y + 1), name, fill=(255, 255, 0))
sheet.save(out)
print(out, sheet.size)
