import Foundation
import Network

struct HTTPRequest {
    var method: String
    var path: String                 // percent-decoded, without the query
    var query: [String: String]
    var headers: [String: String]    // keys lowercased
    var body: Data                   // small bodies
    var bodyFile: URL?               // large bodies, spooled to disk as they arrive
}

struct HTTPResponse {
    var status: Int
    var contentType = "application/json"
    var body = Data()

    static func json(_ object: Any, status: Int = 200) -> HTTPResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return HTTPResponse(status: status, body: data)
    }
    static func text(_ message: String, status: Int) -> HTTPResponse {
        HTTPResponse(status: status, contentType: "text/plain; charset=utf-8", body: Data(message.utf8))
    }
    static func bytes(_ data: Data, type: String = "application/octet-stream") -> HTTPResponse {
        HTTPResponse(status: 200, contentType: type, body: data)
    }
    static let ok = HTTPResponse.json(["ok": true])
    static let noContent = HTTPResponse(status: 204)
}

/// A small HTTP/1.1 server on 127.0.0.1 for the page in the web view: one request per connection,
/// bodies of any size (uploads are written to disk while they arrive, never held whole in memory).
final class HTTPServer: @unchecked Sendable {
    typealias Handler = @Sendable (HTTPRequest) async -> HTTPResponse

    private let handler: Handler
    private let spoolDir: URL
    private let spoolOver = 16 << 20
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "tape.http")
    private let lock = NSLock()
    private var open: [ObjectIdentifier: Connection] = [:]
    private(set) var port: UInt16 = 0

    init(spoolDir: URL, handler: @escaping Handler) {
        self.spoolDir = spoolDir
        self.handler = handler
    }

    var isRunning: Bool {
        guard let listener else { return false }
        if case .ready = listener.state { return true }
        return false
    }

    /// Listens on the preferred port (so the page's own storage stays with the same address), or any free one.
    func start(preferredPort: UInt16) throws {
        stop()
        var lastError: Error = NWError.posix(.EADDRINUSE)
        for candidate in [preferredPort, 0] {
            do {
                try listen(on: candidate)
                return
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func listen(on candidate: UInt16) throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: candidate) ?? .any)
        let listener = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        var failure: Error?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case .failed(let error): failure = error; ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] nw in self?.accept(nw) }
        listener.start(queue: queue)
        if ready.wait(timeout: .now() + 3) == .timedOut { listener.cancel(); throw NWError.posix(.ETIMEDOUT) }
        if let failure { listener.cancel(); throw failure }
        listener.stateUpdateHandler = nil
        self.listener = listener
        port = listener.port?.rawValue ?? candidate
    }

    private func accept(_ nw: NWConnection) {
        let c = Connection(nw, server: self)
        lock.lock(); open[ObjectIdentifier(c)] = c; lock.unlock()
        c.start()
    }

    fileprivate func closed(_ c: Connection) {
        lock.lock(); open[ObjectIdentifier(c)] = nil; lock.unlock()
    }

    fileprivate func respond(to request: HTTPRequest) async -> HTTPResponse { await handler(request) }
    fileprivate var spoolThreshold: Int { spoolOver }
    fileprivate func newSpoolFile() -> URL { spoolDir.appendingPathComponent("upload-\(UUID().uuidString)") }
}

private final class Connection: @unchecked Sendable {
    private let nw: NWConnection
    private weak var server: HTTPServer?
    private var head = Data()
    private var request: HTTPRequest?
    private var expected = 0
    private var received = 0
    private var spool: FileHandle?
    private var dispatched = false

    init(_ nw: NWConnection, server: HTTPServer) {
        self.nw = nw
        self.server = server
    }

    func start() {
        nw.stateUpdateHandler = { [self] state in
            switch state {
            case .failed, .cancelled: cleanup()
            default: break
            }
        }
        nw.start(queue: DispatchQueue(label: "tape.http.conn"))
        readMore()
    }

    private func readMore() {
        nw.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [self] data, _, isComplete, error in
            if let data, !data.isEmpty { take(data) }
            if dispatched { return }
            if error != nil || isComplete { nw.cancel(); return }
            readMore()
        }
    }

    private func take(_ data: Data) {
        if request != nil { body(data); return }
        head.append(data)
        guard let end = head.range(of: Data("\r\n\r\n".utf8)) else {
            if head.count > 64 << 10 { send(.text("Request headers too large", status: 431)) }
            return
        }
        guard var req = parseHead(head.subdata(in: head.startIndex..<end.lowerBound)) else {
            send(.text("Bad request", status: 400)); return
        }
        let rest = head.subdata(in: end.upperBound..<head.endIndex)
        head = Data()
        expected = Int(req.headers["content-length"] ?? "") ?? 0
        if let server, expected > server.spoolThreshold {
            let url = server.newSpoolFile()
            FileManager.default.createFile(atPath: url.path, contents: nil)
            spool = try? FileHandle(forWritingTo: url)
            req.bodyFile = url
        }
        request = req
        body(rest)
    }

    private func body(_ data: Data) {
        guard !dispatched, request != nil else { return }
        let want = min(data.count, max(0, expected - received))
        if want > 0 {
            let part = data.prefix(want)
            if let spool { spool.write(part) } else { request!.body.append(part) }
            received += want
        }
        if received >= expected { dispatch() }
    }

    private func dispatch() {
        guard !dispatched, let req = request else { return }
        dispatched = true
        try? spool?.close()
        spool = nil
        Task { [self] in
            let response = await server?.respond(to: req) ?? .text("Server stopped", status: 503)
            if let file = req.bodyFile { try? FileManager.default.removeItem(at: file) } // left over unless the handler moved it
            send(response)
        }
    }

    private func send(_ r: HTTPResponse) {
        dispatched = true
        var out = Data("HTTP/1.1 \(r.status) \(reason(r.status))\r\n".utf8)
        // cross-origin isolation: lets the page share memory with its workers (strategy optimization)
        let isolation = "Cross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nCross-Origin-Resource-Policy: same-origin\r\n"
        out.append(Data("Content-Type: \(r.contentType)\r\nContent-Length: \(r.body.count)\r\nCache-Control: no-store\r\n\(isolation)Connection: close\r\n\r\n".utf8))
        out.append(r.body)
        nw.send(content: out, completion: .contentProcessed { [self] _ in nw.cancel() })
    }

    private func cleanup() {
        try? spool?.close()
        spool = nil
        server?.closed(self)
    }

    private func parseHead(_ data: Data) -> HTTPRequest? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        var lines = text.components(separatedBy: "\r\n")
        let first = lines.removeFirst().split(separator: " ")
        guard first.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let target = String(first[1])
        let comps = URLComponents(string: "http://127.0.0.1" + target)
        var query: [String: String] = [:]
        for item in comps?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        let rawPath = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
        return HTTPRequest(method: String(first[0]), path: rawPath.removingPercentEncoding ?? rawPath,
                           query: query, headers: headers, body: Data(), bodyFile: nil)
    }

    private func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 431: return "Request Header Fields Too Large"
        case 501: return "Not Implemented"
        case 503: return "Service Unavailable"
        default: return status < 400 ? "OK" : "Error"
        }
    }
}
