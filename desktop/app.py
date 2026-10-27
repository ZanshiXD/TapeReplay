"""Tape Replay desktop app.

Serves the replay UI from a private localhost server and opens it in a native
window. Data files and backtests are stored under %APPDATA%\\TapeReplay.
"""
import ctypes
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import struct
import subprocess
import sys
import threading
import time
import webbrowser
from ctypes import wintypes
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

APP_NAME = "TapeReplay"
DATA_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), APP_NAME)
DATASETS = os.path.join(DATA_DIR, "datasets")
SESSIONS = os.path.join(DATA_DIR, "sessions")
BUNDLE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(BUNDLE, "web")
PACK_DIR = os.path.join(BUNDLE, "data")  # price data shipped inside the EXE (build_pack.py)
TOKEN = secrets.token_urlsafe(24)
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LOCK = threading.Lock()
WINDOW = None  # the pywebview window, used for the native file dialog
PICKED = {}    # id -> path of a file chosen in the dialog, served to the page in chunks
CHUNK = 8 << 20
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".ico": "image/x-icon"}


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def read_json(path):
    with open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


class OPENFILENAMEW(ctypes.Structure):
    _fields_ = [("lStructSize", wintypes.DWORD), ("hwndOwner", wintypes.HWND), ("hInstance", wintypes.HINSTANCE),
                ("lpstrFilter", wintypes.LPCWSTR), ("lpstrCustomFilter", wintypes.LPWSTR), ("nMaxCustFilter", wintypes.DWORD),
                ("nFilterIndex", wintypes.DWORD), ("lpstrFile", wintypes.LPWSTR), ("nMaxFile", wintypes.DWORD),
                ("lpstrFileTitle", wintypes.LPWSTR), ("nMaxFileTitle", wintypes.DWORD), ("lpstrInitialDir", wintypes.LPCWSTR),
                ("lpstrTitle", wintypes.LPCWSTR), ("Flags", wintypes.DWORD), ("nFileOffset", wintypes.WORD),
                ("nFileExtension", wintypes.WORD), ("lpstrDefExt", wintypes.LPCWSTR), ("lCustData", wintypes.LPARAM),
                ("lpfnHook", ctypes.c_void_p), ("lpTemplateName", wintypes.LPCWSTR), ("pvReserved", ctypes.c_void_p),
                ("dwReserved", wintypes.DWORD), ("FlagsEx", wintypes.DWORD)]


def open_file_dialog(owner):
    """Windows' standard Open dialog, several files allowed. Safe to call from any thread, unlike the WinForms one.
    Returns a list of paths (empty when cancelled)."""
    ctypes.windll.ole32.CoInitializeEx(None, 2)  # the dialog needs a single-threaded COM apartment
    path = ctypes.create_unicode_buffer(1 << 20)
    filt = ctypes.create_unicode_buffer("Price data (*.csv;*.txt;*.tsv;*.dbn;*.zst)\0*.csv;*.txt;*.tsv;*.dbn;*.zst\0All files (*.*)\0*.*\0\0")
    ofn = OPENFILENAMEW()
    ofn.lStructSize = ctypes.sizeof(ofn)
    ofn.hwndOwner = owner
    ofn.lpstrFilter = ctypes.cast(filt, wintypes.LPCWSTR)
    ofn.lpstrFile = ctypes.cast(path, wintypes.LPWSTR)
    ofn.nMaxFile = len(path)
    ofn.lpstrTitle = "Load price data (select several files to combine them)"
    # explorer style, several files, file and path must exist, keep cwd
    ofn.Flags = 0x00080000 | 0x00000200 | 0x00001000 | 0x00000800 | 0x00000008
    if not ctypes.windll.comdlg32.GetOpenFileNameW(ctypes.byref(ofn)):
        return []
    items = path[:].split("\0\0")[0].split("\0")  # one path, or a folder followed by file names
    return items if len(items) == 1 else sorted(os.path.join(items[0], f) for f in items[1:])


def copy_as_csv(src, out):
    """Append one data file to an open output file: .zst is decompressed, UTF-16 text converted to UTF-8,
    anything else (UTF-8 text, binary DBN) copied as it is."""
    if src.lower().endswith(".zst"):
        from compression import zstd
        f = zstd.open(src, "rb")
    else:
        f = open(src, "rb")
    with f:
        head = f.read(4)
        if head[:2] in (b"\xff\xfe", b"\xfe\xff") or (len(head) == 4 and head[1:2] == b"\x00" and head[3:4] == b"\x00"):
            enc = "utf-16" if head[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-16-le"
            text = io.TextIOWrapper(io.BufferedReader(_Prefixed(head, f)), encoding=enc, newline="")
            last = ""
            for block in iter(lambda: text.read(CHUNK // 4), ""):
                out.write(block.encode("utf-8"))
                last = block[-1:]
            return last
        if head[:3] == b"\xef\xbb\xbf":
            head = head[3:]
        out.write(head)
        last = head[-1:]
        for block in iter(lambda: f.read(CHUNK), b""):
            out.write(block)
            last = block[-1:]
        return last.decode("latin-1")


class _Prefixed(io.RawIOBase):
    """A stream that first yields bytes already read, then the rest of the file."""
    def __init__(self, head, f):
        self.head, self.f = head, f

    def readable(self):
        return True

    def readinto(self, b):
        if self.head:
            n = min(len(b), len(self.head))
            b[:n] = self.head[:n]
            self.head = self.head[n:]
            return n
        data = self.f.read(len(b))
        b[:len(data)] = data
        return len(data)


def tmp_dir():
    d = os.path.join(DATA_DIR, "tmp")
    os.makedirs(d, exist_ok=True)
    return d


LINK_OVER = 200 << 20  # larger files stay where they are; the library points at them


def dataset_path(ds_id):
    """The CSV behind a library entry: its own copy, or the original file for linked entries."""
    own = os.path.join(DATASETS, ds_id + ".csv")
    if os.path.isfile(own):
        return own
    mp = os.path.join(DATASETS, ds_id + ".json")
    if os.path.isfile(mp):
        return read_json(mp).get("linked")
    return None


def store_dataset(src, meta, move):
    """Add a CSV file to the library without holding it in memory. Returns its metadata."""
    size = os.path.getsize(src)
    link = not move and size > LINK_OVER and not os.path.abspath(src).startswith(os.path.abspath(tmp_dir()))
    if link:
        # hashing gigabytes would be slow; path, size and modified time identify the file
        ds_id = hashlib.sha1(f"{os.path.abspath(src)}|{size}|{os.path.getmtime(src)}".encode()).hexdigest()[:16]
    else:
        h = hashlib.sha1()
        with open(src, "rb") as f:
            for block in iter(lambda: f.read(CHUNK), b""):
                h.update(block)
        ds_id = h.hexdigest()[:16]
    with LOCK:
        csv_path = os.path.join(DATASETS, ds_id + ".csv")
        if link:
            meta = dict(meta, linked=os.path.abspath(src))
        elif not os.path.isfile(csv_path):
            if move or os.path.abspath(src).startswith(os.path.abspath(tmp_dir())):
                os.replace(src, csv_path)
            else:
                shutil.copyfile(src, csv_path + ".tmp")
                os.replace(csv_path + ".tmp", csv_path)
        elif move:
            os.remove(src)
        meta_path = os.path.join(DATASETS, ds_id + ".json")
        if os.path.isfile(meta_path):
            return read_json(meta_path)  # same file loaded before: keep the original entry
        meta = dict(meta, id=ds_id, size=size, added=int(time.time() * 1000), name=str(meta.get("name") or "data.csv")[:200])
        write_atomic(meta_path, json.dumps(meta).encode("utf-8"))
    return meta


def install_builtin():
    """Unpack the data shipped inside the EXE into the Library, once per PC.
    The pack holds a parsed series (byte-shuffled, zstd-compressed columns); it becomes
    the same cache file the page writes after reading a CSV."""
    if not os.path.isdir(PACK_DIR):
        return
    from compression import zstd
    for fn in sorted(os.listdir(PACK_DIR)):
        if not fn.endswith(".tapepack"):
            continue
        try:
            with open(os.path.join(PACK_DIR, fn), "rb") as f:
                if f.read(9) != b"TAPEPACK1":
                    continue
                meta = json.loads(f.read(struct.unpack("<I", f.read(4))[0]))
                ds_id = meta["id"]
                meta_path = os.path.join(DATASETS, ds_id + ".json")
                have_cache = any(n.startswith(ds_id + "_") and n.endswith(".bin") for n in os.listdir(DATASETS))
                if os.path.isfile(meta_path) and have_cache:
                    continue  # already in this PC's Library
                series = meta.pop("series")
                bin_path = os.path.join(DATASETS, ds_id + "_all.bin")
                hj = json.dumps(series).encode()
                with open(bin_path + ".tmp", "wb") as out:
                    out.write(struct.pack("<I", len(hj)) + hj + b"\0" * ((4 + len(hj) + 7) // 8 * 8 - 4 - len(hj)))
                    for _ in range(6):
                        width, size = struct.unpack("<BQ", f.read(9))
                        shuffled = zstd.decompress(f.read(size))
                        n = len(shuffled) // width
                        col = bytearray(len(shuffled))
                        for i in range(width):
                            col[i::width] = shuffled[i * n:(i + 1) * n]
                        out.write(col)
                os.replace(bin_path + ".tmp", bin_path)
            if not os.path.isfile(meta_path):
                meta.update(builtin=True, size=os.path.getsize(bin_path), added=int(time.time() * 1000))
                write_atomic(meta_path, json.dumps(meta).encode("utf-8"))
            # on a fresh install, open it at launch with sensible futures defaults
            pp = os.path.join(DATA_DIR, "prefs.json")
            prefs = read_json(pp) if os.path.isfile(pp) else {}
            if not prefs.get("defaultDs"):
                prefs["defaultDs"] = {"id": ds_id}
                if "cfg" not in prefs and meta.get("pointValue"):
                    prefs["cfg"] = {"pv": meta["pointValue"], "qty": 1, "spread": 0, "ticks": 4}
                write_atomic(pp, json.dumps(prefs).encode("utf-8"))
            log(f"installed built-in data {fn}")
        except Exception:
            import traceback
            log(f"could not install built-in data {fn}\n{traceback.format_exc()}")


SERIES = {}  # id -> SeriesPack: long built-in series, read a month at a time


class SeriesPack:
    """A .tapeseries (see build_series.py): monthly blocks of byte-shuffled, zstd-compressed columns.
    Lives inside the EXE as a Windows resource (read in place, never unpacked) or, while developing, as a file."""

    def __init__(self, read, size):
        self.read, self.size = read, size
        tail = read(size - 12, 12)
        if tail[4:] != b"TAPESER1":
            raise ValueError("not a series pack")
        hlen = struct.unpack("<I", tail[:4])[0]
        self.header = json.loads(read(size - 12 - hlen, hlen))

    def index(self):
        h = dict(self.header)
        h["blocks"] = [{"t0": b["t0"], "t1": b["t1"], "n": b["n"]} for b in h["blocks"]]
        return h

    def block(self, i):
        """One month as raw columns: time f64, then open/high/low/close/volume f32."""
        from compression import zstd
        out = bytearray()
        for off, size in self.header["blocks"][i]["cols"]:
            shuffled = zstd.decompress(self.read(off, size))
            width = 8 if not out else 4
            n = len(shuffled) // width
            col = bytearray(len(shuffled))
            for j in range(width):
                col[j::width] = shuffled[j * n:(j + 1) * n]
            out += col
        return bytes(out)


def exe_resource_packs():
    """Series packs embedded in this EXE (resource type TAPEDATA, names SERIES1, SERIES2, ...)."""
    if not getattr(sys, "frozen", False):
        return []
    k32 = ctypes.windll.kernel32
    k32.FindResourceW.restype = ctypes.c_void_p
    k32.FindResourceW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p)
    k32.LoadResource.restype = ctypes.c_void_p
    k32.LoadResource.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
    k32.LockResource.restype = ctypes.c_void_p
    k32.LockResource.argtypes = (ctypes.c_void_p,)
    k32.SizeofResource.restype = ctypes.c_uint32
    k32.SizeofResource.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
    packs = []
    for i in range(1, 21):
        res = k32.FindResourceW(None, f"SERIES{i}", "TAPEDATA")
        if not res:
            break
        base, size = k32.LockResource(k32.LoadResource(None, res)), k32.SizeofResource(None, res)
        packs.append(SeriesPack(lambda off, n, b=base: ctypes.string_at(b + off, n), size))
    return packs


def file_packs():
    packs = []
    if os.path.isdir(PACK_DIR):
        for fn in sorted(os.listdir(PACK_DIR)):
            if fn.endswith(".tapeseries"):
                path = os.path.join(PACK_DIR, fn)
                def read(off, n, path=path):
                    with open(path, "rb") as f:
                        f.seek(off)
                        return f.read(n)
                packs.append(SeriesPack(read, os.path.getsize(path)))
    return packs


def register_series():
    """List each built-in series in the Library, and open it at launch on a fresh install."""
    for pack in exe_resource_packs() + file_packs():
        try:
            h = pack.header
            SERIES[h["id"]] = pack
            meta_path = os.path.join(DATASETS, h["id"] + ".json")
            if not os.path.isfile(meta_path):
                meta = {"id": h["id"], "name": h["name"], "bars": h["n"], "base": h["base"], "from": h["from"], "to": h["to"],
                        "contracts": h.get("contracts", 1), "size": pack.size, "added": int(time.time() * 1000),
                        "builtin": True, "chunked": True}
                write_atomic(meta_path, json.dumps(meta).encode("utf-8"))
            pp = os.path.join(DATA_DIR, "prefs.json")
            prefs = read_json(pp) if os.path.isfile(pp) else {}
            default = (prefs.get("defaultDs") or {}).get("id")
            if not default or not os.path.isfile(os.path.join(DATASETS, default + ".json")):
                prefs["defaultDs"] = {"id": h["id"]}
                if "cfg" not in prefs and h.get("pointValue"):
                    prefs["cfg"] = {"pv": h["pointValue"], "qty": 1, "spread": 0, "ticks": 4}
                write_atomic(pp, json.dumps(prefs).encode("utf-8"))
        except Exception:
            import traceback
            log(f"could not register a built-in series\n{traceback.format_exc()}")


def window_handle():
    try:
        return int(WINDOW.native.Handle.ToInt64())
    except Exception:
        return None


def list_json(folder, suffix):
    out = []
    for name in os.listdir(folder):
        if name.endswith(suffix):
            try:
                out.append(read_json(os.path.join(folder, name)))
            except (OSError, ValueError):
                pass
    return out


def log(msg):
    try:
        with open(os.path.join(DATA_DIR, "log.txt"), "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg.rstrip() + "\n")
    except OSError:
        pass


class ExclusiveServer(ThreadingHTTPServer):
    """Owns its port outright. The stock server sets SO_REUSEADDR, which on Windows lets a second copy of the
    app bind the same port, so its window could end up talking to the first copy's server."""
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except Exception:
            import traceback
            log(f"error handling {getattr(self, 'command', '?')} {getattr(self, 'path', '?')}\n{traceback.format_exc()}")
            raise

    def send(self, code, body=b"", ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code, msg):
        self.send(code, msg, "text/plain; charset=utf-8")

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def route(self):
        """Split /api/<kind>/<id>/<extra>; None for static paths. Checks the token."""
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return None
        if not secrets.compare_digest(self.headers.get("X-Token", ""), TOKEN):
            self.fail(403, "Forbidden")
            return False
        parts = [p for p in path[5:].split("/") if p]
        if any(not ID_RE.match(p) for p in parts[1:]):
            self.fail(400, "Bad id")
            return False
        return parts

    # ---- static files ----
    def static(self):
        rel = unquote(urlparse(self.path).path).lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(os.path.realpath(WEB_DIR) + os.sep) or not os.path.isfile(full):
            return self.fail(404, "Not found")
        with open(full, "rb") as f:
            data = f.read()
        self.send(200, data, MIME.get(os.path.splitext(full)[1], "application/octet-stream"))

    # ---- api ----
    def do_GET(self):
        parts = self.route()
        if parts is None:
            return self.static()
        if parts is False:
            return
        if parts == ["sessions"]:
            return self.send(200, list_json(SESSIONS, ".meta.json"))
        if parts == ["datasets"]:
            return self.send(200, [m for m in list_json(DATASETS, ".json") if "id" in m and "list" not in m])
        if parts == ["caps"]:
            return self.send(200, {"pick": WINDOW is not None})
        if parts and parts[0] == "series" and len(parts) in (2, 3):
            pack = SERIES.get(parts[1])
            if not pack:
                return self.fail(404, "That built-in data is not in this version of the app.")
            if len(parts) == 2:
                return self.send(200, pack.index())
            i = int(parts[2]) if parts[2].isdigit() else -1
            if not 0 <= i < len(pack.header["blocks"]):
                return self.fail(404, "No such block")
            return self.send(200, pack.block(i), "application/octet-stream")
        if len(parts) == 3 and parts[0] in ("blob", "stat"):
            # one chunk of (or the size of) a picked file, a library data file or a parsed-series cache
            kind, bid = parts[1], parts[2]
            path = (PICKED.get(bid) if kind == "picked" else dataset_path(bid) if kind == "dataset"
                    else os.path.join(DATASETS, bid + ".bin") if kind == "cache" else None)
            if not path or not os.path.isfile(path):
                if kind == "dataset" and path:
                    return self.fail(404, f"The original file is no longer at {path}. Load it again.")
                return self.fail(404, "That file is no longer available. Load it again.")
            if parts[0] == "stat":
                return self.send(200, {"size": os.path.getsize(path)})
            q = parse_qs(urlparse(self.path).query)
            start, length = int(q.get("start", ["0"])[0]), min(int(q.get("len", [str(CHUNK)])[0]), 64 << 20)
            with open(path, "rb") as f:
                f.seek(start)
                return self.send(200, f.read(length), "application/octet-stream")
        if parts == ["prefs"]:
            p = os.path.join(DATA_DIR, "prefs.json")
            return self.send(200, read_json(p) if os.path.isfile(p) else {})
        if len(parts) == 2 and parts[0] == "census":
            p = os.path.join(DATASETS, parts[1] + ".census.json")
            if not os.path.isfile(p):
                return self.fail(404, "No contract list yet")
            with open(p, "rb") as f:
                return self.send(200, f.read())
        if parts == ["last"]:
            p = os.path.join(DATA_DIR, "last.json")
            last = read_json(p) if os.path.isfile(p) else {}
            if last.get("id") and not os.path.isfile(os.path.join(SESSIONS, last["id"] + ".json")):
                last = {}
            return self.send(200, last)
        if len(parts) == 2 and parts[0] == "sessions":
            p = os.path.join(SESSIONS, parts[1] + ".json")
            if not os.path.isfile(p):
                return self.fail(404, "That backtest no longer exists.")
            with open(p, "rb") as f:
                return self.send(200, f.read())
        if len(parts) == 3 and parts[0] == "datasets" and parts[2] == "csv":
            p = os.path.join(DATASETS, parts[1] + ".csv")
            if not os.path.isfile(p):
                return self.fail(404, "That data file no longer exists.")
            with open(p, "rb") as f:
                return self.send(200, f.read(), "text/plain; charset=utf-8")
        self.fail(404, "Not found")

    def do_POST(self):
        parts = self.route()
        if not parts:
            return None if parts is False else self.fail(404, "Not found")
        if parts == ["pick"]:
            # native open dialog; the file is read here rather than by the web view
            if WINDOW is None:
                return self.fail(501, "No file dialog available")
            paths = open_file_dialog(window_handle())
            if not paths:
                return self.send(204)
            path, name = paths[0], os.path.basename(paths[0])
            try:
                for p in paths:  # fail early, naming the file Windows will not open
                    name = os.path.basename(p)
                    with open(p, "rb") as f:
                        f.read(1)
                if len(paths) > 1 or path.lower().endswith(".zst"):
                    # several files (a batch download) become one, as do compressed ones
                    out = os.path.join(tmp_dir(), secrets.token_hex(8) + ".csv")
                    with open(out, "wb") as of:
                        for p in paths:
                            name = os.path.basename(p)
                            last = copy_as_csv(p, of)
                            # binary DBN files are joined as they are; the page reads each file's own header
                            if not p.lower().endswith((".dbn", ".dbn.zst")) and last not in ("\n", "\r", ""):
                                of.write(b"\n")
                    first = os.path.basename(paths[0])
                    first = first[:-4] if first.lower().endswith(".zst") else first
                    path, name = out, first if len(paths) == 1 else f"{first} + {len(paths) - 1} more"
                else:
                    name = os.path.basename(path)
            except PermissionError:
                return self.fail(409, f"Windows would not let the app open {name}. If it is open in Excel or another program, close it there and try again.")
            except OSError as e:
                return self.fail(409, f"Could not open {name}: {e.strerror or e}. If it is a OneDrive file, right-click it and choose Always keep on this device.")
            except Exception as e:
                return self.fail(409, f"Could not decompress {name}: {e}")
            pick_id = secrets.token_hex(8)
            PICKED[pick_id] = path
            return self.send(200, {"id": pick_id, "name": name, "size": os.path.getsize(path)})
        if parts == ["datasets", "adopt"]:
            # add a file chosen in the dialog to the library
            try:
                req = json.loads(self.body().decode("utf-8"))
            except ValueError:
                return self.fail(400, "Bad JSON")
            src = PICKED.get(str(req.get("pick")))
            if not src or not os.path.isfile(src):
                return self.fail(404, "That file is no longer available. Load it again.")
            return self.send(200, store_dataset(src, req.get("meta") or {}, move=False))
        if parts == ["datasets"]:
            # upload (drag and drop): streamed to disk, never held in memory
            try:
                meta = json.loads(unquote(self.headers.get("X-Meta", "{}")))
            except ValueError:
                meta = {}
            left = int(self.headers.get("Content-Length") or 0)
            tmp = os.path.join(tmp_dir(), secrets.token_hex(8) + ".csv")
            with open(tmp, "wb") as f:
                while left > 0:
                    block = self.rfile.read(min(CHUNK, left))
                    if not block:
                        break
                    f.write(block)
                    left -= len(block)
            return self.send(200, store_dataset(tmp, meta, move=True))
        self.fail(404, "Not found")

    def do_PUT(self):
        parts = self.route()
        if not parts:
            return None if parts is False else self.fail(404, "Not found")
        if len(parts) == 2 and parts[0] == "cache":
            # parsed series (binary), streamed to disk
            left = int(self.headers.get("Content-Length") or 0)
            dest = os.path.join(DATASETS, parts[1] + ".bin")
            with open(dest + ".tmp", "wb") as f:
                while left > 0:
                    block = self.rfile.read(min(CHUNK, left))
                    if not block:
                        break
                    f.write(block)
                    left -= len(block)
            if left:
                os.remove(dest + ".tmp")
                return self.fail(400, "Upload was cut short")
            os.replace(dest + ".tmp", dest)
            return self.send(200, {"ok": True})
        if len(parts) == 2 and parts[0] == "census":
            raw = self.body()
            write_atomic(os.path.join(DATASETS, parts[1] + ".census.json"), raw)
            return self.send(200, {"ok": True})
        if parts == ["prefs"]:
            raw = self.body()
            try:
                json.loads(raw.decode("utf-8"))
            except ValueError:
                return self.fail(400, "Bad JSON")
            with LOCK:
                write_atomic(os.path.join(DATA_DIR, "prefs.json"), raw)
            return self.send(200, {"ok": True})
        if len(parts) == 2 and parts[0] == "sessions":
            raw = self.body()
            try:
                doc = json.loads(raw.decode("utf-8"))
            except ValueError:
                return self.fail(400, "Bad JSON")
            meta = {k: doc.get(k) for k in ("id", "name", "datasetId", "datasetName", "created", "updated", "status", "tf", "summary")}
            meta["id"] = parts[1]
            with LOCK:
                existing = os.path.join(SESSIONS, parts[1] + ".meta.json")
                if os.path.isfile(existing):
                    # a rename from the Library wins over the name the page last knew
                    old = read_json(existing)
                    if old.get("renamed"):
                        meta["name"] = doc["name"] = old["name"]
                        meta["renamed"] = True
                        raw = json.dumps(doc).encode("utf-8")
                write_atomic(os.path.join(SESSIONS, parts[1] + ".json"), raw)
                write_atomic(existing, json.dumps(meta).encode("utf-8"))
                write_atomic(os.path.join(DATA_DIR, "last.json"), json.dumps({"id": parts[1]}).encode("utf-8"))
            return self.send(200, {"ok": True})
        self.fail(404, "Not found")

    def do_PATCH(self):
        parts = self.route()
        if not parts:
            return None if parts is False else self.fail(404, "Not found")
        if len(parts) == 2 and parts[0] == "sessions":
            try:
                name = str(json.loads(self.body().decode("utf-8")).get("name", "")).strip()[:200]
            except ValueError:
                return self.fail(400, "Bad JSON")
            if not name:
                return self.fail(400, "Name is empty")
            with LOCK:
                mp, fp = (os.path.join(SESSIONS, parts[1] + s) for s in (".meta.json", ".json"))
                if not os.path.isfile(mp):
                    return self.fail(404, "That backtest no longer exists.")
                meta, doc = read_json(mp), read_json(fp)
                meta["name"] = doc["name"] = name
                meta["renamed"] = True
                write_atomic(fp, json.dumps(doc).encode("utf-8"))
                write_atomic(mp, json.dumps(meta).encode("utf-8"))
            return self.send(200, {"ok": True})
        self.fail(404, "Not found")

    def do_DELETE(self):
        parts = self.route()
        if not parts:
            return None if parts is False else self.fail(404, "Not found")
        if len(parts) == 2 and parts[0] in ("sessions", "datasets"):
            folder = SESSIONS if parts[0] == "sessions" else DATASETS
            exts = (".json", ".meta.json") if parts[0] == "sessions" else (".csv", ".json", ".census.json")
            with LOCK:
                for ext in exts:
                    p = os.path.join(folder, parts[1] + ext)
                    if os.path.isfile(p):
                        os.remove(p)
                if parts[0] == "datasets":  # parsed-series caches; a linked original file is never touched
                    for name in os.listdir(DATASETS):
                        if name.startswith(parts[1] + "_") and name.endswith(".bin"):
                            os.remove(os.path.join(DATASETS, name))
            return self.send(200, {"ok": True})
        self.fail(404, "Not found")


def find_edge():
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            p = os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")
            if os.path.isfile(p):
                return p
    return shutil.which("msedge")


def main():
    for d in (DATASETS, SESSIONS):
        os.makedirs(d, exist_ok=True)
    shutil.rmtree(os.path.join(DATA_DIR, "tmp"), ignore_errors=True)  # leftovers from decompressed .zst files
    install_builtin()
    register_series()
    # the same port each launch keeps the page's own small preferences (it is a different site per port);
    # a second copy of the app falls back to any free port
    try:
        server = ExclusiveServer(("127.0.0.1", 47613), Handler)
    except OSError:
        server = ExclusiveServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/index.html?t={TOKEN}"

    global WINDOW
    try:
        import webview
        window = WINDOW = webview.create_window("Tape Replay", url, width=1480, height=920, min_size=(1000, 640),
                                       background_color="#0c1016", text_select=True)

        flushed = threading.Event()

        def flush_then_close():
            # evaluate_js needs the UI thread, so it runs here while the close is held back;
            # if the page never loaded it would wait forever, so give it a few seconds at most
            def flush():
                try:
                    window.evaluate_js("window.__tapeFlush && window.__tapeFlush()")
                except Exception:
                    pass
            t = threading.Thread(target=flush, daemon=True)
            t.start()
            t.join(3)
            flushed.set()
            window.destroy()

        def on_closing():
            if flushed.is_set():
                return True
            threading.Thread(target=flush_then_close, daemon=True).start()
            return False

        window.events.closing += on_closing
        webview.start(private_mode=False, storage_path=os.path.join(DATA_DIR, "webview"))
        return
    except Exception:
        pass

    # Fallback: Microsoft Edge in app mode, or the default browser.
    edge = find_edge()
    if edge:
        profile = os.path.join(DATA_DIR, "edge-profile")
        subprocess.Popen([edge, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run",
                          "--window-size=1480,920"]).wait()
    else:
        webbrowser.open(url)
        while True:
            time.sleep(3600)


if __name__ == "__main__":
    main()
