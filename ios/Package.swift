// swift-tools-version: 5.9
// Tape Replay for iPhone and iPad, built with xtool (https://github.com/xtool-org/xtool).
// xtool turns this library into an app; see xtool.yml and README.md.
import PackageDescription

let package = Package(
    name: "TapeReplay",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "TapeReplay", targets: ["TapeReplay"]),
    ],
    dependencies: [
        // Zstandard: reads .dbn.zst files and compresses the monthly blocks imports are split into
        .package(url: "https://github.com/facebook/zstd", from: "1.5.6"),
    ],
    targets: [
        .target(
            name: "TapeReplay",
            dependencies: [.product(name: "libzstd", package: "zstd")],
            // web/ is the same page the desktop app shows (copied in by sync_web.py)
            resources: [.copy("web"), .copy("ios-shim.js")]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
