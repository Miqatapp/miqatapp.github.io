# Prints the center "x y" of the first UI node whose text or content-desc matches the regex.
import re, sys, xml.etree.ElementTree as ET
pat = re.compile(sys.argv[2])
for n in ET.parse(sys.argv[1]).iter('node'):
    label = (n.get('text') or '') + ' ' + (n.get('content-desc') or '')
    if pat.search(label.strip()):
        x1, y1, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds')))
        if x2 > x1 and y2 > y1:
            print((x1 + x2) // 2, (y1 + y2) // 2)
            break
