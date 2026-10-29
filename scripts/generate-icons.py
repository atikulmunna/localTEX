"""Generate localTEX's geometric app mark using only the Python standard library."""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1] / 'src-tauri' / 'icons'
ROOT.mkdir(parents=True, exist_ok=True)

def segment_distance(x, y, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    t = max(0, min(1, ((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)))
    return math.hypot(x-a[0]-t*dx, y-a[1]-t*dy)

def png(size):
    pixels = bytearray()
    strokes = [((.32,.27),(.32,.72)),((.32,.72),(.51,.72)),((.48,.38),(.76,.38)),((.62,.38),(.62,.67)),((.62,.67),(.70,.72))]
    for row in range(size):
        pixels.append(0)
        for col in range(size):
            sums = [0,0,0,0]
            for sy in (.25,.75):
                for sx in (.25,.75):
                    x,y=(col+sx)/size,(row+sy)/size
                    dx,dy=max(abs(x-.5)-.29,0),max(abs(y-.5)-.29,0)
                    inside = math.hypot(dx,dy) <= .19
                    line = min(segment_distance(x,y,*s) for s in strokes) < .028
                    color = (255,250,243,255) if line and inside else (118,97,174,255) if inside else (0,0,0,0)
                    sums = [a+b for a,b in zip(sums,color)]
            pixels.extend(v//4 for v in sums)
    def chunk(kind, data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(pixels),9))+chunk(b'IEND',b'')

images = [(size,png(size)) for size in (32,128,256)]
for size,data in images:
    (ROOT / f'{size}x{size}.png').write_bytes(data)
offset=6+16*len(images)
entries=bytearray()
for size,data in images:
    entries.extend(struct.pack('<BBBBHHII',size if size<256 else 0,size if size<256 else 0,0,0,1,32,len(data),offset))
    offset+=len(data)
(ROOT/'icon.ico').write_bytes(struct.pack('<HHH',0,1,len(images))+entries+b''.join(data for _,data in images))
print('Generated Windows icon and PNG assets.')
