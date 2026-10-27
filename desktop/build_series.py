"""Turn a large Databento OHLCV file (.dbn or .dbn.zst) into a built-in series for the EXE.

The continuous series follows the most-traded outright contract each day (never rolling back),
like the app's own "Continuous" choice. Bars are stored in monthly blocks, each column
byte-shuffled and zstd-compressed, so the app can load any date range without unpacking the rest.

File layout (.tapeseries):
    b"TAPESER1" | blocks ... | header JSON | u32 header length | b"TAPESER1"
The header lists each block's first/last time, bar count, and the offset and size of its six
columns (time f64, open/high/low/close/volume f32), offsets counted from the start of the file.

Build-time only (uses numpy):
    python build_series.py <file.dbn.zst> <id> "<display name>" <out name> [point value]
"""
import json
import os
import struct
import sys
import time

import numpy as np
from compression import zstd

MAGIC = b"TAPESER1"
REC = np.dtype([("len", "u1"), ("rtype", "u1"), ("pub", "<u2"), ("id", "<u4"), ("ts", "<u8"),
                ("o", "<i8"), ("h", "<i8"), ("l", "<i8"), ("c", "<i8"), ("v", "<u8")])
UNDEF = np.iinfo(np.int64).max


def open_dbn(path):
    """Returns (stream positioned at the first record, {instrument id: symbol})."""
    f = zstd.open(path, "rb") if path.lower().endswith(".zst") else open(path, "rb")
    pre = f.read(8)
    if pre[:3] != b"DBN":
        raise SystemExit("Not a DBN file")
    version, mlen = pre[3], struct.unpack("<I", pre[4:8])[0]
    meta = f.read(mlen)
    p = 16 + 2 + 8 + 8 + 8 + (8 if version == 1 else 0) + 3
    cl = 22
    if version >= 2:
        cl = struct.unpack_from("<H", meta, p)[0]
        p += 2 + 53
    else:
        p += 47
    p += 4 + struct.unpack_from("<I", meta, p)[0]
    cs = lambda q: meta[q:q + cl].split(b"\0")[0].decode()
    for _ in range(3):
        p += 4 + struct.unpack_from("<I", meta, p)[0] * cl
    # mappings: raw symbol -> intervals of instrument ids
    raw2ids = {}
    q = p + 4
    for _ in range(struct.unpack_from("<I", meta, p)[0]):
        raw = cs(q); q += cl
        ni = struct.unpack_from("<I", meta, q)[0]; q += 4
        for _ in range(ni):
            q += 8
            sym = cs(q); q += cl
            if sym.isdigit():
                raw2ids.setdefault(raw, set()).add(int(sym))
    names = {}
    for raw, ids in raw2ids.items():
        for i in ids:
            names.setdefault(i, raw if len(ids) == 1 else f"{raw}#{i}")
    return f, names


def chunks(path, size=64 << 20):
    f, _ = open_dbn(path)
    carry = b""
    with f:
        while True:
            data = f.read(size)
            if not data:
                break
            buf = carry + data
            if buf[0] != 14:
                raise SystemExit(f"Unexpected record size {buf[0] * 4}; only OHLCV records are supported")
            usable = len(buf) - len(buf) % 56
            carry = buf[usable:]
            yield np.frombuffer(buf[:usable], dtype=REC)


def main(path, ds_id, name, out_name, point_value=None):
    t0 = time.time()
    _, names = open_dbn(path)
    spread = lambda i: "-" in names.get(i, "")
    # pass 1: volume and bar count per (day, instrument)
    vol, cnt = {}, {}
    total = 0
    for r in chunks(path):
        day = (r["ts"] // (86400 * 10**9)).astype(np.int64)
        key = (day << 32) | r["id"].astype(np.int64)
        u, inv = np.unique(key, return_inverse=True)
        vs, ns = np.bincount(inv, weights=r["v"].astype(np.float64)), np.bincount(inv)
        for k, a, b in zip(u.tolist(), vs.tolist(), ns.tolist()):
            vol[k] = vol.get(k, 0.0) + a
            cnt[k] = cnt.get(k, 0) + b
        total += len(r)
    print(f"pass 1: {total:,} records, {len(names)} named instruments, {time.time() - t0:.0f}s", flush=True)
    # the roll: each day's most-traded outright, never going back to a contract already left
    by_day = {}
    for k, v in vol.items():
        by_day.setdefault(k >> 32, []).append((v, k & 0xFFFFFFFF))
    roll, left, cur, rolls = {}, set(), None, []
    for d in sorted(by_day):
        best = max(((v, i) for v, i in by_day[d] if not spread(i) and i not in left), default=None)
        if best and best[1] != cur:
            if cur is not None:
                left.add(cur)
            cur = best[1]
            rolls.append([int(d) * 86400, names.get(cur, f"ID {cur}")])
        if cur is not None:
            roll[d] = cur
    expected = sum(cnt.get((d << 32) | i, 0) for d, i in roll.items())
    print(f"roll: {len(rolls)} contracts, {expected:,} bars expected", flush=True)

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", out_name)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    out = open(out_path + ".tmp", "wb")
    out.write(MAGIC)
    blocks, pend, cur_month = [], [], None
    dec = 0

    def flush():
        nonlocal pend
        if not pend:
            return
        cols = [np.concatenate([p[j] for p in pend]) for j in range(6)]
        # same second twice: keep the last
        t = cols[0]
        keep = np.append(t[1:] != t[:-1], True)
        cols = [c[keep] for c in cols]
        blk = {"t0": float(cols[0][0]), "t1": float(cols[0][-1]), "n": int(len(cols[0])), "cols": []}
        for c in cols:
            w = c.dtype.itemsize
            z = zstd.compress(np.ascontiguousarray(c).view(np.uint8).reshape(-1, w).T.tobytes(), 9)
            blk["cols"].append([out.tell(), len(z)])
            out.write(z)
        blocks.append(blk)
        pend = []

    # pass 2: keep the rolled contract's bars, in monthly blocks
    roll_arr_days = np.array(sorted(roll), dtype=np.int64)
    roll_arr_ids = np.array([roll[d] for d in roll_arr_days.tolist()], dtype=np.int64)
    for r in chunks(path):
        day = (r["ts"] // (86400 * 10**9)).astype(np.int64)
        pos = np.searchsorted(roll_arr_days, day)
        pos[pos >= len(roll_arr_days)] = 0
        want = np.where(roll_arr_days[pos] == day, roll_arr_ids[pos], -1)
        sel = r[(r["id"].astype(np.int64) == want) & (r["o"] != UNDEF)]
        if not len(sel):
            continue
        t = np.round(sel["ts"] / 1e9).astype(np.float64)
        o, h, l, c = ((sel[k] / 1e9).astype(np.float32) for k in ("o", "h", "l", "c"))
        h, l = np.maximum(np.maximum(h, o), c), np.minimum(np.minimum(l, o), c)
        v = sel["v"].astype(np.float32)
        if dec == 0:
            sample = np.concatenate([o[:400], c[:400]]).astype(np.float64)
            for d in range(9):
                if np.all(np.abs(sample * 10**d - np.round(sample * 10**d)) < 1e-6):
                    dec = d; break
        month = (t // 86400).astype("datetime64[D]").astype("datetime64[M]").astype(np.int64)
        cuts = np.flatnonzero(np.diff(month)) + 1
        for a, b in zip(np.r_[0, cuts], np.r_[cuts, len(t)]):
            m = int(month[a])
            if cur_month is not None and m != cur_month:
                flush()
            cur_month = m
            pend.append((t[a:b], o[a:b], h[a:b], l[a:b], c[a:b], v[a:b]))
        print(f"  pass 2: {len(blocks)} months written, {time.time() - t0:.0f}s", end="\r", flush=True)
    flush()
    n = sum(b["n"] for b in blocks)
    header = {"v": 1, "id": ds_id, "name": name, "n": n, "base": 1, "prec": max(dec, 2), "hasVol": True,
              "from": blocks[0]["t0"], "to": blocks[-1]["t1"], "contracts": len(rolls), "rolls": rolls, "blocks": blocks}
    if point_value:
        header["pointValue"] = float(point_value)
    hj = json.dumps(header).encode()
    out.write(hj + struct.pack("<I", len(hj)) + MAGIC)
    out.close()
    os.replace(out_path + ".tmp", out_path)
    print(f"\n{out_path}: {n:,} bars in {len(blocks)} monthly blocks, {os.path.getsize(out_path) / 1048576:.0f} MB, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main(*sys.argv[1:6])
