import Foundation

// A long bar series split into monthly blocks, the format the desktop app's build_series.py writes:
//     "TAPESER1" | blocks ... | header JSON | u32 header length | "TAPESER1"
// Each block holds six columns (time f64, then open, high, low, close, volume f32), each byte-shuffled
// (all first bytes, then all second bytes, ...) and Zstandard-compressed. The header lists every block's
// first and last time, bar count and its columns' offsets and sizes, so any month loads on its own.

private let magic = Data("TAPESER1".utf8)
private let widths = [8, 4, 4, 4, 4, 4]

private func number(_ any: Any?) -> Double { (any as? NSNumber)?.doubleValue ?? 0 }

final class SeriesFile {
    let header: [String: Any]
    private let handle: FileHandle
    private let blocks: [[String: Any]]

    init(url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { throw AppError("That data is not in the Library any more.") }
        handle = try FileHandle(forReadingFrom: url)
        let size = try handle.seekToEnd()
        guard size > 20 else { throw AppError("That data file is damaged. Import it again.") }
        try handle.seek(toOffset: size - 12)
        let tail = try handle.read(upToCount: 12) ?? Data()
        guard tail.count == 12, tail.suffix(8) == magic else { throw AppError("That data file is damaged. Import it again.") }
        let length = UInt64(UInt32(littleEndian: tail.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }))
        try handle.seek(toOffset: size - 12 - length)
        let json = try handle.read(upToCount: Int(length)) ?? Data()
        guard let h = try JSONSerialization.jsonObject(with: json) as? [String: Any] else { throw AppError("That data file is damaged. Import it again.") }
        header = h
        blocks = h["blocks"] as? [[String: Any]] ?? []
    }
    deinit { try? handle.close() }

    /// What the page needs to plan sections: the header, with each block's times and bar count only.
    func index() -> [String: Any] {
        var h = header
        h["blocks"] = blocks.map { ["t0": number($0["t0"]), "t1": number($0["t1"]), "n": Int(number($0["n"]))] }
        return h
    }

    /// One month as plain columns, back to back: time f64 x n, then open, high, low, close, volume f32 x n.
    func block(_ i: Int) throws -> Data {
        guard blocks.indices.contains(i), let cols = blocks[i]["cols"] as? [[Any]], cols.count == 6 else { throw AppError("No such block") }
        let n = Int(number(blocks[i]["n"]))
        var out = Data(capacity: n * 28)
        for (k, col) in cols.enumerated() {
            try handle.seek(toOffset: UInt64(number(col[0])))
            let packed = try handle.read(upToCount: Int(number(col[1]))) ?? Data()
            out.append(unshuffle(try Zstd.decompress(packed, size: n * widths[k]), width: widths[k]))
        }
        return out
    }
}

/// Writes a series file one month at a time; only the month being written is in memory.
final class SeriesWriter {
    private let handle: FileHandle
    private var offset: UInt64 = 0
    private(set) var blocks: [[String: Any]] = []
    private(set) var bars = 0

    init(url: URL) throws {
        _ = FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try FileHandle(forWritingTo: url)
        try write(magic)
    }
    deinit { try? handle.close() }

    func add(t: [Double], o: [Float], h: [Float], l: [Float], c: [Float], v: [Float]) throws {
        guard let first = t.first, let last = t.last else { return }
        var cols: [[UInt64]] = []
        for raw in [bytes(of: t), bytes(of: o), bytes(of: h), bytes(of: l), bytes(of: c), bytes(of: v)] {
            let width = cols.isEmpty ? 8 : 4
            let packed = try Zstd.compress(shuffle(raw, width: width))
            cols.append([offset, UInt64(packed.count)])
            try write(packed)
        }
        blocks.append(["t0": first, "t1": last, "n": t.count, "cols": cols])
        bars += t.count
    }

    func finish(header: [String: Any]) throws {
        var h = header
        h["blocks"] = blocks
        let json = try JSONSerialization.data(withJSONObject: h)
        var length = UInt32(json.count).littleEndian
        try write(json)
        try write(Data(bytes: &length, count: 4))
        try write(magic)
        try handle.close()
    }

    private func write(_ data: Data) throws {
        try handle.write(contentsOf: data)
        offset += UInt64(data.count)
    }

    private func bytes<T>(of array: [T]) -> Data { array.withUnsafeBytes { Data($0) } }
}

/// Byte-shuffling groups each byte position together, which compresses prices and times far better.
func shuffle(_ raw: Data, width: Int) -> Data {
    let n = raw.count / width
    var out = Data(count: raw.count)
    raw.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
        out.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
            let s = src.bindMemory(to: UInt8.self), d = dst.bindMemory(to: UInt8.self)
            for j in 0..<width { for i in 0..<n { d[j * n + i] = s[i * width + j] } }
        }
    }
    return out
}

func unshuffle(_ packed: Data, width: Int) -> Data {
    let n = packed.count / width
    var out = Data(count: packed.count)
    packed.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
        out.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
            let s = src.bindMemory(to: UInt8.self), d = dst.bindMemory(to: UInt8.self)
            for j in 0..<width { for i in 0..<n { d[i * width + j] = s[j * n + i] } }
        }
    }
    return out
}
