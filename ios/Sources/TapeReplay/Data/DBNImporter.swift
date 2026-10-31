import Foundation

/// Imports Databento OHLCV data (.dbn or .dbn.zst; one file or a batch read back to back) of any size.
///
/// The files are read twice, as a stream, so memory use does not grow with the file:
///   1. volume per contract per day, to choose the contract to follow each day: the most-traded outright
///      (spreads skipped), never going back to one already left - the same roll as the desktop app;
///   2. that contract's bars, written to a series file one calendar month at a time.
/// The page then loads only the months a session needs.
final class DBNImporter {
    typealias Progress = (Double, String) -> Void

    private let files: [URL]
    private let id: String
    private let name: String
    private let output: URL
    private let progress: Progress

    init(files: [URL], id: String, name: String, output: URL, progress: @escaping Progress) {
        self.files = files
        self.id = id
        self.name = name
        self.output = output
        self.progress = progress
    }

    private struct DayStat { var volume = 0.0; var bars = 0 }

    func run() throws -> [String: Any] {
        let sizes = files.map { ((try? FileManager.default.attributesOfItem(atPath: $0.path))?[.size] as? NSNumber)?.uint64Value ?? 1 }
        let total = Double(max(1, sizes.reduce(0, +)))

        // ---- pass 1: volume and bar count per (day, contract) ----
        var names: [UInt32: String] = [:]
        var stats: [UInt64: DayStat] = [:]
        var rtypeSeen: UInt8 = 0
        var done: UInt64 = 0
        for (k, url) in files.enumerated() {
            let reader = try DBNReader(url)
            names.merge(reader.names) { first, _ in first }
            try reader.forEachRecord({ raw, at in
                let rtype = raw[at + 1]
                guard raw[at] == 14, DBNReader.ohlcv(rtype) else { return }
                rtypeSeen = rtype
                let ts = raw.loadUnaligned(fromByteOffset: at + 8, as: UInt64.self)
                let inst = raw.loadUnaligned(fromByteOffset: at + 4, as: UInt32.self)
                let key = (ts / 86_400_000_000_000) << 32 | UInt64(inst)
                stats[key, default: DayStat()].volume += Double(raw.loadUnaligned(fromByteOffset: at + 48, as: UInt64.self))
                stats[key, default: DayStat()].bars += 1
            }, chunkDone: {
                progress(Double(done + reader.consumed) / total * 0.45, "Reading file \(k + 1) of \(files.count) (pass 1 of 2)")
            })
            done += sizes[k]
        }
        guard rtypeSeen != 0 else { throw AppError("No price bars found. Import Databento OHLCV files (ohlcv-1s, -1m, -1h or -1d).") }
        let base: Int = [0x20: 1, 0x21: 60, 0x22: 3600, 0x23: 86400, 0x24: 86400][Int(rtypeSeen)] ?? 1

        // ---- the roll ----
        var byDay: [UInt64: [(volume: Double, inst: UInt32)]] = [:]
        for (key, s) in stats { byDay[key >> 32, default: []].append((s.volume, UInt32(truncatingIfNeeded: key))) }
        let isSpread = { (inst: UInt32) -> Bool in (names[inst] ?? "").contains("-") }
        var roll: [UInt64: UInt32] = [:], left = Set<UInt32>(), current: UInt32?, rolls: [[Any]] = []
        for day in byDay.keys.sorted() {
            // equal volume: the higher id, as the desktop does, so the same file always rolls the same way
            let best = byDay[day]!.filter { !isSpread($0.inst) && !left.contains($0.inst) }
                .max { ($0.volume, $0.inst) < ($1.volume, $1.inst) }
            if let best, best.inst != current {
                if let current { left.insert(current) }
                current = best.inst
                rolls.append([Double(day) * 86400, names[best.inst] ?? "ID \(best.inst)"])
            }
            if let current { roll[day] = current }
        }
        stats = [:]

        // ---- pass 2: the followed contract's bars, a month at a time ----
        let partial = output.deletingLastPathComponent().appendingPathComponent(output.lastPathComponent + ".part")
        try? FileManager.default.removeItem(at: partial)
        let writer = try SeriesWriter(url: partial)
        // the month being gathered (about 1.5 million bars at most for 1-second data)
        var t: [Double] = [], o: [Float] = [], h: [Float] = [], l: [Float] = [], c: [Float] = [], v: [Float] = []
        var month = Int.min, lastDay = UInt64.max, wanted: UInt32?, dayMonth = 0
        var sample: [Double] = []

        func flush() throws {
            guard !t.isEmpty else { return }
            // the same second twice (overlapping files in a batch): keep the later bar
            var keep = 0
            for i in 0..<t.count where i + 1 == t.count || t[i + 1] != t[i] {
                t[keep] = t[i]; o[keep] = o[i]; h[keep] = h[i]; l[keep] = l[i]; c[keep] = c[i]; v[keep] = v[i]
                keep += 1
            }
            try writer.add(t: Array(t[..<keep]), o: Array(o[..<keep]), h: Array(h[..<keep]), l: Array(l[..<keep]), c: Array(c[..<keep]), v: Array(v[..<keep]))
            t.removeAll(keepingCapacity: true); o.removeAll(keepingCapacity: true); h.removeAll(keepingCapacity: true)
            l.removeAll(keepingCapacity: true); c.removeAll(keepingCapacity: true); v.removeAll(keepingCapacity: true)
        }

        done = 0
        for (k, url) in files.enumerated() {
            let reader = try DBNReader(url)
            try reader.forEachRecord({ raw, at in
                guard raw[at] == 14, DBNReader.ohlcv(raw[at + 1]) else { return }
                let ts = raw.loadUnaligned(fromByteOffset: at + 8, as: UInt64.self)
                let day = ts / 86_400_000_000_000
                if day != lastDay { lastDay = day; wanted = roll[day]; dayMonth = monthIndex(days: Int64(day)) }
                guard let w = wanted, raw.loadUnaligned(fromByteOffset: at + 4, as: UInt32.self) == w else { return }
                let op = raw.loadUnaligned(fromByteOffset: at + 16, as: Int64.self)
                if op == Int64.max { return } // no trade in this bar
                if dayMonth != month {
                    try flush()
                    month = dayMonth
                }
                let px = { (off: Int) -> Float in Float(Double(raw.loadUnaligned(fromByteOffset: at + off, as: Int64.self)) / 1e9) }
                let open = px(16), close = px(40)
                t.append((Double(ts) / 1e9).rounded())
                o.append(open)
                h.append(max(px(24), open, close))
                l.append(min(px(32), open, close))
                c.append(close)
                v.append(Float(raw.loadUnaligned(fromByteOffset: at + 48, as: UInt64.self)))
                // exact prices: a Float copy of 1.08575 (6E) would fail every decimals test and fall back to 2
                if sample.count < 800 { sample.append(Double(op) / 1e9); sample.append(Double(raw.loadUnaligned(fromByteOffset: at + 40, as: Int64.self)) / 1e9) }
            }, chunkDone: {
                progress(0.45 + Double(done + reader.consumed) / total * 0.55, "Writing months: \(writer.blocks.count) done (pass 2 of 2)")
            })
            done += sizes[k]
        }
        try flush()
        guard writer.bars > 0, let first = writer.blocks.first, let last = writer.blocks.last else {
            try? FileManager.default.removeItem(at: partial)
            throw AppError("No bars to keep: the file has no outright contracts with trades.")
        }

        // price decimals, from the first bars
        var decimals = 2
        for d in 0...8 where sample.allSatisfy({ abs($0 * pow(10, Double(d)) - ($0 * pow(10, Double(d))).rounded()) < 1e-6 }) {
            decimals = max(d, 2); break
        }
        let header: [String: Any] = [
            "v": 1, "id": id, "name": name, "n": writer.bars, "base": base, "prec": decimals, "hasVol": true,
            "from": first["t0"] ?? 0, "to": last["t1"] ?? 0, "contracts": rolls.count, "rolls": rolls,
        ]
        try writer.finish(header: header)
        try? FileManager.default.removeItem(at: output)
        try FileManager.default.moveItem(at: partial, to: output)
        progress(1, "Done")
        return header
    }
}

/// The calendar month (year * 12 + month - 1) of a day counted from 1970-01-01, in UTC.
func monthIndex(days z0: Int64) -> Int {
    let z = z0 + 719_468
    let era = (z >= 0 ? z : z - 146_096) / 146_097
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let m = mp < 10 ? mp + 3 : mp - 9
    let y = yoe + era * 400 + (m <= 2 ? 1 : 0)
    return Int(y * 12 + m - 1)
}

/// Reads one DBN file (v1 to v3): its symbol table from the metadata, then its records in large chunks.
final class DBNReader {
    let names: [UInt32: String]
    private let source: ByteSource
    private var pending: Data

    static func ohlcv(_ rtype: UInt8) -> Bool { rtype >= 0x20 && rtype <= 0x24 }

    var consumed: UInt64 { source.consumed }

    init(_ url: URL) throws {
        source = try openSource(url)
        var head = Data()
        while head.count < 8 {
            let more = try source.read(1 << 20)
            if more.isEmpty { break }
            head.append(more)
        }
        guard head.count >= 8, head.prefix(3) == Data("DBN".utf8) else {
            throw AppError("\(url.lastPathComponent) is not a DBN file.")
        }
        let version = head[head.startIndex + 3]
        let metaLength = Int(UInt32(littleEndian: head.subdata(in: (head.startIndex + 4)..<(head.startIndex + 8)).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }))
        while head.count < 8 + metaLength {
            let more = try source.read(max(1 << 20, 8 + metaLength - head.count))
            if more.isEmpty { throw AppError("\(url.lastPathComponent) ends inside its header.") }
            head.append(more)
        }
        let meta = head.subdata(in: (head.startIndex + 8)..<(head.startIndex + 8 + metaLength))
        names = DBNReader.parseSymbols(meta, version: version)
        pending = head.subdata(in: (head.startIndex + 8 + metaLength)..<head.endIndex)
    }

    /// Calls `body` with each record (the chunk's bytes and the record's offset in them), and `chunkDone`
    /// after every chunk of a few megabytes.
    func forEachRecord(_ body: (UnsafeRawBufferPointer, Int) throws -> Void, chunkDone: () -> Void) throws {
        while true {
            let more = try source.read(8 << 20)
            var chunk = pending
            chunk.append(more)
            if chunk.isEmpty { break }
            var used = 0
            try chunk.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                while used < raw.count {
                    let length = Int(raw[used]) * 4
                    if length < 16 { throw AppError("This DBN file is damaged (a record of \(length) bytes).") }
                    if used + length > raw.count { break }
                    try body(raw, used)
                    used += length
                }
            }
            pending = chunk.subdata(in: (chunk.startIndex + used)..<chunk.endIndex)
            chunkDone()
            if more.isEmpty { break } // anything left is a record cut off at the end of the file
        }
    }

    /// Instrument id to symbol, from the metadata's symbol mappings (e.g. 42140864 -> MNQZ5).
    private static func parseSymbols(_ m: Data, version: UInt8) -> [UInt32: String] {
        let bytes = [UInt8](m)
        func u16(_ p: Int) -> Int? { p + 2 <= bytes.count ? Int(bytes[p]) | Int(bytes[p + 1]) << 8 : nil }
        func u32(_ p: Int) -> Int? { p + 4 <= bytes.count ? (0..<4).reduce(0) { $0 | Int(bytes[p + $1]) << (8 * $1) } : nil }
        var p = 16 + 2 + 8 + 8 + 8 + (version == 1 ? 8 : 0) + 3
        var cl = 22
        if version >= 2 {
            guard let len = u16(p) else { return [:] }
            cl = len
            p += 2 + 53
        } else {
            p += 47
        }
        func cstr(_ q: Int) -> String? {
            guard q + cl <= bytes.count else { return nil }
            let slice = bytes[q..<(q + cl)].prefix { $0 != 0 }
            return String(decoding: slice, as: UTF8.self)
        }
        guard let schemaLen = u32(p) else { return [:] }
        p += 4 + schemaLen
        for _ in 0..<3 { // symbols, partial, not found
            guard let n = u32(p) else { return [:] }
            p += 4 + n * cl
        }
        guard let count = u32(p) else { return [:] }
        var q = p + 4
        var rawToIDs: [String: Set<UInt32>] = [:]
        for _ in 0..<count {
            guard let raw = cstr(q) else { break }
            q += cl
            guard let intervals = u32(q) else { break }
            q += 4
            for _ in 0..<intervals {
                q += 8 // start and end dates
                guard let sym = cstr(q) else { break }
                q += cl
                if let inst = UInt32(sym) { rawToIDs[raw, default: []].insert(inst) }
            }
        }
        var out: [UInt32: String] = [:]
        for (raw, ids) in rawToIDs {
            for inst in ids where out[inst] == nil { out[inst] = ids.count == 1 ? raw : "\(raw)#\(inst)" }
        }
        return out
    }
}
