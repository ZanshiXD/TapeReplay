import CryptoKit
import Foundation

/// The app's saved data, laid out like the desktop app's data folder:
///   prefs.json, last.json
///   sessions/<id>.json, <id>.meta.json
///   optimizations/<id>.json, <id>.meta.json (strategy optimizations)
///   datasets/<id>.json (Library entry), <id>.csv (a loaded file), <id>.tapeseries (an imported DBN, in monthly
///   blocks), <id>_*.bin (parsed-series caches), <id>.census.json (contracts in a file)
///   tmp/ (picked files and uploads on their way in)
final class Storage: @unchecked Sendable {
    let root: URL
    let datasets: URL
    let sessions: URL
    let optims: URL
    let tmp: URL
    let lock = NSLock()
    private let fm = FileManager.default

    init() {
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        root = support.appendingPathComponent("TapeReplay", isDirectory: true)
        datasets = root.appendingPathComponent("datasets", isDirectory: true)
        sessions = root.appendingPathComponent("sessions", isDirectory: true)
        optims = root.appendingPathComponent("optimizations", isDirectory: true)
        tmp = root.appendingPathComponent("tmp", isDirectory: true)
        for dir in [root, datasets, sessions, optims, tmp] { try? fm.createDirectory(at: dir, withIntermediateDirectories: true) }
        // whatever an earlier run left half way (an interrupted import or upload)
        for name in (try? fm.contentsOfDirectory(atPath: tmp.path)) ?? [] { try? fm.removeItem(at: tmp.appendingPathComponent(name)) }
    }

    var prefsURL: URL { root.appendingPathComponent("prefs.json") }
    var lastURL: URL { root.appendingPathComponent("last.json") }

    func readJSON(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func writeJSON(_ object: Any, to url: URL) throws {
        try writeAtomic(JSONSerialization.data(withJSONObject: object), to: url)
    }

    func writeAtomic(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
    }

    func listJSON(in folder: URL, suffix: String) -> [[String: Any]] {
        let names = (try? fm.contentsOfDirectory(atPath: folder.path)) ?? []
        return names.filter { $0.hasSuffix(suffix) }.compactMap { readJSON(folder.appendingPathComponent($0)) }
    }

    func exists(_ url: URL) -> Bool { fm.fileExists(atPath: url.path) }

    func size(_ url: URL) -> UInt64 {
        ((try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.uint64Value ?? 0
    }

    /// Part of a file, for the page's chunked readers.
    func read(_ url: URL, from start: UInt64, length: Int) throws -> Data {
        let fh = try FileHandle(forReadingFrom: url)
        defer { try? fh.close() }
        try fh.seek(toOffset: start)
        return try fh.read(upToCount: length) ?? Data()
    }

    /// Writes a request body (in memory or already on disk) to its place.
    func put(_ request: HTTPRequest, to url: URL) throws {
        if let file = request.bodyFile {
            if exists(url) { try fm.removeItem(at: url) }
            try fm.moveItem(at: file, to: url)
        } else {
            try writeAtomic(request.body, to: url)
        }
    }

    func newTempURL(_ ext: String) -> URL {
        tmp.appendingPathComponent(String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16)) + "." + ext)
    }

    /// Adds a data file to the Library (moved in, not copied: picked files are already the app's own copies).
    /// Files up to 200 MB are named by their content, so loading the same file twice keeps one entry.
    func storeDataset(from src: URL, meta: [String: Any]) throws -> [String: Any] {
        let bytes = size(src)
        let id: String
        if bytes <= 200 << 20 {
            var hash = Insecure.SHA1()
            let fh = try FileHandle(forReadingFrom: src)
            while let block = try fh.read(upToCount: 8 << 20), !block.isEmpty { hash.update(data: block) }
            try? fh.close()
            id = String(hash.finalize().map { String(format: "%02x", $0) }.joined().prefix(16))
        } else {
            id = Self.shortID("\(meta["name"] ?? "")|\(bytes)|\(Date().timeIntervalSince1970)")
        }
        lock.lock(); defer { lock.unlock() }
        let csv = datasets.appendingPathComponent(id + ".csv")
        let metaURL = datasets.appendingPathComponent(id + ".json")
        if exists(csv) { try? fm.removeItem(at: src) } else { try fm.moveItem(at: src, to: csv) }
        if let existing = readJSON(metaURL) { return existing }
        var entry = meta
        entry["id"] = id
        entry["size"] = bytes
        entry["added"] = Int(Date().timeIntervalSince1970 * 1000)
        entry["name"] = String(String(describing: meta["name"] ?? "data.csv").prefix(200))
        try writeJSON(entry, to: metaURL)
        return entry
    }

    func deleteDataset(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        for ext in [".csv", ".json", ".census.json", ".tapeseries"] { try? fm.removeItem(at: datasets.appendingPathComponent(id + ext)) }
        for name in (try? fm.contentsOfDirectory(atPath: datasets.path)) ?? [] where name.hasPrefix(id + "_") && name.hasSuffix(".bin") {
            try? fm.removeItem(at: datasets.appendingPathComponent(name))
        }
    }

    static func shortID(_ seed: String) -> String {
        String(Insecure.SHA1.hash(data: Data(seed.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16))
    }
}
