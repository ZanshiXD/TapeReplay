"""Write the signed update manifest (latest.json) for a built TapeReplay.exe.

The app downloads latest.json from the public releases repository, checks its signature against the public
key in app.py, and installs the EXE only if its size and SHA-256 match. Used by the Windows release workflow:

    TAPE_SIGNING_KEY=<base64 Ed25519 private key> python release.py 1.2.0 dist/TapeReplay.exe notes.txt out/latest.json

The signing key is a GitHub secret (UPDATE_SIGNING_KEY); a backup lives outside the project, never in git.
"""
import base64
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app  # noqa: E402  (for the manifest format and the public key the app checks against)

RELEASES = "https://github.com/ZanshiXD/TapeReplay-releases/releases/download"


def main():
    version, exe, notes_path, out = sys.argv[1:5]
    version = version.lstrip("v")
    data = open(exe, "rb").read()
    notes = open(notes_path, encoding="utf-8").read().strip() if os.path.isfile(notes_path) else ""
    manifest = {"version": version, "url": f"{RELEASES}/v{version}/TapeReplay.exe", "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "notes": notes or "Fixes and improvements."}
    key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(os.environ["TAPE_SIGNING_KEY"].strip()))
    doc = {"manifest": manifest, "sig": base64.b64encode(key.sign(app.manifest_bytes(manifest))).decode()}
    app.verify_manifest(doc)  # the key must match the one built into the app, or every update would be refused
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
    print(f"Signed {version}: {len(data):,} bytes, sha256 {manifest['sha256']}")


if __name__ == "__main__":
    main()
