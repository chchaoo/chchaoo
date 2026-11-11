"""Trim unused SVG space while preserving every snake animation frame."""
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

ET.register_namespace('', 'http://www.w3.org/2000/svg')


def compact(source):
    root = ET.fromstring(source)
    cells = [e for e in root if 'c' in e.get('class', '').split()]
    bars = [e for e in root if 'u' in e.get('class', '').split()]
    snakes = [e for e in root if 's' in e.get('class', '').split()]
    if not cells or not bars or not snakes:
        raise ValueError('Unrecognized snake SVG; refusing to crop it')
    style = ''.join(e.text or '' for e in root if e.tag.endswith('}style'))
    moves = [(float(x), float(y)) for x, y in re.findall(
        r'translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)', style)]
    if not moves:
        raise ValueError('Missing animation bounds')
    # The snake can travel outside the grid. Include all animation positions.
    top = math.floor(min(min(float(e.get('y')) for e in cells) - .5,
                         min(y for x, y in moves) + min(float(e.get('y')) for e in snakes)))
    bottom = max(max(float(e.get('y')) + 12.5 for e in cells),
                 max(y for x, y in moves) + max(float(e.get('y')) + float(e.get('height')) for e in snakes))
    bar_y = math.ceil(bottom + 4)
    for bar in bars:
        bar.set('y', str(bar_y))
    height = math.ceil(bar_y + max(float(e.get('height')) for e in bars)) - top
    left, _, width, _ = root.get('viewBox').split()
    root.set('viewBox', f'{left} {top} {width} {height}')
    root.set('height', str(height))
    return ET.tostring(root, encoding='unicode')


if __name__ == '__main__':
    for name in sys.argv[1:]:
        path = Path(name)
        path.write_text(compact(path.read_text(encoding='utf-8')), encoding='utf-8')
