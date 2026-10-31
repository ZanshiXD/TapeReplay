"""Imports Databento OHLCV data (.dbn or .dbn.zst; one file or a batch read back to back) of any size.

The same import as the iOS app's (ios/Sources/TapeReplay/Data/DBNImporter.swift), so a file comes out the
same on both. The files are read twice, as a stream, so memory use does not grow with the file:
  1. volume per contract per day, to choose the contract to follow each day: the most-traded outright
     (spreads skipped), never going back to one already left;
  2. that contract's bars, written to a series file one calendar month at a time.
The page then loads only the months a session needs, so files far larger than memory work.

The series file is the format build_series.py writes and SeriesPack (app.py) reads:
    b"TAPESER1" | blocks ... | header JSON | u32 header length | b"TAPESER1"
Each block holds six columns (time f64, then open, high, low, close, volume f32), each byte-shuffled and
Zstandard-compressed. Standard library only (Python 3.14 for compression.zstd).
"""
import datetime
import json
import os
import struct
from array import array

try:
    from compression import zstd
    ZstdError = zstd.ZstdError
except ImportError:  # Python before 3.14: the app is built with 3.14; tests that never import still load app.py
    zstd, ZstdError = None, OSError

MAGIC = b"TAPESER1"
REC = 56                     # an OHLCV record: 16-byte header, open, high, low, close (i64), volume (u64)
DAY_NS = 86400 * 10**9
UNDEF = (1 << 63) - 1        # no trade in this bar
BASE = {0x20: 1, 0x21: 60, 0x22: 3600, 0x23: 86400, 0x24: 86400}  # ohlcv-1s, -1m, -1h, -1d, -eod
CHUNK = 8 << 20


class ImportError_(Exception):
    """A problem with the file, said in words the person can act on."""


def is_dbn_name(path):
    n = path.lower()
    return n.endswith(".dbn") or n.endswith(".dbn.zst")


def parse_symbols(m, version):
    """Instrument id -> symbol, from the metadata's symbol mappings (e.g. 42140864 -> MNQZ5)."""
    try:
        p = 16 + 2 + 8 + 8 + 8 + (8 if version == 1 else 0) + 3
        cl = 22
        if version >= 2:
            cl = struct.unpack_from("<H", m, p)[0]
            p += 2 + 53
        else:
            p += 47
        cstr = lambda q: m[q:q + cl].split(b"\0")[0].decode("utf-8", "replace")
        p += 4 + struct.unpack_from("<I", m, p)[0]           # schema definition
        for _ in range(3):                                   # symbols, partial, not found
            p += 4 + struct.unpack_from("<I", m, p)[0] * cl
        count = struct.unpack_from("<I", m, p)[0]
        q = p + 4
        raw2ids = {}
        for _ in range(count):
            raw = cstr(q); q += cl
            intervals = struct.unpack_from("<I", m, q)[0]; q += 4
            for _ in range(intervals):
                q += 8                                       # start and end dates
                sym = cstr(q); q += cl
                if sym.isdigit():
                    raw2ids.setdefault(raw, set()).add(int(sym))
    except (struct.error, IndexError):
        return {}                                            # contracts are shown by instrument id
    names = {}
    for raw, ids in raw2ids.items():
        for i in ids:
            names.setdefault(i, raw if len(ids) == 1 else f"{raw}#{i}")
    return names


class DBNReader:
    """One DBN file (v1 to v3, plain or .zst): its symbol table, then its OHLCV records in large chunks."""

    def __init__(self, path):
        self.path = path
        self.raw = open(path, "rb")
        self.f = zstd.ZstdFile(self.raw, "rb") if path.lower().endswith(".zst") else self.raw
        try:
            pre = self.f.read(8)
        except ZstdError:
            self.close()
            raise ImportError_(f"{os.path.basename(path)} could not be decompressed.")
        if len(pre) < 8 or pre[:3] != b"DBN":
            self.close()
            raise ImportError_(f"{os.path.basename(path)} is not a DBN file.")
        self.version = pre[3]
        if self.version > 3:
            self.close()
            raise ImportError_(f"{os.path.basename(path)} is DBN version {self.version}, which this app does not read yet.")
        mlen = struct.unpack("<I", pre[4:8])[0]
        meta = self.f.read(mlen)
        if len(meta) < mlen:
            self.close()
            raise ImportError_(f"{os.path.basename(path)} ends inside its header.")
        self.names = parse_symbols(meta, self.version)

    @property
    def consumed(self):
        """Bytes of the file on disk read so far (compressed bytes for .zst), for progress."""
        try:
            return self.raw.tell()
        except (OSError, ValueError):
            return 0

    def close(self):
        if self.f is not self.raw:
            self.f.close()
        self.raw.close()

    def chunks(self):
        """Yields bytes holding whole OHLCV records back to back (other record types are skipped)."""
        carry = b""
        try:
            while True:
                try:
                    more = self.f.read(CHUNK)
                except ZstdError:
                    raise ImportError_(f"{os.path.basename(self.path)} is damaged (it could not be decompressed).")
                buf = carry + more if carry else more
                if not buf:
                    return
                n = len(buf) // REC
                # fast path: nothing but OHLCV records (a historical OHLCV file is all of them)
                if n and buf[0:n * REC:REC] == b"\x0e" * n and set(buf[1:n * REC:REC]) <= BASE.keys():
                    used = n * REC
                    yield buf[:used] if used < len(buf) else buf
                else:
                    keep, used = [], 0
                    while used < len(buf):
                        length = buf[used] * 4
                        if length < 16:
                            raise ImportError_(f"This DBN file is damaged (a record of {length} bytes).")
                        if used + length > len(buf):
                            break
                        if length == REC and buf[used + 1] in BASE:
                            keep.append(buf[used:used + REC])
                        used += length
                    if keep:
                        yield b"".join(keep)
                carry = buf[used:]
                if not more:
                    return                      # anything left is a record cut off at the end of the file
        finally:
            self.close()


def month_of(day):
    """The calendar month (year * 12 + month - 1) of a day counted from 1970-01-01, in UTC."""
    d = datetime.date(1970, 1, 1) + datetime.timedelta(days=day)
    return d.year * 12 + d.month - 1


def shuffle(raw, width):
    # byte i of every value together: the slowly-changing high bytes then compress very well
    return b"".join(raw[j::width] for j in range(width))


class SeriesWriter:
    """Writes a series file one month at a time; only the month being written is in memory."""

    def __init__(self, path):
        self.f = open(path, "wb")
        self.f.write(MAGIC)
        self.blocks, self.bars = [], 0

    def add(self, t, o, h, l, c, v):
        if not t:
            return
        cols = []
        for col in (t, o, h, l, c, v):
            z = zstd.compress(shuffle(col.tobytes(), col.itemsize))
            cols.append([self.f.tell(), len(z)])
            self.f.write(z)
        self.blocks.append({"t0": t[0], "t1": t[-1], "n": len(t), "cols": cols})
        self.bars += len(t)

    def finish(self, header):
        hj = json.dumps(dict(header, blocks=self.blocks)).encode("utf-8")
        self.f.write(hj + struct.pack("<I", len(hj)) + MAGIC)
        self.f.close()

    def abandon(self):
        self.f.close()


def run(files, ds_id, name, output, progress=lambda f, msg: None):
    """Imports files (paths, in order) into the series file output; returns its header (without blocks)."""
    sizes = [max(1, os.path.getsize(p)) for p in files]
    total = float(sum(sizes))

    # ---- pass 1: volume per (day, contract) ----
    names, vol, rtype_seen, done = {}, {}, 0, 0
    for k, path in enumerate(files):
        reader = DBNReader(path)
        for i, n in reader.names.items():
            names.setdefault(i, n)
        for recs in reader.chunks():
            rtype_seen = rtype_seen or recs[1]
            words = memoryview(recs).cast("Q")
            get = vol.get
            for hd, ts, v in zip(words[0::7].tolist(), words[1::7].tolist(), words[6::7].tolist()):
                key = (ts // DAY_NS) << 32 | hd >> 32
                vol[key] = get(key, 0) + v
            progress((done + reader.consumed) / total * 0.45, f"Reading file {k + 1} of {len(files)} (pass 1 of 2)")
        done += sizes[k]
    if not rtype_seen:
        raise ImportError_("No price bars found. Import Databento OHLCV files (ohlcv-1s, -1m, -1h or -1d).")
    base = BASE.get(rtype_seen, 1)

    # ---- the roll: each day's most-traded outright, never going back to a contract already left ----
    by_day = {}
    for key, v in vol.items():
        by_day.setdefault(key >> 32, []).append((v, key & 0xFFFFFFFF))
    vol = None
    spread = lambda i: "-" in names.get(i, "")
    roll, left, cur, rolls = {}, set(), None, []
    for day in sorted(by_day):
        # equal volume: the higher id, as the iOS app does, so the same file always rolls the same way
        best = max(((v, i) for v, i in by_day[day] if not spread(i) and i not in left), default=None)
        if best and best[1] != cur:
            if cur is not None:
                left.add(cur)
            cur = best[1]
            rolls.append([day * 86400, names.get(cur, f"ID {cur}")])
        if cur is not None:
            roll[day] = cur
    by_day = None

    # ---- pass 2: the followed contract's bars, a month at a time ----
    partial = output + ".part"
    writer = SeriesWriter(partial)
    try:
        T, O, H, L, C, V = array("d"), array("f"), array("f"), array("f"), array("f"), array("f")
        month, last_day, wanted, day_month = None, None, None, None
        sample = []

        def flush():
            nonlocal T, O, H, L, C, V
            if not T:
                return
            # the same second twice (overlapping files in a batch): keep the later bar
            n = len(T)
            if any(T[i] == T[i + 1] for i in range(n - 1)):
                keep = [i for i in range(n) if i + 1 == n or T[i + 1] != T[i]]
                T, O, H, L, C, V = (array(a.typecode, [a[i] for i in keep]) for a in (T, O, H, L, C, V))
            writer.add(T, O, H, L, C, V)
            T, O, H, L, C, V = array("d"), array("f"), array("f"), array("f"), array("f"), array("f")

        done = 0
        for k, path in enumerate(files):
            reader = DBNReader(path)
            for recs in reader.chunks():
                u = memoryview(recs).cast("Q")
                s = memoryview(recs).cast("q")
                hds, tss = u[0::7].tolist(), u[1::7].tolist()
                ops, hps, lps, cps, vs = s[2::7].tolist(), s[3::7].tolist(), s[4::7].tolist(), s[5::7].tolist(), u[6::7].tolist()
                for i, ts in enumerate(tss):
                    day = ts // DAY_NS
                    if day != last_day:
                        last_day, wanted, day_month = day, roll.get(day), month_of(day)
                    if wanted is None or hds[i] >> 32 != wanted:
                        continue
                    op = ops[i]
                    if op == UNDEF:
                        continue
                    if day_month != month:
                        flush()
                        month = day_month
                    cp = cps[i]
                    o, c = op / 1e9, cp / 1e9
                    T.append((ts + 500_000_000) // 1_000_000_000)
                    O.append(o)
                    H.append(max(hps[i] / 1e9, o, c))
                    L.append(min(lps[i] / 1e9, o, c))
                    C.append(c)
                    V.append(vs[i])
                    if len(sample) < 800:
                        sample += (o, c)
                progress(0.45 + (done + reader.consumed) / total * 0.55, f"Writing months: {len(writer.blocks)} done (pass 2 of 2)")
            done += sizes[k]
        flush()
        if not writer.bars:
            raise ImportError_("No bars to keep: the file has no outright contracts with trades.")

        # price decimals, from the first bars (exact prices, not their float32 copies)
        decimals = 2
        for d in range(9):
            if all(abs(x * 10**d - round(x * 10**d)) < 1e-6 for x in sample):
                decimals = max(d, 2)
                break
        header = {"v": 1, "id": ds_id, "name": name, "n": writer.bars, "base": base, "prec": decimals, "hasVol": True,
                  "from": writer.blocks[0]["t0"], "to": writer.blocks[-1]["t1"], "contracts": len(rolls), "rolls": rolls}
        writer.finish(header)
    except BaseException:
        writer.abandon()
        try:
            os.remove(partial)
        except OSError:
            pass
        raise
    os.replace(partial, output)
    progress(1.0, "Done")
    return header
