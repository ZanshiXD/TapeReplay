"""Copy the app's page into the iOS app.

The iOS app shows the same page as the desktop app (tape-replay.html). This builds it the way the desktop
build does (local copies of the chart library and fonts, so it works offline) and copies the result into
Sources/TapeReplay/web. Run it after changing tape-replay.html, before `xtool dev`:
    python3 sync_web.py
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "desktop"))
import build  # noqa: E402  (desktop/build.py)

build.vendor()
build.page()
dest = os.path.join(HERE, "Sources", "TapeReplay", "web")
shutil.rmtree(dest, ignore_errors=True)
shutil.copytree(build.WEB, dest)
print("Copied", build.WEB, "to", dest)
# the app icon: the desktop app's design, full-bleed at 1024 px (iOS rounds the corners)
icon = build.png(1024, rounded=False, alpha=False)
with open(os.path.join(HERE, "Icon.png"), "wb") as f:
    f.write(icon)
# the same image in the icon catalog the App Store build compiles (AppStore/project.yml)
with open(os.path.join(HERE, "AppStore", "Assets.xcassets", "Icon.appiconset", "Icon-1024.png"), "wb") as f:
    f.write(icon)
print("Wrote Icon.png and the App Store icon")
