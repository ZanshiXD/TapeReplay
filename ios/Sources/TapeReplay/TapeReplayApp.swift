import SwiftUI
import UIKit

@main
struct TapeReplayApp: App {
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            WebContainer()
                .ignoresSafeArea()
                .background(Color(red: 0.047, green: 0.063, blue: 0.086))
        }
        .onChange(of: phase) { _, now in
            switch now {
            case .background:
                AppModel.shared.saveNow()
            case .active:
                AppModel.shared.wake()
            default:
                break
            }
        }
    }
}

/// Ties the pieces together: the local server that stands in for the desktop app's Python backend,
/// the web view that shows the page, and the native file picker.
@MainActor
final class AppModel {
    static let shared = AppModel()

    let storage = Storage()
    private(set) lazy var server = AppServer(storage: storage)
    weak var controller: WebViewController?
    private let picker = FilePicker()
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var busyImports = 0

    /// Starts the server if needed and loads the page from it.
    func load() {
        do {
            try server.startIfNeeded()
        } catch {
            controller?.showFailure("The app could not start its local server: \(error.localizedDescription)")
            return
        }
        guard let url = URL(string: "http://127.0.0.1:\(server.port)/index.html?t=\(server.token)") else { return }
        controller?.webView.load(URLRequest(url: url))
    }

    /// The page saves every few seconds; this saves the open session at once (the app may be closed while in the background).
    func saveNow() {
        controller?.webView.evaluateJavaScript("window.__tapeFlush && window.__tapeFlush()", completionHandler: nil)
    }

    /// iOS may stop the server's listener while the app is suspended; restart it and reload when that happened.
    func wake() {
        if !server.isRunning { load() }
    }

    func pickFiles() async -> [URL]? {
        guard let vc = controller else { return nil }
        return await picker.pick(from: vc)
    }

    /// Keeps a long DBN import going briefly if the app is sent to the background, and the screen awake meanwhile.
    func importStarted() {
        busyImports += 1
        UIApplication.shared.isIdleTimerDisabled = true
        if backgroundTask == .invalid {
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Import data") { [weak self] in
                self?.endBackgroundTask()
            }
        }
    }

    func importFinished() {
        busyImports = max(0, busyImports - 1)
        if busyImports == 0 {
            UIApplication.shared.isIdleTimerDisabled = false
            endBackgroundTask()
        }
    }

    private func endBackgroundTask() {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }
}
