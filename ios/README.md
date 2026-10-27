# Tape Replay for iPhone and iPad

The iOS app runs the same interface as the desktop app: the page (`tape-replay.html`) in a full-screen web view.
A native layer replaces the desktop's Python backend:

| Piece | File | What it does |
| --- | --- | --- |
| App shell | `Sources/TapeReplay/TapeReplayApp.swift` | Starts everything, saves the session when the app goes to the background |
| Web view | `Sources/TapeReplay/WebContainer.swift` | Shows the page; the system file picker |
| Touch layer | `Sources/TapeReplay/ios-shim.js` | Drawing and dragging lines by touch, long-press for the order menu, safe areas |
| Local server | `Sources/TapeReplay/Server/` | The same `/api` as the desktop app, on 127.0.0.1: sessions, preferences, the Library |
| DBN import | `Sources/TapeReplay/Data/DBNImporter.swift` | Any size of `.dbn` / `.dbn.zst` file (or a batch), streamed into monthly blocks |
| Series files | `Sources/TapeReplay/Data/SeriesFile.swift` | Monthly blocks, read one month at a time (same format as the desktop's `build_series.py`) |
| Zstandard | `Sources/TapeReplay/Data/Zstd.swift` | Reads `.zst` files, compresses the blocks (facebook/zstd via SwiftPM) |

The built-in data is generated practice data, not real market data. It is made on the device as you need it.

## Build and install with xtool (Windows)

xtool builds iOS apps without a Mac. On Windows it runs inside WSL.

On this PC, steps 1 to 6 are done (Ubuntu 26.04 in WSL, Swift 6.4.1, xtool 1.24.0, the iOS SDK). The project builds
from `~/TapeReplay-iOS` in Ubuntu (a copy of this folder, since building on the Windows drive is slow).

1. **WSL and USB.** Install WSL (Ubuntu) with `wsl --install`. Install usbipd-win so the iPhone can be attached
   to WSL over USB, and check it shows up in WSL.
2. **Swift.** Inside WSL, install Swift 6.x with swiftly (swift.org's installer). On Ubuntu 26.04 the toolchain
   (built for 24.04) also needs 24.04's `libxml2.so.2` and `libicu*.so.74`: they are kept in
   `~/.local/lib/swift-compat` and added to `LD_LIBRARY_PATH` by `~/.local/share/swiftly/env.sh`.
3. **Packages.** `sudo apt-get install usbmuxd` (plus Swift's build dependencies).
4. **Xcode.xip.** Download Xcode from Apple's developer site in a browser (it needs an Apple ID): xtool only
   takes the iOS SDK out of it. xcodes (github.com/XcodesOrg/xcodes) can also download it, but only on a Mac.
5. **xtool.** The AppImage from xtool's GitHub releases, unpacked (WSL has no FUSE) into `~/.local/opt/xtool` and
   run as `~/.local/bin/xtool`; check `xtool --help`.
6. **SDK.** `xtool sdk install /mnt/c/Users/<you>/Downloads/Xcode_<version>.xip` (no sign-in needed). After this,
   `xtool dev build` compiles the app.
7. **Sign-in, for installing on a device.** `xtool auth`: an App Store Connect API key, or an Apple ID and
   password (a free Apple ID works; xtool's docs suggest a separate one, since password sign-in uses private Apple APIs).
7. **Bundle ID.** Edit `xtool.yml` and change `com.example.TapeReplay` to your own ID (e.g. `com.yourname.tapereplay`).
8. **Copy the page in.** After any change to `tape-replay.html`, from this folder run:

   ```bash
   python3 sync_web.py
   ```

9. **Build, sign and install.** Plug in the iPhone or iPad, unlock it, and from this folder run:

   ```bash
   xtool dev
   ```

   The first build is slow (Swift builds its modules for iOS); later ones are faster. The first time, tap
   **Trust** on the device, enable Developer Mode if asked, and trust your developer certificate under
   **Settings > General > VPN & Device Management**.

With a free Apple ID the app stops opening after 7 days; run `xtool dev` again to reinstall it. Your saved sessions
and imported data stay on the device.

## Using it on a touch screen

- **Draw:** pick a tool, then tap (or tap twice for lines), or drag with one finger.
- **Move things:** drag drawings, their handles, order lines and the TP and SL buttons on a tag.
- **Pan and zoom:** drag an empty part of the chart, or pinch.
- **Order menu:** touch and hold an empty part of the chart (the right-click menu on a desktop).
- **Bottom panel:** drag its top edge to resize it.
- A keyboard on an iPad works with all the desktop shortcuts.

## Importing data

**Import** opens the system picker (Files, iCloud Drive, other apps). You can also copy files into the app's
folder in the Files app (On My iPhone > Tape Replay) and pick them from there.

- **DBN (`.dbn`, `.dbn.zst`, one file or several):** converted natively, whatever the size. The app reads the
  files twice: first to choose the contract to follow each day (the most-traded outright, never rolling back),
  then to write that contract's bars in monthly blocks. Only one month is ever in memory, and a session loads only
  the months it uses. Keep the app open while a large file imports (the screen stays on); several gigabytes take
  several minutes. The picked copy is deleted afterwards and only the compact monthly blocks are kept.
- **CSV (`.csv`, `.csv.zst`, batches):** read by the page as on the desktop. Very large CSV files may not fit in
  memory on a phone: convert them to DBN, or use a shorter date range.

A session holds at most about 12 million bars on iOS (40 million on a PC): roughly six months of busy 1-second
futures data, or well over a year of the practice data.

## What has been tested

- The data code (`Data/*.swift`: DBN importer, series files, zstd) compiles with Swift 6.4.1 on Linux and was run
  on a real 1.5 GB Databento file (MNQ, 1-second bars, 2019 to 2026): 112,459,769 bars, 90 months and 31 contract
  rolls, every month byte for byte the same as the desktop's Python-built series, in 38 seconds with at most
  172 MB of memory.
- The page and the touch layer were tested in a browser with real touch events.
- The whole app builds with `xtool dev build` (Swift 6.4.1, the iOS SDK from Xcode 27.2 RC, xtool 1.24.0) with no
  errors or warnings, into an arm64 `TapeReplay.app` with the page and touch layer in its resource bundle.
- Not yet run on a device: that needs `xtool auth` (step 7) and an iPhone or iPad over USB.
