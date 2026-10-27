"""Make a data pack that ships inside the EXE.

Takes a parsed series from the app's Library cache (datasets/<id>_<pick>.bin) and writes
data/<file>.tapepack: the same columns, byte-shuffled and zstd-compressed (about 7x smaller).
On first launch the app unpacks it back into the Library (see install_builtin in app.py).

    python build_pack.py <cache .bin> <library id> "<display name>" <out name> [point value]
"""
import json
import os
import struct
import sys
from compression import zstd

MAGIC = b"TAPEPACK1"


def shuffle(b, width):
    # byte i of every value together: the slowly-changing high bytes then compress very well
    return b"".join(b[i::width] for i in range(width))


def main(src, ds_id, name, out_name, point_value=None):
    raw = open(src, "rb").read()
    hlen = struct.unpack_from("<I", raw, 0)[0]
    head = json.loads(raw[4:4 + hlen])
    n, off = head["n"], (4 + hlen + 7) // 8 * 8
    t0, t1 = struct.unpack_from("<d", raw, off)[0], struct.unpack_from("<d", raw, off + (n - 1) * 8)[0]
    cols, p = [(raw[off:off + n * 8], 8)], off + n * 8
    for _ in range(5):  # open, high, low, close, volume (float32)
        cols.append((raw[p:p + n * 4], 4))
        p += n * 4
    meta = {"id": ds_id, "name": name, "bars": n, "base": head["base"], "from": t0, "to": t1, "contracts": 1,
            "series": {k: head[k] for k in ("v", "n", "base", "prec", "bad", "hasVol")}}
    if point_value:
        meta["pointValue"] = float(point_value)  # $ per 1.0 price move, used as the default on a fresh install
    os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"), exist_ok=True)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", out_name)
    with open(out, "wb") as f:
        hj = json.dumps(meta).encode()
        f.write(MAGIC + struct.pack("<I", len(hj)) + hj)
        for col, width in cols:
            z = zstd.compress(shuffle(col, width), 9)
            f.write(struct.pack("<BQ", width, len(z)) + z)
    print(f"{out}: {n:,} bars, {os.path.getsize(out) / 1048576:.0f} MB")


if __name__ == "__main__":
    main(*sys.argv[1:6])
