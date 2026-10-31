"""Importing price data in the desktop app (desktop/app.py, without its window, on any OS; Python 3.14):
Databento DBN files (v1-v3, plain, .zst and batches) go through the app's chunked import and come back as a
monthly series, compared with a continuous series worked out here; a decompressed CSV stays readable after it
joins the Library (another contract can be chosen in Session settings).
    python tests/test_import.py
"""
import datetime
import json
import os
import random
import struct
import sys
import tempfile
import threading
import time
import urllib.request
from compression import zstd

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.environ["APPDATA"] = tempfile.mkdtemp(prefix="tape-appdata-")
sys.path.insert(0, os.path.join(ROOT, "desktop"))
import app  # noqa: E402

DATA = tempfile.mkdtemp(prefix="tape-dbn-")
DAY = 86400
UNDEF = (1 << 63) - 1
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


# ---- test files: three outright contracts and a calendar spread, 1-minute bars over four months ----
def metadata(version, mappings):
    cl = 22 if version == 1 else 71
    cs = lambda s: s.encode() + b"\0" * (cl - len(s))
    m = b"GLBX.MDP3".ljust(16, b"\0") + struct.pack("<HQQQ", 1, 0, 0, 0) + (struct.pack("<Q", 0) if version == 1 else b"")
    m += bytes([1, 0, 0]) + (struct.pack("<H", cl) + b"\0" * 53 if version >= 2 else b"\0" * 47)
    m += struct.pack("<I", 0) + struct.pack("<I", 1) + cs("MNQ.FUT") + struct.pack("<II", 0, 0) + struct.pack("<I", len(mappings))
    for raw, iid in mappings:
        m += cs(raw) + struct.pack("<III", 1, 20250101, 20260101) + cs(str(iid))
    m += b"\0" * (-len(m) % 8)
    return b"DBN" + bytes([version]) + struct.pack("<I", len(m)) + m


MAPS = [("MNQH5", 1001), ("MNQM5", 1002), ("MNQU5", 1003), ("MNQH5-MNQM5", 2001)]
NAMES = {i: n for n, i in MAPS}
T0 = 1735689600  # 2025-01-01
rnd = random.Random(7)
BARS = []  # (ts ns, id, o, h, l, c, volume, no trade)
px = {1001: 21000.0, 1002: 21100.0, 1003: 21200.0, 2001: -100.0}
for d in range(120):
    day0 = T0 + d * DAY
    if (day0 // DAY + 4) % 7 in (5, 6):
        continue
    lead = 1001 if d < 40 else 1002 if d < 80 else 1003
    for mi in range(0, 1440, 7):
        for iid in (1001, 1002, 1003, 2001):
            if iid != lead and rnd.random() < 0.3:
                continue
            o = px[iid] = round((px[iid] + rnd.gauss(0, 2)) * 4) / 4
            c = round((o + rnd.gauss(0, 1.5)) * 4) / 4
            vol = (900 if iid == lead else 40) + rnd.randint(0, 50)
            vol = 5000 if (d == 85 and iid == 1001) else 300 if iid == 2001 else vol  # an old contract busy again: no roll back
            BARS.append(((day0 + mi * 60) * 10**9, iid, o, max(o, c) + 0.25, min(o, c) - 0.25, c, vol, rnd.random() < 0.02))


def rec(b):
    ts, iid, o, h, l, c, v, undef = b
    q = (lambda x: UNDEF) if undef else (lambda x: int(round(x * 1e9)))
    return struct.pack("<BBHIQqqqqQ", 14, 0x21, 1, iid, ts, q(o), q(h), q(l), q(c), v)


def write(name, bars, version=2, z=False, maps=MAPS):
    data = metadata(version, maps) + b"".join(rec(b) for b in bars)
    with open(os.path.join(DATA, name), "wb") as f:
        f.write(zstd.compress(data) if z else data)
    return os.path.join(DATA, name)


# the continuous series expected: each UTC day the most-traded outright, never rolling back
vol = {}
for ts, iid, *_, v, undef in BARS:
    vol[(ts // 10**9 // DAY, iid)] = vol.get((ts // 10**9 // DAY, iid), 0) + v
roll, left, cur, ROLLS = {}, set(), None, []
for day in sorted({d for d, _ in vol}):
    best = max(((v, i) for (d, i), v in vol.items() if d == day and "-" not in NAMES[i] and i not in left), default=None)
    if best and best[1] != cur:
        left.add(cur)
        cur = best[1]
        ROLLS.append([day * DAY, NAMES[cur]])
    roll[day] = cur
WANT = [(ts // 10**9, c, v) for ts, iid, o, h, l, c, v, undef in BARS if not undef and roll[ts // 10**9 // DAY] == iid]

months = {}
for b in BARS:
    months.setdefault(datetime.datetime.fromtimestamp(b[0] // 10**9, datetime.UTC).strftime("%Y%m"), []).append(b)
CASES = {
    "DBN v1": [write("v1.dbn", BARS, 1)], "DBN v2": [write("v2.dbn", BARS, 2)], "DBN v3": [write("v3.dbn", BARS, 3)],
    ".dbn.zst": [write("v2.dbn.zst", BARS, 2, True)],
    "batch of .dbn.zst": [write(f"glbx-{m}.ohlcv-1m.dbn.zst", bs, 2, True) for m, bs in sorted(months.items())],
}

# ---- the app's server, with the Open dialog answering with chosen paths ----
for d in (app.DATASETS, app.SESSIONS, app.OPTIMS):
    os.makedirs(d, exist_ok=True)
PICK = []
app.WINDOW = object()
app.window_handle = lambda: None
app.open_file_dialog = lambda owner: list(PICK)
srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}/api/"


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"X-Token": app.TOKEN})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if r.headers.get("Content-Type", "").startswith("application/json") and raw else raw)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def import_files(paths):
    PICK[:] = paths
    st, p = api("POST", "pick")
    check(st == 200 and p["dbn"], f"pick: {st} {p}")
    st, j = api("POST", "import", {"pick": p["id"], "name": p["name"]})
    check(st == 200, f"import: {st} {j}")
    for _ in range(600):
        st, s = api("GET", "import/" + j["job"])
        if s["state"] != "running":
            break
        time.sleep(0.05)
    check(s["state"] == "done", f"import finished: {s}")
    return s["dataset"]


def series(ds_id):
    st, ix = api("GET", "series/" + ds_id)
    check(st == 200, f"series index: {st} {ix}")
    T, C, V = [], [], []
    for i, b in enumerate(ix["blocks"]):
        st, raw = api("GET", f"series/{ds_id}/{i}")
        n = b["n"]
        T += struct.unpack_from(f"<{n}d", raw, 0)
        C += struct.unpack_from(f"<{n}f", raw, n * 8 + 3 * n * 4)
        V += struct.unpack_from(f"<{n}f", raw, n * 8 + 4 * n * 4)
    return ix, T, C, V


st, caps = api("GET", "caps")
check(caps.get("importDbn") is True, "the page is told to use the app's import")
for label, paths in CASES.items():
    meta = import_files(paths)
    ix, T, C, V = series(meta["id"])
    check(meta["chunked"] and meta["bars"] == len(WANT), f"{label}: {meta['bars']} bars, expected {len(WANT)}")
    check(ix["rolls"] == ROLLS, f"{label}: rolls {ix['rolls']}")
    check(T == [w[0] for w in WANT], f"{label}: times")
    check([round(c, 2) for c in C] == [w[1] for w in WANT] and V == [w[2] for w in WANT], f"{label}: closes and volume")
    check(ix["base"] == 60 and ix["prec"] == 2 and len(ix["blocks"]) == 4, f"{label}: base {ix['base']}, prec {ix['prec']}, {len(ix['blocks'])} months")
    check(any(d["id"] == meta["id"] for d in api("GET", "datasets")[1]), f"{label}: in the Library")
    api("DELETE", "datasets/" + meta["id"])
    check(not os.path.exists(os.path.join(app.DATASETS, meta["id"] + ".tapeseries")), f"{label}: removed with the Library entry")
    check(all(os.path.isfile(p) for p in paths), f"{label}: the chosen files are left alone")
    print(f"  {label}: {meta['bars']} bars, {len(ix['rolls'])} contracts")

# a currency future: prices like 1.08575 keep their five decimals
fx, p = [], 1.08575
for i in range(500):
    p = round((p + rnd.choice((-1, 0, 1)) * 0.00005) / 0.00005) * 0.00005
    fx.append(((T0 + i * 60) * 10**9, 3001, p, p + 0.00005, p - 0.00005, p, 100, False))
meta = import_files([write("6e.dbn", fx, maps=[("6EH5", 3001)])])
check(series(meta["id"])[0]["prec"] == 5, "6E keeps five decimals")

# errors are said plainly
PICK[:] = [os.path.join(DATA, "v2.dbn"), write("x.csv", [])]
check(api("POST", "pick")[0] == 409, "DBN and CSV files together are refused")
with open(os.path.join(DATA, "trades.dbn"), "wb") as f:
    f.write(metadata(2, MAPS) + struct.pack("<BBHIQ", 12, 0, 1, 1001, 0) + b"\0" * 32)  # an MBP-0 record (no OHLCV)
PICK[:] = [os.path.join(DATA, "trades.dbn")]
_, p = api("POST", "pick")
_, j = api("POST", "import", {"pick": p["id"], "name": p["name"]})
for _ in range(100):
    s = api("GET", "import/" + j["job"])[1]
    if s["state"] != "running":
        break
    time.sleep(0.05)
check(s["state"] == "error" and "OHLCV" in s["message"], f"a file without bars: {s}")

# a .zst CSV is decompressed for the page; once it joins the Library, the same pick still reads (now its copy)
csv = "ts_event,open,high,low,close,volume,symbol\n" + "".join(f"2025-01-02T00:{m:02d}:00Z,1,2,0.5,1.5,10,MNQH5\n" for m in range(30))
with open(os.path.join(DATA, "bars.csv.zst"), "wb") as f:
    f.write(zstd.compress(csv.encode()))
PICK[:] = [os.path.join(DATA, "bars.csv.zst")]
_, p = api("POST", "pick")
check(not p.get("dbn") and p["name"] == "bars.csv", f"csv pick: {p}")
st, meta = api("POST", "datasets/adopt", {"pick": p["id"], "meta": {"name": "bars.csv"}})
check(st == 200, f"adopt: {st} {meta}")
st, raw = api("GET", f"blob/picked/{p['id']}?start=0&len=100")
check(st == 200 and raw.startswith(b"ts_event"), f"the pick reads after joining the Library: {st} {raw[:60]}")

print(f"import: {passed} checks passed")
