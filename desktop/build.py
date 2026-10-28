"""Build TapeReplay.exe.

1. Copies ../tape-replay.html into web/index.html, pointing it at local copies of
   the chart library and fonts so the app works offline.
2. Draws the app icon, and writes _version.py from TAPE_VERSION (the release version; 0.0.0-dev otherwise).
3. Runs PyInstaller to produce a single-file dist/TapeReplay.exe, including .tapepack files from data/
   (build_pack.py), installed into the Library on first launch. .tapeseries files (build_series.py) are
   embedded only with TAPE_EMBED_SERIES=1; the app's built-in data is generated practice data.

Run with the Python that has pyinstaller and pywebview installed:
    python build.py [output folder, default dist]
"""
import os
import re
import struct
import subprocess
import sys
import urllib.request
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
SRC = os.path.join(HERE, "..", "tape-replay.html")
LW_URL = "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"
FONTS_URL = ("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@400;500;600;700"
             "&family=JetBrains+Mono:wght@400;500;600&display=swap")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def vendor():
    os.makedirs(os.path.join(WEB, "fonts"), exist_ok=True)
    lw = os.path.join(WEB, "lw.js")
    if not os.path.isfile(lw):
        with open(lw, "wb") as f:
            f.write(fetch(LW_URL))
    css_path = os.path.join(WEB, "fonts.css")
    if not os.path.isfile(css_path):
        css = fetch(FONTS_URL).decode("utf-8")
        # keep only the latin subsets; the UI never needs the others
        blocks = re.findall(r"/\* ([\w-]+) \*/\s*(@font-face \{.*?\})", css, re.S)
        out = []
        for i, (subset, block) in enumerate(blocks):
            if subset != "latin":
                continue
            url = re.search(r"url\((https://[^)]+)\)", block).group(1)
            name = f"f{i}.woff2"
            with open(os.path.join(WEB, "fonts", name), "wb") as f:
                f.write(fetch(url))
            out.append(block.replace(url, "fonts/" + name))
        with open(css_path, "w", encoding="utf-8") as f:
            f.write("\n".join(out))


def page():
    with open(SRC, encoding="utf-8") as f:
        html = f.read()
    html = re.sub(r'<link rel="preconnect"[^>]*>\n?', "", html)
    html = re.sub(r'<link rel="stylesheet" href="https://fonts\.googleapis\.com[^"]*">', '<link rel="stylesheet" href="fonts.css">', html)
    html = html.replace(f'<script src="{LW_URL}"></script>', '<script src="lw.js"></script>')
    assert 'src="lw.js"' in html, "chart library tag not found in tape-replay.html"
    head = '<!doctype html>\n<html lang="en">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    with open(os.path.join(WEB, "index.html"), "w", encoding="utf-8") as f:
        f.write(head + html)


def png(size, rounded=True, alpha=True):
    """A dark tile with one green and one red candle. rounded=False fills the square (iOS rounds icons itself);
    alpha=False writes plain RGB, which the App Store requires for the app icon."""
    bg, up, dn = (18, 24, 32, 255), (45, 179, 138, 255), (229, 85, 76, 255)
    s = size / 32.0
    px = [[(0, 0, 0, 0) if rounded else bg] * size for _ in range(size)]
    r = 6 * s
    for y in range(size if rounded else 0):
        for x in range(size):
            cx = min(max(x + .5, r), size - r)
            cy = min(max(y + .5, r), size - r)
            if (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= r * r:
                px[y][x] = bg

    def rect(x0, y0, x1, y1, col):
        for y in range(int(y0 * s), int(y1 * s)):
            for x in range(int(x0 * s), int(x1 * s)):
                px[y][x] = col
    rect(10.5, 6, 11.5, 26, up); rect(8, 10, 14, 21, up)
    rect(20.5, 5, 21.5, 24, dn); rect(18, 8, 24, 17, dn)
    width = 4 if alpha else 3
    raw = b"".join(b"\x00" + bytes(c for p in row for c in p[:width]) for row in px)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6 if alpha else 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def icon(path):
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [png(s) for s in sizes]
    off = 6 + 16 * len(sizes)
    hdr = struct.pack("<HHH", 0, 1, len(sizes))
    for s, d in zip(sizes, imgs):
        hdr += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(d), off)
        off += len(d)
    with open(path, "wb") as f:
        f.write(hdr + b"".join(imgs))


def main():
    # output folder: dist/, or another one given on the command line (e.g. while dist/TapeReplay.exe is running)
    dist = os.path.join(HERE, sys.argv[1] if len(sys.argv) > 1 else "dist")
    # the version the app reports and compares with releases (TAPE_VERSION=1.2.0 for a release build)
    with open(os.path.join(HERE, "_version.py"), "w", encoding="utf-8") as f:
        f.write(f'VERSION = "{os.environ.get("TAPE_VERSION") or "0.0.0-dev"}"\n')
    vendor()
    page()
    ico = os.path.join(HERE, "icon.ico")
    icon(ico)
    extra = []
    data = os.path.join(HERE, "data")
    files = sorted(os.listdir(data)) if os.path.isdir(data) else []
    # small packs (build_pack.py) are unpacked with the app and installed into the Library once
    for f in files:
        if f.endswith(".tapepack"):
            extra += ["--add-data", f"{os.path.join(data, f)}{os.pathsep}data"]
    # Long series (build_series.py) can go in as Windows resources, read in place and never unpacked.
    # Off by default: the app now ships generated practice data instead of real market data. Set
    # TAPE_EMBED_SERIES=1 to build a private copy with your own .tapeseries files inside.
    if os.environ.get("TAPE_EMBED_SERIES") == "1":
        for i, f in enumerate([f for f in files if f.endswith(".tapeseries")], 1):
            extra += ["--resource", f"{os.path.join(data, f)},TAPEDATA,SERIES{i},0"]
    subprocess.check_call([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
                           "--name", "TapeReplay", "--icon", ico, "--add-data", f"{WEB}{os.pathsep}web", *extra,
                           "--distpath", dist, "--workpath", os.path.join(HERE, "build"),
                           "--specpath", HERE, os.path.join(HERE, "app.py")], cwd=HERE)
    print("Built", os.path.join(dist, "TapeReplay.exe"))


if __name__ == "__main__":
    main()
