#!/usr/bin/env python3
"""Convert captured renders to PNG and report pixel differences; never bless baselines."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageChops

parser = argparse.ArgumentParser()
parser.add_argument('light')
parser.add_argument('dark')
parser.add_argument('output')
args = parser.parse_args()
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
light = Image.open(args.light).convert('RGB')
dark = Image.open(args.dark).convert('RGB')
if light.size != dark.size:
    raise SystemExit('Render dimensions differ; capture the same viewport')
light.save(out / 'light.png')
dark.save(out / 'dark.png')
diff = ImageChops.difference(light, dark)
diff.save(out / 'theme-diff.png')
changed = sum(pixel != (0, 0, 0) for pixel in diff.getdata())
report = {'width': light.width, 'height': light.height, 'changedPixels': changed,
          'changedFraction': changed / (light.width * light.height),
          'interpretation': 'Theme difference evidence, not a cross-theme equality assertion.'}
(out / 'render-diff.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
if changed == 0:
    raise SystemExit('Theme switch produced no pixel changes')
