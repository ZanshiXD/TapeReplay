import Foundation
import libzstd

/// A stream of bytes read front to back: a plain file, or a Zstandard-compressed one decompressed on the fly.
/// `read` returns an empty Data at the end. `consumed` is how far into the file on disk reading has got
/// (for progress: a compressed file's own size, not the larger decompressed size).
protocol ByteSource: AnyObject {
    func read(_ maxLength: Int) throws -> Data
    var consumed: UInt64 { get }
}

/// A plain file, or a .zst one decompressed as it is read.
func openSource(_ url: URL) throws -> ByteSource {
    let file = try FileSource(url)
    return url.pathExtension.lowercased() == "zst" ? try ZstdSource(file) : file
}

final class FileSource: ByteSource {
    private let handle: FileHandle
    private(set) var consumed: UInt64 = 0

    init(_ url: URL) throws { handle = try FileHandle(forReadingFrom: url) }
    deinit { try? handle.close() }

    func read(_ maxLength: Int) throws -> Data {
        let data = try handle.read(upToCount: maxLength) ?? Data()
        consumed += UInt64(data.count)
        return data
    }
}

final class ZstdSource: ByteSource {
    private let source: ByteSource
    private let stream: OpaquePointer
    private var input = Data()
    private var inputPos = 0
    private var frameOpen = false // the last call stopped inside a frame (more input needed to finish it)

    init(_ source: ByteSource) throws {
        self.source = source
        guard let s = ZSTD_createDStream() else { throw AppError("Could not start decompressing") }
        stream = s
        _ = ZSTD_initDStream(stream)
    }
    deinit { ZSTD_freeDStream(stream) }

    var consumed: UInt64 { source.consumed }

    func read(_ maxLength: Int) throws -> Data {
        var out = Data(count: maxLength)
        var produced = 0
        while produced == 0 {
            if inputPos >= input.count {
                input = try source.read(ZSTD_DStreamInSize() * 8)
                inputPos = 0
                if input.isEmpty {
                    if frameOpen { throw AppError("The compressed file ends early; it may not have finished downloading.") }
                    return Data()
                }
            }
            let result: Int = input.withUnsafeBytes { inRaw in
                out.withUnsafeMutableBytes { outRaw in
                    var inBuf = ZSTD_inBuffer(src: inRaw.baseAddress, size: inRaw.count, pos: inputPos)
                    var outBuf = ZSTD_outBuffer(dst: outRaw.baseAddress, size: maxLength, pos: produced)
                    let r = ZSTD_decompressStream(stream, &outBuf, &inBuf)
                    inputPos = inBuf.pos
                    produced = outBuf.pos
                    return r
                }
            }
            if ZSTD_isError(result) != 0 { throw AppError("Could not decompress: \(String(cString: ZSTD_getErrorName(result)))") }
            frameOpen = result != 0
        }
        out.count = produced
        return out
    }
}

enum Zstd {
    static func compress(_ data: Data, level: Int32 = 3) throws -> Data {
        var out = Data(count: ZSTD_compressBound(data.count))
        let size: Int = data.withUnsafeBytes { src in
            out.withUnsafeMutableBytes { dst in
                ZSTD_compress(dst.baseAddress, dst.count, src.baseAddress, src.count, level)
            }
        }
        if ZSTD_isError(size) != 0 { throw AppError("Could not compress: \(String(cString: ZSTD_getErrorName(size)))") }
        out.count = size
        return out
    }

    /// A frame whose decompressed size is known (the series blocks record it).
    static func decompress(_ data: Data, size: Int) throws -> Data {
        var out = Data(count: size)
        let got: Int = data.withUnsafeBytes { src in
            out.withUnsafeMutableBytes { dst in
                ZSTD_decompress(dst.baseAddress, dst.count, src.baseAddress, src.count)
            }
        }
        if ZSTD_isError(got) != 0 || got != size { throw AppError("A block of this data file is damaged. Import the file again.") }
        return out
    }
}
