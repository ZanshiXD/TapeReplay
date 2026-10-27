import Foundation
import Security

/// The page's backend: the same /api the desktop app's Python server offers (sessions, prefs, the Library,
/// file reads in chunks, series blocks), plus the native picker and the chunked DBN import.
final class AppServer: @unchecked Sendable {
    let storage: Storage
    let token: String
    private var http: HTTPServer!
    private let web: URL?
    private let lock = NSLock()
    private var picked: [String: Picked] = [:]
    private var jobs: [String: ImportJob] = [:]

    struct Picked {
        var urls: [URL]
        var name: String
        var size: UInt64
        var dbn: Bool
    }

    init(storage: Storage) {
        self.storage = storage
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        token = bytes.map { String(format: "%02x", $0) }.joined()
        web = Bundle.module.url(forResource: "web", withExtension: nil)
        http = HTTPServer(spoolDir: storage.tmp) { [unowned self] request in await self.handle(request) }
    }

    var port: UInt16 { http.port }
    var isRunning: Bool { http.isRunning }

    func startIfNeeded() throws {
        if !http.isRunning { try http.start(preferredPort: 47613) }
    }

    // MARK: - routing

    private func handle(_ r: HTTPRequest) async -> HTTPResponse {
        guard r.path.hasPrefix("/api/") else { return staticFile(r.path) }
        guard r.headers["x-token"] == token else { return .text("Forbidden", status: 403) }
        let parts = r.path.dropFirst(5).split(separator: "/").map(String.init)
        guard parts.dropFirst().allSatisfy(Self.validID) else { return .text("Bad id", status: 400) }
        do {
            switch (r.method, parts.count) {
            case ("GET", _): return try await get(parts, r)
            case ("POST", _): return try await post(parts, r)
            case ("PUT", 1...2): return try put(parts, r)
            case ("PATCH", 2) where parts[0] == "sessions": return try rename(parts[1], r)
            case ("DELETE", 2): return delete(parts)
            default: return .text("Not found", status: 404)
            }
        } catch {
            return .text(error.localizedDescription, status: 409)
        }
    }

    private func get(_ p: [String], _ r: HTTPRequest) async throws -> HTTPResponse {
        let s = storage
        switch p.count {
        case 1:
            switch p[0] {
            case "sessions": return .json(s.listJSON(in: s.sessions, suffix: ".meta.json"))
            case "datasets": return .json(s.listJSON(in: s.datasets, suffix: ".json").filter { $0["id"] != nil && $0["list"] == nil })
            case "caps": return .json(["pick": true, "importDbn": true, "ios": true])
            case "prefs": return .json(s.readJSON(s.prefsURL) ?? [:])
            case "last":
                var last = s.readJSON(s.lastURL) ?? [:]
                if let id = last["id"] as? String, !s.exists(s.sessions.appendingPathComponent(id + ".json")) { last = [:] }
                return .json(last)
            default: break
            }
        case 2:
            switch p[0] {
            case "sessions": return try file(s.sessions.appendingPathComponent(p[1] + ".json"), missing: "That backtest no longer exists.")
            case "census": return try file(s.datasets.appendingPathComponent(p[1] + ".census.json"), missing: "No contract list yet")
            case "series": return .json(try SeriesFile(url: seriesURL(p[1])).index())
            case "import":
                guard let job = lock.withLock({ jobs[p[1]] }) else { return .text("No such import", status: 404) }
                return .json(job.snapshot())
            default: break
            }
        case 3:
            if p[0] == "series" {
                guard let i = Int(p[2]) else { return .text("No such block", status: 404) }
                return .bytes(try SeriesFile(url: seriesURL(p[1])).block(i))
            }
            if p[0] == "datasets" && p[2] == "csv" {
                return try file(s.datasets.appendingPathComponent(p[1] + ".csv"), missing: "That data file no longer exists.", type: "text/plain; charset=utf-8")
            }
            if p[0] == "blob" || p[0] == "stat" {
                guard let url = blobURL(kind: p[1], id: p[2]), s.exists(url) else {
                    return .text("That file is no longer available. Load it again.", status: 404)
                }
                if p[0] == "stat" { return .json(["size": s.size(url)]) }
                let start = UInt64(r.query["start"] ?? "0") ?? 0
                let length = min(Int(r.query["len"] ?? "") ?? (8 << 20), 64 << 20)
                return .bytes(try s.read(url, from: start, length: length))
            }
        default: break
        }
        return .text("Not found", status: 404)
    }

    private func post(_ p: [String], _ r: HTTPRequest) async throws -> HTTPResponse {
        switch p {
        case ["pick"]:
            guard let urls = await AppModel.shared.pickFiles(), !urls.isEmpty else { return .noContent }
            let item = try await Task.detached { try self.prepare(urls) }.value
            let id = Storage.shortID(UUID().uuidString)
            lock.withLock { picked[id] = item }
            return .json(["id": id, "name": item.name, "size": item.size, "dbn": item.dbn])

        case ["datasets", "adopt"]:
            // a picked file joins the Library once its session starts
            let body = try jsonBody(r)
            guard let pickID = body["pick"] as? String, let item = lock.withLock({ picked[pickID] }), let src = item.urls.first else {
                return .text("That file is no longer available. Load it again.", status: 404)
            }
            let meta = try storage.storeDataset(from: src, meta: body["meta"] as? [String: Any] ?? [:])
            if let id = meta["id"] as? String {
                lock.withLock { picked[pickID]?.urls = [storage.datasets.appendingPathComponent(id + ".csv")] }
            }
            return .json(meta)

        case ["datasets"]:
            // an upload from the page: already spooled to disk by the server when large
            let meta = (r.headers["x-meta"]?.removingPercentEncoding).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [String: Any] ?? [:]
            let src = storage.newTempURL("csv")
            try storage.put(r, to: src)
            return .json(try storage.storeDataset(from: src, meta: meta))

        case ["import"]:
            let body = try jsonBody(r)
            guard let pickID = body["pick"] as? String, let item = lock.withLock({ picked[pickID] }), item.dbn else {
                return .text("That file is no longer available. Pick it again.", status: 404)
            }
            let job = ImportJob()
            lock.withLock { jobs[job.id] = job }
            startImport(job, files: item.urls, name: item.name)
            return .json(["job": job.id])

        default:
            return .text("Not found", status: 404)
        }
    }

    private func put(_ p: [String], _ r: HTTPRequest) throws -> HTTPResponse {
        let s = storage
        if p == ["prefs"] {
            _ = try jsonBody(r)
            s.lock.withLock { try? s.put(r, to: s.prefsURL) }
            return .ok
        }
        guard p.count == 2 else { return .text("Not found", status: 404) }
        switch p[0] {
        case "cache":
            try s.put(r, to: s.datasets.appendingPathComponent(p[1] + ".bin"))
            return .ok
        case "census":
            try s.put(r, to: s.datasets.appendingPathComponent(p[1] + ".census.json"))
            return .ok
        case "sessions":
            var doc = try jsonBody(r)
            var meta: [String: Any] = [:]
            for k in ["id", "name", "datasetId", "datasetName", "created", "updated", "status", "tf", "summary"] { meta[k] = doc[k] }
            meta["id"] = p[1]
            try s.lock.withLock {
                let metaURL = s.sessions.appendingPathComponent(p[1] + ".meta.json")
                // a rename from the Library wins over the name the page last knew
                if let old = s.readJSON(metaURL), old["renamed"] as? Bool == true, let name = old["name"] {
                    meta["name"] = name; meta["renamed"] = true; doc["name"] = name
                }
                try s.writeJSON(doc, to: s.sessions.appendingPathComponent(p[1] + ".json"))
                try s.writeJSON(meta, to: metaURL)
                try s.writeJSON(["id": p[1]], to: s.lastURL)
            }
            return .ok
        default:
            return .text("Not found", status: 404)
        }
    }

    private func rename(_ id: String, _ r: HTTPRequest) throws -> HTTPResponse {
        let body = try jsonBody(r)
        let name = String(((body["name"] as? String) ?? "").trimmingCharacters(in: .whitespaces).prefix(200))
        guard !name.isEmpty else { return .text("Name is empty", status: 400) }
        let s = storage
        return try s.lock.withLock {
            let metaURL = s.sessions.appendingPathComponent(id + ".meta.json"), docURL = s.sessions.appendingPathComponent(id + ".json")
            guard var meta = s.readJSON(metaURL), var doc = s.readJSON(docURL) else { return .text("That backtest no longer exists.", status: 404) }
            meta["name"] = name; meta["renamed"] = true; doc["name"] = name
            try s.writeJSON(doc, to: docURL)
            try s.writeJSON(meta, to: metaURL)
            return .ok
        }
    }

    private func delete(_ p: [String]) -> HTTPResponse {
        switch p[0] {
        case "sessions":
            storage.lock.withLock {
                for ext in [".json", ".meta.json"] { try? FileManager.default.removeItem(at: storage.sessions.appendingPathComponent(p[1] + ext)) }
            }
            return .ok
        case "datasets":
            storage.deleteDataset(p[1])
            return .ok
        default:
            return .text("Not found", status: 404)
        }
    }

    // MARK: - picked files

    /// Picked files arrive as copies in the system's inbox; they move into the app's own temporary folder.
    /// DBN files (plain or .zst, one or a batch) stay as they are for the native import. CSV files become one
    /// file the page can read in chunks: a batch is joined, and a .zst is decompressed as it is copied.
    private func prepare(_ picked: [URL]) throws -> Picked {
        let fm = FileManager.default
        var urls: [URL] = []
        for src in picked.sorted(by: { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }) {
            let dest = storage.tmp.appendingPathComponent(UUID().uuidString + "-" + src.lastPathComponent)
            do { try fm.moveItem(at: src, to: dest) } catch { try fm.copyItem(at: src, to: dest) }
            urls.append(dest)
        }
        let names = picked.map(\.lastPathComponent).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        let label = names.count == 1 ? names[0] : "\(names[0]) + \(names.count - 1) more"
        let isDBN = { (u: URL) -> Bool in let n = u.lastPathComponent.lowercased(); return n.hasSuffix(".dbn") || n.hasSuffix(".dbn.zst") }
        let total = urls.reduce(UInt64(0)) { $0 + storage.size($1) }
        if urls.allSatisfy(isDBN) { return Picked(urls: urls, name: label, size: total, dbn: true) }
        if urls.contains(where: isDBN) { throw AppError("Pick either DBN files or CSV files, not both at once.") }
        if urls.count == 1 && !urls[0].lastPathComponent.lowercased().hasSuffix(".zst") {
            return Picked(urls: urls, name: label, size: total, dbn: false)
        }
        let out = storage.newTempURL("csv")
        fm.createFile(atPath: out.path, contents: nil)
        let writer = try FileHandle(forWritingTo: out)
        defer { try? writer.close() }
        for url in urls {
            let source = try openSource(url)
            var lastByte: UInt8 = 10
            while true {
                let data = try source.read(4 << 20)
                if data.isEmpty { break }
                writer.write(data)
                lastByte = data.last ?? lastByte
            }
            if lastByte != 10 && lastByte != 13 { writer.write(Data([10])) }
            try? fm.removeItem(at: url)
        }
        let name = label.lowercased().hasSuffix(".zst") ? String(label.dropLast(4)) : label
        return Picked(urls: [out], name: name, size: storage.size(out), dbn: false)
    }

    private func blobURL(kind: String, id: String) -> URL? {
        switch kind {
        case "picked": return lock.withLock { picked[id]?.urls.first }
        case "dataset": return storage.datasets.appendingPathComponent(id + ".csv")
        case "cache": return storage.datasets.appendingPathComponent(id + ".bin")
        default: return nil
        }
    }

    private func seriesURL(_ id: String) -> URL { storage.datasets.appendingPathComponent(id + ".tapeseries") }

    // MARK: - DBN import

    private func startImport(_ job: ImportJob, files: [URL], name: String) {
        let storage = self.storage
        Task.detached(priority: .userInitiated) {
            await MainActor.run { AppModel.shared.importStarted() }
            do {
                let id = Storage.shortID(name + "|\(files.map { storage.size($0) })")
                let out = storage.datasets.appendingPathComponent(id + ".tapeseries")
                let display = name.replacingOccurrences(of: ".dbn.zst", with: "", options: .caseInsensitive)
                    .replacingOccurrences(of: ".dbn", with: "", options: .caseInsensitive)
                let header = try DBNImporter(files: files, id: id, name: display, output: out) { progress, message in
                    job.update(progress, message)
                }.run()
                let meta: [String: Any] = [
                    "id": id, "name": display, "bars": header["n"] ?? 0, "base": header["base"] ?? 1,
                    "from": header["from"] ?? 0, "to": header["to"] ?? 0, "contracts": header["contracts"] ?? 1,
                    "size": storage.size(out), "added": Int(Date().timeIntervalSince1970 * 1000), "chunked": true, "imported": true,
                ]
                try storage.writeJSON(meta, to: storage.datasets.appendingPathComponent(id + ".json"))
                for f in files { try? FileManager.default.removeItem(at: f) } // the monthly blocks now hold everything needed
                job.finish(meta)
            } catch {
                job.fail(error.localizedDescription)
            }
            await MainActor.run { AppModel.shared.importFinished() }
        }
    }

    // MARK: - helpers

    private func jsonBody(_ r: HTTPRequest) throws -> [String: Any] {
        let data = try r.bodyFile.map { try Data(contentsOf: $0) } ?? r.body
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AppError("Bad JSON") }
        return obj
    }

    private func file(_ url: URL, missing: String, type: String = "application/json") throws -> HTTPResponse {
        guard storage.exists(url) else { return .text(missing, status: 404) }
        return .bytes(try Data(contentsOf: url), type: type)
    }

    private func staticFile(_ path: String) -> HTTPResponse {
        guard let web else { return .text("The page is missing from the app", status: 404) }
        let rel = path == "/" ? "index.html" : String(path.dropFirst())
        let url = web.appendingPathComponent(rel).standardizedFileURL
        guard url.path.hasPrefix(web.standardizedFileURL.path + "/"), let data = try? Data(contentsOf: url) else {
            return .text("Not found", status: 404)
        }
        let types = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
                     "woff2": "font/woff2", "png": "image/png", "ico": "image/x-icon"]
        return .bytes(data, type: types[url.pathExtension.lowercased()] ?? "application/octet-stream")
    }

    static func validID(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 64 && s.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-" }
    }
}

/// Progress of one import, polled by the page.
final class ImportJob: @unchecked Sendable {
    let id = Storage.shortID(UUID().uuidString)
    private let lock = NSLock()
    private var state = "running", progress = 0.0, message = "Starting", dataset: [String: Any]?

    func update(_ p: Double, _ m: String) { lock.withLock { progress = p; message = m } }
    func finish(_ meta: [String: Any]) { lock.withLock { state = "done"; progress = 1; dataset = meta } }
    func fail(_ m: String) { lock.withLock { state = "error"; message = m } }
    func snapshot() -> [String: Any] {
        lock.withLock {
            var out: [String: Any] = ["state": state, "progress": progress, "message": message]
            if let dataset { out["dataset"] = dataset }
            return out
        }
    }
}
