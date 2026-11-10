"""Downloads Python for strategy backtests (Pyodide, CPython compiled to WebAssembly, with numpy and pandas) into
public/pyodide/, which the build copies into dist/ so the apps run strategies offline. Not kept in git.
    python3 scripts/fetch_pyodide.py      (or: npm run pyodide)
"""
import hashlib
import io
import json
import os
import shutil
import tarfile
import urllib.request

DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "pyodide")
# Python for strategy backtests: Pyodide (CPython compiled to WebAssembly). Keep the version in step with
# PYODIDE_VER in src/app.ts. The core comes from the GitHub release, the packages from Pyodide's CDN.
PYODIDE_VERSION = "0.27.7"
PYODIDE_CORE_URL = f"https://github.com/pyodide/pyodide/releases/download/{PYODIDE_VERSION}/pyodide-core-{PYODIDE_VERSION}.tar.bz2"
PYODIDE_CDN = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE_VERSION}/full/"
PYODIDE_CORE = ["pyodide.js", "pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]
PYODIDE_PACKAGES = ["numpy", "pandas"]  # plus what they depend on
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def vendor_pyodide():
    """public/pyodide/: the Pyodide runtime with numpy and pandas, so strategies run offline."""
    dest = DEST
    stamp = os.path.join(dest, "VERSION")
    want = PYODIDE_VERSION + " " + " ".join(PYODIDE_PACKAGES)
    if os.path.isfile(stamp) and open(stamp, encoding="utf-8").read().strip() == want:
        return
    print(f"Downloading Python (Pyodide {PYODIDE_VERSION}) for strategy backtests...")
    shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest)
    with tarfile.open(fileobj=io.BytesIO(fetch(PYODIDE_CORE_URL, 300)), mode="r:bz2") as tar:
        for name in PYODIDE_CORE:
            with open(os.path.join(dest, name), "wb") as f:
                f.write(tar.extractfile("pyodide/" + name).read())
    with open(os.path.join(dest, "pyodide-lock.json"), encoding="utf-8") as f:
        packages = json.load(f)["packages"]
    need, todo = set(), list(PYODIDE_PACKAGES)
    while todo:
        name = todo.pop()
        if name not in need:
            need.add(name)
            todo += packages[name]["depends"]
    for name in sorted(need):
        p = packages[name]
        data = fetch(PYODIDE_CDN + p["file_name"], 300)
        if hashlib.sha256(data).hexdigest() != p["sha256"]:
            raise SystemExit(f"{p['file_name']} did not match its checksum in pyodide-lock.json")
        with open(os.path.join(dest, p["file_name"]), "wb") as f:
            f.write(data)
        print("  ", p["file_name"], f"{len(data) / 1e6:.1f} MB")
    with open(stamp, "w", encoding="utf-8") as f:
        f.write(want + "\n")


if __name__ == "__main__":
    vendor_pyodide()
