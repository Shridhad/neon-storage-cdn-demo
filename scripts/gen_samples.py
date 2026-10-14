"""Writes six small gradient PNGs (320x240) into the directory given as argv[1]."""
import struct
import sys
import zlib

W, H = 320, 240
PALETTE = [(0xE8, 0x5D, 0x75), (0x5D, 0xA9, 0xE8), (0x6B, 0xCB, 0x77), (0xF4, 0xB1, 0x42), (0x9B, 0x72, 0xCF), (0x2F, 0x3E, 0x46)]


def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def png(base):
    rows = bytearray()
    for y in range(H):
        rows.append(0)
        for x in range(W):
            stripe = 40 if (x // 32 + y // 32) % 2 else 0
            for c in base:
                rows.append(min(255, int(c * (0.4 + 0.6 * y / H)) + stripe))
    ihdr = struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")


out = sys.argv[1]
for i, colour in enumerate(PALETTE, start=1):
    with open(f"{out}/sample-{i}.png", "wb") as f:
        f.write(png(colour))
